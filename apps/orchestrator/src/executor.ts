// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import { CursorClient } from "@/clients/cursor";
import { GitHubClient, type PullRequest } from "@/clients/github";
import { HttpError } from "@/clients/http";
import { PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";
import {
  getEnabledProject,
  getProjectByRepo,
  getActiveRunForIssue,
  getActiveRunForPr,
  getRunForBugbot,
  createRun,
  updateRun,
  type ProjectConfig,
} from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { decide, type Action, type Event, type Run } from "@/machine";
import type { Job } from "@/queue";

export class Executor {
  readonly plane: PlaneClient;
  readonly cursor: CursorClient;
  readonly github: GitHubClient;

  constructor(
    private readonly db: Db,
    private readonly env: Env
  ) {
    this.plane = new PlaneClient(env);
    this.cursor = new CursorClient(env);
    this.github = new GitHubClient(env);
  }

  handle = async (job: Job): Promise<void> => {
    switch (job.kind) {
      case "plane.issue_in_progress":
        return this.onIssueInProgress(job.payload as { issueId: string; projectId: string });
      case "github.pr_opened":
        return this.onPrOpened(
          job.payload as { owner: string; repo: string; prNumber: number; headSha: string; branch: string }
        );
      case "github.bugbot_review":
        return this.onBugbotReview(
          job.payload as {
            owner: string;
            repo: string;
            prNumber: number;
            headSha: string | null;
            reviewId: number;
            state: string;
            body: string;
          }
        );
      case "github.bugbot_check_success":
        return this.onBugbotCheckSuccess(
          job.payload as {
            owner: string;
            repo: string;
            prNumber: number | null;
            headSha: string | null;
          }
        );
      case "github.pr_synchronized":
        return this.onPrSynchronized(job.payload as { owner: string; repo: string; prNumber: number; headSha: string });
      case "reconcile.stale":
        return this.onStale(job.payload as { runId: number; minutes: number });
      case "reconcile.bugbot":
        // Jobs encolados por el sondeo viejo: ya no se aplican. El veredicto
        // llega por webhook; rehacerlo desde GitHub reaplicaba reviews viejas.
        logger.info("reconcile de Bugbot desactivado, se espera el webhook", { runId: (job.payload as { runId?: number }).runId });
        return;
      default:
        logger.warn("tipo de trabajo desconocido", { kind: job.kind });
    }
  };

  /** Aplica una decisión: primero el estado, después los efectos. */
  private async apply(run: Run | null, config: ProjectConfig, event: Event): Promise<void> {
    const decision = decide(run, event, config.maxAttempts);

    if (decision.ignoredBecause) {
      logger.info("evento ignorado", { event: event.type, reason: decision.ignoredBecause });
      return;
    }

    // La run puede no existir todavía: la crea el manejador de arranque.
    let current = run;
    if (!current && event.type === "issue_entered_in_progress") {
      current = await createRun(this.db, event.issueId, event.projectId);
      if (!current) {
        logger.info("otra entrega creó la run primero", { issueId: event.issueId });
        return;
      }
    }
    if (!current) return;

    if (decision.nextState || decision.incrementAttempts) {
      await updateRun(this.db, current.id, {
        ...(decision.nextState ? { state: decision.nextState } : {}),
        ...(decision.incrementAttempts ? { incrementAttempts: true } : {}),
      });
    }

    for (const action of decision.actions) {
      await this.perform(action, current, config);
    }
  }

  private async perform(action: Action, run: Run, config: ProjectConfig): Promise<void> {
    const { planeWorkspaceSlug: slug, githubOwner: owner, githubRepo: repo } = config;

    switch (action.type) {
      case "start_agent": {
        const issue = await this.plane.getIssue(slug, config.planeProjectId, action.issueId);
        const agent = await this.cursor.createAgent({
          prompt: buildPrompt(issue.name, issue.description_stripped, config.baseBranch),
          repoUrl: `https://github.com/${owner}/${repo}`,
          baseBranch: config.baseBranch,
          name: `plane-${issue.name.slice(0, 60)}`,
        });
        await updateRun(this.db, run.id, { cursorAgentId: agent.id });
        logger.info("agente lanzado", { runId: run.id, agentId: agent.id, cursorUrl: agent.url });
        return;
      }

      case "move_issue":
        await this.plane.moveIssue(slug, config.planeProjectId, action.issueId, action.to);
        return;

      case "comment_issue":
        await this.plane.comment(slug, config.planeProjectId, action.issueId, action.body);
        return;

      case "request_bugbot":
        await this.github.requestBugbotReview(owner, repo, action.prNumber);
        return;

      case "send_followup":
        await this.sendFollowUp(action.agentId, action.findings);
        return;

      case "merge_pr": {
        const pr = await this.github.getPullRequest(owner, repo, action.prNumber);
        if (pr.merged) {
          logger.info("PR ya estaba mergeado", { runId: run.id, prNumber: action.prNumber });
        } else {
          assertMergeable(pr);
          await this.github.mergePullRequest(owner, repo, action.prNumber, pr.head.sha);
          logger.info("PR mergeado", { runId: run.id, prNumber: action.prNumber });
        }
        await this.deleteMergedBranch(owner, repo, pr.head.ref, config.baseBranch);
        return;
      }

      case "park":
        logger.warn("run aparcada", { runId: run.id, reason: action.reason });
        return;
    }
  }

  /**
   * Tras mergear a main la rama del agente ya no sirve. No se toca la rama
   * base ni main/master aunque GitHub devolviera un ref raro.
   */
  private async deleteMergedBranch(owner: string, repo: string, branch: string, baseBranch: string): Promise<void> {
    const protectedBranches = new Set(["main", "master", baseBranch, ""]);
    if (protectedBranches.has(branch)) {
      logger.warn("no se borra la rama base tras el merge", { owner, repo, branch });
      return;
    }
    try {
      await this.github.deleteBranch(owner, repo, branch);
      logger.info("rama eliminada", { owner, repo, branch });
    } catch (error) {
      // El merge ya ocurrió: fallar aquí dejaría el job reintentando contra
      // un PR cerrado y la issue sin pasar a Done.
      logger.warn("no se pudo borrar la rama", { owner, repo, branch, error: String(error) });
    }
  }

  private async onIssueInProgress(payload: { issueId: string; projectId: string }): Promise<void> {
    const config = await getEnabledProject(this.db, payload.projectId);
    if (!config) {
      logger.info("proyecto no habilitado, se ignora", { projectId: payload.projectId });
      return;
    }
    const run = await getActiveRunForIssue(this.db, payload.issueId);
    await this.apply(run, config, {
      type: "issue_entered_in_progress",
      issueId: payload.issueId,
      projectId: payload.projectId,
    });
  }

  private async onPrOpened(payload: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    branch: string;
  }): Promise<void> {
    const config = await getProjectByRepo(this.db, payload.owner, payload.repo);
    if (!config) return;

    // Se busca la run que espera PR y todavía no tiene uno asignado.
    const res = await this.db.query(
      `SELECT * FROM runs WHERE plane_project_id = $1 AND state = 'agent_running' AND pr_number IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [config.planeProjectId]
    );
    const row = res.rows[0];
    if (!row) {
      logger.info("PR sin run esperando", { prNumber: payload.prNumber });
      return;
    }

    const run: Run = {
      id: Number(row.id),
      planeIssueId: row.plane_issue_id,
      planeProjectId: row.plane_project_id,
      cursorAgentId: row.cursor_agent_id ?? null,
      prNumber: null,
      headSha: payload.headSha,
      lastBugbotReviewId: null,
      state: "agent_running",
      attempts: Number(row.attempts),
    };

    await updateRun(this.db, run.id, { prNumber: payload.prNumber, headSha: payload.headSha });
    await this.apply(run, config, {
      type: "pr_opened",
      prNumber: payload.prNumber,
      headSha: payload.headSha,
      agentId: run.cursorAgentId,
    });
  }

  private async onPrSynchronized(payload: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  }): Promise<void> {
    const config = await getProjectByRepo(this.db, payload.owner, payload.repo);
    if (!config) return;

    const run = await getActiveRunForPr(this.db, config.planeProjectId, payload.prNumber);
    if (!run) {
      logger.info("sync sin run asociada", { prNumber: payload.prNumber });
      return;
    }

    await updateRun(this.db, run.id, { headSha: payload.headSha });
    await this.apply(run, config, {
      type: "pr_synchronized",
      prNumber: payload.prNumber,
      headSha: payload.headSha,
    });
  }

  private async onBugbotReview(payload: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string | null;
    reviewId: number;
    state: string;
    body: string;
  }): Promise<void> {
    const config = await getProjectByRepo(this.db, payload.owner, payload.repo);
    if (!config) return;

    const run = await getRunForBugbot(this.db, config.planeProjectId, payload.prNumber, payload.headSha);
    if (!run?.prNumber) {
      logger.info("revisión de Bugbot sin run asociada", { prNumber: payload.prNumber });
      return;
    }

    if (payload.reviewId > 0 && run.lastBugbotReviewId === payload.reviewId) {
      logger.info("revisión de Bugbot ya aplicada", { prNumber: payload.prNumber, reviewId: payload.reviewId });
      return;
    }

    // Review de un commit que ya no es HEAD: el agente empujó y esta opinión
    // es de la versión anterior. Aplicarla reabriría un ciclo ya cerrado.
    if (payload.headSha && run.headSha && payload.headSha !== run.headSha) {
      logger.info("revisión de Bugbot de un commit anterior, se ignora", {
        prNumber: payload.prNumber,
        reviewId: payload.reviewId,
        reviewSha: payload.headSha,
        runSha: run.headSha,
      });
      return;
    }

    if (payload.headSha) {
      await updateRun(this.db, run.id, { headSha: payload.headSha });
    }

    const findings =
      payload.reviewId > 0 ? await this.collectFindingsForReview(config, payload.prNumber, payload.reviewId) : [];
    const interpreted = interpretBugbotReview({
      state: payload.state,
      body: payload.body,
      findings,
    });

    if (interpreted.kind === "ignore") {
      logger.info("revisión de Bugbot sin veredicto, se espera", {
        prNumber: payload.prNumber,
        reviewId: payload.reviewId,
        state: payload.state,
      });
      return;
    }

    logger.info("veredicto de Bugbot", {
      prNumber: payload.prNumber,
      reviewId: payload.reviewId,
      kind: interpreted.kind,
      findings: interpreted.findings.length,
    });

    await this.apply(run, config, {
      type: "bugbot_verdict",
      prNumber: run.prNumber,
      conclusion: interpreted.kind === "success" ? "success" : "neutral",
      findings: interpreted.findings,
    });

    if (payload.reviewId > 0) {
      await updateRun(this.db, run.id, { lastBugbotReviewId: payload.reviewId });
    }
  }

  /** Check de Bugbot en verde: no hay review de GitHub, pero sí "no encontró bugs". */
  private async onBugbotCheckSuccess(payload: {
    owner: string;
    repo: string;
    prNumber: number | null;
    headSha: string | null;
  }): Promise<void> {
    const config = await getProjectByRepo(this.db, payload.owner, payload.repo);
    if (!config) return;

    const run = await getRunForBugbot(this.db, config.planeProjectId, payload.prNumber, payload.headSha);
    if (!run?.prNumber) {
      logger.info("check de Bugbot en verde sin run asociada", {
        prNumber: payload.prNumber,
        headSha: payload.headSha,
      });
      return;
    }

    if (payload.headSha && run.headSha && payload.headSha !== run.headSha) {
      logger.info("check de Bugbot de un commit anterior, se ignora", {
        prNumber: run.prNumber,
        checkSha: payload.headSha,
        runSha: run.headSha,
      });
      return;
    }

    if (payload.headSha) {
      await updateRun(this.db, run.id, { headSha: payload.headSha });
    }

    logger.info("veredicto de Bugbot", { prNumber: run.prNumber, kind: "success", source: "check" });
    await this.apply(run, config, {
      type: "bugbot_verdict",
      prNumber: run.prNumber,
      conclusion: "success",
      findings: [],
    });
  }

  /**
   * Un 409 `agent_busy` no es un fallo del ciclo: el agente ya está
   * trabajando (el follow-up anterior o el push en curso). Reintentar el job
   * volvería a incrementar intentos.
   */
  private async sendFollowUp(agentId: string, findings: string[]): Promise<void> {
    try {
      await this.cursor.sendFollowUp(agentId, buildFixPrompt(findings));
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        logger.info("agente ocupado, se espera el push", { agentId });
        return;
      }
      throw error;
    }
  }

  /** Comentarios en línea de esta revisión, no de las anteriores del mismo PR. */
  private async collectFindingsForReview(config: ProjectConfig, prNumber: number, reviewId: number): Promise<string[]> {
    const { githubOwner: owner, githubRepo: repo } = config;
    try {
      const comments = await this.github.listCommentsForReview(owner, repo, prNumber, reviewId);
      return comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""} — ${cleanFinding(c.body)}`);
    } catch (error) {
      logger.warn("no se pudieron leer los comentarios de la revisión", {
        prNumber,
        reviewId,
        error: String(error),
      });
      return [];
    }
  }

  private async onStale(payload: { runId: number; minutes: number }): Promise<void> {
    const res = await this.db.query(`SELECT * FROM runs WHERE id = $1`, [payload.runId]);
    const row = res.rows[0];
    if (!row) return;
    const config = await getEnabledProject(this.db, row.plane_project_id);
    if (!config) return;

    const run = runFromRow(row);
    await this.apply(run, config, { type: "agent_stale", minutes: payload.minutes });
  }
}

function runFromRow(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    planeIssueId: row.plane_issue_id as string,
    planeProjectId: row.plane_project_id as string,
    cursorAgentId: (row.cursor_agent_id as string) ?? null,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    headSha: (row.head_sha as string) ?? null,
    lastBugbotReviewId:
      row.last_bugbot_review_id === null || row.last_bugbot_review_id === undefined
        ? null
        : Number(row.last_bugbot_review_id),
    state: row.state as Run["state"],
    attempts: Number(row.attempts),
  };
}

/**
 * Mergear con CI en rojo sería un fallo, no una función: Bugbot en verde dice
 * que no encontró bugs, no que el resto de la suite pase.
 *
 * Lanzar en vez de devolver false es intencionado: el job reintenta con
 * backoff, que es justo lo que hace falta cuando GitHub todavía está
 * calculando el merge (`mergeable === null`) o cuando la rama está detrás.
 */
export function assertMergeable(pr: PullRequest): void {
  if (pr.merged) {
    throw new Error(`El PR #${pr.number} ya está mergeado`);
  }
  if (pr.mergeable === null || pr.mergeable_state === "unknown") {
    throw new Error(`GitHub aún calcula si el PR #${pr.number} es mergeable; se reintenta`);
  }
  if (pr.mergeable_state !== "clean") {
    throw new Error(
      `No se mergea el PR #${pr.number}: mergeable_state = "${pr.mergeable_state}" ` +
        `(solo "clean" garantiza sin conflictos y con los checks requeridos en verde)`
    );
  }
}

/** Check de CI de Bugbot (`Cursor Bugbot`). No se usa `/cursor/` a secas:
 *  el agente publica checks propios que no son una revisión. */
export const isBugbotCheck = (name: string | undefined) => /bugbot/i.test(name ?? "");

/** Bugbot publica reviews como `cursor[bot]`. */
export const isBugbot = (login: string | undefined) =>
  /bugbot/i.test(login ?? "") || /^cursor\[bot\]$/i.test(login ?? "");

export type BugbotReviewKind = "success" | "findings" | "ignore";

/**
 * Interpreta la revisión enviada por Bugbot. No se usa el check de CI: ese
 * completa antes de que existan comentarios, y un `neutral` no significa
 * "encontró bugs".
 *
 * - APPROVED, o "found 0 potential issues" → merge
 * - CHANGES_REQUESTED, comentarios en línea, o "found N>0" → corregir
 * - Cualquier otra cosa (review incompleta) → ignorar y esperar el evento real
 */
export function interpretBugbotReview(input: { state: string; body: string; findings: string[] }): {
  kind: BugbotReviewKind;
  findings: string[];
} {
  const state = input.state.trim().toUpperCase();
  if (state === "DISMISSED" || state === "PENDING") {
    return { kind: "ignore", findings: [] };
  }
  if (state === "APPROVED") {
    return { kind: "success", findings: [] };
  }

  const count = parseFoundCount(input.body);
  const findings =
    input.findings.length > 0 ? input.findings : count && count > 0 ? [cleanFinding(input.body)].filter(Boolean) : [];

  if (state === "CHANGES_REQUESTED") {
    return { kind: "findings", findings };
  }

  if (count === 0) return { kind: "success", findings: [] };
  if (findings.length > 0) return { kind: "findings", findings };
  return { kind: "ignore", findings: [] };
}

/** Extrae el "found N potential issues" del resumen de Bugbot. */
export function parseFoundCount(body: string): number | null {
  const match = body.match(/found\s+(\d+)\s+potential issues/i);
  return match ? Number(match[1]) : null;
}

/** Quita el marcado de Bugbot y deja una línea legible. */
export function cleanFinding(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("<!--")) ?? "";
  return firstLine.replace(/^#+\s*/, "").slice(0, 300);
}

function buildPrompt(title: string, description: string | null, baseBranch: string): string {
  return [
    `Implementa la siguiente tarea y abre un pull request contra \`${baseBranch}\`.`,
    "",
    `# ${title}`,
    "",
    description?.trim() || "(La issue no trae descripción; guíate por el título.)",
    "",
    "Cíñete al alcance descrito. No hagas refactors ni cambios de formato no relacionados.",
  ].join("\n");
}

function buildFixPrompt(findings: string[]): string {
  const list = findings.length
    ? findings.map((f) => `- ${f}`).join("\n")
    : "- Revisa los comentarios de la revisión automática en el pull request.";
  return [
    "La revisión automática encontró problemas en tu pull request. Corrígelos y empuja a la misma rama:",
    "",
    list,
    "",
    "No abras un pull request nuevo.",
  ].join("\n");
}
