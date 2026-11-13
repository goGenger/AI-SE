import { describe, expect, it } from "vitest";
import {
  isTestFirstMandatedEdge,
  listScriptConsumers,
  listScriptProviders,
  validateScriptProviders,
  type ScriptProviderTask
} from "./validateScriptProviders";

/** PL-M9 9b：脚本提供者守卫单测（纯函数，无 IO）。 */

function task(overrides: Partial<ScriptProviderTask> & { id: string }): ScriptProviderTask {
  return {
    type: "BACKEND",
    dependencies: [],
    ...overrides
  };
}

/** run 1 slice-1 的实值形状（PL-M4，`docs/166` §2.1）：脚手架提供 test script，却被排在 TEST 之后。 */
function run1Shape(): ScriptProviderTask[] {
  return [
    task({ id: "T-01", type: "DESIGN" }),
    task({ id: "T-02", type: "TEST", dependencies: ["T-01"], acKeys: ["AC-04"] }),
    task({ id: "T-03", type: "TEST", dependencies: ["T-01"] }),
    task({ id: "T-04", type: "TEST", dependencies: ["T-01"] }),
    // 提供者依赖消费者——倒置边（这是 run 1 真实的 DAG 形状）。
    task({ id: "T-05", type: "BACKEND", dependencies: ["T-04"], providesScripts: ["test", "build"] }),
    task({ id: "T-07", type: "BACKEND", dependencies: ["T-02"], acKeys: ["AC-04"] })
  ];
}

describe("validateScriptProviders（PL-M9 9b）", () => {
  it("无提供者声明 → 无输入、零报错（与 PL-M7 7a 同一退路口径）", () => {
    const tasks = run1Shape().map(({ providesScripts: _drop, ...rest }) => rest);
    expect(listScriptProviders(tasks)).toEqual([]);
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });

  it("run 1 形状：三个 TEST 任务都排在提供者之前 → 逐个报错并列出提供者", () => {
    const errors = validateScriptProviders({ tasks: run1Shape() });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("T-02");
    expect(errors[1]).toContain("T-03");
    expect(errors[2]).toContain("T-04");
    for (const message of errors) {
      expect(message).toContain("PLAN_TEST_BEFORE_SCRIPT_PROVIDER");
      expect(message).toContain("T-05");
      expect(message).toContain("test script");
    }
  });

  it("直接依赖提供者 → 满足", () => {
    const tasks = run1Shape();
    tasks[1]!.dependencies = ["T-01", "T-05"];
    tasks[2]!.dependencies = ["T-01", "T-05"];
    tasks[3]!.dependencies = ["T-01", "T-05"];
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });

  it("传递依赖提供者 → 满足", () => {
    const tasks = [
      task({ id: "T-05", type: "BACKEND", providesScripts: ["test"] }),
      task({ id: "T-06", type: "BACKEND", dependencies: ["T-05"] }),
      task({ id: "T-02", type: "TEST", dependencies: ["T-06"] }),
      task({ id: "T-03", type: "TEST", dependencies: ["T-02"] })
    ];
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });

  it("声明了别的 script（不含 test）不算提供者", () => {
    const tasks = run1Shape();
    tasks[4]!.providesScripts = ["lint"];
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });

  it("切片内没有 TEST 任务 → 无消费者、零报错", () => {
    const tasks = [task({ id: "T-05", providesScripts: ["test"] })];
    expect(listScriptConsumers(tasks)).toEqual([]);
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });

  it("与切片是否最终无关（不传 isFinalSlice，任何切片同判）", () => {
    const tasks = run1Shape();
    tasks[1]!.dependencies = ["T-01", "T-05"];
    tasks[2]!.dependencies = ["T-01", "T-05"];
    tasks[3]!.dependencies = ["T-01", "T-05"];
    expect(validateScriptProviders({ tasks })).toEqual([]);
  });
});

describe("isTestFirstMandatedEdge（PL-M9 9b × N4 的无解冲突判定）", () => {
  it("实现类任务 → TEST 且共享 AC：是 N4 强制的边（9b 不得删除）", () => {
    expect(
      isTestFirstMandatedEdge(
        task({ id: "P", type: "BACKEND", acKeys: ["AC-04"] }),
        task({ id: "C", type: "TEST", acKeys: ["AC-4"] })
      )
    ).toBe(true);
  });

  it("不共享 AC → 不是 N4 强制的边（run 1 的 T-05 → T-04 即此形状）", () => {
    expect(
      isTestFirstMandatedEdge(
        task({ id: "T-05", type: "BACKEND" }),
        task({ id: "T-04", type: "TEST" })
      )
    ).toBe(false);
  });

  it("目标不是 TEST 任务 → 不是", () => {
    expect(
      isTestFirstMandatedEdge(
        task({ id: "P", type: "BACKEND", acKeys: ["AC-04"] }),
        task({ id: "C", type: "DATABASE", acKeys: ["AC-04"] })
      )
    ).toBe(false);
  });

  it("源不是实现类任务 → 不是", () => {
    expect(
      isTestFirstMandatedEdge(
        task({ id: "P", type: "DESIGN", acKeys: ["AC-04"] }),
        task({ id: "C", type: "TEST", acKeys: ["AC-04"] })
      )
    ).toBe(false);
  });
});
