import { Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { resolveTaskTimeoutMs } from "../services/workflowTaskExecutor";

/** G3（GX-09）：超时预算解析顺序——任务输入 > 按类型表 > 全局默认（含配置解析边界）。 */

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "T1",
    title: "Backend task",
    description: "",
    type: "BACKEND",
    status: "RUNNING",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("resolveTaskTimeoutMs（G3/GX-09）", () => {
  it("任务输入 execution.timeoutMs 最优先（覆盖类型表与全局）", () => {
    expect(
      resolveTaskTimeoutMs(makeTask({ input: { execution: { timeoutMs: 123_000 } } }), {
        taskTimeoutByType: { BACKEND: 900_000 },
        taskTimeoutMs: 600_000
      })
    ).toBe(123_000);
  });

  it("类型表命中时覆盖全局默认", () => {
    expect(
      resolveTaskTimeoutMs(makeTask({ type: "TEST" }), {
        taskTimeoutByType: { TEST: 900_000 },
        taskTimeoutMs: 600_000
      })
    ).toBe(900_000);
  });

  it("类型表未命中回退全局默认", () => {
    expect(
      resolveTaskTimeoutMs(makeTask({ type: "REVIEW" }), {
        taskTimeoutByType: { BACKEND: 900_000 },
        taskTimeoutMs: 600_000
      })
    ).toBe(600_000);
  });

  it("未配置类型表 = 零行为变化（全局默认）", () => {
    expect(resolveTaskTimeoutMs(makeTask(), { taskTimeoutMs: 600_000 })).toBe(600_000);
  });

  it("未配置任何预算时回退 120s 兜底", () => {
    expect(resolveTaskTimeoutMs(makeTask(), {})).toBe(120_000);
  });

  it("FG5（run1 `5ae5163e` 参照）：BACKEND 骨架类任务在类型表配置下获得 900s（600s 边界解除）", () => {
    // 未配置：维持全局 600s 默认（零行为变化，与 run1 超时件同预算）。
    expect(resolveTaskTimeoutMs(makeTask({ type: "BACKEND" }), { taskTimeoutMs: 600_000 })).toBe(
      600_000
    );
    // 配置后：BACKEND 获得 900s（边界性慢任务不再一刀切）。
    expect(
      resolveTaskTimeoutMs(makeTask({ type: "BACKEND" }), {
        taskTimeoutByType: { BACKEND: 900_000 },
        taskTimeoutMs: 600_000
      })
    ).toBe(900_000);
  });
});

describe("TASK_TIMEOUT_MS_BY_TYPE 配置解析（G3/GX-09）", () => {
  const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  it("缺省/空串 = 未配置", () => {
    expect(loadConfig(base).taskTimeoutByType).toBeUndefined();
    expect(loadConfig({ ...base, TASK_TIMEOUT_MS_BY_TYPE: "" }).taskTimeoutByType).toBeUndefined();
  });

  it("合法 JSON 对象 → 解析为映射", () => {
    expect(
      loadConfig({ ...base, TASK_TIMEOUT_MS_BY_TYPE: '{"BACKEND":900000,"TEST":900000}' })
        .taskTimeoutByType
    ).toEqual({ BACKEND: 900_000, TEST: 900_000 });
  });

  it("非法 JSON / 未知任务类型 / 非正整数值 → 启动即失败", () => {
    expect(() => loadConfig({ ...base, TASK_TIMEOUT_MS_BY_TYPE: "{oops" })).toThrow(/valid JSON/);
    expect(() => loadConfig({ ...base, TASK_TIMEOUT_MS_BY_TYPE: '{"NOPE":1}' })).toThrow(
      /unknown task type/
    );
    expect(() => loadConfig({ ...base, TASK_TIMEOUT_MS_BY_TYPE: '{"BACKEND":0}' })).toThrow(
      /positive integer/
    );
  });
});
