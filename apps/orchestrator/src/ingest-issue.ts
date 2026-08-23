import type { PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";
import { getEnabledProject, getProjectByRepo, type ProjectConfig } from "@/db/queries";

const DEFAULT_OWNER = "camuflex-com";
const DEFAULT_REPO = "camuflex-backend";
const NAME_MAX = 255;
const PRIORITIES = new Set(["urgent", "high", "medium", "low", "none"]);

export type IssueIngestPayload = {
  name: string;
  description: string;
  projectId?: string;
  owner: string;
  repo: string;
  priority?: string;
  state?: string;
  externalId?: string;
  externalSource?: string;
};

export type ParseResult = { ok: true; payload: IssueIngestPayload } | { ok: false; error: string };

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
      state: asString(body.state),
      externalId: asString(body.externalId) ?? asString(body.external_id),
      externalSource: asString(body.externalSource) ?? asString(body.external_source),
    },
  };
}

export async function resolveIngestProject(db: Db, payload: IssueIngestPayload): Promise<ProjectConfig | null> {
  if (payload.projectId) return getEnabledProject(db, payload.projectId);
  return getProjectByRepo(db, payload.owner, payload.repo);
}

export async function createIngestedIssue(
  plane: PlaneClient,
  config: ProjectConfig,
  payload: IssueIngestPayload
): Promise<{ id: string; name: string; sequenceId: number | null; projectId: string }> {
  const issue = await plane.createIssue(config.planeWorkspaceSlug, config.planeProjectId, {
    name: payload.name,
    description: payload.description,
    priority: payload.priority,
    stateName: payload.state,
    externalId: payload.externalId,
    externalSource: payload.externalSource,
  });
  return {
    id: issue.id,
    name: issue.name,
    sequenceId: issue.sequence_id ?? null,
    projectId: config.planeProjectId,
  };
}

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};
