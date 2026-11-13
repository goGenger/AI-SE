import { DockerSandbox } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodingAgent } from "../coding/CodingAgent";
import { ScriptedCodingLLMProvider } from "../llm/ScriptedCodingLLMProvider";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

function workspaceRoot(): string {
  return path.resolve(process.cwd(), "../..");
}

describe.skipIf(!runDockerTests)("CodingAgent Docker E2E", () => {
  it("fixes the sample project bug through LangGraph, ToolRuntime, and Docker Sandbox", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-se-e2e-"));
    const workspacePath = path.join(tempRoot, "coding-agent-test-project");
    await cp(path.join(workspaceRoot(), "examples/coding-agent-test-project"), workspacePath, {
      recursive: true
    });

    try {
      const sandbox = new DockerSandbox({
        allowedWorkspaceRoot: tempRoot,
        limits: {
          timeoutMs: 45_000,
          network: "none",
          cpus: 1,
          memory: "512m",
          pidsLimit: 1024
        }
      });
      const toolRuntime = new ToolRuntime({ tools: createPhase1Tools() });

      const initGit = await toolRuntime.execute(
        "run_command",
        {
          command:
            "git init && git config user.email phase1@example.local && git config user.name 'AI-SE Phase1' && git add . && git commit -m initial",
          timeoutMs: 30_000
        },
        {
          requestId: "req-e2e-setup",
          taskId: "task-e2e-setup",
          agentRunId: "run-e2e-setup",
          toolCallId: "tool-e2e-setup",
          actor: "vitest",
          workspacePath,
          sandbox,
          timeoutMs: 30_000
        }
      );
      expect(initGit.success).toBe(true);

      const agent = new CodingAgent({
        llmProvider: new ScriptedCodingLLMProvider(),
        toolRuntime,
        defaultTimeoutMs: 180_000,
        defaultMaxIterations: 16
      });

      const result = await agent.run(
        "修复项目中的测试失败问题，并确保所有测试通过。",
        {
          requestId: "req-e2e",
          projectId: "project-e2e",
          taskId: "task-e2e",
          agentRunId: "run-e2e",
          actor: "vitest",
          workspacePath,
          sandbox
        },
        {
          maxIterations: 16,
          timeoutMs: 180_000
        }
      );

      expect(result.status).toBe("succeeded");
      expect(
        result.toolResults.some((entry) => entry.toolName === "git_diff" && entry.success)
      ).toBe(true);
      expect(
        result.toolResults.some(
          (entry) =>
            entry.toolName === "run_unit_test" &&
            !entry.success &&
            entry.error?.code === "TEST_ERROR"
        )
      ).toBe(true);
      expect(
        result.toolResults.some((entry) => entry.toolName === "run_unit_test" && entry.success)
      ).toBe(true);

      const finalTest = await toolRuntime.execute(
        "run_unit_test",
        {
          command: "node --test --experimental-strip-types tests/*.test.ts",
          timeoutMs: 30_000
        },
        {
          requestId: "req-e2e-verify",
          taskId: "task-e2e-verify",
          agentRunId: "run-e2e-verify",
          toolCallId: "tool-e2e-verify",
          actor: "vitest",
          workspacePath,
          sandbox,
          timeoutMs: 30_000
        }
      );

      expect(finalTest.success).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
