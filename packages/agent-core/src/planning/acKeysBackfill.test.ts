import { AcceptanceCriterion, TaskPlan } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { backfillTaskPlanAcKeys } from "./acKeysBackfill";
import { s1v4Plan, s1v4SliceScope, s1v4StoredCriteria } from "./s1v4Fixture";

/** F1-2：acKeys 确定性回填（纯规则单测；FX-04 单测部分 / FX-05）。 */

type PlanTask = TaskPlan["tasks"][number];

function criterion(acKey: string, frKeys: string[] = []): AcceptanceCriterion {
  return {
    acKey,
    text: `Criterion ${acKey}`,
    priority: "Must",
    verification: null,
    smoke: false,
    frKeys
  };
}

function planTask(
  id: string,
  type: PlanTask["type"],
  acKeys?: string[],
  dependencies: string[] = []
): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Task ${id} description.`,
    type,
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 1,
    acceptanceCriteria: [`Task ${id} is done.`],
    sourceSpecTypes: ["FUNCTIONAL"],
    ...(acKeys !== undefined ? { acKeys } : {})
  };
}

describe("backfillTaskPlanAcKeys（F1-2：确定性回填）", () => {
  it("FX-05①：AC-x 写法解析并按记录规范键对齐（大小写/前导零归一）", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [planTask("T1", "BACKEND", ["ac-1", "AC-02"])],
      criteria: [criterion("AC-01"), criterion("AC-02")]
    });

    expect(result.errors).toEqual([]);
    expect(result.tasks[0]?.acKeys).toEqual(["AC-01", "AC-02"]);
    expect(result.changes).toEqual([
      {
        taskId: "T1",
        before: ["ac-1", "AC-02"],
        after: ["AC-01", "AC-02"],
        added: [],
        expanded: [],
        dropped: []
      }
    ]);
  });

  it("FX-05②：FR-x（含 [FR-001] 方括号）按 FR/AC 记录展开为 AC 键", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [planTask("T1", "BACKEND", ["[FR-001]", "FR-2"])],
      criteria: [
        criterion("AC-01", ["FR-1"]),
        criterion("AC-02", ["FR-1"]),
        criterion("AC-03", ["FR-2"])
      ]
    });

    expect(result.errors).toEqual([]);
    expect(result.tasks[0]?.acKeys).toEqual(["AC-01", "AC-02", "AC-03"]);
    expect(result.changes[0]?.expanded).toEqual([
      { ref: "[FR-001]", acKeys: ["AC-01", "AC-02"] },
      { ref: "FR-2", acKeys: ["AC-03"] }
    ]);
  });

  it("FX-05③：未知格式明确报错（PLAN_ACKEYS_INVALID）并移除该条目", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [planTask("T1", "BACKEND", ["TS-1", "garbage"])],
      criteria: [criterion("AC-01")]
    });

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("PLAN_ACKEYS_INVALID");
    expect(result.errors[0]).toContain("TS-1");
    // 未知条目被移除；AC-01 未被引用 → 回填到实现类任务。
    expect(result.tasks[0]?.acKeys).toEqual(["AC-01"]);
    expect(result.changes[0]?.dropped).toEqual(["TS-1", "garbage"]);
  });

  it("范围回填：未被引用的 AC 落到实现类任务（多目标任务一致；TEST 任务不新增共享面）", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [
        planTask("T2", "BACKEND", ["AC-01"]),
        planTask("T3", "FRONTEND", [], ["T2"]),
        planTask("T4", "TEST", ["AC-01"], ["T2", "T3"])
      ],
      criteria: [criterion("AC-01"), criterion("AC-02"), criterion("AC-03")]
    });

    expect(result.errors).toEqual([]);
    expect(result.tasks[0]?.acKeys).toEqual(["AC-01", "AC-02", "AC-03"]);
    expect(result.tasks[1]?.acKeys).toEqual(["AC-02", "AC-03"]);
    expect(result.tasks[2]?.acKeys).toEqual(["AC-01"]);
    expect(result.changes.map((change) => change.taskId).sort()).toEqual(["T2", "T3"]);
  });

  it("无 AC 记录：不做回填（不回填、无事件；空键任务保持空）", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [planTask("T2", "BACKEND"), planTask("T5", "TEST")],
      criteria: []
    });

    expect(result.errors).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.tasks[0]?.acKeys).toBeUndefined();
    expect(result.tasks[1]?.acKeys).toBeUndefined();
  });

  it("幂等：对回填结果再次回填不产生任何变化", () => {
    const first = backfillTaskPlanAcKeys({
      tasks: s1v4Plan.tasks,
      criteria: s1v4StoredCriteria,
      frKeys: s1v4SliceScope.frKeys
    });
    const second = backfillTaskPlanAcKeys({
      tasks: first.tasks,
      criteria: s1v4StoredCriteria,
      frKeys: s1v4SliceScope.frKeys
    });

    expect(second.changes).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.tasks).toEqual(first.tasks);
  });

  it("FX-04（单测部分）：S1 v4 真实计划回填后——实现类任务非空、每条 AC 至少映射一个任务", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: s1v4Plan.tasks,
      criteria: s1v4StoredCriteria,
      frKeys: s1v4SliceScope.frKeys
    });

    expect(result.errors).toEqual([]);
    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    // S1 v4：T1 DESIGN / T2 BACKEND / T3 TEST / T4 TEST / T5 BUILD / T6 REVIEW。
    const backend = byId.get("T2");
    expect(backend?.acKeys?.length).toBe(s1v4StoredCriteria.length);
    expect(backend?.acKeys).toEqual(s1v4StoredCriteria.map((criterion) => criterion.acKey));

    const mapped = new Set(result.tasks.flatMap((task) => task.acKeys ?? []));
    for (const criterion of s1v4StoredCriteria) {
      expect(mapped.has(criterion.acKey)).toBe(true);
    }
    // 回填只落在实现类任务；TEST/其他任务保持缺省。
    expect(byId.get("T3")?.acKeys).toBeUndefined();
    expect(byId.get("T6")?.acKeys).toBeUndefined();
  });

  it("已完整映射的计划不产生任何变化（LLM 计划不被改写）", () => {
    const result = backfillTaskPlanAcKeys({
      tasks: [
        planTask("T-04", "BACKEND", ["AC-01", "AC-02"]),
        planTask("T-05", "TEST", ["AC-01", "AC-02"], ["T-04"])
      ],
      criteria: [criterion("AC-01"), criterion("AC-02")]
    });

    expect(result.changes).toEqual([]);
    expect(result.tasks[0]?.acKeys).toEqual(["AC-01", "AC-02"]);
  });
});
