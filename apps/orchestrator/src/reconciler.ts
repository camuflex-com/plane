// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import type { Db } from "@/db";
import { findRunsAwaitingBugbot, findStaleRuns } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { enqueue } from "@/queue";
import { sleep } from "@/clients/http";

/**
 * Red de seguridad para lo que los webhooks no cubren.
 *
 * - Agente que muere sin abrir PR (la v1 de Cursor no emite webhooks).
 * - Veredicto de Bugbot perdido por un reinicio: el check ya está en verde y
 *   GitHub no reenvía el webhook.
 */
export async function runReconciler(db: Db, env: Env, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileOnce(db, env);
    } catch (error) {
      logger.error("fallo en el barrido", { error: String(error) });
    }
    await sleep(env.RECONCILE_INTERVAL_MS);
    if (signal.aborted) return;
  }
}

async function reconcileOnce(db: Db, env: Env): Promise<void> {
  const stale = await findStaleRuns(db, env.AGENT_STALE_MINUTES);
  for (const run of stale) {
    logger.warn("run sin PR, se marca para aparcar", { runId: run.id });
    await enqueue(db, "reconcile.stale", { runId: run.id, minutes: env.AGENT_STALE_MINUTES });
  }

  const waiting = await findRunsAwaitingBugbot(db);
  for (const run of waiting) {
    logger.info("run esperando a Bugbot, se reconcilia", { runId: run.id, prNumber: run.prNumber });
    await enqueue(db, "reconcile.bugbot", { runId: run.id });
  }
}
