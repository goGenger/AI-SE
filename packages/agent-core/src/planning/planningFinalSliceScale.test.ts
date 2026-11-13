import {
  BACKEND_NODE_PROFILE,
  AcceptanceCriterion,
  JsonObject,
  Requirement,
  TaskPlan
} from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModelRequest } from "./PlanningModel";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { TaskGraphValidationError } from "./validateTaskGraph";

/**
 * F1-4（发现⑤）：最终切片治理的图级验证。
 * - FX-13(a)：非最终切片挂全局性 AC/交付链任务 → 校验拦截（两个错误码），修复轮收敛；
 * - FX-15(a)：observe 只记录 `FINAL_SLICE_SCALE_OBSERVED`、不判失败；
 * - FX-15(b)：enforce 超限 → LLM 压缩（提示不增删 AC 映射）→ 收敛；不收敛 → TaskGraphValidationError。
 */

const criteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-05",
    text: "PATCH 含未知字段 → 400 UNKNOWN_FIELD",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-5"]
  },
  {
    acKey: "AC-24",
    text: "docker build 成功；docker run 后健康端点可达",
    priority: "Must",
    verification: "容器运行",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-30",
    text: "README 命令可执行；pnpm test 全绿",
    priority: "Must",
    verification: "命令执行 + 测试名解析",
    smoke: false,
    frKeys: ["FR-9"]
  }
];

function requirement(): Requirement {
  const timestamp = new Date().toISOString();
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    title: "E1 最终切片治理",
    description: "Final-slice governance replay",
    rawContent: "交付一个可部署的任务看板（无编号 AC 形态，AC 记录由库注入）。",
    status: "DRAFT",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

const slice = {
  key: "slice-5",
  title: "任务查询更新删除与数据隔离",
  goal: "完成功能收尾并交付验证。",
  frKeys: ["FR-5"]
};

function baseTask(
  id: string,
  type: TaskPlan["tasks"][number]["type"],
  acKeys: string[],
  dependencies: string[]
): TaskPlan["tasks"][number] {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    type,
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 2,
    acceptanceCriteria: [`${id} acceptance`],
    sourceSpecTypes: ["FUNCTIONAL"],
    ...(acKeys.length > 0 ? { acKeys } : {})
  };
}

/** 超限大计划（6 任务；含交付链与全局性 AC）。 */
function bigPlan(): TaskPlan {
  return {
    summary: "final slice overloaded plan",
    tasks: [
      baseTask("T-101", "TEST", ["AC-05"], []),
      baseTask("T-102", "BACKEND", ["AC-05"], ["T-101"]),
      {
        ...baseTask("T-103", "BUILD", ["AC-30"], ["T-102"]),
        delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
      },
      baseTask("T-104", "TEST", ["AC-24", "AC-30"], ["T-103"]),
      // PL-M1（`docs/158` §3）：全局性 AC 也必须有实现类任务覆盖——原先这份夹具只让 TEST/BUILD
      // 引用 AC-24/AC-30，正是 run 3 slice-5 的那个缺口，新校验器会拦下它。
      baseTask("T-106", "BACKEND", ["AC-24", "AC-30"], ["T-104"]),
      {
        ...baseTask("T-105", "DEPLOY", [], ["T-106"]),
        delivery: { action: "DEPLOY", environment: "staging" }
      }
    ]
  };
}

/** 压缩后小计划（4 任务；AC 映射与依赖保持）。 */
function smallPlan(): TaskPlan {
  return {
    summary: "final slice compressed plan",
    tasks: [
      baseTask("T-101", "TEST", ["AC-05"], []),
      baseTask("T-102", "BACKEND", ["AC-05"], ["T-101"]),
      baseTask("T-104", "TEST", ["AC-24", "AC-30"], ["T-102"]),
      baseTask("T-106", "BACKEND", ["AC-24", "AC-30"], ["T-104"])
    ]
  };
}

/** 非最终切片的合规计划（2 任务；无交付链、无全局性 AC）。 */
function nonFinalPlan(): TaskPlan {
  return {
    summary: "non-final slice plan",
    tasks: [
      baseTask("T-101", "TEST", ["AC-05"], []),
      baseTask("T-102", "BACKEND", ["AC-05"], ["T-101"])
    ]
  };
}

class PlanSequenceModel extends ScriptedPlanningModel {
  readonly attempts: Array<{ prompt: string; plan: TaskPlan }> = [];

  constructor(
    fixtures: ReturnType<typeof createTodoPlanningFixtures>,
    private readonly plans: TaskPlan[]
  ) {
    super(fixtures);
  }

  override async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    if (request.stage === "task_planning") {
      const plan = this.plans[Math.min(this.attempts.length, this.plans.length - 1)];
      this.attempts.push({ prompt: request.prompt, plan });
      return plan;
    }
    return super.generateStructured(request);
  }
}

async function runFinalSlice(plans: TaskPlan[], finalSliceMaxTasks?: number) {
  const fixtures = createTodoPlanningFixtures();
  const model = new PlanSequenceModel(fixtures, plans);
  const records: Array<{ eventType: string; payload: JsonObject }> = [];
  const lifecycle: AgentLifecycleHooks = {
    async onEvent(record) {
      records.push({ eventType: record.eventType, payload: record.payload });
    }
  };

  const promise = runPlanningGraph({
    profile: BACKEND_NODE_PROFILE,
    agentRunId: "e5e5e5e5-5555-4555-8555-555555555555",
    taskId: "f6f6f6f6-6666-4666-8666-666666666666",
    requirement: requirement(),
    model,
    lifecycle,
    pipeline: "level2",
    slice,
    skipStages: ["ui_spec"],
    seedAnalysis: fixtures.requirement_analysis,
    acceptanceCriteria: criteria,
    deliveryConfigured: true,
    isFinalSlice: true,
    deliveryEnvironment: "staging",
    ...(finalSliceMaxTasks !== undefined ? { finalSliceMaxTasks } : {})
  });

  return { promise, model, records };
}

describe("F1-4 FX-15(a)：observe 只记录最终切片规模、不判失败", () => {
  it("阈值缺省 → 计划通过 + FINAL_SLICE_SCALE_OBSERVED 事件（四指标 + mode=observe）", async () => {
    const { promise, model, records } = await runFinalSlice([bigPlan()]);
    const result = await promise;

    expect(result.taskPlan.tasks).toHaveLength(6);
    expect(model.attempts).toHaveLength(1);
    // 最终切片范围并入全部全局性 AC → 提示词携带 AC-24/AC-30。
    expect(model.attempts[0]?.prompt).toContain("AC-24");
    expect(model.attempts[0]?.prompt).toContain("AC-30");

    const scale = records.find((entry) => entry.eventType === "FINAL_SLICE_SCALE_OBSERVED");
    expect(scale?.payload).toMatchObject({
      mode: "observe",
      taskCount: 6,
      deliveryTaskCount: 2,
      frCount: 1,
      globalAcCount: 2
    });
    expect(scale?.payload.threshold).toBeUndefined();
  });
});

describe("F1-4 FX-15(b)：enforce 超限 → LLM 压缩（不增删 AC 映射）→ 收敛", () => {
  it("attempt 0 超限报 FINAL_SLICE_OVERLOAD；压缩提示进入下一轮；压缩后通过并记录 enforce 规模", async () => {
    const { promise, model, records } = await runFinalSlice([bigPlan(), smallPlan()], 4);
    const result = await promise;

    expect(model.attempts).toHaveLength(2);
    const firstFailed = records.find((entry) => entry.eventType === "TASK_DAG_VALIDATION_FAILED");
    expect(firstFailed?.payload.errorCount).toBeGreaterThan(0);
    expect(
      (firstFailed?.payload.validationErrors as string[]).some((error) =>
        error.includes("FINAL_SLICE_OVERLOAD")
      )
    ).toBe(true);

    expect(model.attempts[1]?.prompt).toContain("FINAL_SLICE_OVERLOAD");
    expect(model.attempts[1]?.prompt).toContain("do NOT add or remove AC mappings");

    expect(result.taskPlan.tasks).toHaveLength(4);
    const scale = records.find((entry) => entry.eventType === "FINAL_SLICE_SCALE_OBSERVED");
    expect(scale?.payload).toMatchObject({ mode: "enforce", threshold: 4, taskCount: 4 });
  });

  it("重复超限（不收敛）→ 修复轮耗尽抛 TaskGraphValidationError（含 FINAL_SLICE_OVERLOAD）", async () => {
    const { promise, model } = await runFinalSlice([bigPlan()], 3);
    await expect(promise).rejects.toThrow(TaskGraphValidationError);
    await expect(promise).rejects.toThrow(/FINAL_SLICE_OVERLOAD/);
    expect(model.attempts).toHaveLength(3);
  });
});

describe("F1-4 FX-13(a)：非最终切片的全局性 AC / 交付链归属拦截", () => {
  it("首轮计划违规（GLOBAL_AC_OUTSIDE_FINAL_SLICE + DELIVERY_TASK_OUTSIDE_FINAL_SLICE）→ 修复轮给出错误并收敛", async () => {
    const fixtures = createTodoPlanningFixtures();
    const model = new PlanSequenceModel(fixtures, [bigPlan(), nonFinalPlan()]);
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "a7a7a7a7-7777-4777-8777-777777777777",
      taskId: "b8b8b8b8-8888-4888-8888-888888888888",
      requirement: requirement(),
      model,
      lifecycle,
      pipeline: "level2",
      slice,
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis,
      acceptanceCriteria: criteria,
      deliveryConfigured: true,
      isFinalSlice: false
    });

    // 非最终切片提示词不再提出交付链、且范围不含全局性 AC 编号。
    expect(model.attempts[0]?.prompt).toContain("NOT the final slice");
    expect(model.attempts[0]?.prompt).not.toContain("AC-24");
    expect(model.attempts[0]?.prompt).not.toContain("AC-30");

    const firstFailed = records.find((entry) => entry.eventType === "TASK_DAG_VALIDATION_FAILED");
    const errors = firstFailed?.payload.validationErrors as string[];
    expect(errors.some((error) => error.includes("GLOBAL_AC_OUTSIDE_FINAL_SLICE"))).toBe(true);
    // N-41（`docs/232` §T4-8）：交付链任务改由确定性规则**先剔除**，不再出现在校验错误面——
    // 否则模型要同时看两条错误，而它对「挪走交付任务」这条从未收敛。
    expect(errors.some((error) => error.includes("DELIVERY_TASK_OUTSIDE_FINAL_SLICE"))).toBe(false);
    expect(
      records.some(
        (entry) =>
          entry.eventType === "PLAN_AUTOFIXED" && entry.payload.rule === "non-final-slice-delivery"
      )
    ).toBe(true);

    expect(model.attempts).toHaveLength(2);
    expect(model.attempts[1]?.prompt).toContain("GLOBAL_AC_OUTSIDE_FINAL_SLICE");
    expect(result.taskPlan.tasks).toHaveLength(2);
  });
});
