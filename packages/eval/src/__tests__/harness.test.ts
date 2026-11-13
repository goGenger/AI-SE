import { describe, expect, it, vi } from "vitest";
import {
  collectChainMetrics,
  collectDurationMetrics,
  DEFAULT_PER_TASK_TIMEOUT_MS,
  workflowBudgetMs,
  collectStagingSegment,
  ensureEnvironments,
  ensurePlanning,
  ensureSliceStarted,
  HarnessDeps,
  scopeSlicesToRun,
  waitWorkflowTerminal,
  SliceView
} from "../harness";
import { EvalFixture } from "../types";

function depsWith(slices: SliceView[]): HarnessDeps {
  return {
    http: {
      get: async () => ({ success: true, data: { slices } }),
      post: async () => ({ success: true, data: {} }),
      del: async () => undefined
    },
    log: () => undefined,
    sleep: async () => undefined
  } as unknown as HarnessDeps;
}

const options = {
  runs: 1,
  replan: false,
  runTimeoutMs: 1000,
  pollIntervalMs: 1,
  oracleTimeoutMs: 1000
};

describe("ensureSliceStarted（N2 重跑语义，B-4 缺陷修复）", () => {
  it("复用链式编排已启动的工作流（RUNNING + workflowRunId）", async () => {
    const result = await ensureSliceStarted(
      depsWith([{ sliceKey: "s1", status: "RUNNING", workflowRunId: "wf-1" }]),
      "req-1",
      "s1",
      options
    );
    expect(result.workflowId).toBe("wf-1");
    expect(result.slice?.sliceKey).toBe("s1");
  });

  it("DONE 切片返回 null（由 harness 自驱重启）", async () => {
    const result = await ensureSliceStarted(
      depsWith([{ sliceKey: "s1", status: "DONE" }]),
      "req-1",
      "s1",
      options
    );
    expect(result.workflowId).toBeNull();
  });

  it("上一轮遗留的 FAILED 切片返回 null（可重启，不再直接抛错）", async () => {
    const result = await ensureSliceStarted(
      depsWith([{ sliceKey: "s1", status: "FAILED" }]),
      "req-1",
      "s1",
      options,
      new Set(["s1"])
    );
    expect(result.workflowId).toBeNull();
  });

  it("本轮链中途转 FAILED 的切片仍然抛错（失败不自动前进）", async () => {
    await expect(
      ensureSliceStarted(
        depsWith([{ sliceKey: "s1", status: "FAILED" }]),
        "req-1",
        "s1",
        options,
        new Set()
      )
    ).rejects.toThrow("切片 s1 失败");
  });
});

describe("ensureSliceStarted（F1-4 / FX-15d：关口重审与链停自启动）", () => {
  it("PLANNED 超过宽限期仍无工作流 → 返回 null（harness 自启动），无介入", async () => {
    vi.useFakeTimers();
    try {
      const deps = {
        http: {
          get: async () => ({
            success: true,
            data: { slices: [{ sliceKey: "s1", status: "PLANNED" }] }
          }),
          post: async () => ({ success: true, data: {} }),
          del: async () => undefined
        },
        log: () => undefined,
        sleep: async (ms: number) => {
          await vi.advanceTimersByTimeAsync(ms);
        }
      } as unknown as HarnessDeps;

      const result = await ensureSliceStarted(deps, "req-1", "s1", {
        ...options,
        pollIntervalMs: 600
      });
      expect(result.workflowId).toBeNull();
      expect(result.slice?.status).toBe("PLANNED");
      expect(result.interventions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("需求 PLANNING_REVIEW（拆分/升级重审）→ 自动批准一次并计入人工介入", async () => {
    vi.useFakeTimers();
    try {
      const posts: string[] = [];
      let approved = false;
      const deps = {
        http: {
          get: async (path: string) => {
            if (path === "/api/requirements/req-1") {
              return { success: true, data: { status: approved ? "ANALYZED" : "PLANNING_REVIEW" } };
            }
            if (path.endsWith("/slices")) {
              return {
                success: true,
                data: {
                  slices: [{ sliceKey: "s1", status: approved ? "PLANNED" : "PENDING" }],
                  approval: approved ? null : { id: "ap-1", status: "PENDING" }
                }
              };
            }
            throw new Error(`unexpected GET ${path}`);
          },
          post: async (path: string) => {
            posts.push(path);
            approved = true;
            return { success: true, data: {} };
          },
          del: async () => undefined
        },
        log: () => undefined,
        sleep: async (ms: number) => {
          await vi.advanceTimersByTimeAsync(ms);
        }
      } as unknown as HarnessDeps;

      const result = await ensureSliceStarted(deps, "req-1", "s1", {
        ...options,
        pollIntervalMs: 600
      });
      expect(result.workflowId).toBeNull();
      expect(result.interventions).toBe(1);
      expect(posts).toEqual(["/api/approvals/ap-1/approve"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ensurePlanning（E-2 修复：replan 对已 ANALYZED 需求强制重规划）", () => {
  function planningDeps(calls: Array<{ path: string; body: unknown }>): HarnessDeps {
    return {
      http: {
        get: async (path: string) => {
          if (path === "/api/projects/p1/requirements")
            return { success: true, data: [{ id: "req-1", title: "F1" }] };
          if (path === "/api/requirements/req-1")
            return { success: true, data: { status: "ANALYZED" } };
          if (path.endsWith("/slices")) return { success: true, data: { slices: [] } };
          if (path.endsWith("/specifications")) return { success: true, data: [] };
          if (path.endsWith("/tasks")) return { success: true, data: { tasks: [] } };
          throw new Error(`unexpected GET ${path}`);
        },
        post: async (path: string, body?: unknown) => {
          calls.push({ path, body });
          return { success: true, data: {} };
        },
        del: async () => undefined
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as HarnessDeps;
  }

  const fixture = {
    id: "F1",
    title: "t",
    tier: "S",
    requirementText: "r"
  } as unknown as EvalFixture;

  it("replan=true 时 analyze 请求携带 regenerate=true", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const planning = await ensurePlanning(planningDeps(calls), fixture, "p1", true);
    expect(calls).toEqual([
      { path: "/api/requirements/req-1/analyze", body: { regenerate: true } }
    ]);
    expect(planning.requirementId).toBe("req-1");
  });

  it("replan=false 且已 ANALYZED 时不触发 analyze（保持复用语义）", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    await ensurePlanning(planningDeps(calls), fixture, "p1", false);
    expect(calls).toEqual([]);
  });
});

describe("collectStagingSegment（L1-8 staging 段判据）", () => {
  const task = (
    status: string,
    action: string,
    environment?: string
  ): { status: string; input: { delivery: { action: string; environment?: string } } } => ({
    status,
    input: { delivery: environment === undefined ? { action } : { action, environment } }
  });

  it("三段均 SUCCESS → 交付成立", () => {
    expect(
      collectStagingSegment([
        task("SUCCESS", "CI"),
        task("SUCCESS", "DEPLOY", "staging"),
        task("SUCCESS", "VERIFY", "staging")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: "SUCCESS", verify: "SUCCESS", delivered: true });
  });

  it("staging DEPLOY 失败 → 不交付，且三段状态各自留档（归因用）", () => {
    expect(
      collectStagingSegment([
        task("SUCCESS", "CI"),
        task("FAILED", "DEPLOY", "staging"),
        task("PENDING", "VERIFY", "staging")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: "FAILED", verify: "PENDING", delivered: false });
  });

  it("staging DEPLOY 成功但 VERIFY 失败 → 不交付（VERIFY 是判据的一部分）", () => {
    expect(
      collectStagingSegment([
        task("SUCCESS", "CI"),
        task("SUCCESS", "DEPLOY", "staging"),
        task("FAILED", "VERIFY", "staging")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: "SUCCESS", verify: "FAILED", delivered: false });
  });

  it("链没走到 → 三段皆 null（与「走到了但失败」区分）", () => {
    expect(collectStagingSegment([task("SUCCESS", "CI")])).toEqual({
      ci: "SUCCESS",
      deploy: null,
      verify: null,
      delivered: false
    });
    expect(collectStagingSegment([])).toEqual({
      ci: null,
      deploy: null,
      verify: null,
      delivered: false
    });
  });

  it("production 的 DEPLOY / VERIFY 不计入 staging 段", () => {
    expect(
      collectStagingSegment([
        task("SUCCESS", "CI"),
        task("SUCCESS", "DEPLOY", "production"),
        task("SUCCESS", "VERIFY", "production")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: null, verify: null, delivered: false });
  });

  it("staging ROLLBACK 不被误认为 staging DEPLOY", () => {
    expect(
      collectStagingSegment([
        task("SUCCESS", "CI"),
        task("SUCCESS", "ROLLBACK", "staging"),
        task("SUCCESS", "VERIFY", "staging")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: null, verify: "SUCCESS", delivered: false });
  });

  /**
   * N-36（`docs/146`）：交付任务被 replan 后，源任务（FAILED）与重试任务（SUCCESS）**同时存在**
   * 于任务数组里，且数组未按时间排序。旧实现 `tasks.find(...)` 取第一条 ⇒ 把「已被重试救回」
   * 的段判成失败。`l1-m4u` run 2 的真实形状：CI 失败 → 诊断 → 重跑成功 → 才部署 → VERIFY 成功，
   * 而 staging 段记 0。
   */
  const timed = (
    status: string,
    action: string,
    createdAt: string,
    environment?: string
  ): { status: string; createdAt: string; input: { delivery: { action: string; environment?: string } } } => ({
    status,
    createdAt,
    input: { delivery: environment === undefined ? { action } : { action, environment } }
  });

  it("N-36：源任务 FAILED、重试 SUCCESS ⇒ 取最终一次，判交付成立", () => {
    expect(
      collectStagingSegment([
        timed("FAILED", "CI", "2026-10-23T03:14:47.000Z"),
        timed("SUCCESS", "CI", "2026-10-23T03:39:37.000Z"),
        timed("SUCCESS", "DEPLOY", "2026-10-23T03:14:47.000Z", "staging"),
        timed("SUCCESS", "VERIFY", "2026-10-23T03:14:47.000Z", "staging")
      ])
    ).toEqual({ ci: "SUCCESS", deploy: "SUCCESS", verify: "SUCCESS", delivered: true });
  });

  it("N-36 反向对照：先成功后失败 ⇒ 取最终一次，判不交付（不是「任一成功即通过」）", () => {
    expect(
      collectStagingSegment([
        timed("SUCCESS", "CI", "2026-10-23T03:14:47.000Z"),
        timed("FAILED", "CI", "2026-10-23T03:39:37.000Z"),
        timed("SUCCESS", "DEPLOY", "2026-10-23T03:14:47.000Z", "staging"),
        timed("SUCCESS", "VERIFY", "2026-10-23T03:14:47.000Z", "staging")
      ])
    ).toEqual({ ci: "FAILED", deploy: "SUCCESS", verify: "SUCCESS", delivered: false });
  });
});

describe("scopeSlicesToRun / collectChainMetrics（N-16：切片进度跨 run 串味）", () => {
  /**
   * 库内真相（L1-M4l）：`requirement_slices` 按需求（计划版本）存，三个 run 共用 v81。
   * run 1 把 S2 置成 FAILED 后，run 2 / run 3 从未创建过 S2 工作流。
   */
  const shared = [
    { sliceKey: "S1", status: "DONE", workflowRunId: "wf-run1-s1" },
    { sliceKey: "S2", status: "FAILED", workflowRunId: "wf-run1-s2" }
  ];

  it("修前口径：只看状态会把 run 2 记成到达 S2", () => {
    expect(collectChainMetrics(shared, ["FAILED"]).sliceReached).toBe("S2");
  });

  it("修后口径：run 2 只驱动过 S1 ⇒ 到达 S1", () => {
    const scoped = scopeSlicesToRun(shared, ["S1"]);
    expect(collectChainMetrics(scoped, ["FAILED"]).sliceReached).toBe("S1");
  });

  it("run 1 驱动过两片 ⇒ 仍记 S2（不把真实进度改小）", () => {
    const scoped = scopeSlicesToRun(shared, ["S1", "S2"]);
    expect(collectChainMetrics(scoped, ["SUCCESS", "FAILED"]).sliceReached).toBe("S2");
  });

  it("未驱动的切片按 PENDING 计，且不改动入参数组", () => {
    const scoped = scopeSlicesToRun(shared, ["S1"]);
    expect(scoped[1]).toEqual({ sliceKey: "S2", status: "PENDING", workflowRunId: "wf-run1-s2" });
    expect(shared[1].status).toBe("FAILED");
  });

  it("chainCompleted 同样只认本 run 驱动的切片", () => {
    const allDone = [
      { sliceKey: "S1", status: "DONE" },
      { sliceKey: "S2", status: "DONE" }
    ];
    expect(collectChainMetrics(scopeSlicesToRun(allDone, ["S1"]), ["SUCCESS"]).chainCompleted).toBe(
      false
    );
    expect(
      collectChainMetrics(scopeSlicesToRun(allDone, ["S1", "S2"]), ["SUCCESS", "SUCCESS"])
        .chainCompleted
    ).toBe(true);
  });

  it("单级模式（executed 的 sliceKey 为 null）不影响切片视图", () => {
    expect(scopeSlicesToRun(shared, [null])).toEqual([
      { sliceKey: "S1", status: "PENDING", workflowRunId: "wf-run1-s1" },
      { sliceKey: "S2", status: "PENDING", workflowRunId: "wf-run1-s2" }
    ]);
  });
});

/**
 * N-59（`docs/232` §10）：`durationMs` 必须覆盖被超时/取消切断的切片。
 *
 * 原缺陷：只累加同时有 startedAt 与 finishedAt 的工作流 ⇒ F1 第二轮记 28 分钟，实际 120 分钟。
 */
describe("collectDurationMetrics（N-59：超时终止不得低报）", () => {
  const T0 = Date.parse("2026-10-28T07:00:00.000Z");
  const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

  it("全部完成 ⇒ 各片时长之和", () => {
    const result = collectDurationMetrics(
      [
        { startedAt: at(0), finishedAt: at(30) },
        { startedAt: at(30), finishedAt: at(90) }
      ],
      T0,
      T0 + 90 * 60_000
    );
    expect(result.durationMs).toBe(90 * 60_000);
    expect(result.incomplete).toBe(0);
  });

  it("有片没 finishedAt ⇒ 按 now 计入，并标记 incomplete", () => {
    // 这正是 F1 第二轮的形状：slice-1 完成 30 分钟，slice-2 跑到 now（120 分钟处）被切断。
    const result = collectDurationMetrics(
      [
        { startedAt: at(0), finishedAt: at(30) },
        { startedAt: at(30) }
      ],
      T0,
      T0 + 120 * 60_000
    );
    // 30 + (120-30) = 120
    expect(result.durationMs).toBe(120 * 60_000);
    expect(result.incomplete).toBe(1);
  });

  it("旧实现会低报的那个具体读数：28 分钟 vs 120 分钟", () => {
    // 旧实现只看到第一片（28 分钟）。新实现必须给出 >= 120 分钟。
    const result = collectDurationMetrics(
      [
        { startedAt: at(0), finishedAt: at(28) },
        { startedAt: at(28) }
      ],
      T0,
      T0 + 120 * 60_000
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(120 * 60_000);
    expect(result.durationMs / (28 * 60_000)).toBeGreaterThan(4);
  });

  it("批次墙钟是下界：各片之和小于墙钟时取墙钟", () => {
    // 片之间有空档（规划/审批/等待），片时长之和 10 分钟，但本轮实际跑了 60 分钟。
    const result = collectDurationMetrics(
      [{ startedAt: at(50), finishedAt: at(60) }],
      T0,
      T0 + 60 * 60_000
    );
    expect(result.durationMs).toBe(60 * 60_000);
  });

  it("没有可解析的工作流 ⇒ 退回墙钟，不是 0", () => {
    const result = collectDurationMetrics([{}, { startedAt: "not-a-date" }], T0, T0 + 45 * 60_000);
    expect(result.durationMs).toBe(45 * 60_000);
    expect(result.incomplete).toBe(0);
  });
});

/**
 * N-60（`docs/232` §10，用户 2026-10-29 裁定「按任务计时」）：
 * 单切片预算 = max(下界, 任务数 × 每任务预算)。
 */
describe("workflowBudgetMs（N-60：按任务计时）", () => {
  const FLOOR = 90 * 60_000; // F1 的 runTimeoutMs
  const PER_TASK = DEFAULT_PER_TASK_TIMEOUT_MS; // 8 min（N-63）

  it("任务少 ⇒ 下界生效，行为与改动前一致", () => {
    // slice-1 实测：7 个任务 × 8 min = 56 min < 90 min 下界。
    expect(workflowBudgetMs(7, FLOOR, PER_TASK)).toBe(FLOOR);
  });

  it("任务多 ⇒ 按任务数放大（这正是 F1 第二轮被切断的那片）", () => {
    // slice-2 实测：派生到 21 个任务 × 8 min = 168 min > 90 min。
    expect(workflowBudgetMs(21, FLOOR, PER_TASK)).toBe(21 * PER_TASK);
    expect(workflowBudgetMs(21, FLOOR, PER_TASK)).toBeGreaterThan(FLOOR);
  });

  it("预算随 REPLAN 派生增长：7 → 21 个任务跨越下界", () => {
    expect(workflowBudgetMs(7, FLOOR, PER_TASK)).toBe(FLOOR);
    expect(workflowBudgetMs(21, FLOOR, PER_TASK)).toBeGreaterThan(
      workflowBudgetMs(7, FLOOR, PER_TASK)
    );
  });

  it("0 个任务（工作流还没建任务）⇒ 退回下界，不是 0", () => {
    expect(workflowBudgetMs(0, FLOOR, PER_TASK)).toBe(FLOOR);
  });

  it("默认每任务预算是 8 分钟（N-63：6 分钟在任务数 ≥15 时等于没有余量）", () => {
    expect(DEFAULT_PER_TASK_TIMEOUT_MS).toBe(8 * 60_000);
  });

  it("任务极多时不小于任务数 × 每任务预算（不设上限，由 REPLAN 深度守卫兜底）", () => {
    expect(workflowBudgetMs(100, FLOOR, PER_TASK)).toBe(100 * PER_TASK);
  });
});

/**
 * N-60 集成层面：轮询时**每次重算**预算，REPLAN 派生出的新任务要把预算一起抬高。
 * 这条钉的是「不能用开工时的任务数算一次就固定」——那对 REPLAN 链无效。
 */
describe("waitWorkflowTerminal（N-60：预算随任务增长）", () => {
  const runOptions = {
    runs: 1,
    replan: false,
    runTimeoutMs: 60_000, // 下界 1 min
    perTaskTimeoutMs: 60_000, // 每任务 1 min
    pollIntervalMs: 1,
    oracleTimeoutMs: 1
  };

  it("任务数逐轮增长 ⇒ 终态照常返回，且预算跟着涨", async () => {
    // 每轮多一个任务（模拟 REPLAN 派生），第 3 轮转为 SUCCESS。
    const taskCounts = [1, 2, 3];
    let poll = 0;
    const deps = {
      http: {
        get: async () => {
          const count = taskCounts[Math.min(poll, taskCounts.length - 1)];
          poll += 1;
          return {
            success: true,
            data: {
              workflow: { status: poll > taskCounts.length ? "SUCCESS" : "RUNNING" },
              tasks: Array.from({ length: count }, () => ({ status: "PENDING" }))
            }
          };
        },
        post: async () => ({ success: true, data: {} }),
        del: async () => undefined
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-1", runOptions);
    expect(waited.status).toBe("SUCCESS");
    // 最后观察到的任务数是 3 ⇒ 预算 3×1min，大于 1min 下界。
    expect(waited.budgetMs).toBe(3 * 60_000);
  });

  it("任务数不再增长时预算恒定，不会自己无限放大", async () => {
    let poll = 0;
    const deps = {
      http: {
        get: async () => {
          poll += 1;
          return {
            success: true,
            data: {
              workflow: { status: poll > 2 ? "SUCCESS" : "RUNNING" },
              tasks: [{ status: "PENDING" }, { status: "PENDING" }]
            }
          };
        },
        post: async () => ({ success: true, data: {} }),
        del: async () => undefined
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-2", runOptions);
    expect(waited.budgetMs).toBe(2 * 60_000);
    expect(waited.taskCount).toBe(2);
  });
});

describe("waitWorkflowTerminal（N-60：超时分支仍然可达）", () => {
  it("预算用尽 ⇒ 返回 TIMEOUT，并带上当时的任务数与预算（可归因）", async () => {
    const deps = {
      http: {
        get: async () => ({
          success: true,
          data: {
            // 永远 RUNNING：只能靠预算把它切掉
            workflow: { status: "RUNNING" },
            tasks: [{ status: "RUNNING" }, { status: "PENDING" }]
          }
        }),
        post: async () => ({ success: true, data: {} }),
        del: async () => undefined
      },
      log: () => undefined,
      // 每轮真等 2ms，让墙钟真的走起来（预算下界 1ms）
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 2))
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-timeout", {
      runs: 1,
      replan: false,
      runTimeoutMs: 1,
      perTaskTimeoutMs: 0,
      pollIntervalMs: 1,
      oracleTimeoutMs: 1
    });
    expect(waited.status).toBe("TIMEOUT");
    // 归因信息必须带出来，否则事后分不清「任务多」还是「太慢」。
    expect(waited.budgetMs).toBe(1);
    expect(waited.taskCount).toBe(2);
  });
});

/**
 * N-62（`docs/232` §10）：**判超时不是「不再看它」，是「不再为它付钱」**。
 *
 * 实测（2026-10-29 F1 第四轮）：批次打印 `run 1 done` 时 slice-4 在库里仍是 `RUNNING`，
 * 手工 cancel 才停。窗口短所以没烧到钱，但形状是必然的——超时那一刻仍有任务在飞。
 *
 * 与 N-58 同一手法：**回读状态**，不以「调用返回 200」当作已停。
 */
describe("waitWorkflowTerminal 超时取消（N-62）", () => {
  const options = {
    runs: 1,
    replan: false,
    runTimeoutMs: 1,
    perTaskTimeoutMs: 1,
    pollIntervalMs: 1,
    oracleTimeoutMs: 1
  };

  function slowSleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
  }

  it("超时后调用 cancel 接口，并回读确认已终态", async () => {
    const posts: string[] = [];
    const logs: string[] = [];
    let status = "RUNNING";
    const deps = {
      http: {
        get: async () => ({
          success: true,
          data: { workflow: { status }, tasks: [{ status: "RUNNING" }] }
        }),
        post: async (path: string) => {
          posts.push(path);
          status = "CANCELLED";
          return { success: true, data: {} };
        },
        del: async () => undefined
      },
      log: (message: string) => logs.push(message),
      sleep: slowSleep
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(waited.status).toBe("TIMEOUT");
    expect(posts).toEqual(["/api/workflows/wf-1/cancel"]);
    expect(logs.join("\n")).toContain("已停止（CANCELLED）");
  });

  it("取消失败不影响超时结论，只留下要人手工处理的告警", async () => {
    const logs: string[] = [];
    const deps = {
      http: {
        get: async () => ({
          success: true,
          data: { workflow: { status: "RUNNING" }, tasks: [{ status: "RUNNING" }] }
        }),
        post: async () => {
          throw new Error("network down");
        },
        del: async () => undefined
      },
      log: (message: string) => logs.push(message),
      sleep: slowSleep
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(waited.status).toBe("TIMEOUT");
    expect(logs.join("\n")).toContain("请手工 cancel");
  });

  it("取消后仍未停止 ⇒ 回读重试用尽后告警，不假装已停", async () => {
    const logs: string[] = [];
    const deps = {
      http: {
        get: async () => ({
          success: true,
          data: { workflow: { status: "RUNNING" }, tasks: [{ status: "RUNNING" }] }
        }),
        post: async () => ({ success: true, data: {} }),
        del: async () => undefined
      },
      log: (message: string) => logs.push(message),
      sleep: slowSleep
    } as unknown as HarnessDeps;

    const waited = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(waited.status).toBe("TIMEOUT");
    expect(logs.join("\n")).toContain("仍未停止");
    expect(logs.join("\n")).not.toContain("已停止（");
  });
});

/**
 * N-73（`docs/232` §10）：**工作区优先的交付环境**。
 *
 * 夹具声明 `delivery.environments` 后，harness 必须在跑批前把它们 upsert 进项目——否则规划期
 * 会以 `DELIVERY_ENVIRONMENT_MISSING` 失败，staging 交付链永远不会被排出来。
 */
describe("ensureEnvironments（N-73）", () => {
  const baseFixture = {
    id: "F1",
    tier: "F1",
    title: "fixture",
    requirementText: "requirement",
    oracle: { command: "node", args: ["oracle.mjs"] },
    delivery: {
      environments: [
        {
          name: "staging" as const,
          endpoint: "http://127.0.0.1:18900",
          adapter: "static" as const,
          configuration: { testIds: ["app-title"] }
        }
      ]
    }
  } as EvalFixture;

  function depsWithPut(puts: Array<{ path: string; body: unknown }>): HarnessDeps {
    return {
      http: {
        get: async () => ({}),
        post: async () => ({}),
        del: async () => undefined,
        put: async (path: string, body?: unknown) => {
          puts.push({ path, body });
          return {};
        }
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as HarnessDeps;
  }

  it("逐个 PUT 到 /api/environments", async () => {
    const puts: Array<{ path: string; body: unknown }> = [];
    await ensureEnvironments(depsWithPut(puts), "project-1", baseFixture);
    expect(puts).toEqual([
      {
        path: "/api/environments",
        body: {
          projectId: "project-1",
          name: "staging",
          endpoint: "http://127.0.0.1:18900",
          adapter: "static",
          configuration: { testIds: ["app-title"] }
        }
      }
    ]);
  });

  it("没有声明交付环境 ⇒ 不发请求（既有夹具零变化）", async () => {
    const puts: Array<{ path: string; body: unknown }> = [];
    const fixture = { ...baseFixture, delivery: undefined } as EvalFixture;
    await ensureEnvironments(depsWithPut(puts), "project-1", fixture);
    expect(puts).toEqual([]);
  });

  it("声明了环境但客户端没有 PUT ⇒ 明确失败，不静默跳过", async () => {
    const deps = {
      http: {
        get: async () => ({}),
        post: async () => ({}),
        del: async () => undefined
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as HarnessDeps;
    await expect(ensureEnvironments(deps, "project-1", baseFixture)).rejects.toThrow(/no PUT|has no PUT/);
  });
});
