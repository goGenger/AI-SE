import { BACKEND_NODE_PROFILE, JsonObject } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModelRequest } from "./PlanningModel";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { l1Requirement, l1v5Plan, l1v5SliceScope, l1v5StoredCriteria } from "./l1v5Fixture";

/**
 * F1-2 / FX-04（回放部分）：E-2b 批次 L1 重规划 v5（acKeys 全空，证据面失效的实况输入）。
 * 修复后：原始空键计划随库记录进入规划图 → 确定性回填 → 一次通过校验；
 * 实现类任务 acKeys 非空率 100%、每条 AC 至少映射一个任务（assert 于下方）。
 */

describe("F1-2 FX-04 回放：L1 v5（E-2b 实测）", () => {
  it("空键计划经回填后一次通过；回填事件留痕；映射完整", async () => {
    const events: string[] = [];
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.task_planning = l1v5Plan;

    class ReplayModel extends ScriptedPlanningModel {
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

    const model = new ReplayModel(fixtures);
    const lifecycle: AgentLifecycleHooks = {
      async onEvent(record) {
        events.push(record.eventType);
        records.push({ eventType: record.eventType, payload: record.payload });
      }
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "e5e5e5e5-5555-4555-8555-555555555555",
      taskId: "f6f6f6f6-6666-4666-8666-666666666666",
      requirement: l1Requirement,
      model,
      lifecycle,
      pipeline: "level2",
      slice: l1v5SliceScope,
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis,
      acceptanceCriteria: l1v5StoredCriteria
    });

    expect(model.taskPlanAttempts).toBe(1);
    expect(events).not.toContain("TASK_DAG_VALIDATION_FAILED");
    expect(events).toContain("PLAN_ACKEYS_BACKFILLED");

    // 实现类任务（T2/T3/T4 BACKEND）非空率 100%；每条 AC 至少映射到一个任务。
    const byId = new Map(result.taskPlan.tasks.map((task) => [task.id, task]));
    for (const id of ["T2", "T3", "T4"]) {
      expect(byId.get(id)?.acKeys?.length).toBe(l1v5StoredCriteria.length);
    }
    const mapped = new Set(result.taskPlan.tasks.flatMap((task) => task.acKeys ?? []));
    for (const criterion of l1v5StoredCriteria) {
      expect(mapped.has(criterion.acKey)).toBe(true);
    }

    const backfillEvents = records.filter((entry) => entry.eventType === "PLAN_ACKEYS_BACKFILLED");
    expect(backfillEvents.map((entry) => entry.payload.taskId).sort()).toEqual(["T2", "T3", "T4"]);
    expect((backfillEvents[0]?.payload.added as string[]).length).toBe(l1v5StoredCriteria.length);
  });
});
