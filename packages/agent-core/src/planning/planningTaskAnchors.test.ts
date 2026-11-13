import { BACKEND_NODE_PROFILE, AcceptanceCriterion, JsonObject, TaskPlan } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { s1Requirement, s1v4SliceScope, s1v4StoredCriteria } from "./s1v4Fixture";

/**
 * PL-M7（`docs/164` §3，严重度按 `docs/165` §2 更正）：图级联合验证。
 * - 7b（观察项）：非最终切片里无锚点的 TEST 任务 → 发 `PLAN_TEST_TASK_UNANCHORED`，**计划仍通过**；
 * - 7a（硬错误）：任务声明切片范围外的 AC → `PLAN_ANCHOR_OUT_OF_SCOPE` 进入 `errors[]` → 修复轮耗尽后失败。
 */

function anchorPlan(overrides: { testAcKeys?: string[]; backendAcKeys?: string[] }): TaskPlan {
  return {
    summary: "PL-M7 graph-level replay",
    tasks: [
      {
        id: "T-01",
        title: "Implement slugify",
        description: "Implement the slugify pipeline.",
        type: "BACKEND",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 2,
        acceptanceCriteria: ["slugify works"],
        sourceSpecTypes: ["FUNCTIONAL"],
        ...(overrides.backendAcKeys ? { acKeys: overrides.backendAcKeys } : {})
      },
      {
        id: "T-02",
        title: "Integration tests",
        description: "Cover the slugify flow end to end.",
        type: "TEST",
        priority: "MEDIUM",
        dependencies: ["T-01"],
        estimatedComplexity: 2,
        acceptanceCriteria: ["flow covered"],
        sourceSpecTypes: ["FUNCTIONAL"],
        ...(overrides.testAcKeys ? { acKeys: overrides.testAcKeys } : {})
      }
    ]
  };
}

describe("PL-M7（图级）", () => {
  it("7b：无锚点的 TEST 任务只产生观察事件，计划仍然通过", async () => {
    const events: string[] = [];
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = anchorPlan({});
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        events.push(record.eventType);
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "e1e1e1e1-1111-4111-8111-111111111111",
      taskId: "f2f2f2f2-2222-4222-8222-222222222222",
      requirement: s1Requirement,
      model: new ScriptedPlanningModel(fixtures),
      lifecycle,
      pipeline: "level2",
      slice: s1v4SliceScope,
      isFinalSlice: false,
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis,
      acceptanceCriteria: s1v4StoredCriteria
    });

    // 观察项：事件有，错误没有。
    const observation = records.find((entry) => entry.eventType === "PLAN_TEST_TASK_UNANCHORED");
    expect(observation?.payload.taskId).toBe("T-02");
    expect(events).not.toContain("TASK_DAG_VALIDATION_FAILED");
    expect(result.taskPlan.tasks.some((task) => task.id === "T-02")).toBe(true);
  });

  it("7a：声明切片范围外的 AC → PLAN_ANCHOR_OUT_OF_SCOPE 拦截", async () => {
    const events: string[] = [];
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    // AC-99 属 FR-99，不在 slice 的 frKeys（FR-1..FR-4 / FR-8）内 → 范围外。
    const outside: AcceptanceCriterion = {
      acKey: "AC-99",
      text: "Owned by another slice.",
      priority: null,
      verification: null,
      smoke: false,
      frKeys: ["FR-99"]
    };
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = anchorPlan({ backendAcKeys: ["AC-99"] });
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        events.push(record.eventType);
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    await expect(
      runPlanningGraph({
        profile: BACKEND_NODE_PROFILE,
        agentRunId: "a3a3a3a3-3333-4333-8333-333333333333",
        taskId: "b4b4b4b4-4444-4444-8444-444444444444",
        requirement: s1Requirement,
        model: new ScriptedPlanningModel(fixtures),
        lifecycle,
        pipeline: "level2",
        slice: s1v4SliceScope,
        isFinalSlice: false,
        skipStages: ["ui_spec"],
        seedAnalysis: fixtures.requirement_analysis,
        acceptanceCriteria: [...s1v4StoredCriteria, outside]
      })
    ).rejects.toThrow(/PLAN_ANCHOR_OUT_OF_SCOPE/);

    const failed = records.find((entry) => entry.eventType === "TASK_DAG_VALIDATION_FAILED");
    const errors = (failed?.payload.validationErrors ?? []) as string[];
    expect(errors.some((error) => error.includes("PLAN_ANCHOR_OUT_OF_SCOPE"))).toBe(true);
    expect(errors.some((error) => error.includes("AC-99"))).toBe(true);
  });
});
