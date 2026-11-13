import { AcceptanceCriterion } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  validateMustAcTestCoverage,
  validateTestFirstOrder,
  type TestFirstTask
} from "./validateTestFirstPlan";

/** N4：测试先行/覆盖校验器单测（纯规则）。 */

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

function task(
  overrides: Partial<TestFirstTask> & { id: string; type: TestFirstTask["type"] }
): TestFirstTask {
  return { dependencies: [], acKeys: [], ...overrides };
}

const criteria = [criterion({ acKey: "AC-01" }), criterion({ acKey: "AC-02", priority: "Should" })];

describe("validateTestFirstOrder", () => {
  it("flags an implementation task that skips its test dependency", () => {
    const errors = validateTestFirstOrder({
      criteria,
      tasks: [
        task({ id: "T1", type: "TEST", acKeys: ["AC-01", "AC-02"] }),
        task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] })
      ]
    });
    expect(errors).toEqual([
      "Implementation task T2 must depend on test task T1 (shared ACs: AC-01) to keep tests first."
    ]);
  });

  it("accepts a direct dependency and a transitive dependency chain", () => {
    expect(
      validateTestFirstOrder({
        criteria,
        tasks: [
          task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
          task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"], dependencies: ["T1"] })
        ]
      })
    ).toEqual([]);

    expect(
      validateTestFirstOrder({
        criteria,
        tasks: [
          task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
          task({ id: "T2", type: "DATABASE", acKeys: ["AC-01"], dependencies: ["T1"] }),
          task({
            id: "T3",
            type: "BACKEND",
            acKeys: ["AC-01"],
            dependencies: ["T2"]
          })
        ]
      })
    ).toEqual([]);
  });

  it("ignores tasks without shared ACs and non-implementation types", () => {
    expect(
      validateTestFirstOrder({
        criteria,
        tasks: [
          task({ id: "T1", type: "TEST", acKeys: ["AC-02"] }),
          task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] }),
          task({ id: "T3", type: "REVIEW", acKeys: ["AC-02"] })
        ]
      })
    ).toEqual([]);
  });

  it("skips validation entirely when the requirement has no numbered criteria", () => {
    expect(
      validateTestFirstOrder({
        criteria: [],
        tasks: [task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] })]
      })
    ).toEqual([]);
  });

  /**
   * N-70（`docs/232` §10）：**按 AC 判定**，不是「实现任务 × 每个 TEST 任务」逐对判定。
   * 旧口径会把排在实现之后的收尾验证任务也要求成前置，自动修复于是把 `实现 → 验证` 边反转，
   * 验证任务成了 DAG 的根、先跑先红。
   */
  describe("N-70：同一 AC 的多个 TEST 任务", () => {
    it("依赖其中任一（红灯测试）即满足，收尾验证任务不必前置", () => {
      expect(
        validateTestFirstOrder({
          criteria,
          tasks: [
            task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
            task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"], dependencies: ["T1"] }),
            // 收尾验证：规划器明确排在实现之后。
            task({ id: "T3", type: "TEST", acKeys: ["AC-01"], dependencies: ["T2"] })
          ]
        })
      ).toEqual([]);
    });

    it("一个都没前置时只补一条边（取第一个覆盖它的 TEST 任务），不再按任务数放大", () => {
      expect(
        validateTestFirstOrder({
          criteria,
          tasks: [
            task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
            task({ id: "T3", type: "TEST", acKeys: ["AC-01"] }),
            task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] })
          ]
        })
      ).toEqual([
        "Implementation task T2 must depend on test task T1 (shared ACs: AC-01) to keep tests first."
      ]);
    });

    it("逐 AC 判定：已满足的 AC 不进补边清单", () => {
      expect(
        validateTestFirstOrder({
          criteria,
          tasks: [
            task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
            task({ id: "T2", type: "TEST", acKeys: ["AC-02"] }),
            task({ id: "T3", type: "BACKEND", acKeys: ["AC-01", "AC-02"], dependencies: ["T1"] })
          ]
        })
      ).toEqual([
        "Implementation task T3 must depend on test task T2 (shared ACs: AC-02) to keep tests first."
      ]);
    });
  });
});

describe("validateMustAcTestCoverage", () => {
  it("flags a Must AC with no TEST task coverage", () => {
    const errors = validateMustAcTestCoverage({
      criteria,
      tasks: [
        task({ id: "T1", type: "TEST", acKeys: ["AC-02"] }),
        task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] })
      ]
    });
    expect(errors).toEqual(["Must acceptance criterion AC-01 has no TEST task coverage."]);
  });

  it("accepts Should-only gaps and full Must coverage", () => {
    expect(
      validateMustAcTestCoverage({
        criteria,
        tasks: [
          task({ id: "T1", type: "TEST", acKeys: ["AC-01"] }),
          task({ id: "T2", type: "BACKEND", acKeys: ["AC-02"] })
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
      validateMustAcTestCoverage({
        criteria: scoped,
        frKeys: ["FR-1"],
        tasks: [task({ id: "T1", type: "TEST", acKeys: ["AC-01"] })]
      })
    ).toEqual([]);
  });

  it("skips validation when the requirement has no numbered criteria", () => {
    expect(
      validateMustAcTestCoverage({
        criteria: [],
        tasks: [task({ id: "T2", type: "BACKEND", acKeys: ["AC-01"] })]
      })
    ).toEqual([]);
  });
});
