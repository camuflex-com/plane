import { Router, type Request, type Response } from "express";
import { CursorClient } from "@/clients/cursor";
import { requestJson } from "@/clients/http";
import type { Db } from "@/db";
import { getEnabledProject } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";

type RunRow = {
  id: string;
  plane_issue_id: string;
  cursor_agent_id: string | null;
  pr_number: number | null;
  head_sha: string | null;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Autorización delegada a Plane.
 *
 * El navegador está en el mismo origen, así que manda su cookie de sesión sin
 * hacer nada. En vez de reimplementar los permisos, se reenvía esa cookie a
 * Plane: si Plane deja ver el proyecto, nosotros también. Así no hay una
 * segunda fuente de verdad sobre quién puede ver qué.
 */
async function canSeeProject(env: Env, cookie: string, slug: string, projectId: string): Promise<boolean> {
  if (!cookie) return false;
  try {
    await requestJson(`${env.PLANE_BASE_URL}/api/workspaces/${slug}/projects/${projectId}/members/`, {
      headers: { Cookie: cookie },
      retries: 0,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Envuelve un handler async para que sus errores lleguen a Express.
 *
 * Express 4 no captura promesas rechazadas: sin esto, un fallo de base sería
 * un `unhandledRejection` y la petición quedaría colgada sin responder.
 */
const wrap = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  handler(req, res).catch((error: unknown) => {
    logger.error("fallo en el API de lectura", { path: req.path, error: String(error) });
    if (!res.headersSent) res.status(500).json({ error: "error interno" });
  });
};

export function createApiRouter(db: Db, env: Env): Router {
  const api = Router();
  const cursor = new CursorClient(env);

  api.get(
    "/projects/:projectId/runs",
    wrap(async (req: Request, res: Response) => {
      const { projectId } = req.params;

      const config = await getEnabledProject(db, projectId);
      if (!config) {
        // Un proyecto sin automatización no es un error: simplemente no tiene
        // nada que mostrar.
        res.json({ enabled: false, runs: [] });
        return;
      }

      if (!(await canSeeProject(env, req.header("cookie") ?? "", config.planeWorkspaceSlug, projectId))) {
        res.status(403).json({ error: "sin acceso a este proyecto" });
        return;
      }

      const result = await db.query<RunRow>(
        `SELECT id, plane_issue_id, cursor_agent_id, pr_number, head_sha, state, attempts,
              last_error, created_at, updated_at
         FROM runs WHERE plane_project_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [projectId]
      );

      res.json({
        enabled: true,
        repo: `${config.githubOwner}/${config.githubRepo}`,
        maxAttempts: config.maxAttempts,
        runs: result.rows.map((r) => ({
          id: String(r.id),
          issueId: r.plane_issue_id,
          state: r.state,
          attempts: r.attempts,
          lastError: r.last_error,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          agentUrl: r.cursor_agent_id ? `https://cursor.com/agents/${r.cursor_agent_id}` : null,
          prUrl: r.pr_number
            ? `https://github.com/${config.githubOwner}/${config.githubRepo}/pull/${r.pr_number}`
            : null,
          prNumber: r.pr_number,
        })),
      });
    })
  );

  /** Detalle con el razonamiento del agente, traído de Cursor en el momento. */
  api.get(
    "/projects/:projectId/runs/:runId",
    wrap(async (req: Request, res: Response) => {
      const { projectId, runId } = req.params;

      const config = await getEnabledProject(db, projectId);
      if (!config) {
        res.status(404).json({ error: "proyecto sin automatización" });
        return;
      }
      if (!(await canSeeProject(env, req.header("cookie") ?? "", config.planeWorkspaceSlug, projectId))) {
        res.status(403).json({ error: "sin acceso a este proyecto" });
        return;
      }

      const result = await db.query<RunRow>(`SELECT * FROM runs WHERE id = $1 AND plane_project_id = $2`, [
        runId,
        projectId,
      ]);
      const row = result.rows[0];
      if (!row) {
        res.status(404).json({ error: "run no encontrada" });
        return;
      }

      // El razonamiento vive en Cursor, no aquí. Se consulta al abrir el detalle
      // en vez de replicarlo: así no hay copia que se quede desactualizada.
      let agent: { status?: string; result?: string; durationMs?: number } | null = null;
      if (row.cursor_agent_id) {
        try {
          const detail = await cursor.getAgent(row.cursor_agent_id);
          agent = { status: detail.status };
          if (detail.latestRunId) {
            const run = await cursor.getRun(row.cursor_agent_id, detail.latestRunId);
            agent = { status: run.status ?? detail.status, result: run.result, durationMs: run.durationMs };
          }
        } catch (error) {
          logger.warn("no se pudo leer el agente en Cursor", { agentId: row.cursor_agent_id, error: String(error) });
        }
      }

      res.json({
        id: String(row.id),
        issueId: row.plane_issue_id,
        state: row.state,
        attempts: row.attempts,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        agentUrl: row.cursor_agent_id ? `https://cursor.com/agents/${row.cursor_agent_id}` : null,
        prUrl: row.pr_number
          ? `https://github.com/${config.githubOwner}/${config.githubRepo}/pull/${row.pr_number}`
          : null,
        agent,
      });
    })
  );

  return api;
}
