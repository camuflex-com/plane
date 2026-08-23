// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import { CursorClient } from "@/clients/cursor";
import { GitHubClient, type PullRequest } from "@/clients/github";
import { PlaneClient } from "@/clients/plane";
import type { Db } from "@/db";
import {
  getActiveRunForHeadSha,
  getActiveRunForIssue,
  getActiveRunForPr,
  getEnabledProject,
  getProjectByRepo,
  createRun,
  updateRun,
  type ProjectConfig,
} from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { decide, type Action, type Event, type Run } from "@/machine";
import { enqueue, type Job } from "@/queue";

/** Cuánto esperar a que Bugbot publique su revisión, y cuántas veces. */
const VERDICT_DEFER_MS = 30_000;
const MAX_VERDICT_DEFERRALS = 12;

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
      case "github.check_completed":
        return this.onCheckCompleted(
          job.payload as {
            owner: string;
            repo: string;
            prNumber: number | null;
            headSha: string | null;
            conclusion: string;
          }
        );
      case "reconcile.stale":
        return this.onStale(job.payload as { runId: number; minutes: number });
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
        await this.cursor.sendFollowUp(action.agentId, buildFixPrompt(action.findings));
        return;

      case "merge_pr": {
        const pr = await this.github.getPullRequest(owner, repo, action.prNumber);
        assertMergeable(pr);
        await this.github.mergePullRequest(owner, repo, action.prNumber, pr.head.sha);
        logger.info("PR mergeado", { runId: run.id, prNumber: action.prNumber });
        return;
      }

      case "park":
        logger.warn("run aparcada", { runId: run.id, reason: action.reason });
        return;
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

  private async onCheckCompleted(payload: {
    owner: string;
    repo: string;
    prNumber: number | null;
    headSha: string | null;
    conclusion: string;
    deferAttempt?: number;
  }): Promise<void> {
    const deferAttempt = payload.deferAttempt ?? 0;
    const config = await getProjectByRepo(this.db, payload.owner, payload.repo);
    if (!config) return;

    // El payload de check_run a menudo no trae el PR asociado; el sha sí, y la
    // run guarda el suyo desde que se abrió el pull request.
    const run = payload.prNumber
      ? await getActiveRunForPr(this.db, config.planeProjectId, payload.prNumber)
      : await getActiveRunForHeadSha(this.db, config.planeProjectId, payload.headSha ?? "");

    if (!run?.prNumber) {
      logger.info("veredicto sin run asociada", { prNumber: payload.prNumber, headSha: payload.headSha });
      return;
    }

    // Con veredicto limpio no hace falta esperar a nada: no hay detalle que
    // recoger.
    if (payload.conclusion === "success") {
      await this.apply(run, config, {
        type: "bugbot_verdict",
        prNumber: run.prNumber,
        conclusion: "success",
        findings: [],
      });
      return;
    }

    // Con hallazgos sí: el check de Bugbot puede completar MINUTOS antes de
    // que publique su revisión. Actuar con el primero produce un "sin detalle"
    // inútil y, peor, deja la run fuera de `in_review`, de modo que el
    // veredicto de verdad llega tarde y se descarta.
    const findings = await this.collectFindings(config, run.prNumber);
    if (findings.length === 0) {
      const attempt = Number(deferAttempt) + 1;
      if (attempt <= MAX_VERDICT_DEFERRALS) {
        logger.info("veredicto sin revisión todavía, se pospone", { prNumber: run.prNumber, attempt });
        await enqueue(this.db, "github.check_completed", { ...payload, deferAttempt: attempt }, VERDICT_DEFER_MS);
        return;
      }
      logger.warn("se agotó la espera de la revisión; se sigue sin detalle", { prNumber: run.prNumber });
    }

    await this.apply(run, config, {
      type: "bugbot_verdict",
      prNumber: run.prNumber,
      conclusion: payload.conclusion as never,
      findings,
    });
  }

  /**
   * Detalle de los hallazgos: los comentarios en línea de Bugbot y, si no hay,
   * el resumen de su review.
   */
  private async collectFindings(config: ProjectConfig, prNumber: number): Promise<string[]> {
    const { githubOwner: owner, githubRepo: repo } = config;
    try {
      const comments = await this.github.listReviewComments(owner, repo, prNumber);
      const inline = comments
        .filter((c) => isBugbot(c.user?.login))
        .map((c) => `${c.path}${c.line ? `:${c.line}` : ""} — ${cleanFinding(c.body)}`);
      if (inline.length > 0) return inline;

      // Sin comentarios en línea, el resumen de la review sirve de detalle.
      const reviews = await this.github.listReviews(owner, repo, prNumber);
      const summary = reviews.findLast((r) => isBugbot(r.user?.login) && r.body?.trim());
      return summary ? [cleanFinding(summary.body)] : [];
    } catch (error) {
      // Quedarse sin el detalle no debe bloquear el ciclo: se devuelve la
      // issue igualmente y el agente puede releer el PR.
      logger.warn("no se pudieron leer los comentarios de la revisión", { prNumber, error: String(error) });
      return [];
    }
  }

  private async onStale(payload: { runId: number; minutes: number }): Promise<void> {
    const res = await this.db.query(`SELECT * FROM runs WHERE id = $1`, [payload.runId]);
    const row = res.rows[0];
    if (!row) return;
    const config = await getEnabledProject(this.db, row.plane_project_id);
    if (!config) return;

    const run: Run = {
      id: Number(row.id),
      planeIssueId: row.plane_issue_id,
      planeProjectId: row.plane_project_id,
      cursorAgentId: row.cursor_agent_id ?? null,
      prNumber: row.pr_number === null ? null : Number(row.pr_number),
      state: row.state,
      attempts: Number(row.attempts),
    };
    await this.apply(run, config, { type: "agent_stale", minutes: payload.minutes });
  }
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

/** Bugbot publica como `cursor[bot]`. */
export const isBugbot = (login: string | undefined) => /bugbot|cursor/i.test(login ?? "");

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

export { enqueue };
