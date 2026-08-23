// oxlint-disable no-await-in-loop -- la secuencialidad es intencionada:
// reintentos con backoff, sondeo de la cola y acciones que deben aplicarse
// en orden. Paralelizarlas rompería justamente lo que se busca.
import type { Db } from "@/db";
import { logger } from "@/logger";
import { sleep } from "@/clients/http";

export type Job = { id: number; kind: string; payload: Record<string, unknown>; attempts: number };
export type JobHandler = (job: Job) => Promise<void>;

const MAX_ATTEMPTS = 5;

export async function enqueue(db: Db, kind: string, payload: Record<string, unknown>, delayMs = 0): Promise<void> {
  await db.query(
    `INSERT INTO jobs (kind, payload, run_after) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
    [kind, JSON.stringify(payload), String(delayMs)]
  );
}

/**
 * Toma un trabajo pendiente.
 *
 * `FOR UPDATE SKIP LOCKED` permite que varias réplicas del worker compitan sin
 * pisarse: cada una se lleva un trabajo distinto en vez de bloquearse.
 */
async function claim(db: Db): Promise<Job | null> {
  const res = await db.query(
    `UPDATE jobs SET locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE locked_at IS NULL AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, kind, payload, attempts`
  );
  const row = res.rows[0];
  return row ? { id: Number(row.id), kind: row.kind, payload: row.payload, attempts: Number(row.attempts) } : null;
}

async function complete(db: Db, id: number) {
  await db.query(`DELETE FROM jobs WHERE id = $1`, [id]);
}

async function fail(db: Db, job: Job, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (job.attempts >= MAX_ATTEMPTS) {
    // Se conserva la fila y se deja bloqueada: un trabajo que falló cinco
    // veces necesita que alguien lo mire, no otro reintento automático.
    logger.error("trabajo agotado, queda para revisión manual", { id: job.id, kind: job.kind, error: message });
    await db.query(`UPDATE jobs SET last_error = $1 WHERE id = $2`, [message, job.id]);
    return;
  }

  const delayMs = Math.min(60_000, 1000 * 2 ** job.attempts);
  logger.warn("trabajo fallido, se reintenta", { id: job.id, kind: job.kind, delayMs, error: message });
  await db.query(
    `UPDATE jobs SET locked_at = NULL, last_error = $1,
            run_after = now() + ($2 || ' milliseconds')::interval
      WHERE id = $3`,
    [message, String(delayMs), job.id]
  );
}

/** Bucle del worker. Se detiene limpiamente cuando se aborta la señal. */
export async function runWorker(
  db: Db,
  handler: JobHandler,
  options: { pollMs: number; signal: AbortSignal }
): Promise<void> {
  while (!options.signal.aborted) {
    let job: Job | null = null;
    try {
      job = await claim(db);
    } catch (error) {
      logger.error("no se pudo tomar un trabajo", { error: String(error) });
      await sleep(options.pollMs);
      continue;
    }

    if (!job) {
      await sleep(options.pollMs);
      continue;
    }

    try {
      await handler(job);
      await complete(db, job.id);
    } catch (error) {
      await fail(db, job, error);
    }
  }
}
