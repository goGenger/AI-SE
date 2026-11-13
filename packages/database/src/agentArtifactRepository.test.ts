import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAgentArtifactRepository } from "./agentArtifactRepository";
import { runMigrations } from "./migrate";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

/**
 * 功能清点 T3（基线回归）：`findLatestByMetadataKind` 是基线查询的唯一落点，
 * 用真 postgres:16 验——`metadata->>'kind'` 的 JSONB 取值与排序都在 SQL 里，
 * 用 fake 断言不了。
 */
describe("PgAgentArtifactRepository.findLatestByMetadataKind", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: PgAgentArtifactRepository;
  let projectId: string;
  let otherProjectId: string;
  let taskId: string;
  let agentRunId: string;

  beforeAll(async () => {
    const postgres = await startPostgresContainer();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    projectId = await createTestProject(pool, "artifacts");
    otherProjectId = await createTestProject(pool, "artifacts-other");

    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, task_key, title, type)
       VALUES ($1, 'ui-task', 'UI', 'FRONTEND') RETURNING id`,
      [projectId]
    );
    taskId = task.rows[0]!.id;
    const run = await pool.query<{ id: string }>(
      "INSERT INTO agent_runs (project_id, task_id) VALUES ($1, $2) RETURNING id",
      [projectId, taskId]
    );
    agentRunId = run.rows[0]!.id;
    repository = new PgAgentArtifactRepository(pool);
  }, 180_000);

  afterAll(async () => stop?.());

  async function write(kind: string, project: string, name: string) {
    return await repository.create({
      projectId: project,
      taskId,
      agentRunId,
      agentName: "frontend",
      type: "GENERATED_FILE",
      name,
      content: {},
      metadata: { kind }
    });
  }

  it("没有匹配的 kind 时返回 null", async () => {
    expect(await repository.findLatestByMetadataKind(projectId, "nothing-here")).toBeNull();
  });

  it("只返回指定 kind，且取最近一条", async () => {
    await write("ui_screenshot", projectId, "candidate");
    const firstBaseline = await write("ui_screenshot_baseline", projectId, "baseline-1");
    const secondBaseline = await write("ui_screenshot_baseline", projectId, "baseline-2");

    const found = await repository.findLatestByMetadataKind(projectId, "ui_screenshot_baseline");

    expect(found?.id).toBe(secondBaseline.id);
    expect(found?.id).not.toBe(firstBaseline.id);
  });

  it("按项目隔离：别的项目的基线不会被当成这个项目的", async () => {
    await write("ui_screenshot_baseline", otherProjectId, "other-baseline");

    const found = await repository.findLatestByMetadataKind(otherProjectId, "ui_screenshot_baseline");
    expect(found?.name).toBe("other-baseline");

    const mine = await repository.findLatestByMetadataKind(projectId, "ui_screenshot_baseline");
    expect(mine?.name).toBe("baseline-2");
  });
});
