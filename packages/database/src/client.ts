import { Pool } from "pg";

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_SIZE ?? 10)
  });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
