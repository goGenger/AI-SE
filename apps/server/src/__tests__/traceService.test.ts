import {
  AgentRun,
  Deployment,
  Task,
  ToolCallAudit,
  TraceNode,
  WorkflowRun
} from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { TraceService, TraceSources } from "../services/traceService";

/** 7-C：追踪树组装单测（数据来源为窄接口，无需数据库）。 */

const T0 = "2026-10-15T10:00:00.000Z";
const T1 = "2026-10-15T10:00:05.000Z";
const T2 = "2026-10-15T10:00:20.000Z";

function workflow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wf-1",
    projectId: "p-1",
    requirementId: "r-1",
    planningVersion: 1,
    status: "SUCCESS",
    policy: {
      maxConcurrency: 1,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    startedAt: T0,
    finishedAt: T2,
    createdAt: T0,
    updatedAt: T2,
    ...overrides
  };
}

function task(overrides: Partial<Task> & { id: string; taskKey: string }): Task {
  return {
    projectId: "p-1",
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
    createdAt: T0,
    updatedAt: T2,
    ...overrides
  };
}

function agentRun(overrides: Partial<AgentRun> & { id: string; taskId: string }): AgentRun {
  return {
    status: "succeeded",
    input: {},
    currentIteration: 1,
    maxIterations: 10,
    retryCount: 0,
    createdAt: T0,
    updatedAt: T1,
    ...overrides
  };
}

function toolCall(
  overrides: Partial<ToolCallAudit> & { id: string; agentRunId: string; toolCallId: string }
): ToolCallAudit {
  return {
    iteration: 1,
    toolName: "read_file",
    input: {},
    status: "succeeded",
    startedAt: T0,
    createdAt: T0,
    ...overrides
  };
}

function deployment(overrides: Partial<Deployment> & { id: string; taskId: string }): Deployment {
  return {
    projectId: "p-1",
    workflowRunId: "wf-1",
    version: "1.0.0",
    environment: "staging",
    image: "ai-se-app:abcdef",
    gitCommit: "abcdef1234567890",
    operation: "DEPLOY",
    status: "SUCCESS",
    endpoint: "http://127.0.0.1:3000",
    healthCheck: {},
    createdAt: T0,
    updatedAt: T1,
    ...overrides
  };
}

function sources(overrides: Partial<TraceSources> = {}): TraceSources {
  return {
    findWorkflowById: async () => workflow(),
    findTasks: async () => [],
    findByTaskIds: async () => [],
    findByAgentRunIds: async () => [],
    findByWorkflowRunId: async () => [],
    findWorkflowStartedRequestId: async () => undefined,
    ...overrides
  };
}

function kinds(node: TraceNode): string[] {
  return [node.kind, ...node.children.flatMap(kinds)];
}

describe("TraceService", () => {
  it("returns null when the workflow run does not exist", async () => {
    const trace = await new TraceService(
      sources({ findWorkflowById: async () => null })
    ).build("missing");
    expect(trace).toBeNull();
  });

  it("assembles Workflow → Task → AgentRun → ToolCall and attaches deployments to their task", async () => {
    const trace = await new TraceService(
      sources({
        findTasks: async () => [
          task({ id: "t-1", taskKey: "CI", type: "BUILD" }),
          task({ id: "t-2", taskKey: "STAGING", type: "DEPLOY", status: "WAITING_APPROVAL" })
        ],
        findByTaskIds: async () => [
          agentRun({ id: "ar-1", taskId: "t-1", startedAt: T0, finishedAt: T1 }),
          agentRun({
            id: "ar-2",
            taskId: "t-2",
            input: { runtime: "delivery-orchestrator", workflowRunId: "wf-1" }
          })
        ],
        findByAgentRunIds: async () => [
          toolCall({
            id: "tc-1",
            agentRunId: "ar-1",
            toolCallId: "call-1",
            toolName: "run_unit_test",
            startedAt: T0,
            finishedAt: T1
          }),
          toolCall({
            id: "tc-2",
            agentRunId: "ar-2",
            toolCallId: "call-2",
            toolName: "deploy_release",
            startedAt: T0,
            finishedAt: T1
          })
        ],
        findByWorkflowRunId: async () => [deployment({ id: "d-1", taskId: "t-2" })],
        findWorkflowStartedRequestId: async () => "req-1"
      })
    ).build("wf-1");

    expect(trace?.requestId).toBe("req-1");
    expect(trace?.counts).toEqual({ tasks: 2, agentRuns: 2, toolCalls: 2, deployments: 1 });
    expect(kinds(trace!.root)).toEqual([
      "workflow",
      "task",
      "agentRun",
      "toolCall",
      "task",
      "agentRun",
      "toolCall",
      "deployment"
    ]);

    const [ci, staging] = trace!.root.children;
    expect(ci.label).toBe("CI");
    expect(ci.children[0].label).toBe("agent"); // 无 agentName/runtime 时的回落
    expect(ci.children[0].children[0].label).toBe("run_unit_test");
    expect(staging.label).toBe("STAGING");
    expect(staging.status).toBe("WAITING_APPROVAL");
    expect(staging.children[0].label).toBe("delivery-orchestrator");
    expect(staging.children[1].kind).toBe("deployment");
    expect(staging.children[1].label).toBe("staging DEPLOY");
  });

  it("computes duration from timestamps and falls back to the recorded tool duration", async () => {
    const trace = await new TraceService(
      sources({
        findTasks: async () => [task({ id: "t-1", taskKey: "A", startedAt: T0, finishedAt: T2 })],
        findByTaskIds: async () => [
          agentRun({ id: "ar-1", taskId: "t-1", startedAt: T0, finishedAt: T1 })
        ],
        findByAgentRunIds: async () => [
          // 时间戳齐全 → 用差值；缺 finished_at → 用记录的 duration。
          toolCall({
            id: "tc-1",
            agentRunId: "ar-1",
            toolCallId: "call-1",
            startedAt: T0,
            finishedAt: T1
          }),
          toolCall({
            id: "tc-2",
            agentRunId: "ar-1",
            toolCallId: "call-2",
            startedAt: T0,
            duration: 250
          })
        ]
      })
    ).build("wf-1");

    expect(trace!.root.durationMs).toBe(20_000);
    expect(trace!.root.children[0].durationMs).toBe(20_000);
    expect(trace!.root.children[0].children[0].durationMs).toBe(5_000);
    expect(trace!.root.children[0].children[0].children.map((n) => n.durationMs)).toEqual([
      5_000, 250
    ]);
  });

  it("redacts credential-shaped strings and never carries tool input or output", async () => {
    const trace = await new TraceService(
      sources({
        findTasks: async () => [task({ id: "t-1", taskKey: "A" })],
        findByTaskIds: async () => [
          agentRun({
            id: "ar-1",
            taskId: "t-1",
            input: { agentName: "sk-abcdefghijklmnop", agentType: "BACKEND" }
          })
        ],
        findByAgentRunIds: async () => [
          toolCall({
            id: "tc-1",
            agentRunId: "ar-1",
            toolCallId: "call-1",
            input: { command: "echo ghp_abcdefghijklmnop" },
            output: { stdout: "ghp_abcdefghijklmnop" }
          })
        ]
      })
    ).build("wf-1");

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(trace!.root.children[0].children[0].label).toBe("[REDACTED]");
    expect(trace!.root.children[0].children[0].children[0].detail).not.toHaveProperty("input");
    expect(trace!.root.children[0].children[0].children[0].detail).not.toHaveProperty("output");
  });

  it("orders tasks by execution start and puts not-yet-started tasks last", async () => {
    const trace = await new TraceService(
      sources({
        // 仓储顺序是字母序（同一事务克隆出来的任务 created_at 相同）。
        findTasks: async () => [
          task({ id: "t-1", taskKey: "CI", startedAt: T0, finishedAt: T1 }),
          task({ id: "t-2", taskKey: "E2E" }),
          task({ id: "t-3", taskKey: "PRODUCTION" }),
          task({ id: "t-4", taskKey: "STAGING", startedAt: T1, finishedAt: T2 })
        ]
      })
    ).build("wf-1");

    expect(trace!.root.children.map((node) => node.label)).toEqual([
      "CI",
      "STAGING",
      "E2E",
      "PRODUCTION"
    ]);
  });

  it("keeps the tree when the request id lookup fails", async () => {
    const trace = await new TraceService(
      sources({
        findTasks: async () => [task({ id: "t-1", taskKey: "A" })],
        findWorkflowStartedRequestId: async () => {
          throw new Error("workflow_events unavailable");
        }
      })
    ).build("wf-1");

    expect(trace).not.toBeNull();
    expect(trace?.requestId).toBeUndefined();
    expect(trace?.counts.tasks).toBe(1);
  });
});
