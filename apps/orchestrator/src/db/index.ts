import pg from "pg";
import { logger } from "@/logger";
import { SCHEMA_SQL } from "./schema";

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 8 });
}

/** Aplica el esquema. Idempotente: seguro en cada arranque y con réplicas. */
export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA_SQL);
  logger.info("esquema aplicado");
}

/**
 * Registra una entrega y dice si es nueva.
 *
 * Plane y GitHub reintentan las entregas fallidas; sin esto, un reintento
 * lanzaría un segundo agente o repetiría un merge.
 */
export async function claimDelivery(db: Db, source: string, deliveryId: string): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO deliveries (source, delivery_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING delivery_id`,
    [source, deliveryId]
  );
  return (res.rowCount ?? 0) > 0;
}
