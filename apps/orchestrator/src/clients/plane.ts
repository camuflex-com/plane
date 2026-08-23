import type { Env } from "@/env";
import { HttpError, requestJson } from "./http";

type State = { id: string; name: string; group: string };
type IssueState = string | { id?: string; name?: string; group?: string };
export type Issue = {
  id: string;
  name: string;
  description_stripped: string | null;
  state: IssueState;
  sequence_id?: number;
};

export type CreateIssueInput = {
  name: string;
  description?: string;
  priority?: string;
  stateName?: string;
  externalId?: string;
  externalSource?: string;
};

/** Nombres de los estados que maneja el ciclo. Deben existir en el proyecto. */
export const STATE_NAMES = {
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
} as const;

export type TargetState = keyof typeof STATE_NAMES;

export class PlaneClient {
  constructor(private readonly env: Env) {}

  private get headers() {
    return { "X-API-Key": this.env.PLANE_API_KEY, "Content-Type": "application/json" };
  }

  private url(slug: string, path: string) {
    return `${this.env.PLANE_BASE_URL}/api/v1/workspaces/${slug}/${path}`;
  }

  async getIssue(slug: string, projectId: string, issueId: string): Promise<Issue> {
    return requestJson<Issue>(this.url(slug, `projects/${projectId}/work-items/${issueId}/`), {
      headers: this.headers,
    });
  }

  /**
   * Busca por (external_id, external_source). Es la guarda anti-duplicados
   * del ingest: el mismo recurso no debe abrir otra issue.
   */
  async findIssueByExternal(
    slug: string,
    projectId: string,
    externalId: string,
    externalSource: string
  ): Promise<Issue | null> {
    const query = new URLSearchParams({
      external_id: externalId,
      external_source: externalSource,
      expand: "state",
    });
    try {
      return await requestJson<Issue>(this.url(slug, `projects/${projectId}/work-items/?${query.toString()}`), {
        headers: this.headers,
        retries: 0,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Los estados se resuelven por nombre porque los ids son por proyecto. Si el
   * proyecto no tiene el estado esperado, es mejor fallar aquí con un mensaje
   * claro que dejar la issue en un limbo silencioso.
   */
  async resolveStateId(slug: string, projectId: string, target: TargetState): Promise<string> {
    return this.resolveStateByName(slug, projectId, STATE_NAMES[target]);
  }

  async resolveStateByName(slug: string, projectId: string, wanted: string): Promise<string> {
    const page = await requestJson<{ results: State[] }>(this.url(slug, `projects/${projectId}/states/`), {
      headers: this.headers,
    });
    const match = page.results.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase());
    if (!match) {
      throw new Error(`El proyecto ${projectId} no tiene un estado llamado "${wanted}"`);
    }
    return match.id;
  }

  async moveIssue(slug: string, projectId: string, issueId: string, target: TargetState): Promise<void> {
    const stateId = await this.resolveStateId(slug, projectId, target);
    await requestJson(this.url(slug, `projects/${projectId}/work-items/${issueId}/`), {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify({ state: stateId }),
    });
  }

  async comment(slug: string, projectId: string, issueId: string, markdown: string): Promise<void> {
    await requestJson(this.url(slug, `projects/${projectId}/work-items/${issueId}/comments/`), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ comment_html: toHtml(markdown) }),
    });
  }

  /**
   * Crea la issue a nombre del bot: el token es `PLANE_API_KEY`, así que Plane
   * atribuye la autoría a esa cuenta.
   */
  async createIssue(slug: string, projectId: string, input: CreateIssueInput): Promise<Issue> {
    const body: Record<string, unknown> = {
      name: input.name,
      description_html: toHtml(input.description ?? "") || "<p></p>",
    };
    if (input.priority) body.priority = input.priority;
    if (input.externalId) {
      body.external_id = input.externalId;
      body.external_source = input.externalSource ?? "camuflex-backend";
    }
    if (input.stateName) {
      body.state = await this.resolveStateByName(slug, projectId, input.stateName);
    }

    return requestJson<Issue>(this.url(slug, `projects/${projectId}/work-items/`), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }
}

/** Estados terminales de Plane: reabrir esos sí; el resto ya está en curso. */
export function issueIsClosed(issue: Issue): boolean {
  const group = typeof issue.state === "object" ? (issue.state.group ?? "") : "";
  const name = typeof issue.state === "object" ? (issue.state.name ?? "") : "";
  const label = `${group} ${name}`.toLowerCase();
  return /completed|cancelled|canceled|done/.test(label);
}

/** Conversión mínima: Plane espera HTML y solo generamos párrafos y listas. */
function toHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("- ")) return `<li>${escapeHtml(trimmed.slice(2))}</li>`;
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join("");
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
