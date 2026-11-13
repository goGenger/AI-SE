import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

/**
 * Spins up a disposable PostgreSQL container for Phase 5.5-3 tests, following
 * the pattern of planningRepositories.test.ts / workflowRepositories.test.ts.
 */
export async function startPostgresContainer(): Promise<{
  pool: Pool;
  stop: () => Promise<void>;
}> {
  const name = `ai-se-mcp-postgres-test-${randomUUID()}`;

  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=aise",
    "-e",
    "POSTGRES_DB=aise",
    "-p",
    "127.0.0.1::5432",
    // tmpfs PGDATA: never leak an anonymous docker volume per test run
    // (accumulated volumes filled the Docker VM disk and broke other suites).
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:16-alpine"
  ]);

  const portLine = await docker(["port", name, "5432/tcp"]);
  const port = portLine.split(":").at(-1);
  if (!port) {
    throw new Error("Cannot resolve PostgreSQL test container port");
  }

  const pool = new Pool({
    connectionString: `postgres://aise@127.0.0.1:${port}/aise`,
    max: 4
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return {
        pool,
        stop: async () => {
          await pool.end();
          await docker(["rm", "-f", name]);
        }
      };
    } catch {
      await sleep(500);
    }
  }

  const logs = await docker(["logs", name]);
  await pool.end();
  await docker(["rm", "-f", name]);
  throw new Error(`PostgreSQL test container did not become ready: ${logs}`);
}

/** Creates a real project row (mcp_tool_bindings.project_id FK target). */
export async function createTestProject(pool: Pool, label: string): Promise<string> {
  const repository = await pool.query<{ id: string }>(
    `INSERT INTO repositories (url) VALUES ($1) RETURNING id`,
    [`https://example.com/${label}-${randomUUID()}`]
  );
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description, repository_id, status) VALUES ($1, '', $2, 'active') RETURNING id`,
    [`${label} project`, repository.rows[0].id]
  );
  return project.rows[0].id;
}
