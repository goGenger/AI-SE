import { BACKEND_NODE_PROFILE, JsonObject, Requirement, TaskPlan } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModelRequest } from "./PlanningModel";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";

/**
 * N-43（`docs/232` §T4-9）：骨架先行契约的图级接线。
 * 夹具取 L1-M4v 回归（2026-10-23）S1-foundation 的实值形状：清单任务只写 `package.json`，
 * 脚本实现排在后面的任务。契约要在**第一个切片**里把「脚本真实可执行」写进骨架任务的 AC。
 */

const slice = {
  key: "S1-foundation",
  title: "工程基线与构建契约脚手架",
  goal: "建立可构建、可测试的工程骨架。",
  frKeys: ["FR-9"]
};

function requirement(): Requirement {
  const timestamp = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "工程骨架",
    description: "Skeleton-first replay",
    rawContent: "交付一个可部署的任务看板（无编号 AC 形态）。",
    status: "DRAFT",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function manifestPlan(): TaskPlan {
  return {
    summary: "foundation slice",
    tasks: [
      {
        id: "S1-T01",
        title: "建立单包 pnpm 工程清单与五个约定脚本",
        description: "创建 package.json 与五个脚本。",
        type: "BUILD",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 4,
        acceptanceCriteria: [
          "仓库根存在 package.json，且可被 JSON.parse 正常解析。",
          "package.json 的 scripts 同时包含 start、test、lint、typecheck、build 五个键。"
        ],
        providesScripts: ["start", "test", "lint", "typecheck", "build"],
        sourceSpecTypes: ["TECHNICAL"]
      },
      {
        id: "S1-T02",
        title: "补齐运行时与版本库基线文件及锁文件",
        description: "创建 .nvmrc、.gitignore 与 pnpm-lock.yaml。",
        type: "BUILD",
        priority: "MEDIUM",
        dependencies: ["S1-T01"],
        estimatedComplexity: 2,
        acceptanceCriteria: [".nvmrc 存在于仓库根。"],
        sourceSpecTypes: ["TECHNICAL"]
      },
      {
        id: "S1-T06",
        title: "实现 lint / typecheck / build 三个零依赖自检脚本",
        description: "创建 scripts/lint.js、scripts/typecheck.js 与 scripts/build.js。",
        type: "BUILD",
        priority: "MEDIUM",
        dependencies: ["S1-T01"],
        estimatedComplexity: 3,
        acceptanceCriteria: ["scripts/build.js 存在。"],
        sourceSpecTypes: ["TECHNICAL"]
      }
    ]
  };
}

class TaskPlanModel extends ScriptedPlanningModel {
  constructor(
    fixtures: ReturnType<typeof createTodoPlanningFixtures>,
    private readonly plan: TaskPlan
  ) {
    super(fixtures);
  }

  override async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    if (request.stage === "task_planning") return this.plan;
    return super.generateStructured(request);
  }
}

async function run(isFirstSlice: boolean | undefined) {
  const fixtures = createTodoPlanningFixtures();
  const records: Array<{ eventType: string; payload: JsonObject }> = [];
  const lifecycle: AgentLifecycleHooks = {
    async onEvent(record) {
      records.push({ eventType: record.eventType, payload: record.payload });
    }
  };
  const result = await runPlanningGraph({
    profile: BACKEND_NODE_PROFILE,
    agentRunId: "33333333-3333-4333-8333-333333333333",
    taskId: "44444444-4444-4444-8444-444444444444",
    requirement: requirement(),
    model: new TaskPlanModel(fixtures, manifestPlan()),
    lifecycle,
    pipeline: "level2",
    slice,
    skipStages: ["ui_spec"],
    seedAnalysis: fixtures.requirement_analysis,
    ...(isFirstSlice !== undefined ? { isFirstSlice } : {})
  });
  return { result, records };
}

describe("N-43 骨架先行契约（图级）", () => {
  it("第一个切片：骨架任务的 AC 被补齐五个脚本的可执行条款，并留痕 PLAN_AUTOFIXED", async () => {
    const { result, records } = await run(true);

    const repairs = records.filter(
      (record) =>
        record.eventType === "PLAN_AUTOFIXED" && record.payload.rule === "skeleton-script-ac"
    );
    expect(repairs.map((record) => record.payload.script)).toEqual([
      "start",
      "test",
      "lint",
      "typecheck",
      "build"
    ]);
    expect(repairs.every((record) => record.payload.taskId === "S1-T01")).toBe(true);
    expect(records.some((record) => record.eventType === "TASK_DAG_VALIDATION_FAILED")).toBe(false);

    const generated = records.find((record) => record.eventType === "TASK_DAG_GENERATED");
    expect(generated?.payload.skeletonAcCount).toBe(5);

    const skeleton = result.taskPlan.tasks.find((task) => task.id === "S1-T01");
    expect(skeleton?.acceptanceCriteria).toHaveLength(7);
    expect(skeleton?.acceptanceCriteria.join("\n")).toContain("`pnpm run build`");
    // 任务图与 AC 编号映射不变。
    expect(result.taskPlan.tasks).toHaveLength(3);
    expect(result.taskPlan.tasks.every((task) => task.acKeys === undefined)).toBe(true);
  });

  it("未传 isFirstSlice（非首个切片 / 单级模式）：既有行为逐字不变", async () => {
    const { result, records } = await run(undefined);

    expect(
      records.some(
        (record) =>
          record.eventType === "PLAN_AUTOFIXED" && record.payload.rule === "skeleton-script-ac"
      )
    ).toBe(false);
    const skeleton = result.taskPlan.tasks.find((task) => task.id === "S1-T01");
    expect(skeleton?.acceptanceCriteria).toHaveLength(2);
    expect(records.some((record) => record.eventType === "TASK_DAG_GENERATED")).toBe(true);
  });

  it("同一脚本被清单任务与实现任务同时声明 → 校验失败并入修复轮", async () => {
    const plan = manifestPlan();
    // 实值形状的第二种：实现任务也声明了脚本 ⇒ 声明与实现被拆开，必然有一个任务永远过不了自己的检查。
    const duplicated: TaskPlan = {
      ...plan,
      tasks: plan.tasks.map((task) =>
        task.id === "S1-T06" ? { ...task, providesScripts: ["build"] } : task
      )
    };
    const fixtures = createTodoPlanningFixtures();
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const promise = runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "55555555-5555-4555-8555-555555555555",
      taskId: "66666666-6666-4666-8666-666666666666",
      requirement: requirement(),
      model: new TaskPlanModel(fixtures, duplicated),
      lifecycle,
      pipeline: "level2",
      slice,
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis,
      isFirstSlice: true,
      maxValidationRetries: 1
    });

    await expect(promise).rejects.toThrow(/SKELETON_SCRIPT_MULTIPLE_PROVIDERS/);
    const failed = records.filter((record) => record.eventType === "TASK_DAG_VALIDATION_FAILED");
    expect(failed).toHaveLength(2);
  });
});
