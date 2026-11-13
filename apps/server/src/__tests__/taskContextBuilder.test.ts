import { AgentRegistry } from "@ai-se/agent-core";
import { Project, Requirement, Task, WorkflowRun } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { TaskContextBuilder } from "../services/taskContextBuilder";

/**
 * 2026-10-15 裁定（`docs/151`）：验证记录留在任务输出里，但**不进 Agent 输入**。
 * 这里钉住的是「不进输入」与「存储不动」两件事。
 */

const NOW = "2026-10-15T10:00:00.000Z";

const project: Project = {
  id: "p-1",
  name: "Project",
  description: "",
  repository: null,
  workspacePath: null,
  status: "active",
  createdAt: NOW,
  updatedAt: NOW
};

const requirement: Requirement = {
  id: "r-1",
  projectId: "p-1",
  title: "Requirement",
  description: "",
  rawContent: "",
  status: "ANALYZED",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

const workflow: WorkflowRun = {
  id: "wf-1",
  projectId: "p-1",
  requirementId: "r-1",
  planningVersion: 1,
  status: "RUNNING",
  policy: {
    maxConcurrency: 1,
    maxRetries: 1,
    failureStrategy: "FAIL_FAST",
    allowRetry: true,
    allowReplan: false,
    approvalRequired: false
  },
  input: {},
  createdAt: NOW,
  updatedAt: NOW
};

function task(overrides: Partial<Task> & { id: string; taskKey: string }): Task {
  return {
    projectId: "p-1",
    requirementId: "r-1",
    workflowRunId: "wf-1",
    title: overrides.taskKey,
    description: "",
    type: "BACKEND",
    status: "SUCCESS",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    origin: "RUNTIME",
    approvalRequired: false,
    failureHandled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function builderFor(upstreams: Task[], downstream: Task): TaskContextBuilder {
  return new TaskContextBuilder({
    projects: { findById: async () => project },
    planning: {
      findRequirementById: async () => requirement,
      findSpecificationsByRequirementId: async () => []
    },
    workflows: {
      findTasks: async () => [...upstreams, downstream],
      findDependencies: async () =>
        upstreams.map((upstream, index) => ({
          id: `d-${index}`,
          sourceTaskId: upstream.id,
          targetTaskId: downstream.id,
          sourceTaskKey: upstream.taskKey,
          targetTaskKey: downstream.taskKey,
          origin: "RUNTIME" as const,
          active: true,
          createdAt: NOW
        }))
    },
    agentRuns: { findByTaskId: async () => [] },
    artifacts: { findByTaskIds: async () => [] }
  } as unknown as ConstructorParameters<typeof TaskContextBuilder>[0]);
}

const definition = new AgentRegistry().get("backend-agent");

describe("TaskContextBuilder", () => {
  it("keeps the verification record out of the Agent input without touching the stored output", async () => {
    const verification = {
      mode: "observe",
      verdict: "verified",
      checks: [
        {
          name: "test",
          passed: true,
          exitCode: 0,
          stdoutTail: "ok 1 - [AC-01] fine",
          stderrTail: ""
        }
      ],
      finishedAt: NOW
    };
    const stored = { outcome: "success", summary: "implemented", verification };
    const upstream = task({ id: "t-1", taskKey: "S1-T01", output: stored });
    const downstream = task({ id: "t-2", taskKey: "S1-T02", status: "RUNNING" });

    const context = await builderFor([upstream], downstream).build(definition, workflow, downstream);

    expect(context.dependencyResults).toHaveLength(1);
    // 不进 Agent 输入：其余字段照旧，验证记录不在。
    expect(context.dependencyResults[0].output).toEqual({
      outcome: "success",
      summary: "implemented"
    });
    expect(JSON.stringify(context.dependencyResults)).not.toContain("stdoutTail");
    // 存储不动：同一条记录仍带着验证，供 AC 覆盖判定与追溯表读取。
    expect(stored.verification).toBe(verification);
    expect(upstream.output).toHaveProperty("verification");
  });

  it("leaves outputs without a verification record untouched", async () => {
    const upstream = task({ id: "t-1", taskKey: "S1-T01", output: { outcome: "success" } });
    const bare = task({ id: "t-3", taskKey: "S1-T03", output: undefined });
    const downstream = task({ id: "t-2", taskKey: "S1-T02", status: "RUNNING" });

    const context = await builderFor([upstream, bare], downstream).build(
      definition,
      workflow,
      downstream
    );

    expect(context.dependencyResults.map((entry) => entry.output)).toEqual([
      { outcome: "success" },
      undefined
    ]);
  });

  /**
   * N-17（`docs/189` §4.3）：`enforce` 下任务**就是因此失败的**，理由必须传到下游与重试——
   * 否则被 replan 出来的修复任务看不到上游为什么死，同一个死法必然重演（L1-M4l 那 7 次）。
   * 收窄而非推翻 `docs/151`：只回灌压缩投影，体积来源一律不进。
   */
  it("feeds the enforced failure reason back, without the bulky fields", async () => {
    const verification = {
      mode: "enforce",
      verdict: "failed",
      reason: "protected test files weakened: src/test/store.test.js",
      failureCode: "VERIFICATION_FAILED",
      checks: [
        {
          name: "test",
          passed: false,
          exitCode: 1,
          stdoutTail: "not ok 1 - [AC-04]",
          stderrTail: ""
        }
      ],
      antiTamper: {
        verdict: "failed",
        changed: ["src/test/store.test.js"],
        weakened: ["src/test/store.test.js"]
      },
      finishedAt: NOW
    };
    const stored = { outcome: "failure", summary: "hardened the slice", verification };
    const upstream = task({ id: "t-1", taskKey: "S1-T01", status: "FAILED", output: stored });
    const downstream = task({ id: "t-2", taskKey: "S1-T01-DEBUG-1", status: "RUNNING" });

    const context = await builderFor([upstream], downstream).build(definition, workflow, downstream);

    expect(context.dependencyResults[0].output).toEqual({
      outcome: "failure",
      summary: "hardened the slice",
      verification: {
        verdict: "failed",
        reason: "protected test files weakened: src/test/store.test.js",
        failureCode: "VERIFICATION_FAILED"
      }
    });
    // 体积来源不进 Agent 输入（`docs/151` 实测它们占验证记录 53%）。
    const serialized = JSON.stringify(context.dependencyResults);
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("checks");
    expect(serialized).not.toContain("antiTamper");
    // 存储不动：同一条记录仍带着完整验证，供 AC 覆盖判定与追溯表读取。
    expect(stored.verification).toBe(verification);
  });

  it("docs/265: review/repair context reads official visual, not an agent self-report", async () => {
    const verification = {
      mode: "enforce",
      verdict: "failed",
      reason: "checks failed: visual",
      failureCode: "VISUAL_DEFAULT_SKIN",
      checks: [
        {
          name: "visual",
          passed: false,
          failureCode: "VISUAL_DEFAULT_SKIN",
          stdoutTail: "very long capture log",
          stderrTail: "date panel default skin",
          visual: {
            passed: false,
            failureCode: "VISUAL_DEFAULT_SKIN",
            reason: "日期面板含默认大日历插画",
            judged: "deterministic"
          }
        }
      ]
    };
    const stored = { outcome: "failure", summary: "已按 UI 图实现", verification };
    const upstream = task({ id: "t-1", taskKey: "S1-T13", type: "TEST", status: "FAILED", output: stored });
    const review = task({ id: "t-2", taskKey: "S1-T14", type: "REVIEW", status: "RUNNING" });
    const context = await builderFor([upstream], review).build(definition, workflow, review);
    expect(context.dependencyResults[0].output).toMatchObject({
      summary: "已按 UI 图实现",
      verification: {
        verdict: "failed",
        failureCode: "VISUAL_DEFAULT_SKIN",
        officialVisual: {
          passed: false,
          failureCode: "VISUAL_DEFAULT_SKIN",
          reason: "日期面板含默认大日历插画"
        }
      }
    });
    const serialized = JSON.stringify(context.dependencyResults);
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("very long capture log");
  });
});

/**
 * N-40（`docs/231` §8）：校验器按 `[AC-xx]` 标记选测试，而编号此前从未告诉 agent。
 * `acceptanceScope` 是那条断链的补口——口径必须与校验器的 `sliceScopeFallback` 一致。
 */
describe("TaskContextBuilder.acceptanceScope", () => {
  const noopBuilder = () =>
    new TaskContextBuilder({
      projects: { findById: async () => project },
      planning: {
        findRequirementById: async () => requirement,
        findSpecificationsByRequirementId: async () => []
      },
      workflows: {
        findTasks: async () => [
          task({ id: "t-1", taskKey: "S1-T01", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
          task({ id: "t-2", taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-02"] } }),
          task({ id: "t-3", taskKey: "S2-T01", sliceKey: "S2", input: { acKeys: ["AC-09"] } })
        ],
        findDependencies: async () => []
      },
      agentRuns: { findByTaskId: async () => [] },
      artifacts: { findByTaskIds: async () => [] }
    } as unknown as ConstructorParameters<typeof TaskContextBuilder>[0]);

  it("任务自己声明了编号就用它", async () => {
    const own = task({ id: "t-9", taskKey: "S1-T09", sliceKey: "S1", input: { acKeys: ["AC-07"] } });
    expect(await noopBuilder().acceptanceScope(workflow, own)).toEqual(["AC-07"]);
  });

  it("没声明时用同切片的并集（不含别的切片）", async () => {
    const bare = task({ id: "t-4", taskKey: "S1-T04", sliceKey: "S1" });
    expect(await noopBuilder().acceptanceScope(workflow, bare)).toEqual(["AC-01", "AC-02"]);
  });

  it("没有切片归属时不猜（空数组）", async () => {
    const orphan = task({ id: "t-5", taskKey: "X-T01" });
    expect(await noopBuilder().acceptanceScope(workflow, orphan)).toEqual([]);
  });

  it("读库失败时降级为空数组，而不是让任务起不来", async () => {
    const failing = new TaskContextBuilder({
      projects: { findById: async () => project },
      planning: {
        findRequirementById: async () => requirement,
        findSpecificationsByRequirementId: async () => []
      },
      workflows: {
        findTasks: async () => {
          throw new Error("db down");
        },
        findDependencies: async () => []
      },
      agentRuns: { findByTaskId: async () => [] },
      artifacts: { findByTaskIds: async () => [] }
    } as unknown as ConstructorParameters<typeof TaskContextBuilder>[0]);

    const bare = task({ id: "t-6", taskKey: "S1-T06", sliceKey: "S1" });
    expect(await failing.acceptanceScope(workflow, bare)).toEqual([]);
  });
});
