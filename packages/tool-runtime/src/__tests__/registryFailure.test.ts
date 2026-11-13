import { Sandbox, SandboxResult } from "@ai-se/sandbox";
import { describe, expect, it } from "vitest";
import { createCommandTools } from "../tools/commandTools";
import { ToolExecutionContext } from "../types";

/**
 * `docs/236` §4.3：三种失败模式必须**可判别**。
 *
 * 这里只验「判别本身」——用假沙箱喂真实 pnpm 输出样张（样张取自 `docs/238` 的实测记录）。
 * 真跑 docker 的对照在 `packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts`。
 *
 * 判别落成 `details.reason` 而不是新 `RuntimeErrorCode`：`AGENTS.md` §10 禁止第二套错误码
 * 体系，`RuntimeErrorCode` 是全仓共用的闭集。
 */

const runCommand = createCommandTools().find((tool) => tool.name === "run_command")!;

function sandboxWith(output: string, exitCode = 1): Sandbox {
  return {
    async runCommand(_workspace, command): Promise<SandboxResult> {
      return {
        command: command.command,
        exitCode,
        stdout: output,
        stderr: "",
        duration: 1,
        timedOut: false
      };
    }
  };
}

function context(sandbox: Sandbox): ToolExecutionContext {
  return {
    requestId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "tool-call-1",
    actor: "test",
    workspacePath: process.cwd(),
    sandbox,
    timeoutMs: 20,
    dependencyInstallAllowed: true
  };
}

async function detailsFor(output: string): Promise<Record<string, unknown>> {
  try {
    await runCommand.execute({ command: "pnpm install" }, context(sandboxWith(output)));
  } catch (error) {
    return ((error as { details?: Record<string, unknown> }).details ?? {}) as Record<
      string,
      unknown
    >;
  }
  throw new Error("expected the command to fail");
}

describe("docs/236 §4.3：registry 失败的判别", () => {
  it("registry 不可达 → details.reason = REGISTRY_UNAVAILABLE（实测样张）", async () => {
    const details = await detailsFor(
      " WARN  GET http://ai-se-registry:4873/chalk error (EAI_AGAIN). Will retry in 10 seconds.\n" +
        " ERR_PNPM_META_FETCH_FAIL  GET http://ai-se-registry:4873/chalk: request to " +
        "http://ai-se-registry:4873/chalk failed, reason: getaddrinfo EAI_AGAIN ai-se-registry"
    );
    expect(details.reason).toBe("REGISTRY_UNAVAILABLE");
  });

  it("包不存在 → **不**标 REGISTRY_UNAVAILABLE，原样返回 pnpm 的 404", async () => {
    const details = await detailsFor(
      " ERR_PNPM_FETCH_404  GET http://ai-se-registry:4873/no-such-package: Not Found - 404"
    );
    expect(details.reason).toBeUndefined();
    expect(JSON.stringify(details)).toContain("404");
  });

  it("普通失败（依赖冲突等）不误判成 registry 故障", async () => {
    const details = await detailsFor(
      " ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n vite@8 requires vue@^3"
    );
    expect(details.reason).toBeUndefined();
  });

  /**
   * 关键边界：判别只在**真的开了 registry** 时才有意义。无网沙箱里 install 失败是
   * `EAI_AGAIN`（连不上 npmjs），那是**预期行为**，不该报成 registry 故障。
   */
  it("无网沙箱里的 install 失败不会被标成 REGISTRY_UNAVAILABLE", async () => {
    const sandbox: Sandbox = {
      async runCommand(_workspace, command): Promise<SandboxResult> {
        return {
          command: command.command,
          exitCode: 1,
          stdout: " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/chalk: EAI_AGAIN",
          stderr: "",
          duration: 1,
          timedOut: false
        };
      }
    };
    try {
      await runCommand.execute(
        { command: "pnpm install" },
        { ...context(sandbox), dependencyInstallAllowed: false }
      );
      throw new Error("expected failure");
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.reason).toBeUndefined();
    }
  });
});
