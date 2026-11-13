import { AcceptanceCriterion, TaskPlanItem } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { autoFixTaskPlan } from "./autoFixTaskPlan";
import { validateTestFirstOrder } from "./validateTestFirstPlan";

/**
 * F1-3 / FX-10：确定性自动修复层单测。
 * 约束：修复前后差异只含新增依赖边与交付块字段；任务数、AC 映射不变；补块仅发生在最终切片 DEPLOY 上。
 */

const CRITERIA: AcceptanceCriterion[] = [
  {
    acKey: "AC-01",
    text: "AC one is satisfied.",
    priority: "Must",
    verification: null,
    smoke: false,
    frKeys: ["FR-1"]
  }
];

function makeTask(
  id: string,
  type: TaskPlanItem["type"],
  options: {
    acKeys?: string[];
    deps?: string[];
    delivery?: TaskPlanItem["delivery"];
    providesScripts?: string[];
  } = {}
): TaskPlanItem {
  return {
    id,
    title: `Task ${id}`,
    description: `Task ${id} description.`,
    type,
    priority: "MEDIUM",
    dependencies: options.deps ?? [],
    estimatedComplexity: 1,
    acceptanceCriteria: ["Done."],
    ...(options.acKeys ? { acKeys: options.acKeys } : {}),
    ...(options.providesScripts ? { providesScripts: options.providesScripts } : {}),
    sourceSpecTypes: ["FUNCTIONAL"],
    ...(options.delivery ? { delivery: options.delivery } : {})
  };
}

/** 逐任务字段差异（仅列变更字段名，按数组序）。 */
function changedFields(before: TaskPlanItem[], after: TaskPlanItem[]): Record<string, string[]> {
  const byId = new Map(after.map((task) => [task.id, task]));
  const diff: Record<string, string[]> = {};
  for (const task of before) {
    const next = byId.get(task.id);
    if (!next) continue;
    const fields = new Set([...Object.keys(task), ...Object.keys(next)]);
    const changed: string[] = [];
    for (const field of fields) {
      const left = JSON.stringify((task as Record<string, unknown>)[field]);
      const right = JSON.stringify((next as Record<string, unknown>)[field]);
      if (left !== right) changed.push(field);
    }
    if (changed.length > 0) diff[task.id] = changed.sort();
  }
  return diff;
}

describe("F1-3 autoFixTaskPlan（确定性自动修复）", () => {
  it("测试先行补边：只增依赖边；补后校验通过；重复运行幂等", () => {
    const tasks = [
      makeTask("A", "BACKEND", { acKeys: ["AC-01"] }),
      makeTask("B", "TEST", { acKeys: ["AC-01"] })
    ];

    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });

    expect(result.blocked).toEqual([]);
    expect(result.fixes).toEqual([
      {
        rule: "test-first-edge",
        taskId: "A",
        detail: {
          implementationTaskId: "A",
          testTaskId: "B",
          addedDependency: "B",
          sharedAcKeys: ["AC-01"]
        }
      }
    ]);
    expect(result.tasks.map((task) => task.id)).toEqual(["A", "B"]);
    expect(result.tasks.find((task) => task.id === "A")?.dependencies).toEqual(["B"]);
    expect(validateTestFirstOrder({ tasks: result.tasks, criteria: CRITERIA })).toEqual([]);

    const again = autoFixTaskPlan({ tasks: result.tasks, criteria: CRITERIA });
    expect(again.fixes).toEqual([]);
    expect(again.blocked).toEqual([]);
  });

  /**
   * N-46（`docs/232` §9.9）：实测形状——部署类 AC 上模型把 TEST 排在实现之后（「测试依赖实现」），
   * 这是 N4 否定的方向。只记 blocked 会让整片规划连续多轮给出同一种自然顺序并失败，
   * 所以补边成环时先把这条倒置边断开，再补正边。
   */
  it("N-46：补边成环时先断开倒置的「测试依赖实现」边，再补正边（同一轮收敛）", () => {
    const tasks = [
      makeTask("T-A", "TEST", { acKeys: ["AC-01"], deps: ["T-B"] }),
      makeTask("T-B", "BACKEND", { acKeys: ["AC-01"] })
    ];

    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });

    expect(result.blocked).toEqual([]);
    expect(result.fixes).toEqual([
      {
        rule: "test-first-edge",
        taskId: "T-B",
        detail: {
          implementationTaskId: "T-B",
          testTaskId: "T-A",
          addedDependency: "T-A",
          sharedAcKeys: ["AC-01"],
          removedEdges: [{ sourceTaskId: "T-B", targetTaskId: "T-A" }]
        }
      }
    ]);
    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    expect(byId.get("T-B")?.dependencies).toEqual(["T-A"]);
    expect(byId.get("T-A")?.dependencies).toEqual([]);
    expect(validateTestFirstOrder({ tasks: result.tasks, criteria: CRITERIA })).toEqual([]);
  });

  it("N-46：环上没有倒置边 → 仍记 blocked（口径没有放宽）", () => {
    const tasks = [
      makeTask("X", "BACKEND", { acKeys: ["AC-01"] }),
      makeTask("Z", "BUILD", { deps: ["X"] }),
      makeTask("Y", "TEST", { acKeys: ["AC-01"], deps: ["Z"] })
    ];

    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });

    expect(result.fixes).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({ implementationTaskId: "X", testTaskId: "Y" });
    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    expect(byId.get("X")?.dependencies).toEqual([]);
    expect(byId.get("Z")?.dependencies).toEqual(["X"]);
    expect(byId.get("Y")?.dependencies).toEqual(["Z"]);
  });

  it("交付块补全：仅最终切片 + 有环境时补块；覆盖缺失/半缺失/已完整/非可部署动作", () => {
    const missing = makeTask("D1", "DEPLOY");
    const rollbackNoEnv = makeTask("D2", "DEPLOY", { delivery: { action: "ROLLBACK" } });
    const ciAction = makeTask("D3", "DEPLOY", { delivery: { action: "CI", ref: "main" } });
    const complete = makeTask("D4", "DEPLOY", {
      delivery: { action: "DEPLOY", environment: "staging" }
    });
    const ciBuild = makeTask("B1", "BUILD", { delivery: { action: "CI", workflowFile: "ci.yml" } });
    const tasks = [missing, rollbackNoEnv, ciAction, complete, ciBuild];

    // 非最终切片：交付链任务被**确定性剔除**（N-41）。留在这里必然被校验器判死
    // （DELIVERY_TASK_OUTSIDE_FINAL_SLICE），而模型连续三轮修复都不会把它挪走。
    const nonFinal = autoFixTaskPlan({
      tasks,
      criteria: CRITERIA,
      isFinalSlice: false,
      deliveryEnvironment: "staging"
    });
    expect(nonFinal.tasks).toEqual([]);
    expect(nonFinal.fixes.map((fix) => [fix.taskId, fix.rule])).toEqual([
      ["D1", "non-final-slice-delivery"],
      ["D2", "non-final-slice-delivery"],
      ["D3", "non-final-slice-delivery"],
      ["D4", "non-final-slice-delivery"],
      ["B1", "non-final-slice-delivery"]
    ]);

    // 最终切片但无环境：不补块。
    const noEnv = autoFixTaskPlan({ tasks, criteria: CRITERIA, isFinalSlice: true });
    expect(noEnv.fixes).toEqual([]);

    // 最终切片 + 环境：补全缺失字段；已完整的不动；ROLLBACK 保留动作；非可部署动作补正为 DEPLOY。
    const final = autoFixTaskPlan({
      tasks,
      criteria: CRITERIA,
      isFinalSlice: true,
      deliveryEnvironment: "staging"
    });
    const byId = new Map(final.tasks.map((task) => [task.id, task]));
    expect(byId.get("D1")?.delivery).toEqual({ action: "DEPLOY", environment: "staging" });
    expect(byId.get("D2")?.delivery).toEqual({ action: "ROLLBACK", environment: "staging" });
    expect(byId.get("D3")?.delivery).toEqual({
      action: "DEPLOY",
      environment: "staging",
      ref: "main"
    });
    expect(byId.get("D4")?.delivery).toEqual({ action: "DEPLOY", environment: "staging" });
    expect(byId.get("B1")?.delivery).toEqual({ action: "CI", workflowFile: "ci.yml" });
    expect(final.fixes.map((fix) => [fix.taskId, fix.rule])).toEqual([
      ["D1", "delivery-block"],
      ["D2", "delivery-block"],
      ["D3", "delivery-block"]
    ]);
    expect(final.fixes[0]?.detail).toMatchObject({
      taskId: "D1",
      before: null,
      after: { action: "DEPLOY", environment: "staging" }
    });

    // 幂等：补块后重跑零修复。
    const again = autoFixTaskPlan({
      tasks: final.tasks,
      criteria: CRITERIA,
      isFinalSlice: true,
      deliveryEnvironment: "staging"
    });
    expect(again.fixes).toEqual([]);
  });

  it("FX-10 差异面：修复前后差异只含新增依赖边与交付块字段（任务数、AC 映射不变）", () => {
    const tasks = [
      makeTask("A", "BACKEND", { acKeys: ["AC-01"] }),
      makeTask("B", "TEST", { acKeys: ["AC-01"] }),
      makeTask("D1", "DEPLOY", { deps: ["A"] })
    ];

    const result = autoFixTaskPlan({
      tasks,
      criteria: CRITERIA,
      isFinalSlice: true,
      deliveryEnvironment: "staging"
    });

    expect(result.tasks.length).toBe(tasks.length);
    expect(result.tasks.map((task) => task.id)).toEqual(tasks.map((task) => task.id));
    expect(result.tasks.map((task) => task.acKeys ?? null)).toEqual(
      tasks.map((task) => task.acKeys ?? null)
    );
    expect(changedFields(tasks, result.tasks)).toEqual({
      A: ["dependencies"],
      D1: ["delivery"]
    });
    expect(result.fixes.map((fix) => fix.rule).sort()).toEqual([
      "delivery-block",
      "test-first-edge"
    ]);
  });

  it("无 AC 记录（criteria 为空）时不做测试先行补边（保持既有行为）", () => {
    const tasks = [
      makeTask("A", "BACKEND", { acKeys: ["AC-01"] }),
      makeTask("B", "TEST", { acKeys: ["AC-01"] })
    ];
    const result = autoFixTaskPlan({ tasks, criteria: [] });
    expect(result.fixes).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  /**
   * N-70（`docs/232` §10）：第十轮 slice-4 的实值形状。
   *
   * 切片里有两个 TEST 任务覆盖同一 AC：`T1` 写红灯测试、`T3` 收尾验证（规划器把它排在实现之后）。
   * 旧规则逐对要求，于是把 `T2 → T3` 判成倒置边、删掉并反转，验证任务成了 DAG 的根、先跑先红。
   * 按 AC 判定后：`T2` 已依赖 `T1`，AC-01 就满足了，`T3` 的边必须原样保留。
   */
  it("N-70：收尾验证任务排在实现之后时不被反转", () => {
    const tasks = [
      makeTask("T1", "TEST", { acKeys: ["AC-01"] }),
      makeTask("T2", "FRONTEND", { acKeys: ["AC-01"], deps: ["T1"] }),
      makeTask("T3", "TEST", { acKeys: ["AC-01"], deps: ["T2"] })
    ];

    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });

    expect(result.fixes.filter((fix) => fix.rule === "test-first-edge")).toEqual([]);
    expect(result.blocked).toEqual([]);
    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    expect(byId.get("T2")?.dependencies).toEqual(["T1"]);
    expect(byId.get("T3")?.dependencies).toEqual(["T2"]);
    expect(validateTestFirstOrder({ tasks: result.tasks, criteria: CRITERIA })).toEqual([]);
  });
});

describe("PL-M9 9b autoFixTaskPlan 规则 3（脚本提供者先于消费者）", () => {
  /** run 1 slice-1 的实值形状：脚手架（提供者）依赖了 TEST 任务（倒置边）。 */
  function run1Shape(): TaskPlanItem[] {
    return [
      makeTask("T-01", "DESIGN"),
      makeTask("T-02", "TEST", { deps: ["T-01"], acKeys: ["AC-04"] }),
      makeTask("T-03", "TEST", { deps: ["T-01"] }),
      makeTask("T-04", "TEST", { deps: ["T-01"] }),
      makeTask("T-05", "BACKEND", { deps: ["T-04"], providesScripts: ["test", "build"] })
    ];
  }

  it("删倒置边 + 补边：三个 TEST 任务都排到提供者之后（核心判据）", () => {
    const tasks = run1Shape();
    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });

    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    for (const id of ["T-02", "T-03", "T-04"]) {
      expect(byId.get(id)?.dependencies).toContain("T-05");
    }
    // 倒置边 T-05 → T-04 已断开。
    expect(byId.get("T-05")?.dependencies).toEqual([]);
    const fixes = result.fixes.filter((fix) => fix.rule === "script-provider-edge");
    expect(fixes.map((fix) => fix.taskId).sort()).toEqual(["T-02", "T-03", "T-04"]);
    expect(fixes[0]?.detail.removedEdges).toBeDefined();
    // 无环（拓扑可达：T-05 是根）。
    expect(byId.get("T-05")?.dependencies).not.toContain("T-04");
    expect(result.blocked).toEqual([]);
  });

  it("已满足（TEST 已传递依赖提供者）→ 不动", () => {
    const tasks = run1Shape();
    tasks[1]!.dependencies = ["T-01", "T-05"];
    tasks[2]!.dependencies = ["T-01", "T-05"];
    tasks[3]!.dependencies = ["T-01", "T-05"];
    tasks[4]!.dependencies = [];
    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });
    expect(result.fixes.filter((fix) => fix.rule === "script-provider-edge")).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("无提供者声明 → 规则 3 不介入（退路口径）", () => {
    const tasks = run1Shape().map(({ providesScripts: _drop, ...rest }) => rest) as TaskPlanItem[];
    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });
    expect(result.fixes.filter((fix) => fix.rule === "script-provider-edge")).toEqual([]);
  });

  it("倒置边恰是 N4 强制的边 → 不删边、记 blocked（无解冲突交 LLM 修复轮）", () => {
    const tasks = [
      // 提供者本身是实现类任务，且与 TEST 共享 AC-01 → N4 要求 P → C，9b 要求 C → P。
      makeTask("P", "BACKEND", { acKeys: ["AC-01"], deps: ["C"], providesScripts: ["test"] }),
      makeTask("C", "TEST", { acKeys: ["AC-01"] })
    ];
    const result = autoFixTaskPlan({ tasks, criteria: CRITERIA });
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({
      implementationTaskId: "P",
      testTaskId: "C",
      rule: "script-provider-edge"
    });
    // 边未被改动（N4 的边保留）。
    const byId = new Map(result.tasks.map((task) => [task.id, task]));
    expect(byId.get("P")?.dependencies).toEqual(["C"]);
    expect(byId.get("C")?.dependencies).toEqual([]);
  });

  it("幂等：重复运行不再产生规则 3 的 fix", () => {
    const first = autoFixTaskPlan({ tasks: run1Shape(), criteria: CRITERIA });
    const second = autoFixTaskPlan({ tasks: first.tasks, criteria: CRITERIA });
    expect(second.fixes.filter((fix) => fix.rule === "script-provider-edge")).toEqual([]);
    expect(second.blocked).toEqual([]);
  });

  /**
   * N-41（`docs/232` §T4-8）：规划器把 BUILD/DEPLOY 放进非最终切片，校验器判死整片，
   * 而模型连续三轮修复都不挪走它——整次运行的规划死在这里。规则 0 做确定性剔除。
   */
  it("N-41：非最终切片剔除交付链任务，保留其余任务并清掉悬空依赖", () => {
    const impl = makeTask("T1", "BACKEND");
    const test = makeTask("T2", "TEST", { deps: ["T1"] });
    const deploy = makeTask("D1", "DEPLOY");
    const build = makeTask("B1", "BUILD", {
      deps: ["T2"],
      delivery: { action: "CI", workflowFile: "ci.yml" }
    });
    const dependent = makeTask("T3", "FRONTEND", { deps: ["T2", "B1"] });
    const tasks = [impl, test, deploy, build, dependent];

    const nonFinal = autoFixTaskPlan({ tasks, criteria: CRITERIA, isFinalSlice: false });
    expect(nonFinal.tasks.map((task) => task.id)).toEqual(["T1", "T2", "T3"]);
    // 悬空依赖被清掉：T3 原本依赖被删的 B1。
    expect(nonFinal.tasks.find((task) => task.id === "T3")?.dependencies).toEqual(["T2"]);
    expect(
      nonFinal.fixes
        .filter((fix) => fix.rule === "non-final-slice-delivery")
        .map((fix) => fix.taskId)
        .sort()
    ).toEqual(["B1", "D1"]);

    // 最终切片与单级规划（undefined）不得删任务——那是交付任务该待的地方。
    for (const isFinalSlice of [true, undefined]) {
      const kept = autoFixTaskPlan({
        tasks,
        criteria: CRITERIA,
        ...(isFinalSlice === undefined ? {} : { isFinalSlice })
      });
      expect(kept.tasks.map((task) => task.id)).toEqual(["T1", "T2", "D1", "B1", "T3"]);
      expect(kept.fixes.filter((fix) => fix.rule === "non-final-slice-delivery")).toEqual([]);
    }
  });
});
