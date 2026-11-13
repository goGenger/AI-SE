import { AcceptanceCriterion } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { findUnanchoredTestTasks, validateTaskAnchors } from "./validateTaskAnchors";
import type { TestFirstTask } from "./validateTestFirstPlan";

/**
 * PL-M7（`docs/164` §3，严重度按 `docs/165` §2 更正）：7a 越界引用 = 硬错误；7b 无锚点 TEST 任务
 * = 观察项。含 PL-M4 run 1 slice-1 的回归复现。
 */

function criterion(
  overrides: Partial<AcceptanceCriterion> & { acKey: string }
): AcceptanceCriterion {
  return {
    text: `Criterion ${overrides.acKey}`,
    priority: "Must",
    verification: null,
    smoke: false,
    frKeys: ["FR-1"],
    ...overrides
  };
}

/** PL-M4 run 1 的 slice-1 实况（`docs/164` §2）：范围内 AC 只有 AC-04。 */
const runOneCriteria = [
  criterion({ acKey: "AC-04", frKeys: ["FR-7"], verification: "文件扫描" }),
  criterion({ acKey: "AC-25", frKeys: ["FR-8"], verification: "容器运行" }),
  criterion({ acKey: "AC-30", frKeys: ["FR-9"], verification: "命令执行 + 测试名解析" })
];
const sliceOneFrKeys = ["FR-9", "FR-7"];

describe("validateTaskAnchors（PL-M7 7a：越界引用）", () => {
  it("flags an anchor outside the slice scope on any task type", () => {
    const tasks: TestFirstTask[] = [
      // AC-25 属 FR-8（slice-2）且为全局性 AC → 非最终切片双重越界。
      { id: "T-11", type: "TEST", acKeys: ["AC-25"], dependencies: [] },
      // AC-30 的 FR 命中（FR-9）但它是全局性 AC → 同样越界（既有 GLOBAL 守卫的同口径）。
      { id: "T-05", type: "BACKEND", acKeys: ["AC-30"], dependencies: [] }
    ];
    const errors = validateTaskAnchors({
      criteria: runOneCriteria,
      frKeys: sliceOneFrKeys,
      isFinalSlice: false,
      tasks
    });

    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error.includes("PLAN_ANCHOR_OUT_OF_SCOPE"))).toBe(true);
    expect(errors.some((error) => error.includes("T-11") && error.includes("AC-25"))).toBe(true);
    expect(errors.some((error) => error.includes("T-05") && error.includes("AC-30"))).toBe(true);
    expect(errors[0]).toContain("AC-4"); // 范围内清单写进信息，供修复轮机械对齐
  });

  it("accepts in-scope anchors in both namespaces", () => {
    const errors = validateTaskAnchors({
      criteria: runOneCriteria,
      frKeys: sliceOneFrKeys,
      isFinalSlice: false,
      tasks: [
        { id: "T-02", type: "TEST", acKeys: ["AC-04"], dependencies: [] },
        // FR 命名空间：slice-1 的编号 AC 只有一条，FR 子项工作（FR-7-1 / FR-9-1）靠 FR 锚点表达。
        { id: "T-03", type: "TEST", acKeys: ["FR-7"], dependencies: [] },
        { id: "T-04", type: "TEST", acKeys: ["[FR-009]"], dependencies: [] },
        { id: "T-07", type: "BACKEND", acKeys: ["ac-4"], dependencies: [] }
      ]
    });

    expect(errors).toEqual([]);
  });

  it("flags an FR anchor outside the slice scope", () => {
    const errors = validateTaskAnchors({
      criteria: runOneCriteria,
      frKeys: sliceOneFrKeys,
      isFinalSlice: false,
      tasks: [{ id: "T-11", type: "TEST", acKeys: ["FR-8"], dependencies: [] }]
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FR-8");
  });

  it("does not flag a task that simply declares nothing (that is 7b, an observation)", () => {
    // run 1 的 T-10 形状：BACKEND、无 acKeys、无越界引用 → 7a 不报。
    expect(
      validateTaskAnchors({
        criteria: runOneCriteria,
        frKeys: sliceOneFrKeys,
        isFinalSlice: false,
        tasks: [{ id: "T-10", type: "BACKEND", dependencies: [] }]
      })
    ).toEqual([]);
  });

  it("leaves the final slice and the non-sliced mode untouched", () => {
    const tasks: TestFirstTask[] = [
      { id: "T-11", type: "TEST", dependencies: [] },
      { id: "T-12", type: "TEST", acKeys: ["AC-25"], dependencies: [] }
    ];

    expect(
      validateTaskAnchors({
        criteria: runOneCriteria,
        frKeys: sliceOneFrKeys,
        isFinalSlice: true,
        tasks
      })
    ).toEqual([]);
    expect(
      validateTaskAnchors({ criteria: runOneCriteria, frKeys: sliceOneFrKeys, tasks })
    ).toEqual([]);
  });

  it("skips validation when the requirement has no numbered criteria", () => {
    // ScriptedPlanningModel 的 todo 夹具形状：切片有 FR 范围、计划里有 TEST 任务，但需求没有编号
    // AC 记录（`acProtection = none`）——此时不该由本校验器单独要求锚点。
    expect(
      validateTaskAnchors({
        criteria: [],
        frKeys: ["FR-001", "FR-002"],
        isFinalSlice: false,
        tasks: [{ id: "TASK-005", type: "TEST", dependencies: ["TASK-003"] }]
      })
    ).toEqual([]);
  });

  it("skips validation when the slice scope is empty", () => {
    expect(
      validateTaskAnchors({
        criteria: [],
        frKeys: [],
        isFinalSlice: false,
        tasks: [{ id: "T-11", type: "TEST", dependencies: [] }]
      })
    ).toEqual([]);
  });
});

describe("findUnanchoredTestTasks（PL-M7 7b：观察项，不产生错误）", () => {
  it("reports the unanchored TEST task of run 1 slice-1 and ignores non-TEST tasks", () => {
    const findings = findUnanchoredTestTasks({
      criteria: runOneCriteria,
      frKeys: sliceOneFrKeys,
      isFinalSlice: false,
      tasks: [
        { id: "T-10", type: "BACKEND", dependencies: [] },
        { id: "T-11", type: "TEST", dependencies: [] }
      ]
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.taskId).toBe("T-11");
    expect(findings[0]?.inScope).toContain("AC-4");
  });

  it("does not report an anchored TEST task, and reports one whose only entries are unparseable", () => {
    expect(
      findUnanchoredTestTasks({
        criteria: runOneCriteria,
        frKeys: sliceOneFrKeys,
        isFinalSlice: false,
        tasks: [{ id: "T-02", type: "TEST", acKeys: ["AC-04"], dependencies: [] }]
      })
    ).toEqual([]);

    // "FR-7-1" 不是规范锚点（backfill 以 PLAN_ACKEYS_INVALID 报出）→ 视为无锚点。
    expect(
      findUnanchoredTestTasks({
        criteria: runOneCriteria,
        frKeys: sliceOneFrKeys,
        isFinalSlice: false,
        tasks: [{ id: "T-03", type: "TEST", acKeys: ["FR-7-1"], dependencies: [] }]
      })
    ).toHaveLength(1);
  });

  it("stays silent outside the non-final sliced mode and without numbered criteria", () => {
    const tasks: TestFirstTask[] = [{ id: "T-11", type: "TEST", dependencies: [] }];

    expect(
      findUnanchoredTestTasks({
        criteria: runOneCriteria,
        frKeys: sliceOneFrKeys,
        isFinalSlice: true,
        tasks
      })
    ).toEqual([]);
    expect(
      findUnanchoredTestTasks({
        criteria: [],
        frKeys: ["FR-001", "FR-002"],
        isFinalSlice: false,
        tasks: [{ id: "TASK-005", type: "TEST", dependencies: [] }]
      })
    ).toEqual([]);
  });
});
