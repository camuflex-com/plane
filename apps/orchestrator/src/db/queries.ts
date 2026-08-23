import type { Run, RunState } from "@/machine";
import type { Db } from "./index";

export type ProjectConfig = {
  planeProjectId: string;
  planeWorkspaceSlug: string;
  githubOwner: string;
  githubRepo: string;
  baseBranch: string;
  enabled: boolean;
  maxAttempts: number;
};

const toConfig = (r: Record<string, unknown>): ProjectConfig => ({
  planeProjectId: r.plane_project_id as string,
  planeWorkspaceSlug: r.plane_workspace_slug as string,
  githubOwner: r.github_owner as string,
  githubRepo: r.github_repo as string,
  baseBranch: r.base_branch as string,
  enabled: r.enabled as boolean,
  maxAttempts: r.max_attempts as number,
});

const toRun = (r: Record<string, unknown>): Run => ({
  id: Number(r.id),
  planeIssueId: r.plane_issue_id as string,
  planeProjectId: r.plane_project_id as string,
  cursorAgentId: (r.cursor_agent_id as string) ?? null,
  prNumber: r.pr_number === null ? null : Number(r.pr_number),
  headSha: (r.head_sha as string) ?? null,
  lastBugbotReviewId: r.last_bugbot_review_id === null || r.last_bugbot_review_id === undefined
    ? null
    : Number(r.last_bugbot_review_id),
  state: r.state as RunState,
  attempts: Number(r.attempts),
});

/** Solo los proyectos habilitados participan. Es el interruptor de seguridad. */
export async function getEnabledProject(db: Db, projectId: string): Promise<ProjectConfig | null> {
  const res = await db.query(`SELECT * FROM project_config WHERE plane_project_id = $1 AND enabled = TRUE`, [
    projectId,
  ]);
  return res.rows[0] ? toConfig(res.rows[0]) : null;
}

export async function getProjectByRepo(db: Db, owner: string, repo: string): Promise<ProjectConfig | null> {
  const res = await db.query(
    `SELECT * FROM project_config WHERE github_owner = $1 AND github_repo = $2 AND enabled = TRUE`,
    [owner, repo]
  );
  return res.rows[0] ? toConfig(res.rows[0]) : null;
}

export async function getActiveRunForIssue(db: Db, issueId: string): Promise<Run | null> {
  const res = await db.query(
    `SELECT * FROM runs WHERE plane_issue_id = $1 AND state NOT IN ('merged','parked','failed')`,
    [issueId]
  );
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

/** Respaldo cuando el payload de check_run no trae el PR asociado. */
export async function getActiveRunForHeadSha(db: Db, projectId: string, headSha: string): Promise<Run | null> {
  if (!headSha) return null;
  const res = await db.query(
    `SELECT * FROM runs
      WHERE plane_project_id = $1 AND head_sha = $2 AND state NOT IN ('merged','parked','failed')`,
    [projectId, headSha]
  );
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

export async function getActiveRunForPr(db: Db, projectId: string, prNumber: number): Promise<Run | null> {
  const res = await db.query(
    `SELECT * FROM runs
      WHERE plane_project_id = $1 AND pr_number = $2 AND state NOT IN ('merged','parked','failed')`,
    [projectId, prNumber]
  );
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

/**
 * Incluye runs aparcadas: un success de Bugbot que llega tarde (tras un
 * park prematuro o un reinicio) tiene que poder mergear.
 */
export async function getRunForBugbot(
  db: Db,
  projectId: string,
  prNumber: number | null,
  headSha: string | null
): Promise<Run | null> {
  if (prNumber) {
    const byPr = await db.query(
      `SELECT * FROM runs
        WHERE plane_project_id = $1 AND pr_number = $2 AND state NOT IN ('merged','failed')
        ORDER BY updated_at DESC LIMIT 1`,
      [projectId, prNumber]
    );
    if (byPr.rows[0]) return toRun(byPr.rows[0]);
  }
  if (headSha) {
    const bySha = await db.query(
      `SELECT * FROM runs
        WHERE plane_project_id = $1 AND head_sha = $2 AND state NOT IN ('merged','failed')
        ORDER BY updated_at DESC LIMIT 1`,
      [projectId, headSha]
    );
    if (bySha.rows[0]) return toRun(bySha.rows[0]);
  }
  return null;
}

/**
 * Crea la run. El índice único parcial hace que dos eventos simultáneos de
 * "entra a In Progress" no puedan crear dos runs para la misma issue: el
 * segundo choca y devuelve null.
 */
export async function createRun(db: Db, issueId: string, projectId: string): Promise<Run | null> {
  const res = await db.query(
    `INSERT INTO runs (plane_issue_id, plane_project_id, state)
     VALUES ($1, $2, 'queued') ON CONFLICT DO NOTHING RETURNING *`,
    [issueId, projectId]
  );
  return res.rows[0] ? toRun(res.rows[0]) : null;
}

export async function updateRun(
  db: Db,
  id: number,
  patch: {
    state?: RunState;
    cursorAgentId?: string;
    prNumber?: number;
    headSha?: string;
    lastBugbotReviewId?: number;
    incrementAttempts?: boolean;
    lastError?: string;
  }
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(`${sql} = $${values.length}`);
  };

  if (patch.state) add("state", patch.state);
  if (patch.cursorAgentId) add("cursor_agent_id", patch.cursorAgentId);
  if (patch.prNumber !== undefined) add("pr_number", patch.prNumber);
  if (patch.headSha) add("head_sha", patch.headSha);
  if (patch.lastBugbotReviewId !== undefined) add("last_bugbot_review_id", patch.lastBugbotReviewId);
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (patch.incrementAttempts) sets.push("attempts = attempts + 1");

  values.push(id);
  await db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
}

export async function findStaleRuns(db: Db, minutes: number): Promise<Run[]> {
  const res = await db.query(
    `SELECT * FROM runs
      WHERE state = 'agent_running' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(minutes)]
  );
  return res.rows.map(toRun);
}
