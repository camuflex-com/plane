// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import { sleep } from "@/clients/http";
import type { Db } from "@/db";
import { findSilentReviews, findStaleRuns, findUnreviewedHeads } from "@/db/queries";
import type { Env } from "@/env";
import { logger } from "@/logger";
import { enqueue } from "@/queue";

/**
 * Red de seguridad para lo que los webhooks no cubren.
 *
 * Agentes que mueren sin abrir PR (la v1 de Cursor no emite webhooks) y HEADs
 * en revisión para los que nunca se pidió "bugbot run".
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

  // Un HEAD en revisión sin "bugbot run" no recibirá veredicto nunca. El job
  // comprueba el PR antes de comentar, así que repetirlo no duplica nada.
  for (const head of await findUnreviewedHeads(db, UNREVIEWED_QUIET_MINUTES)) {
    logger.warn("HEAD en revisión sin pedir a Bugbot, se pide", { runId: head.runId, prNumber: head.prNumber });
    await enqueue(db, "github.ensure_bugbot", {
      owner: head.owner,
      repo: head.repo,
      prNumber: head.prNumber,
      headSha: head.headSha,
    });
  }

  // Bugbot revisó pero el veredicto no se aplicó: se pide otra vez, con tope.
  for (const silent of await findSilentReviews(db, SILENT_REVIEW_MINUTES)) {
    if (silent.rerequests >= MAX_BUGBOT_REREQUESTS) {
      logger.warn("Bugbot sin veredicto tras repetir, se aparca", { runId: silent.runId, prNumber: silent.prNumber });
      await enqueue(db, "reconcile.bugbot_silent", { runId: silent.runId });
      continue;
    }
    logger.warn("revisión sin veredicto aplicado, se repite bugbot run", {
      runId: silent.runId,
      prNumber: silent.prNumber,
      rerequests: silent.rerequests,
    });
    await enqueue(db, "github.ensure_bugbot", {
      owner: silent.owner,
      repo: silent.repo,
      prNumber: silent.prNumber,
      headSha: silent.headSha,
      force: true,
    });
  }
}

/** Margen para que el job programado tras el sync actúe antes que el barrido. */
const UNREVIEWED_QUIET_MINUTES = 10;
/** Bugbot tarda unos 5 minutos; 20 sin veredicto aplicado es que se perdió. */
const SILENT_REVIEW_MINUTES = 20;
/** Repeticiones de "bugbot run" sobre el mismo commit antes de aparcar. */
export const MAX_BUGBOT_REREQUESTS = 2;
