import { z } from "zod";

/**
 * Toda la configuración se valida al arrancar y falla ruidosamente si algo
 * falta. Un orquestador que arranca con un secreto vacío aceptaría webhooks
 * sin firma o intentaría mergear sin credenciales, y ambos fallos son peores
 * si aparecen tarde.
 */
const schema = z.object({
  PORT: z.coerce.number().default(3100),
  DATABASE_URL: z.string().min(1),

  // Plane
  PLANE_BASE_URL: z.string().url(),
  PLANE_API_KEY: z.string().min(1),
  PLANE_WEBHOOK_SECRET: z.string().min(1),
  /**
   * Usuario bot cuyos eventos se ignoran. Sin esto, cada cambio de estado que
   * hace el orquestador vuelve por el webhook y se realimenta en bucle.
   */
  PLANE_BOT_USER_ID: z.string().uuid(),

  // Cursor
  CURSOR_API_KEY: z.string().min(1),
  CURSOR_BASE_URL: z.string().url().default("https://api.cursor.com"),
  CURSOR_MODEL: z.string().optional(),

  // GitHub
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),

  // Cadencias
  WORKER_POLL_MS: z.coerce.number().default(2000),
  RECONCILE_INTERVAL_MS: z.coerce.number().default(300_000),
  /** Tras esto sin PR, se considera que el agente murió. */
  AGENT_STALE_MINUTES: z.coerce.number().default(60),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  return parsed.data;
}
