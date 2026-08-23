import { HttpError } from "@/clients/http";
import { issueIsClosed, type PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";
import { getEnabledProject, getProjectByRepo, type ProjectConfig } from "@/db/queries";

const DEFAULT_OWNER = "camuflex-com";
const DEFAULT_REPO = "camuflex-backend";
const DEFAULT_SOURCE = "camuflex-backend";
const NAME_MAX = 255;
const KEY_MAX = 255;
const PRIORITIES = new Set(["urgent", "high", "medium", "low", "none"]);

export type IssueIngestPayload = {
  name: string;
  description: string;
  projectId?: string;
  owner: string;
  repo: string;
  priority?: string;
  resource?: string;
  externalId?: string;
  externalSource: string;
};

export type ParseResult = { ok: true; payload: IssueIngestPayload } | { ok: false; error: string };

export type IngestedIssue = {
  id: string;
  name: string;
  sequenceId: number | null;
  projectId: string;
  created: boolean;
  reopened: boolean;
};

/**
 * Clave estable del recurso que falló. Varios errores del mismo sitio
 * tienen que aterrizar en la misma issue.
 */
export function dedupeKey(payload: Pick<IssueIngestPayload, "externalId" | "resource" | "name">): string {
  const raw = payload.externalId || payload.resource || payload.name;
  return raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, KEY_MAX);
}

/**
 * Cuerpo que manda el backend. `name`/`title` es obligatorio; el resto se
 * resuelve: sin `projectId` se busca el proyecto de `camuflex-backend`.
 */
export function parseIssuePayload(raw: string): ParseResult {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "cuerpo ilegible" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "cuerpo ilegible" };
  }

  const name = asString(body.name) || asString(body.title);
  if (!name) return { ok: false, error: "falta name" };
  if (name.length > NAME_MAX) return { ok: false, error: `name supera ${NAME_MAX} caracteres` };

  const priority = asString(body.priority)?.toLowerCase();
  if (priority && !PRIORITIES.has(priority)) {
    return { ok: false, error: "priority inválida" };
  }

  return {
    ok: true,
    payload: {
      name,
      description: asString(body.description) ?? "",
      projectId: asString(body.projectId),
      owner: asString(body.owner) ?? DEFAULT_OWNER,
      repo: asString(body.repo) ?? DEFAULT_REPO,
      priority,
      resource: asString(body.resource),
      externalId: asString(body.externalId) ?? asString(body.external_id),
      externalSource: asString(body.externalSource) ?? asString(body.external_source) ?? DEFAULT_SOURCE,
    },
  };
}

export async function resolveIngestProject(db: Db, payload: IssueIngestPayload): Promise<ProjectConfig | null> {
  if (payload.projectId) return getEnabledProject(db, payload.projectId);
  return getProjectByRepo(db, payload.owner, payload.repo);
}

/**
 * Crea o reutiliza. Los errores van siempre a In Progress: hay que
 * resolverlos ya. Si el recurso ya tiene issue abierta, no se abre otra.
 */
export async function createIngestedIssue(
  plane: PlaneClient,
  config: ProjectConfig,
  payload: IssueIngestPayload
): Promise<IngestedIssue> {
  const { planeWorkspaceSlug: slug, planeProjectId: projectId } = config;
  const key = dedupeKey(payload);
  const source = payload.externalSource;

  const existing = await plane.findIssueByExternal(slug, projectId, key, source);
  if (existing) {
    if (issueIsClosed(existing)) {
      await plane.moveIssue(slug, projectId, existing.id, "in_progress");
      return toResult(existing, projectId, { created: false, reopened: true });
    }
    return toResult(existing, projectId, { created: false, reopened: false });
  }

  try {
    const issue = await plane.createIssue(slug, projectId, {
      name: payload.name,
      description: payload.description,
      priority: payload.priority,
      stateName: "In Progress",
      externalId: key,
      externalSource: source,
    });
    return toResult(issue, projectId, { created: true, reopened: false });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      const raced = await plane.findIssueByExternal(slug, projectId, key, source);
      if (raced) return toResult(raced, projectId, { created: false, reopened: false });
    }
    throw error;
  }
}

const toResult = (
  issue: { id: string; name: string; sequence_id?: number },
  projectId: string,
  flags: { created: boolean; reopened: boolean }
): IngestedIssue => ({
  id: issue.id,
  name: issue.name,
  sequenceId: issue.sequence_id ?? null,
  projectId,
  created: flags.created,
  reopened: flags.reopened,
});

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};
