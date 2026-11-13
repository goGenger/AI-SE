import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRuntime } from "../ToolRuntime";
import { ToolExecutionError } from "../errors";
import { createPhase1Tools } from "../tools";
import {
  ToolCallFinishedRecord,
  ToolCallStartedRecord,
  ToolDefinition,
  ToolExecutionContext
} from "../types";

class FakeSandbox implements Sandbox {
  public commands: SandboxCommand[] = [];

  constructor(private readonly handler: (command: SandboxCommand) => SandboxResult) {}

  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.commands.push(command);
    return this.handler(command);
  }
}

function sandboxResult(
  command: SandboxCommand,
  overrides: Partial<SandboxResult> = {}
): SandboxResult {
  return {
    command: command.command,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    duration: 1,
    timedOut: false,
    ...overrides
  };
}

function context(sandbox: Sandbox, signal?: AbortSignal): ToolExecutionContext {
  return {
    requestId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "tool-call-1",
    actor: "test",
    workspacePath: process.cwd(),
    sandbox,
    timeoutMs: 20,
    signal
  };
}

describe("ToolRuntime", () => {
  it("executes a file tool through the sandbox", async () => {
    const sandbox = new FakeSandbox((command) =>
      sandboxResult(command, { stdout: "file-content" })
    );
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("read_file", { path: "src/index.ts" }, context(sandbox));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ path: "src/index.ts", content: "file-content" });
    expect(sandbox.commands[0].command).toContain("cat");
  });

  it("returns a validation error for invalid tool input", async () => {
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });
    const result = await runtime.execute(
      "read_file",
      { path: "" },
      context(new FakeSandbox(sandboxResult))
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
  });

  it("maps workspace aliases for cwd and still rejects paths outside the workspace", async () => {
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });
    const sandbox = new FakeSandbox(sandboxResult);

    const read = await runtime.execute(
      "read_file",
      { path: "src/index.ts", cwd: "/" },
      context(sandbox)
    );
    expect(read.success).toBe(true);
    expect(sandbox.commands[0].cwd).toBe(".");

    const status = await runtime.execute("git_status", { cwd: "/workspace" }, context(sandbox));
    expect(status.success).toBe(true);
    expect(sandbox.commands[1].cwd).toBe(".");

    const nested = await runtime.execute("git_diff", { cwd: "/workspace/src" }, context(sandbox));
    expect(nested.success).toBe(true);
    expect(sandbox.commands[2].cwd).toBe("src");

    const outside = await runtime.execute("git_status", { cwd: "/etc" }, context(sandbox));
    expect(outside.success).toBe(false);
    expect(outside.error?.code).toBe("TOOL_ERROR");
    expect(outside.error?.message).toContain("cwd must stay inside the workspace");
  });

  it("classifies failed unit tests as TEST_ERROR", async () => {
    const sandbox = new FakeSandbox((command) =>
      sandboxResult(command, { exitCode: 1, stderr: "expected 20 got 5" })
    );
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute(
      "run_unit_test",
      { command: "node --test tests/*.test.ts" },
      context(sandbox)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TEST_ERROR");
  });

  it("classifies sandbox failures as SANDBOX_ERROR", async () => {
    const sandbox: Sandbox = {
      async runCommand() {
        throw new Error("docker unavailable");
      }
    };
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("read_file", { path: "src/index.ts" }, context(sandbox));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("SANDBOX_ERROR");
  });

  it("classifies git command failure", async () => {
    const sandbox = new FakeSandbox((command) =>
      sandboxResult(command, { exitCode: 128, stderr: "not a git repository" })
    );
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("git_status", {}, context(sandbox));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("COMMAND_ERROR");
  });

  it("enforces timeout", async () => {
    const slowTool: ToolDefinition<unknown, unknown> = {
      name: "slow",
      description: "Slow test tool",
      riskLevel: "LOW",
      inputSchema: z.object({}),
      async execute(_input, toolContext) {
        await new Promise((_resolve, reject) => {
          toolContext.signal?.addEventListener(
            "abort",
            () => reject(new ToolExecutionError("TIMEOUT_ERROR", "aborted")),
            { once: true }
          );
        });
      }
    };
    const runtime = new ToolRuntime({ tools: [slowTool] });

    const result = await runtime.execute("slow", {}, context(new FakeSandbox(sandboxResult)));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
  });

  it("honors cancellation before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute(
      "read_file",
      { path: "src/index.ts" },
      context(new FakeSandbox(sandboxResult), controller.signal)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CANCELLED_ERROR");
  });

  it("records tool call audit summaries", async () => {
    const started: ToolCallStartedRecord[] = [];
    const finished: ToolCallFinishedRecord[] = [];
    const sandbox = new FakeSandbox((command) =>
      sandboxResult(command, { stdout: "const token = 'hidden'" })
    );
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute(
      "read_file",
      { path: "src/index.ts" },
      {
        ...context(sandbox),
        iteration: 3,
        toolCallRecorder: {
          async recordToolCallStarted(record) {
            started.push(record);
          },
          async recordToolCallFinished(record) {
            finished.push(record);
          }
        }
      }
    );

    expect(result.success).toBe(true);
    expect(started[0]).toMatchObject({
      agentRunId: "run-1",
      iteration: 3,
      toolCallId: "tool-call-1",
      toolName: "read_file"
    });
    expect(finished[0]).toMatchObject({
      agentRunId: "run-1",
      toolCallId: "tool-call-1",
      status: "succeeded"
    });
    expect(finished[0].output?.summary).toContain("src/index.ts");
  });

  it("7-A：审计与日志带 workflowRunId，且与 tool_calls 的对齐键同在", async () => {
    const entries: Array<{ data: unknown; message: string | undefined }> = [];
    const logger = {
      info: (data: unknown, message?: string) => entries.push({ data, message }),
      warn: (data: unknown, message?: string) => entries.push({ data, message }),
      error: (data: unknown, message?: string) => entries.push({ data, message })
    } as unknown as ToolExecutionContext["logger"];

    const sandbox = new FakeSandbox((command) => sandboxResult(command, { stdout: "file-content" }));
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });
    const result = await runtime.execute("read_file", { path: "src/index.ts" }, {
      ...context(sandbox),
      workflowRunId: "workflow-1",
      logger
    });

    expect(result.success).toBe(true);
    expect(result.audit.workflowRunId).toBe("workflow-1");
    // 对齐键：agentRunId + toolCallId 与 tool_calls 行一致，workflowRunId 指回工作流。
    expect(result.audit).toMatchObject({
      agentRunId: "run-1",
      toolCallId: "tool-call-1",
      workflowRunId: "workflow-1"
    });

    const logged = entries.filter(
      (entry) => entry.message === "tool execution started" || entry.message === "tool execution finished"
    );
    expect(logged).toHaveLength(2);
    for (const entry of logged) {
      expect((entry.data as { audit?: unknown }).audit).toMatchObject({
        agentRunId: "run-1",
        toolCallId: "tool-call-1",
        workflowRunId: "workflow-1"
      });
    }

    // 未知工具的失败路径同样带 workflowRunId（审计不因失败而缺字段）。
    const failure = await runtime.execute("not_a_tool", {}, {
      ...context(sandbox),
      workflowRunId: "workflow-1"
    });
    expect(failure.success).toBe(false);
    expect(failure.audit.workflowRunId).toBe("workflow-1");
  });

  it("7-A：没有工作流时 workflowRunId 缺省（单次运行行为不变）", async () => {
    const sandbox = new FakeSandbox((command) => sandboxResult(command));
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });
    const result = await runtime.execute("read_file", { path: "src/index.ts" }, context(sandbox));
    expect(result.audit.workflowRunId).toBeUndefined();
  });
});
