import { BACKEND_NODE_PROFILE, JsonObject, TaskPlan, TaskPlanItem } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { runPlanningGraph } from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { s1Requirement, s1v4SliceScope, s1v4StoredCriteria } from "./s1v4Fixture";

/**
 * PL-M9 9b（`docs/166` §3）：图级联合验证——计划期守卫与确定性修复的接线。
 *
 * 夹具形状取自 PL-M4 run 1 的 slice-1 实值计划（`docs/166` §2.1 ①）：脚手架任务声明它创建的
 * script，却被排在三个 TEST 任务**之后**，且**依赖**其中一个（倒置边）。修复层必须断开倒置边
 * 并把提供者排到消费者之前，否则三个 TEST 任务的红灯检查会在 `test` script 存在之前运行。
 */

type PlanTask = TaskPlanItem;

function planTask(
  id: string,
  type: PlanTask["type"],
  dependencies: string[],
  providesScripts?: string[]
): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Task ${id} description.`,
    type,
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 2,
    acceptanceCriteria: ["done"],
    sourceSpecTypes: ["FUNCTIONAL"],
    ...(providesScripts ? { providesScripts } : {})
  };
}

function providerPlan(): TaskPlan {
  return {
    summary: "PL-M9 9b graph-level replay (run 1 slice-1 shape)",
    tasks: [
      planTask("T-01", "DESIGN", []),
      planTask("T-02", "TEST", ["T-01"]),
      planTask("T-03", "TEST", ["T-01"]),
      planTask("T-04", "TEST", ["T-01"]),
      // run 1 的倒置边：提供者依赖消费者。
      planTask("T-05", "BACKEND", ["T-04"], ["test", "build"])
    ]
  };
}

async function runGraph(plan: TaskPlan) {
  const events: Array<{ eventType: string; payload: JsonObject }> = [];
  const fixtures = createTodoPlanningFixtures();
  fixtures.task_planning = plan;
  const lifecycle: AgentLifecycleHooks = {
    async onEvent(record) {
      events.push({ eventType: record.eventType, payload: record.payload });
    }
  };
  const result = await runPlanningGraph({
    profile: BACKEND_NODE_PROFILE,
    agentRunId: "c1c1c1c1-1111-4111-8111-111111111111",
    taskId: "d2d2d2d2-2222-4222-8222-222222222222",
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
  return { result, events };
}

describe("PL-M9 9b（图级）", () => {
  it("run 1 形状：自动修复断倒置边并补边，计划通过且提供者排到三个 TEST 任务之前", async () => {
    const { result, events } = await runGraph(providerPlan());

    // 计划通过（修复后守卫无输入）。
    expect(events.map((entry) => entry.eventType)).not.toContain("TASK_DAG_VALIDATION_FAILED");

    const fixes = events.filter(
      (entry) =>
        entry.eventType === "PLAN_AUTOFIXED" && entry.payload.rule === "script-provider-edge"
    );
    expect(fixes.map((entry) => entry.payload.taskId).sort()).toEqual(["T-02", "T-03", "T-04"]);

    const byId = new Map(result.taskPlan.tasks.map((task) => [task.id, task]));
    // 提供者成为根（倒置边 T-05 → T-04 已断开）。
    expect(byId.get("T-05")?.dependencies).toEqual([]);
    // 三个 TEST 任务都依赖提供者。
    for (const id of ["T-02", "T-03", "T-04"]) {
      expect(byId.get(id)?.dependencies).toContain("T-05");
    }
  });

  it("无提供者声明时规则 3 不介入（既有计划形状不受影响）", async () => {
    const plan = providerPlan();
    for (const task of plan.tasks) delete task.providesScripts;
    const { events } = await runGraph(plan);
    expect(
      events.filter(
        (entry) =>
          entry.eventType === "PLAN_AUTOFIXED" && entry.payload.rule === "script-provider-edge"
      )
    ).toEqual([]);
  });
});
