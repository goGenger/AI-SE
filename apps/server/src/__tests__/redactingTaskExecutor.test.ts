import { Task, WorkflowRun } from "@ai-se/shared";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { describe, expect, it } from "vitest";
import { RedactingWorkflowTaskExecutor } from "../services/redactingTaskExecutor";

function makeWorkflow(): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: "wf-redact",
    projectId: "project-redact",
    requirementId: "req-redact",
    planningVersion: 1,
    status: "RUNNING",
    policy: {
      maxConcurrency: 1,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: false,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: now,
    updatedAt: now
  };
}

function makeTask(): Task {
  const now = new Date().toISOString();
  return {
    id: "task-redact",
    projectId: "project-redact",
    taskKey: "S1-T99",
    title: "Redact output",
    description: "carries credential-shaped strings",
    type: "BACKEND",
    status: "RUNNING",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

describe("RedactingWorkflowTaskExecutor (D-3/T8-c)", () => {
  it("scrubs credential-shaped strings and sensitive keys from task output", async () => {
    const inner: WorkflowTaskExecutor = {
      async execute(): Promise<TaskExecutionResult> {
        return {
          status: "succeeded",
          output: {
            summary:
              "leaked sk-test-redteam-0123456789abcdef and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWR0ZWFtIn0.fake-signature",
            nested: { token: "sk-abcdefgh12345678", note: "keep me" },
            list: ["Bearer abcdefgh12345678"]
          },
          agentRunId: "run-redact"
        };
      },
      async cancel() {
        return undefined;
      }
    };
    const executor = new RedactingWorkflowTaskExecutor(inner);

    const result = await executor.execute(makeWorkflow(), makeTask());

    const output = result.output as {
      summary: string;
      nested: { token: string; note: string };
      list: string[];
    };
    expect(output.summary).not.toContain("sk-test-redteam");
    expect(output.summary).not.toContain("eyJhbGci");
    expect(output.nested.token).toBe("[REDACTED]");
    expect(output.nested.note).toBe("keep me");
    expect(output.list[0]).not.toContain("abcdefgh12345678");
    expect(result.agentRunId).toBe("run-redact");
  });

  it("returns results without output untouched", async () => {
    const inner: WorkflowTaskExecutor = {
      async execute(): Promise<TaskExecutionResult> {
        return { status: "failed", error: { code: "X", message: "boom" } };
      },
      async cancel() {
        return undefined;
      }
    };
    const result = await new RedactingWorkflowTaskExecutor(inner).execute(
      makeWorkflow(),
      makeTask()
    );
    expect(result.output).toBeUndefined();
    expect(result.status).toBe("failed");
  });
});
