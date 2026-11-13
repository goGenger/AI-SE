import { AcceptanceCriterion } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  slice5Run3Criteria,
  slice5Run3ImplementationCoverageErrors,
  slice5Run3SliceScope,
  slice5Run3Tasks
} from "./slice5Run3Fixture";
import { validateAcceptanceCoverage } from "./validateAcceptanceCoverage";
import { validateImplementationCoverage } from "./validateImplementationCoverage";
import { validateMustAcTestCoverage, validateTestFirstOrder } from "./validateTestFirstPlan";
import type { TestFirstTask } from "./validateTestFirstPlan";

/** PL-M1（`docs/158` §3）：实现覆盖校验器单测 + run 3 slice-5 回归复现。 */

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

const criteria = [criterion({ acKey: "AC-01" }), criterion({ acKey: "AC-02", priority: "Should" })];

describe("validateImplementationCoverage", () => {
  it("flags a Must AC covered only by a TEST task", () => {
    const errors = validateImplementationCoverage({
      criteria,
      tasks: [
        { id: "T1", type: "TEST", acKeys: ["AC-01"], dependencies: [] },
        { id: "T2", type: "BACKEND", acKeys: ["AC-02"], dependencies: [] }
      ]
    });
    expect(errors).toEqual(["Must acceptance criterion AC-01 has no implementation task coverage."]);
  });

  it("flags a Must AC covered by nothing at all", () => {
    expect(
      validateImplementationCoverage({
        criteria,
        tasks: [{ id: "T1", type: "BACKEND", acKeys: ["AC-02"], dependencies: [] }]
      })
    ).toEqual(["Must acceptance criterion AC-01 has no implementation task coverage."]);
  });

  it("accepts coverage by each implementation type (BACKEND / FRONTEND / DATABASE)", () => {
    for (const type of ["BACKEND", "FRONTEND", "DATABASE"] as const) {
      expect(
        validateImplementationCoverage({
          criteria,
          tasks: [{ id: "T1", type, acKeys: ["AC-01"], dependencies: [] }]
        })
      ).toEqual([]);
    }
  });

  it("does not count non-implementation types as coverage (BUILD / DEPLOY / REVIEW / DEBUG / ANALYSIS / DESIGN)", () => {
    for (const type of ["BUILD", "DEPLOY", "REVIEW", "DEBUG", "ANALYSIS", "DESIGN"] as const) {
      expect(
        validateImplementationCoverage({
          criteria,
          tasks: [{ id: "T1", type, acKeys: ["AC-01"], dependencies: [] }]
        })
      ).toEqual(["Must acceptance criterion AC-01 has no implementation task coverage."]);
    }
  });

  it("accepts a Must AC that has both TEST and implementation coverage", () => {
    expect(
      validateImplementationCoverage({
        criteria,
        tasks: [
          { id: "T1", type: "TEST", acKeys: ["AC-01"], dependencies: [] },
          { id: "T2", type: "BACKEND", acKeys: ["AC-01"], dependencies: ["T1"] }
        ]
      })
    ).toEqual([]);
  });

  it("ignores Should ACs", () => {
    expect(
      validateImplementationCoverage({
        criteria: [criterion({ acKey: "AC-02", priority: "Should" })],
        tasks: [{ id: "T1", type: "BACKEND", dependencies: [] }]
      })
    ).toEqual([]);
  });

  it("ignores tasks without acKeys", () => {
    expect(
      validateImplementationCoverage({
        criteria: [criterion({ acKey: "AC-01" })],
        tasks: [
          { id: "T1", type: "BACKEND", dependencies: [] },
          { id: "T2", type: "BACKEND", acKeys: ["AC-01"], dependencies: [] }
        ]
      })
    ).toEqual([]);
  });

  it("respects the slice FR scope", () => {
    const scoped = [
      criterion({ acKey: "AC-01", frKeys: ["FR-1"] }),
      criterion({ acKey: "AC-09", frKeys: ["FR-9"] })
    ];
    expect(
      validateImplementationCoverage({
        criteria: scoped,
        frKeys: ["FR-1"],
        tasks: [{ id: "T1", type: "BACKEND", acKeys: ["AC-01"], dependencies: [] }]
      })
    ).toEqual([]);
  });

  it("folds global ACs into the final slice and excludes them from a non-final slice", () => {
    const global = [
      criterion({ acKey: "AC-01", frKeys: ["FR-1"] }),
      criterion({ acKey: "AC-24", frKeys: ["FR-9"], verification: "容器运行" })
    ];
    const tasks: TestFirstTask[] = [
      { id: "T1", type: "BACKEND", acKeys: ["AC-01"], dependencies: [] }
    ];

    // 最终切片：全局性 AC 并入范围 → AC-24 无实现覆盖。
    expect(
      validateImplementationCoverage({ criteria: global, frKeys: ["FR-1"], isFinalSlice: true, tasks })
    ).toEqual(["Must acceptance criterion AC-24 has no implementation task coverage."]);

    // 非最终切片：全局性 AC 剔除 → 不报。
    expect(
      validateImplementationCoverage({ criteria: global, frKeys: ["FR-1"], isFinalSlice: false, tasks })
    ).toEqual([]);
  });

  it("skips validation when the requirement has no numbered criteria", () => {
    expect(
      validateImplementationCoverage({
        criteria: [],
        tasks: [{ id: "T1", type: "TEST", acKeys: ["AC-01"], dependencies: [] }]
      })
    ).toEqual([]);
  });
});

/**
 * 回归复现（PL-M1 的核心判据）：run 3 slice-5 的真实计划。
 * 「修前零报错」= 三个既有校验器对该计划全部返回空（这正是缺陷能一路走到 CI 的原因）；
 * 「修后报出」= 新校验器逐条报出 AC-24/25/26/29/30。
 *
 * 边界：本夹具只喂**计划期 AC 覆盖/顺序**这四条校验器（它们共用 `TestFirstTask` 形态）。
 * `validateTaskGraph` / `validateAcKeysPresence` 需要完整 `TaskPlanItem` 形态，不在本夹具范围内——
 * 该计划在真实运行中已通过它们（`docs/158` §1.4：计划首轮通过、任务 49/53 SUCCESS）。
 */
describe("PL-M1 回归复现：run 3 slice-5（e6c513e1）", () => {
  const input = {
    criteria: slice5Run3Criteria,
    tasks: slice5Run3Tasks,
    frKeys: slice5Run3SliceScope.frKeys,
    isFinalSlice: true
  };

  it("修前：三个既有校验器对该计划零报错", () => {
    expect(
      validateAcceptanceCoverage({
        criteria: input.criteria,
        tasks: input.tasks,
        frKeys: input.frKeys,
        isFinalSlice: true
      })
    ).toEqual([]);
    expect(validateTestFirstOrder(input)).toEqual([]);
    expect(validateMustAcTestCoverage(input)).toEqual([]);
  });

  it("修后：新校验器报出无实现覆盖的五条 Must AC", () => {
    expect(validateImplementationCoverage(input)).toEqual(slice5Run3ImplementationCoverageErrors);
  });

  it("该切片确有四个实现任务，但它们的 AC 覆盖不含那五条", () => {
    const implementationAcKeys = new Set(
      slice5Run3Tasks
        .filter((task) => ["BACKEND", "FRONTEND", "DATABASE"].includes(task.type))
        .flatMap((task) => task.acKeys ?? [])
    );
    expect(slice5Run3Tasks.filter((task) => task.type === "BACKEND")).toHaveLength(4);
    expect([...implementationAcKeys].sort()).toEqual(["AC-19", "AC-20", "AC-27", "AC-28"]);
  });
});
