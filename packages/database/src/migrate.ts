import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { Pool } from "pg";
import { createPool } from "./client";

const MIGRATIONS_TABLE = "schema_migrations";

export function defaultMigrationsDir(): string {
  return path.resolve(__dirname, "../migrations");
}

export async function listMigrationFiles(
  migrationsDir = defaultMigrationsDir()
): Promise<string[]> {
  const entries = await fs.readdir(migrationsDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(
  pool = createPool(),
  migrationsDir = defaultMigrationsDir()
): Promise<string[]> {
  await ensureMigrationsTable(pool);

  const applied: string[] = [];
  const files = await listMigrationFiles(migrationsDir);

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
      [file]
    );

    if ((existing.rowCount ?? 0) > 0) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration checksum changed: ${file}`);
      }
      continue;
    }

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
        file,
        checksum
      ]);
      await pool.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  return applied;
}

if (require.main === module) {
  const pool = createPool();
  runMigrations(pool)
    .then((applied) => {
      console.log(JSON.stringify({ applied }));
    })
    .finally(() => pool.end());
}
