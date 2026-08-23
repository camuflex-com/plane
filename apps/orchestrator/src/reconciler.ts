// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import type { Db } from "@/db";
import { findStaleRuns } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { enqueue } from "@/queue";
import { sleep } from "@/clients/http";

/**
 * Red de seguridad para lo que los webhooks no cubren.
 *
 * Si un agente de Cursor muere sin abrir PR, nadie nos avisa: la v1 no emite
 * webhooks y GitHub no tiene nada que contar. Sin este barrido, esas runs se
 * quedarían en `agent_running` para siempre y la issue bloqueada.
 */
export async function runReconciler(db: Db, env: Env, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(env.RECONCILE_INTERVAL_MS);
    if (signal.aborted) return;

    try {
      const stale = await findStaleRuns(db, env.AGENT_STALE_MINUTES);
      for (const run of stale) {
        logger.warn("run sin PR, se marca para aparcar", { runId: run.id });
        await enqueue(db, "reconcile.stale", { runId: run.id, minutes: env.AGENT_STALE_MINUTES });
      }
    } catch (error) {
      logger.error("fallo en el barrido", { error: String(error) });
    }
  }
}
