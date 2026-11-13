import { BACKEND_NODE_PROFILE, JsonObject, TaskPlan } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModelRequest } from "./PlanningModel";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { validateTaskGraph } from "./validateTaskGraph";
import { validateTestFirstOrder } from "./validateTestFirstPlan";
import {
  r1Attempt0Errors,
  r1Attempt0Plan,
  r1Attempt1Errors,
  r1Attempt1Plan,
  r1Attempt2FixedPlan,
  r1Attempt2Plan,
  r1Attempt2TestFirstErrors,
  r1Criteria,
  r1Requirement,
  r1SliceScope
} from "./r1Fixture";

/**
 * F1-3 回放（R1 = E1 slice-2 planningVersion 8）：
 * - FX-08：attempt 0/1（各 5 个测试先行错误）→ 确定性自动修复后一次通过、LLM 修复轮数为 0；
 * - FX-09：attempt 2（T-022 非最终切片 DEPLOY + T-005/T-006 测试先行）→ 2 条测试先行自动修复；
 *   T-022 以 DELIVERY_TASK_OUTSIDE_FINAL_SLICE 拦下且未被补块 → 进入 LLM 修复路径；
 * - FX-12：event 面可统计（每 attempt 的 taskCount / errorCount / autofix 计数）。
 * 复刻口径：原始计划错误与 E 期录像逐字一致（r1Fixture 中的错误原文断言）。
 */

class TaskPlanSequenceModel extends ScriptedPlanningModel {
  taskPlanAttempts = 0;

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
      const plan = this.plans[Math.min(this.taskPlanAttempts, this.plans.length - 1)];
      this.taskPlanAttempts += 1;
      return plan;
    }
    return super.generateStructured(request);
  }
}

async function runReplay(plans: TaskPlan[]) {
  const fixtures = createTodoPlanningFixtures();
  const model = new TaskPlanSequenceModel(fixtures, plans);
  const records: Array<{ eventType: string; payload: JsonObject }> = [];
  const lifecycle: AgentLifecycleHooks = {
    async onEvent(record) {
      records.push({ eventType: record.eventType, payload: record.payload });
    }
  };

  const result = await runPlanningGraph({
    profile: BACKEND_NODE_PROFILE,
    agentRunId: "f1f1f1f1-1111-4111-8111-111111111111",
    taskId: "f2f2f2f2-2222-4222-8222-222222222222",
    requirement: r1Requirement,
    model,
    lifecycle,
    pipeline: "level2",
    slice: r1SliceScope,
    skipStages: ["ui_spec"],
    seedAnalysis: fixtures.requirement_analysis,
    acceptanceCriteria: r1Criteria,
    deliveryConfigured: true,
    isFinalSlice: false,
    deliveryEnvironment: "staging"
  });

  return { result, model, records };
}

describe("F1-3 FX-08 回放：E1 slice-2 attempt 0/1（5 个测试先行错误）", () => {
  it("原始错误与录像逐字一致；自动修复后一次通过、LLM 修复轮数为 0", async () => {
    // 复刻断言（修复前原始计划的错误 = E 期录像原文）。
    expect(
      validateTestFirstOrder({
        tasks: r1Attempt0Plan.tasks,
        criteria: r1Criteria,
        frKeys: r1SliceScope.frKeys
      })
    ).toEqual(r1Attempt0Errors);
    expect(
      validateTestFirstOrder({
        tasks: r1Attempt1Plan.tasks,
        criteria: r1Criteria,
        frKeys: r1SliceScope.frKeys
      })
    ).toEqual(r1Attempt1Errors);

    const cases = [
      {
        plan: r1Attempt0Plan,
        testTaskId: "T-016",
        taskCount: 17,
        implIds: ["T-008", "T-009", "T-010", "T-011", "T-012"]
      },
      {
        plan: r1Attempt1Plan,
        testTaskId: "T-019",
        taskCount: 15,
        implIds: ["T-008", "T-009", "T-010", "T-011", "T-012"]
      }
    ];

    for (const entry of cases) {
      const { result, model, records } = await runReplay([entry.plan]);

      // 一次通过：task_planning 只请求模型 1 次（attempt 0），无失败事件、无 LLM 修复轮。
      expect(model.taskPlanAttempts).toBe(1);
      const types = records.map((record) => record.eventType);
      expect(types).not.toContain("TASK_DAG_VALIDATION_FAILED");
      expect(types).not.toContain("PLANNING_REPAIR_REQUESTED");
      expect(types).not.toContain("PLAN_ACKEYS_BACKFILLED");

      expect(result.taskPlan.tasks.length).toBe(entry.taskCount);

      // 5 条测试先行错误全部由自动修复消化（规则/对象/前后差异留痕）。
      const fixes = records.filter((record) => record.eventType === "PLAN_AUTOFIXED");
      expect(fixes).toHaveLength(5);
      expect(fixes.every((fix) => fix.payload.rule === "test-first-edge")).toBe(true);
      expect(
        fixes.map((fix) => [fix.payload.implementationTaskId, fix.payload.testTaskId])
      ).toEqual(entry.implIds.map((id) => [id, entry.testTaskId]));
      expect(fixes[0]?.payload.sharedAcKeys).toEqual(["AC-02", "AC-04"]);
      expect(fixes[4]?.payload.sharedAcKeys).toEqual(["AC-01"]);

      const generated = records.find((record) => record.eventType === "TASK_DAG_GENERATED");
      expect(generated?.payload).toMatchObject({
        attempt: 0,
        taskCount: entry.taskCount,
        autofixCount: 5
      });

      // 修复后：测试先行满足；任务数与 AC 映射不变。
      const byId = new Map(result.taskPlan.tasks.map((task) => [task.id, task]));
      for (const id of entry.implIds) {
        expect(byId.get(id)?.dependencies).toContain(entry.testTaskId);
      }
      expect(
        validateTestFirstOrder({
          tasks: result.taskPlan.tasks,
          criteria: r1Criteria,
          frKeys: r1SliceScope.frKeys
        })
      ).toEqual([]);
      expect(result.taskPlan.tasks.map((task) => task.acKeys ?? null)).toEqual(
        entry.plan.tasks.map((task) => task.acKeys ?? null)
      );
    }
  }, 60_000);
});

describe("F1-3 FX-09 回放：E1 slice-2 attempt 2（T-022 非最终切片 DEPLOY）", () => {
  it("2 条测试先行自动修复 + T-022（非最终切片 DEPLOY）被确定性剔除，同一轮通过（FX-12）", async () => {
    // 复刻断言（修复前原始计划的错误 = E 期录像原文 + 新归属错误码）。
    expect(
      validateTestFirstOrder({
        tasks: r1Attempt2Plan.tasks,
        criteria: r1Criteria,
        frKeys: r1SliceScope.frKeys
      })
    ).toEqual(r1Attempt2TestFirstErrors);
    const rawDag = validateTaskGraph(r1Attempt2Plan, {
      deliveryConfigured: true,
      isFinalSlice: false
    });
    expect(rawDag.errors).toHaveLength(1);
    expect(rawDag.errors[0]).toContain("T-022");
    expect(rawDag.errors[0]).toContain("DELIVERY_TASK_OUTSIDE_FINAL_SLICE");
    expect(rawDag.errors.join("\n")).not.toContain("without a deployable delivery block");

    const { result, model, records } = await runReplay([r1Attempt2Plan, r1Attempt2FixedPlan]);

    // N-41（`docs/232` §T4-8）：交付任务出现在非最终切片，过去要一次 LLM 修复才能收敛；
    // 现在由确定性规则在**同一轮**把它剔出——只跑 1 次规划，不进入 LLM 修复路径。
    expect(model.taskPlanAttempts).toBe(1);

    const failed = records.filter((record) => record.eventType === "TASK_DAG_VALIDATION_FAILED");
    expect(failed).toHaveLength(0);
    const repairs = records.filter((record) => record.eventType === "PLANNING_REPAIR_REQUESTED");
    expect(repairs).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain("without a deployable delivery block");

    // 2 条测试先行边 + 1 条「非最终切片交付任务剔除」；T-022 不再被补块。
    const autoFixed = records.filter((record) => record.eventType === "PLAN_AUTOFIXED");
    const edgeFixes = autoFixed
      .filter((fix) => fix.payload.rule === "test-first-edge")
      .map((fix) => [fix.payload.rule, fix.payload.implementationTaskId, fix.payload.testTaskId]);
    expect(edgeFixes).toEqual([
      ["test-first-edge", "T-005", "T-019"],
      ["test-first-edge", "T-006", "T-019"]
    ]);
    expect(
      autoFixed
        .filter((fix) => fix.payload.rule === "non-final-slice-delivery")
        .map((fix) => fix.payload.taskId)
    ).toEqual(["T-022"]);
    expect(autoFixed.some((fix) => fix.payload.rule === "delivery-block")).toBe(false);
    expect(autoFixed.some((fix) => fix.payload.status === "cycle-blocked")).toBe(false);

    const generated = records.find((record) => record.eventType === "TASK_DAG_GENERATED");
    expect(generated?.payload).toMatchObject({ attempt: 0, taskCount: 16 });

    expect(result.taskPlan.tasks).toHaveLength(16);
    expect(result.taskPlan.tasks.some((task) => task.id === "T-022")).toBe(false);
    expect(
      validateTestFirstOrder({
        tasks: result.taskPlan.tasks,
        criteria: r1Criteria,
        frKeys: r1SliceScope.frKeys
      })
    ).toEqual([]);

    // FX-12：逐 attempt 的 taskCount / errorCount / 自动修复计数可统计（首轮通过率与收敛率可算）。
    const started = records
      .filter((record) => record.eventType === "TASK_DAG_VALIDATION_STARTED")
      .map((record) => [record.payload.attempt, record.payload.taskCount]);
    expect(started).toEqual([[0, 17]]);
    expect(autoFixed.filter((fix) => fix.payload.attempt === 0)).toHaveLength(3);
  }, 60_000);
});
