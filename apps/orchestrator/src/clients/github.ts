import type { Env } from "@/env";
import { requestJson } from "./http";

/**
 * `mergeable_state` resume en un campo lo que antes consultábamos con la API
 * de checks: `clean` significa sin conflictos y con todos los checks
 * requeridos en verde. Usarlo evita pedir el permiso "Checks" del token.
 *
 * `mergeable` llega como null mientras GitHub calcula el merge; en ese caso
 * hay que reintentar, no asumir nada.
 */
export type MergeableState = "clean" | "blocked" | "unstable" | "dirty" | "behind" | "draft" | "unknown";

export type PullRequest = {
  number: number;
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  head: { sha: string; ref: string };
};

/**
 * Cliente REST de GitHub. Se usa `fetch` en vez de Octokit a propósito: solo
 * hacen falta cinco llamadas y no compensa arrastrar la dependencia.
 */
export class GitHubClient {
  constructor(private readonly env: Env) {}

  private get headers() {
    return {
      Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private repoUrl(owner: string, repo: string, path: string) {
    return `${this.env.GITHUB_API_URL}/repos/${owner}/${repo}/${path}`;
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    return requestJson<PullRequest>(this.repoUrl(owner, repo, `pulls/${prNumber}`), {
      headers: this.headers,
    });
  }

  /** Dispara Bugbot. Es su interfaz pública y no requiere plan Enterprise. */
  async requestBugbotReview(owner: string, repo: string, prNumber: number): Promise<void> {
    await this.commentOnPullRequest(owner, repo, prNumber, "bugbot run");
  }

  async commentOnPullRequest(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    await requestJson(this.repoUrl(owner, repo, `issues/${prNumber}/comments`), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ body }),
    });
  }

  /** Comentarios en línea del PR: de ahí sale el detalle de los hallazgos. */
  async listReviewComments(owner: string, repo: string, prNumber: number) {
    return requestJson<{ user: { login: string }; body: string; path: string; line: number | null }[]>(
      this.repoUrl(owner, repo, `pulls/${prNumber}/comments?per_page=100`),
      { headers: this.headers }
    );
  }

  async mergePullRequest(owner: string, repo: string, prNumber: number, sha: string): Promise<void> {
    // Se manda `sha`: si alguien empujó al PR entre la revisión y el merge,
    // GitHub devuelve 409 y no se mergea código que Bugbot nunca vio.
    await requestJson(this.repoUrl(owner, repo, `pulls/${prNumber}/merge`), {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ merge_method: "squash", sha }),
    });
  }
}
