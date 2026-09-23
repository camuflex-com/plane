// oxlint-disable no-await-in-loop -- los repos se importan de uno en uno a
// propósito: cada alta reserva un identificador que la siguiente debe ver.
import { setTimeout as wait } from "node:timers/promises";
import { GitHubClient, type OrgRepo } from "@/clients/github";
import { HttpError } from "@/clients/http";
import { PlaneClient, type Project } from "@/clients/plane";
import type { Db } from "@/db";
import { insertProjectConfig, listProjectConfigs } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";

/**
 * Importa la organización de GitHub a Plane.
 *
 * Cada repo de la organización que todavía no tenga fila en `project_config`
 * recibe un proyecto en Plane y queda automatizado desde el principio. Antes
 * había que crear el proyecto, su webhook y su fila a mano, repo por repo.
 *
 * Es idempotente: el proyecto se marca con `external_id = owner/repo`, y si
 * un alta anterior se quedó a medias (proyecto creado, fila no), la siguiente
 * pasada lo adopta en vez de duplicarlo. Una fila existente no se toca nunca:
 * un repo deshabilitado a mano sigue deshabilitado.
 */

export const EXTERNAL_SOURCE = "github";
const IDENTIFIER_MAX = 12;

export const externalId = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** "camuflex-design-system" -> "Camuflex Design System". */
export function projectName(repo: string): string {
  return repo
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Identificador corto de Plane (máx. 12, solo letras y números).
 *
 * Se quita el prefijo de la organización cuando sobra: en "camuflex-com",
 * "camuflex-design-system" da DESIGNSYSTEM y no CAMUFLEXDESI. Si choca con
 * uno ocupado, se le añade un número.
 */
export function projectIdentifier(repo: string, org: string, taken: ReadonlySet<string>): string {
  const orgWord = org.split(/[-_.]/)[0]?.toLowerCase() ?? "";
  let words = repo
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length > 1 && words[0] === orgWord) words = words.slice(1);
  const base = (words.join("").toUpperCase() || "REPO").slice(0, IDENTIFIER_MAX);

  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, IDENTIFIER_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Repos que merecen proyecto: los archivados o deshabilitados no. */
export function importableRepos(repos: OrgRepo[]): OrgRepo[] {
  return repos.filter((repo) => !repo.archived && !repo.disabled);
}

/** Proyecto de Plane que ya corresponde a este repo, si lo hay. */
export function matchProject(projects: Project[], owner: string, repo: string): Project | null {
  const id = externalId(owner, repo);
  const byExternal = projects.find(
    (p) => p.external_source === EXTERNAL_SOURCE && (p.external_id ?? "").toLowerCase() === id
  );
  if (byExternal) return byExternal;
  const name = projectName(repo).toLowerCase();
  return projects.find((p) => p.name.trim().toLowerCase() === name) ?? null;
}

export type OrgSyncResult = { imported: string[]; failed: string[] };

export async function syncOrg(db: Db, env: Env): Promise<OrgSyncResult> {
  const github = new GitHubClient(env);
  const plane = new PlaneClient(env);
  const slug = env.PLANE_WORKSPACE_SLUG;
  const org = env.GITHUB_ORG;

  const configured = new Set(
    (await listProjectConfigs(db)).map((c) => `${c.githubOwner}/${c.githubRepo}`.toLowerCase())
  );
  const pending = importableRepos(await github.listOrgRepos(org)).filter(
    (repo) => !configured.has(externalId(repo.owner.login, repo.name))
  );
  const result: OrgSyncResult = { imported: [], failed: [] };
  if (pending.length === 0) return result;

  const projects = await plane.listProjects(slug);
  const taken = new Set(projects.map((p) => p.identifier.toUpperCase()));

  for (const repo of pending) {
    const owner = repo.owner.login;
    try {
      const project = matchProject(projects, owner, repo.name) ?? (await createProject(plane, env, repo, taken));
      projects.push(project);
      taken.add(project.identifier.toUpperCase());

      const baseBranch = repo.default_branch || "main";
      if (!(await github.branchExists(owner, repo.name, baseBranch))) {
        logger.info("repo vacío, se crea el commit inicial", { repo: repo.name, baseBranch });
        await github.createInitialCommit(owner, repo.name, baseBranch);
      }

      await insertProjectConfig(db, {
        planeProjectId: project.id,
        planeWorkspaceSlug: slug,
        githubOwner: owner,
        githubRepo: repo.name,
        baseBranch,
        enabled: true,
      });
      result.imported.push(repo.name);
      logger.info("repo importado a Plane", {
        repo: repo.name,
        projectId: project.id,
        identifier: project.identifier,
        baseBranch,
      });
    } catch (error) {
      result.failed.push(repo.name);
      logger.error("no se pudo importar el repo", { repo: repo.name, error: String(error) });
    }
  }
  return result;
}

async function createProject(plane: PlaneClient, env: Env, repo: OrgRepo, taken: Set<string>): Promise<Project> {
  // El identificador puede estar reservado aunque no se vea: Plane guarda los
  // de proyectos borrados, o de proyectos privados donde el bot no está.
  for (let attempt = 0; attempt < 5; attempt++) {
    const identifier = projectIdentifier(repo.name, env.GITHUB_ORG, taken);
    try {
      return await plane.createProject(env.PLANE_WORKSPACE_SLUG, {
        name: projectName(repo.name),
        identifier,
        description: `Repositorio ${repo.owner.login}/${repo.name}`,
        projectLeadId: env.PLANE_PROJECT_LEAD_ID,
        externalSource: EXTERNAL_SOURCE,
        externalId: externalId(repo.owner.login, repo.name),
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409 && error.body.includes("identifier")) {
        taken.add(identifier);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`sin identificador libre para ${repo.name}`);
}

/** Bucle de importación. Corre al arrancar y luego cada intervalo. */
export async function runOrgSync(db: Db, env: Env, signal: AbortSignal): Promise<void> {
  if (env.ORG_SYNC_INTERVAL_MS <= 0) {
    logger.info("importación de la organización desactivada");
    return;
  }
  while (!signal.aborted) {
    try {
      const { imported, failed } = await syncOrg(db, env);
      if (imported.length || failed.length) {
        logger.info("importación de la organización", { org: env.GITHUB_ORG, imported, failed });
      }
    } catch (error) {
      logger.error("fallo importando la organización", { error: String(error) });
    }
    await sleepUnlessAborted(env.ORG_SYNC_INTERVAL_MS, signal);
  }
}

/** El intervalo es largo: sin cortar la espera, apagar tardaría minutos. */
const sleepUnlessAborted = (ms: number, signal: AbortSignal) => wait(ms, undefined, { signal }).catch(() => undefined);
