// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import { sleep } from "@/clients/http";
import type { Db } from "@/db";
import { findStaleRuns } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { enqueue } from "@/queue";

/**
 * Red de seguridad para lo que los webhooks no cubren.
 *
 * Solo agentes que mueren sin abrir PR: la v1 de Cursor no emite webhooks.
 * El veredicto de Bugbot NO se sondea. GitHub ya lo manda por
 * `pull_request_review` y `check_run`; volver a leer el PR reaplicaba reviews
 * viejas, quemaba intentos y cortaba ciclos que seguían vivos.
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
}
