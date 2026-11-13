import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPlanningRepository } from "./planningRepositories";
import { PgProjectRepository } from "./projectRepository";
import { runMigrations } from "./migrate";
import { RequirementAnalysis, TaskPlan } from "@ai-se/shared";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function startPostgres(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const name = `ai-se-planning-postgres-test-${randomUUID()}`;

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
    max: 2
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

function analysis(): RequirementAnalysis {
  return {
    id: "REQ-ANALYSIS-001",
    summary: "Todo planning",
    goals: ["Todo CRUD"],
    constraints: [],
    assumptions: ["Todos are persisted."],
    acceptanceCriteria: ["Todo can be created."],
    risks: []
  };
}

function taskPlan(duplicateDependency = false): TaskPlan {
  return {
    summary: "Todo plan",
    tasks: [
      {
        id: "TASK-001",
        title: "Design Todo",
        description: "Design Todo architecture.",
        type: "DESIGN",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 1,
        acceptanceCriteria: ["Design is complete."],
        sourceSpecTypes: ["ARCHITECTURE"]
      },
      {
        id: "TASK-002",
        title: "Build Todo DB",
        description: "Create Todo database table.",
        type: "DATABASE",
        priority: "HIGH",
        dependencies: duplicateDependency ? ["TASK-001", "TASK-001"] : ["TASK-001"],
        estimatedComplexity: 2,
        acceptanceCriteria: ["Migration is ready."],
        sourceSpecTypes: ["DATABASE"]
      }
    ]
  };
}

describe("Phase 3 planning repositories", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await stop?.();
  });

  it("applies planning migration tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('requirements', 'specifications', 'tasks', 'task_dependencies')
        ORDER BY table_name
      `
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "requirements",
      "specifications",
      "task_dependencies",
      "tasks"
    ]);
  });

  it("persists requirement, specifications, tasks and dependencies", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: "Planning",
      description: "",
      repository: "https://github.com/example/planning",
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Todo",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    const saved = await planning.savePlanningResult({
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
      version: 1,
      analysis: analysis(),
      specifications: [
        { type: "FUNCTIONAL", content: { requirements: [] } },
        { type: "TECHNICAL", content: { requirements: [] } },
        { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
        { type: "API", content: { endpoints: [] } },
        { type: "DATABASE", content: { tables: [] } },
        { type: "UI", content: { pages: [] } }
      ],
      taskPlan: taskPlan()
    });

    expect(saved.specifications).toHaveLength(7);
    expect(saved.tasks).toHaveLength(2);
    expect(saved.dependencies.map((dependency) => dependency.sourceTaskKey)).toEqual(["TASK-001"]);
    await expect(planning.findRequirementById(requirement.id)).resolves.toMatchObject({
      status: "ANALYZED"
    });
  });

  it("rolls back planning result when dependency persistence fails", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: `Rollback ${randomUUID()}`,
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Rollback",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    await expect(
      planning.savePlanningResult({
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersion: requirement.version,
        version: 1,
        analysis: analysis(),
        specifications: [
          { type: "FUNCTIONAL", content: { requirements: [] } },
          { type: "TECHNICAL", content: { requirements: [] } },
          { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
          { type: "API", content: { endpoints: [] } },
          { type: "DATABASE", content: { tables: [] } },
          { type: "UI", content: { pages: [] } }
        ],
        taskPlan: taskPlan(true)
      })
    ).rejects.toThrow();

    const counts = await pool.query<{
      specifications: string;
      tasks: string;
      dependencies: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM specifications WHERE requirement_id = $1) AS specifications,
          (SELECT count(*) FROM tasks WHERE requirement_id = $1) AS tasks,
          (
            SELECT count(*)
            FROM task_dependencies d
            JOIN tasks t ON t.id = d.target_task_id
            WHERE t.requirement_id = $1
          ) AS dependencies
      `,
      [requirement.id]
    );

    expect(Number(counts.rows[0].specifications)).toBe(0);
    expect(Number(counts.rows[0].tasks)).toBe(0);
    expect(Number(counts.rows[0].dependencies)).toBe(0);
  });

  it("replaces acceptance criteria records and counts latest-task mappings (N3)", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: `Criteria ${randomUUID()}`,
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Criteria",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    const saved = await planning.replaceAcceptanceCriteria({
      projectId: project.id,
      requirementId: requirement.id,
      records: [
        {
          acKey: "AC-01",
          text: "Todo can be created.",
          textHash: "a".repeat(64),
          priority: "Must",
          verification: "HTTP 断言",
          smoke: true,
          frKeys: ["FR-1", "FR-2"],
          source: "parsed"
        },
        {
          acKey: "AC-02",
          text: "Todo list shows persisted items.",
          textHash: "b".repeat(64),
          priority: null,
          verification: null,
          smoke: false,
          frKeys: [],
          source: "llm"
        }
      ]
    });

    expect(saved.map((record) => record.acKey)).toEqual(["AC-01", "AC-02"]);
    expect(saved[0]?.frKeys).toEqual(["FR-1", "FR-2"]);

    const found = await planning.findAcceptanceCriteriaByRequirementId(requirement.id);
    expect(found).toHaveLength(2);
    expect(found[1]).toMatchObject({ priority: null, smoke: false, source: "llm" });

    // 映射计数：同一切片仅计最新版本的原始计划行（v1 被 v2 取代后不重复计数）。
    await pool.query(
      `
        INSERT INTO tasks (
          project_id, requirement_id, task_key, title, description, type, priority, input, version, slice_key
        )
        VALUES
          ($1, $2, 'T1', 'Backend v1', '', 'BACKEND', 'MEDIUM', $3::jsonb, 1, 'slice-a'),
          ($1, $2, 'T1', 'Backend v2', '', 'BACKEND', 'MEDIUM', $4::jsonb, 2, 'slice-a')
      `,
      [
        project.id,
        requirement.id,
        JSON.stringify({ acKeys: ["AC-01"] }),
        JSON.stringify({ acKeys: ["AC-01", "AC-02"] })
      ]
    );

    const counts = await planning.acceptanceCriteriaMappingCounts(requirement.id);
    expect(counts.get("AC-01")).toBe(1);
    expect(counts.get("AC-02")).toBe(1);

    // 替换语义：二次写入整体替换。
    await planning.replaceAcceptanceCriteria({
      projectId: project.id,
      requirementId: requirement.id,
      records: [
        {
          acKey: "AC-09",
          text: "Only one.",
          textHash: "c".repeat(64),
          priority: "Should",
          verification: null,
          smoke: false,
          frKeys: [],
          source: "parsed"
        }
      ]
    });
    const replaced = await planning.findAcceptanceCriteriaByRequirementId(requirement.id);
    expect(replaced.map((record) => record.acKey)).toEqual(["AC-09"]);
  }, 60_000);

  it("persists plan acKeys into task inputs so runtime clones carry the AC mapping (N3 fix)", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: `Keys ${randomUUID()}`,
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Keys",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    const taskPlan: TaskPlan = {
      summary: "Slice plan",
      tasks: [
        {
          id: "T1",
          title: "Write AC-numbered tests",
          description: "Write tests covering the slice ACs first.",
          type: "TEST",
          priority: "MEDIUM",
          dependencies: [],
          estimatedComplexity: 3,
          acceptanceCriteria: ["Tests fail before the implementation exists."],
          acKeys: ["AC-01", "AC-02"],
          sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
        },
        {
          id: "T2",
          title: "Implement endpoints",
          description: "Implement endpoints until the tests pass.",
          type: "BACKEND",
          priority: "MEDIUM",
          dependencies: ["T1"],
          estimatedComplexity: 4,
          acceptanceCriteria: ["Endpoints pass the AC tests."],
          acKeys: ["AC-01"],
          sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
        }
      ]
    };

    const saved = await planning.saveSlicePlanningResult({
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
      version: 1,
      sliceKey: "slice-a",
      analysis: {} as RequirementAnalysis,
      specifications: [],
      taskPlan
    });

    const testTask = saved.tasks.find((task) => task.taskKey === "T1");
    expect(testTask?.input.acKeys).toEqual(["AC-01", "AC-02"]);
    const backendTask = saved.tasks.find((task) => task.taskKey === "T2");
    expect(backendTask?.input.acKeys).toEqual(["AC-01"]);

    const counts = await planning.acceptanceCriteriaMappingCounts(requirement.id);
    expect(counts.get("AC-01")).toBe(2);
    expect(counts.get("AC-02")).toBe(1);
  }, 60_000);

  /**
   * `docs/235` §7 / §6.5：新任务的 `input.profile` 记下**这条计划属于哪个能力口径**
   * （`id@version`）。缺省不落键——历史行与既有调用方一字不改。
   */
  it("stamps the capability profile into task inputs so readings can be attributed (docs/235)", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);

    const taskPlan: TaskPlan = {
      summary: "Slice plan",
      tasks: [
        {
          id: "T1",
          title: "Build the page",
          description: "Build the page.",
          type: "FRONTEND",
          priority: "MEDIUM",
          dependencies: [],
          estimatedComplexity: 3,
          acceptanceCriteria: ["The page renders."],
          sourceSpecTypes: ["UI"]
        }
      ]
    };

    // 两次落盘用**两个独立需求**：同一需求同一 taskKey 会撞唯一约束（这是计划的原始键）。
    const save = async (profile?: string) => {
      const project = await projects.create({
        name: `Profile ${randomUUID()}`,
        description: "",
        repository: `https://github.com/example/${randomUUID()}`,
        status: "active"
      });
      const requirement = await planning.createRequirement(project.id, {
        title: "Profile",
        description: "",
        rawContent: "Create Todo CRUD."
      });
      return planning.saveSlicePlanningResult({
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersion: requirement.version,
        version: 1,
        sliceKey: "slice-a",
        analysis: {} as RequirementAnalysis,
        specifications: [],
        taskPlan,
        ...(profile ? { profile } : {})
      });
    };

    const tagged = await save("frontend-vue@1");
    expect(tagged.tasks[0]?.input.profile).toBe("frontend-vue@1");

    // 反向对照：不传 profile ⇒ 不落键（既有行为的形状）。
    const untagged = await save();
    expect(untagged.tasks[0]?.input).not.toHaveProperty("profile");
  }, 60_000);

  it("F1-2（FX-06）：单一生效计划版本——切片重规划后旧版本行标记 SUPERSEDED，读取面默认过滤", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: `Supersede ${randomUUID()}`,
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Supersede",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    await planning.replaceSlicePlan({
      projectId: project.id,
      requirementId: requirement.id,
      plan: {
        slices: [
          {
            id: "slice-a",
            title: "A",
            goal: "Goal A.",
            frKeys: ["FR-1"],
            dependsOn: [],
            order: 1,
            involvesUi: false,
            acceptanceCriteria: []
          }
        ],
        milestones: []
      }
    });

    const planForVersion = (): TaskPlan => ({
      summary: "Slice plan",
      tasks: [
        {
          id: "T1",
          title: "Write tests",
          description: "Write tests first.",
          type: "TEST",
          priority: "MEDIUM",
          dependencies: [],
          estimatedComplexity: 1,
          acceptanceCriteria: ["Tests written."],
          acKeys: ["AC-01"],
          sourceSpecTypes: ["FUNCTIONAL"]
        },
        {
          id: "T2",
          title: "Implement",
          description: "Implement until green.",
          type: "BACKEND",
          priority: "MEDIUM",
          dependencies: ["T1"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["Implemented."],
          acKeys: ["AC-01"],
          sourceSpecTypes: ["FUNCTIONAL"]
        }
      ]
    });

    const saveVersion = (version: number) =>
      planning.saveSlicePlanningResult({
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersion: requirement.version,
        version,
        sliceKey: "slice-a",
        analysis: {} as RequirementAnalysis,
        specifications: [],
        taskPlan: planForVersion()
      });

    await saveVersion(1);
    await saveVersion(2);

    const raw = await pool.query<{ version: number; superseded: boolean }>(
      `
        SELECT version, superseded_at IS NOT NULL AS superseded
        FROM tasks
        WHERE requirement_id = $1 AND workflow_run_id IS NULL
        ORDER BY version ASC, task_key ASC
      `,
      [requirement.id]
    );
    expect(raw.rows.map((row) => `${row.version}:${row.superseded}`)).toEqual([
      "1:true",
      "1:true",
      "2:false",
      "2:false"
    ]);

    const active = await planning.findTasksByRequirementId(requirement.id);
    expect(active.map((task) => task.version)).toEqual([2, 2]);
    const all = await planning.findTasksByRequirementId(requirement.id, {
      includeSuperseded: true
    });
    expect(all).toHaveLength(4);

    const activeDependencies = await planning.findDependenciesByRequirementId(requirement.id);
    expect(activeDependencies).toHaveLength(1);
    expect(activeDependencies[0]?.sourceTaskKey).toBe("T1");
  }, 60_000);

  it("F1-2（FX-06）：切片计划重做后，退役切片键的旧计划行被标记 SUPERSEDED", async () => {
    const projects = new PgProjectRepository(pool);
    const planning = new PgPlanningRepository(pool);
    const project = await projects.create({
      name: `Retire ${randomUUID()}`,
      description: "",
      repository: `https://github.com/example/${randomUUID()}`,
      status: "active"
    });
    const requirement = await planning.createRequirement(project.id, {
      title: "Retire",
      description: "",
      rawContent: "Create Todo CRUD."
    });

    const sliceA = {
      id: "slice-a",
      title: "A",
      goal: "Goal A.",
      frKeys: ["FR-1"],
      dependsOn: [],
      order: 1,
      involvesUi: false,
      acceptanceCriteria: []
    };
    const sliceB = { ...sliceA, id: "slice-b", title: "B" };

    await planning.replaceSlicePlan({
      projectId: project.id,
      requirementId: requirement.id,
      plan: { slices: [sliceA], milestones: [] }
    });
    await planning.saveSlicePlanningResult({
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
      version: 1,
      sliceKey: "slice-a",
      analysis: {} as RequirementAnalysis,
      specifications: [],
      taskPlan: {
        summary: "Slice plan",
        tasks: [
          {
            id: "T1",
            title: "Implement A",
            description: "Implement slice A.",
            type: "BACKEND",
            priority: "MEDIUM",
            dependencies: [],
            estimatedComplexity: 1,
            acceptanceCriteria: ["A implemented."],
            acKeys: ["AC-01"],
            sourceSpecTypes: ["FUNCTIONAL"]
          }
        ]
      }
    });

    // 重做切片计划：slice-a 退役（不在新切片集内）。
    await planning.replaceSlicePlan({
      projectId: project.id,
      requirementId: requirement.id,
      plan: { slices: [sliceB], milestones: [] }
    });

    const raw = await pool.query<{ slice_key: string; superseded: boolean }>(
      `
        SELECT slice_key, superseded_at IS NOT NULL AS superseded
        FROM tasks
        WHERE requirement_id = $1 AND workflow_run_id IS NULL
      `,
      [requirement.id]
    );
    expect(raw.rows).toEqual([{ slice_key: "slice-a", superseded: true }]);

    const active = await planning.findTasksByRequirementId(requirement.id);
    expect(active).toHaveLength(0);
    const all = await planning.findTasksByRequirementId(requirement.id, {
      includeSuperseded: true
    });
    expect(all).toHaveLength(1);
  }, 60_000);
});
