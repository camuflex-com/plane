import type { Env } from "@/env";
import { HttpError, requestJson } from "./http";

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
  /** Id global de GraphQL: la única vía para sacar un PR de borrador. */
  node_id: string;
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  head: { sha: string; ref: string };
};

export type OrgRepo = {
  name: string;
  owner: { login: string };
  default_branch: string;
  archived: boolean;
  disabled?: boolean;
  /** KB. 0 = repo recién creado, sin ningún commit. */
  size: number;
};

/**
 * Cliente REST de GitHub. Se usa `fetch` en vez de Octokit a propósito: solo
 * hacen falta unas pocas llamadas y no compensa arrastrar la dependencia.
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

  /** Comentarios en línea de UNA revisión: no se mezclan con reviews anteriores. */
  async listCommentsForReview(owner: string, repo: string, prNumber: number, reviewId: number) {
    return requestJson<{ user: { login: string }; body: string; path: string; line: number | null }[]>(
      this.repoUrl(owner, repo, `pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`),
      { headers: this.headers }
    );
  }

  /**
   * Saca un PR de borrador.
   *
   * La API REST no permite hacerlo; solo la mutación GraphQL. Se llama
   * únicamente cuando Bugbot dio el PR por limpio: mientras tenga hallazgos,
   * el PR se queda en borrador.
   */
  async markReadyForReview(nodeId: string): Promise<void> {
    const response = await requestJson<{ errors?: { message: string }[] }>(`${this.env.GITHUB_API_URL}/graphql`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: nodeId },
      }),
    });
    // GraphQL responde 200 aunque la mutación falle: el error viene en el cuerpo.
    if (response?.errors?.length) {
      throw new Error(`No se pudo sacar el PR de borrador: ${response.errors.map((e) => e.message).join("; ")}`);
    }
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

  /** Repos de la organización, sin paginar a mano: GitHub corta en 100. */
  async listOrgRepos(org: string): Promise<OrgRepo[]> {
    const repos: OrgRepo[] = [];
    for (let page = 1; ; page++) {
      // oxlint-disable-next-line no-await-in-loop -- cada página depende de la anterior.
      const batch = await requestJson<OrgRepo[]>(
        `${this.env.GITHUB_API_URL}/orgs/${org}/repos?type=all&per_page=100&page=${page}`,
        { headers: this.headers }
      );
      repos.push(...batch);
      if (batch.length < 100) return repos;
    }
  }

  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await requestJson(this.repoUrl(owner, repo, `branches/${encodeURIComponent(branch)}`), {
        headers: this.headers,
        retries: 0,
      });
      return true;
    } catch (error) {
      // 409 = repo vacío; 404 = la rama no existe.
      if (error instanceof HttpError && (error.status === 404 || error.status === 409)) return false;
      throw error;
    }
  }

  /**
   * Primer commit de un repo vacío. Sin él no existe la rama base y el agente
   * de Cursor no tiene desde dónde partir.
   */
  async createInitialCommit(owner: string, repo: string, branch: string): Promise<void> {
    await requestJson(this.repoUrl(owner, repo, "contents/README.md"), {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({
        message: "chore: commit inicial",
        content: Buffer.from(`# ${repo}\n`).toString("base64"),
        branch,
      }),
    });
  }

  /**
   * Borra la rama del PR. 404 = ya no está, que es el resultado que queremos.
   * No se llama con `main`/`master`: eso lo filtra el executor.
   */
  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    const encoded = branch
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    try {
      await requestJson(this.repoUrl(owner, repo, `git/refs/heads/${encoded}`), {
        method: "DELETE",
        headers: this.headers,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return;
      throw error;
    }
  }
}
