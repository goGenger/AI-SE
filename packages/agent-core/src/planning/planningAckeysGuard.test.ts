import { BACKEND_NODE_PROFILE, JsonObject, Requirement } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModelRequest } from "./PlanningModel";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { s1Requirement, s1v4Plan, s1v4SliceScope, s1v4StoredCriteria } from "./s1v4Fixture";
import { validateAcceptanceCoverage } from "./validateAcceptanceCoverage";
import { validateMustAcTestCoverage, validateTestFirstOrder } from "./validateTestFirstPlan";
import { validateTaskGraph } from "./validateTaskGraph";

/**
 * F1-1 / F1-2：AC 保护缺输入守卫 + 确定性回填的图级联合验证。
 * - FX-02：无 AC 记录 → 允许跳过并显式标注 acProtection=none；
 * - FX-03 前段：修复前证词——R2 计划（S1 v4，acKeys 全空）在旧校验集下零错误（整体空转）；
 * - FX-03 后段（F1-2 落地口径，docs/129 F1-2 节记录口径调整）：同一原始输入经确定性回填后
 *   一次通过校验，回填差异有事件留痕——空键计划不再到达守卫；守卫改由「无可回填目标」用例覆盖；
 * - 守卫兜底：记录存在但计划无可回填目标（无实现类 / TEST 任务）时仍以 PLAN_ACKEYS_MISSING 拦截。
 */

function unnumberedRequirement(): Requirement {
  const timestamp = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Todo 管理系统",
    description: "Planning sample",
    rawContent: "创建一个简单的 Todo 管理系统，支持用户创建、查看、修改和删除 Todo。",
    status: "DRAFT",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

class TaskPlanReplayModel extends ScriptedPlanningModel {
  taskPlanAttempts = 0;

  override async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    if (request.stage === "task_planning") {
      this.taskPlanAttempts += 1;
    }
    return super.generateStructured(request);
  }
}

describe("F1-1 AC 保护缺输入守卫（图级）", () => {
  it("FX-02：需求无 AC 记录 → 跳过并在计划产出与事件中标注 acProtection=none", async () => {
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "c3c3c3c3-3333-4333-8333-333333333333",
      taskId: "d4d4d4d4-4444-4444-8444-444444444444",
      requirement: unnumberedRequirement(),
      model: new ScriptedPlanningModel(),
      lifecycle
    });

    expect(result.taskPlan.tasks.length).toBeGreaterThan(0);

    const marker = records.find((entry) => entry.eventType === "AC_PROTECTION_NONE");
    expect(marker?.payload.acProtection).toBe("none");

    const dag = records.find((entry) => entry.eventType === "TASK_DAG_GENERATED");
    expect(dag?.payload.acProtection).toBe("none");

    const completed = records.find((entry) => entry.eventType === "TASK_PLANNING_COMPLETED");
    expect(completed?.payload.acProtection).toBe("none");
  });

  it("FX-03 前段：修复前校验集对 S1 v4 计划零错误（静默跳过证词）", () => {
    const legacyTasks = s1v4Plan.tasks.map((task) => ({
      id: task.id,
      type: task.type,
      acKeys: task.acKeys,
      dependencies: task.dependencies
    }));

    // 无编号 PRD 解析为空、库记录未被消费 → 旧校验集整体空转："先实现后测试"的计划被放行。
    expect(validateTaskGraph(s1v4Plan).errors).toEqual([]);
    expect(validateAcceptanceCoverage({ criteria: [], tasks: legacyTasks })).toEqual([]);
    expect(validateTestFirstOrder({ criteria: [], tasks: legacyTasks })).toEqual([]);
    expect(validateMustAcTestCoverage({ criteria: [], tasks: legacyTasks })).toEqual([]);
  });

  it("FX-03 后段（F1-2 落地口径）：S1 v4 原始空键计划经回填后一次通过，回填差异有事件留痕", async () => {
    const events: string[] = [];
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = s1v4Plan;

    const model = new TaskPlanReplayModel(fixtures);
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        events.push(record.eventType);
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "a1a1a1a1-1111-4111-8111-111111111111",
      taskId: "b2b2b2b2-2222-4222-8222-222222222222",
      requirement: s1Requirement,
      model,
      lifecycle,
      pipeline: "level2",
      slice: s1v4SliceScope,
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis,
      acceptanceCriteria: s1v4StoredCriteria
    });

    expect(model.taskPlanAttempts).toBe(1);
    expect(events).not.toContain("TASK_DAG_VALIDATION_FAILED");
    expect(events).toContain("PLAN_ACKEYS_BACKFILLED");

    const backfilled = records.find((entry) => entry.eventType === "PLAN_ACKEYS_BACKFILLED");
    expect(backfilled?.payload.taskId).toBe("T2");
    expect(backfilled?.payload.before).toEqual([]);
    expect((backfilled?.payload.after as string[]).length).toBe(s1v4StoredCriteria.length);

    const mapped = new Set(result.taskPlan.tasks.flatMap((task) => task.acKeys ?? []));
    for (const criterion of s1v4StoredCriteria) {
      expect(mapped.has(criterion.acKey)).toBe(true);
    }
  });

  it("守卫兜底：记录存在但计划无可回填目标 → PLAN_ACKEYS_MISSING 拦截（F1-1 语义保留）", async () => {
    const events: string[] = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = {
      summary: "no fill targets",
      tasks: [
        {
          id: "T-A",
          title: "Design",
          description: "Design only.",
          type: "DESIGN",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 1,
          acceptanceCriteria: ["Design completed."],
          sourceSpecTypes: ["FUNCTIONAL"]
        },
        {
          id: "T-B",
          title: "Review",
          description: "Review only.",
          type: "REVIEW",
          priority: "HIGH",
          dependencies: ["T-A"],
          estimatedComplexity: 1,
          acceptanceCriteria: ["Review completed."],
          sourceSpecTypes: ["FUNCTIONAL"]
        }
      ]
    };

    const model = new TaskPlanReplayModel(fixtures);
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        events.push(record.eventType);
      }
    };

    await expect(
      runPlanningGraph({
        profile: BACKEND_NODE_PROFILE,
        agentRunId: "c7c7c7c7-7777-4777-8777-777777777777",
        taskId: "d8d8d8d8-8888-4888-8888-888888888888",
        requirement: s1Requirement,
        model,
        lifecycle,
        pipeline: "level2",
        slice: s1v4SliceScope,
        skipStages: ["ui_spec"],
        seedAnalysis: fixtures.requirement_analysis,
        acceptanceCriteria: s1v4StoredCriteria
      })
    ).rejects.toThrow(/PLAN_ACKEYS_MISSING/);

    expect(model.taskPlanAttempts).toBe(3);
    expect(events.filter((event) => event === "TASK_DAG_VALIDATION_FAILED")).toHaveLength(3);
    expect(events.filter((event) => event === "PLANNING_REPAIR_REQUESTED")).toHaveLength(2);
  });
});
