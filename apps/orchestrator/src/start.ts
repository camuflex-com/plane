import { createPool, migrate } from "@/db";
import { loadEnv } from "@/env";
import { Executor } from "@/executor";
import { logger } from "@/logger";
import { runReconciler } from "@/reconciler";
import { runWorker } from "@/queue";
import { createServer } from "@/server";

async function main() {
  const env = loadEnv();
  const db = createPool(env.DATABASE_URL);

  // El esquema se aplica antes de servir: aceptar webhooks contra tablas que
  // no existen solo produciría entregas perdidas.
  await migrate(db);

  const executor = new Executor(db, env);
  const controller = new AbortController();

  const server = createServer(db, env).listen(env.PORT, () => {
    logger.info("orquestador escuchando", { port: env.PORT });
  });

  const workers = [
    runWorker(db, executor.handle, { pollMs: env.WORKER_POLL_MS, signal: controller.signal }),
    runReconciler(db, env, controller.signal),
  ];

  const shutdown = (signal: string) => {
    logger.info("apagando", { signal });
    controller.abort();
    server.close(() => {
      void Promise.allSettled(workers)
        .then(() => db.end())
        .then(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error("arranque fallido", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
