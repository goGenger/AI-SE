import { describe, expect, it } from "vitest";
import {
  findSkeletonTask,
  repairSkeletonAcceptanceCriteria,
  validateSkeletonPlan,
  type SkeletonTaskLike
} from "./validateSkeletonPlan";

/**
 * N-43（`docs/232` §T4-9）：骨架先行契约。
 * 夹具取 L1-M4v 回归（2026-10-23）第一个切片 S1-foundation 的实值形状：
 * S1-T01 只写清单、脚本实现排在 S1-T06。
 */

function task(
  id: string,
  type: SkeletonTaskLike["type"],
  dependencies: string[],
  acceptanceCriteria: string[],
  providesScripts?: string[]
): SkeletonTaskLike {
  return {
    id,
    type,
    dependencies,
    acceptanceCriteria,
    ...(providesScripts ? { providesScripts } : {})
  };
}

/** 实值形状：T01 的 AC 全部只描述 package.json 字段。 */
const manifestOnly = [
  "仓库根存在 package.json，且可被 JSON.parse 正常解析。",
  "package.json 的 scripts 同时包含 start、test、lint、typecheck、build 五个键。",
  "五个脚本失败时返回非 0 退出码，不存在吞掉错误后强制退出 0 的实现。"
];

function observedPlan(): SkeletonTaskLike[] {
  return [
    task("S1-T01", "BUILD", [], manifestOnly, [
      "start",
      "test",
      "lint",
      "typecheck",
      "build"
    ]),
    task("S1-T02", "BUILD", ["S1-T01"], ["仓库根存在 pnpm-lock.yaml。"]),
    // 实值计划把脚本实现排在五个任务之后——这正是契约要拦的拆分形态。
    task("S1-T06", "BUILD", ["S1-T01"], ["scripts/build.js 存在。"]),
    task("S1-T10", "TEST", ["S1-T01"], ["test/config.test.js 全部用例通过。"])
  ];
}

describe("N-43 findSkeletonTask：声明 build 的任务优先，否则取计划顺序里第一个根任务", () => {
  it("有 build 提供者时以它为准（即使它不是第一个任务）", () => {
    const tasks = [
      task("T-1", "BACKEND", [], ["实现 A。"]),
      task("T-2", "BUILD", ["T-1"], ["创建清单。"], ["build"])
    ];
    expect(findSkeletonTask(tasks)?.id).toBe("T-2");
  });

  it("无人声明脚本时回退到第一个根任务", () => {
    const tasks = [task("T-1", "BACKEND", ["T-0"], ["依赖别的任务。"]), task("T-2", "BUILD", [], ["创建清单。"])];
    expect(findSkeletonTask(tasks)?.id).toBe("T-2");
  });

  it("空计划返回 null", () => {
    expect(findSkeletonTask([])).toBeNull();
  });
});

describe("N-43 repairSkeletonAcceptanceCriteria：首个切片的骨架任务补齐可执行条款", () => {
  it("实值形状（只写清单）→ 五个脚本各补一条可执行 AC，且不改入参", () => {
    const plan = observedPlan();
    const before = JSON.parse(JSON.stringify(plan));
    const result = repairSkeletonAcceptanceCriteria({ tasks: plan, isFirstSlice: true });

    expect(result.repairs.map((repair) => repair.script)).toEqual([
      "start",
      "test",
      "lint",
      "typecheck",
      "build"
    ]);
    expect(result.repairs.every((repair) => repair.taskId === "S1-T01")).toBe(true);

    const skeleton = result.tasks.find((entry) => entry.id === "S1-T01");
    const added = (skeleton?.acceptanceCriteria ?? []).slice(manifestOnly.length);
    expect(added).toHaveLength(5);
    expect(added[4]).toContain("`pnpm run build`");
    expect(added[4]).toContain("exit 0");
    // 其它任务的 AC 一字不改。
    expect(result.tasks.filter((entry) => entry.id !== "S1-T01")).toEqual(
      before.filter((entry: SkeletonTaskLike) => entry.id !== "S1-T01")
    );
    // 入参未被就地修改。
    expect(plan).toEqual(before);
  });

  it("已有「脚本名 + 退出码」条款的脚本不再重复补（只补缺的）", () => {
    const plan = [
      task("T-1", "BUILD", [], ["pnpm build 退出码为 0。"], ["build"]),
      task("T-2", "BACKEND", ["T-1"], ["实现配置模块。"])
    ];
    const result = repairSkeletonAcceptanceCriteria({ tasks: plan, isFirstSlice: true });
    expect(result.repairs.map((repair) => repair.script)).not.toContain("build");
    expect(result.repairs).toHaveLength(4);
  });

  it("非第一个切片 / 非 Node 工程 / 显式 false → 无动作", () => {
    const plan = observedPlan();
    expect(repairSkeletonAcceptanceCriteria({ tasks: plan }).repairs).toEqual([]);
    expect(repairSkeletonAcceptanceCriteria({ tasks: plan, isFirstSlice: false }).repairs).toEqual([]);

    const python = [task("T-1", "BACKEND", [], ["实现 main.py。"])];
    const result = repairSkeletonAcceptanceCriteria({ tasks: python, isFirstSlice: true });
    expect(result.repairs).toEqual([]);
    expect(result.tasks).toEqual(python);
  });
});

describe("N-43 validateSkeletonPlan：同一脚本不得由两个任务声明", () => {
  it("清单任务与实现任务同时声明 build → SKELETON_SCRIPT_MULTIPLE_PROVIDERS", () => {
    const tasks = [
      task("T-1", "BUILD", [], ["创建 package.json。"], ["build"]),
      task("T-2", "BUILD", ["T-1"], ["实现 scripts/build.js。"], ["build"])
    ];
    const errors = validateSkeletonPlan({ tasks, isFirstSlice: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SKELETON_SCRIPT_MULTIPLE_PROVIDERS");
    expect(errors[0]).toContain("T-1, T-2");
  });

  it("每个脚本只有一个提供者 → 无错误（既有计划不受影响）", () => {
    const errors = validateSkeletonPlan({ tasks: observedPlan(), isFirstSlice: true });
    expect(errors).toEqual([]);
  });

  it("非第一个切片 → 不校验", () => {
    const tasks = [
      task("T-1", "BUILD", [], ["创建 package.json。"], ["build"]),
      task("T-2", "BUILD", ["T-1"], ["实现 scripts/build.js。"], ["build"])
    ];
    expect(validateSkeletonPlan({ tasks, isFirstSlice: false })).toEqual([]);
    expect(validateSkeletonPlan({ tasks })).toEqual([]);
  });
});
