import { Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { buildRequirementTraceability, renderTraceabilityMarkdown } from "../services/traceability";

/** C-5（N5）：追溯表生成器单测（纯函数，零 LLM：输入全部为普通数据，无模型依赖）。 */

function criterion(acKey: string, overrides: Record<string, unknown> = {}) {
  return {
    acKey,
    text: `Criterion ${acKey}`,
    priority: "Must" as const,
    verification: null,
    smoke: false,
    frKeys: ["FR-1"],
    ...overrides
  };
}

function task(overrides: Partial<Task> & { id: string; taskKey: string }): Task {
  const now = "2026-10-06T12:00:00.000Z";
  return {
    projectId: "p1",
    title: overrides.taskKey,
    description: "",
    type: "BACKEND",
    status: "SUCCESS",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function verification(
  checks: Array<Record<string, unknown>>,
  finishedAt = "2026-10-06T12:30:00.000Z"
) {
  return { mode: "enforce", verdict: "verified", checks, finishedAt };
}

describe("buildRequirementTraceability", () => {
  it("marks an AC as passed from green verification evidence", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-01")],
      runtimeTasks: [
        task({
          id: "t1",
          taskKey: "S1-T01",
          type: "TEST",
          sliceKey: "SLICE-1",
          input: { acKeys: ["AC-01"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "pass",
                command: "npm run test",
                exitCode: 0,
                acResults: { "AC-01": "passed" }
              }
            ])
          },
          finishedAt: "2026-10-06T12:30:00.000Z"
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("passed");
    expect(view.criteria[0]?.tests).toEqual([
      {
        taskKey: "S1-T01",
        taskType: "TEST",
        sliceKey: "SLICE-1",
        expected: "pass",
        result: "passed",
        command: "npm run test",
        exitCode: 0,
        finishedAt: "2026-10-06T12:30:00.000Z"
      }
    ]);
    expect(view.summary).toEqual({ total: 1, passed: 1, failed: 0, unverified: 0, noTest: 0 });
  });

  it("marks an AC as failed when a green check reports it failed", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-02")],
      runtimeTasks: [
        task({
          id: "t1",
          taskKey: "S1-T02",
          type: "BACKEND",
          input: { acKeys: ["AC-02"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "pass",
                exitCode: 1,
                acResults: { "AC-02": "failed" }
              }
            ])
          }
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("failed");
    expect(view.summary.failed).toBe(1);
  });

  it("does not let red-light evidence decide the final status", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-03")],
      runtimeTasks: [
        task({
          id: "t1",
          taskKey: "S1-T03",
          type: "TEST",
          input: { acKeys: ["AC-03"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "fail",
                exitCode: 1,
                acResults: { "AC-03": "failed" }
              }
            ])
          }
        })
      ]
    });

    // 红灯证据存在（测试先行的红灯）→ 仍为未验证，而不是失败。
    expect(view.criteria[0]?.status).toBe("unverified");
    expect(view.criteria[0]?.tests[0]?.expected).toBe("fail");
  });

  it("marks an AC with no TEST task as no-test and one without executions as unverified", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-04"), criterion("AC-05")],
      runtimeTasks: [
        task({ id: "t1", taskKey: "S1-T04", type: "BACKEND", input: { acKeys: ["AC-04"] } }),
        task({ id: "t2", taskKey: "S1-T05", type: "TEST", input: { acKeys: ["AC-05"] } })
      ]
    });

    expect(view.criteria[0]?.status).toBe("no-test");
    expect(view.criteria[1]?.status).toBe("unverified");
    expect(view.summary).toEqual({ total: 2, passed: 0, failed: 0, unverified: 1, noTest: 1 });
  });

  it("keeps only the latest execution per plan task", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-06")],
      runtimeTasks: [
        task({
          id: "old",
          taskKey: "S1-T06",
          planTaskId: "plan-1",
          type: "TEST",
          input: { acKeys: ["AC-06"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "pass",
                exitCode: 0,
                acResults: { "AC-06": "passed" }
              }
            ])
          },
          finishedAt: "2026-10-06T10:00:00.000Z"
        }),
        task({
          id: "new",
          taskKey: "S1-T06",
          planTaskId: "plan-1",
          type: "TEST",
          input: { acKeys: ["AC-06"] },
          output: {
            verification: verification(
              [
                {
                  name: "test",
                  expected: "pass",
                  exitCode: 1,
                  acResults: { "AC-06": "failed" }
                }
              ],
              "2026-10-06T11:00:00.000Z"
            )
          },
          finishedAt: "2026-10-06T11:00:00.000Z"
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("failed");
    expect(view.criteria[0]?.tests).toHaveLength(1);
  });

  it("renders a markdown export with status labels", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-07", { priority: "Should" })],
      runtimeTasks: [],
      generatedAt: "2026-10-06T13:00:00.000Z"
    });

    const markdown = renderTraceabilityMarkdown(view);
    expect(markdown).toContain("# 追溯表（r1）");
    expect(markdown).toContain("| AC-07 | Should | 无测试覆盖 | - |");
    expect(markdown).toContain("无测试覆盖 1");
  });

  it("FX-18：每条证据携带 commit SHA（检查级优先、记录级兜底）", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-08")],
      runtimeTasks: [
        task({
          id: "t1",
          taskKey: "S1-T08",
          type: "BACKEND",
          input: { acKeys: ["AC-08"] },
          output: {
            verification: {
              mode: "enforce",
              verdict: "verified",
              finishedAt: "2026-10-06T12:30:00.000Z",
              commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              checks: [
                {
                  name: "test",
                  expected: "pass",
                  exitCode: 0,
                  commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  acResults: { "AC-08": "passed" }
                },
                {
                  name: "build",
                  expected: "pass",
                  exitCode: 0,
                  acResults: { "AC-08": "passed" }
                }
              ]
            }
          },
          finishedAt: "2026-10-06T12:30:00.000Z"
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("passed");
    const refs = view.criteria[0]?.tests ?? [];
    expect(refs).toHaveLength(2);
    expect(refs[0]?.commitSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(refs[1]?.commitSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("FX-18/19：交付前全量（authoritative）覆盖早期绿灯——早期绿灯、后续破坏 → 最终显示失败", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-09")],
      runtimeTasks: [
        task({
          id: "early",
          taskKey: "S1-T09",
          type: "TEST",
          input: { acKeys: ["AC-09"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "pass",
                exitCode: 0,
                acResults: { "AC-09": "passed" }
              }
            ])
          },
          finishedAt: "2026-10-06T12:00:00.000Z"
        }),
        task({
          id: "ci",
          taskKey: "S4-T01",
          type: "BUILD",
          sliceKey: "S4",
          input: { acKeys: [] },
          output: {
            gitCommit: "cccccccccccccccccccccccccccccccccccccccc",
            testCommand: "pnpm test",
            testResults: { "AC-09": "failed" }
          },
          finishedAt: "2026-10-06T14:00:00.000Z"
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("failed");
    const authoritative = view.criteria[0]?.tests.find((ref) => ref.authoritative === true);
    expect(authoritative).toMatchObject({
      taskKey: "S4-T01",
      command: "pnpm test",
      commitSha: "cccccccccccccccccccccccccccccccccccccccc",
      result: "failed"
    });
    // 早期绿灯证据保留在列表中，但判定以交付前全量为准。
    expect(view.criteria[0]?.tests.some((ref) => ref.taskKey === "S1-T09")).toBe(true);
    expect(view.summary.failed).toBe(1);
    expect(renderTraceabilityMarkdown(view)).toContain("交付前全量");
  });

  it("FX-18：交付前全量通过时覆盖早期失败（以最终集成为准）", () => {
    const view = buildRequirementTraceability({
      requirementId: "r1",
      criteria: [criterion("AC-10")],
      runtimeTasks: [
        task({
          id: "early",
          taskKey: "S1-T10",
          type: "TEST",
          input: { acKeys: ["AC-10"] },
          output: {
            verification: verification([
              {
                name: "test",
                expected: "pass",
                exitCode: 1,
                acResults: { "AC-10": "failed" }
              }
            ])
          },
          finishedAt: "2026-10-06T12:00:00.000Z"
        }),
        task({
          id: "ci",
          taskKey: "S4-T01",
          type: "BUILD",
          input: { acKeys: [] },
          output: {
            gitCommit: "dddddddddddddddddddddddddddddddddddddddd",
            testResults: { "AC-10": "passed" }
          },
          finishedAt: "2026-10-06T14:00:00.000Z"
        })
      ]
    });

    expect(view.criteria[0]?.status).toBe("passed");
  });
});
