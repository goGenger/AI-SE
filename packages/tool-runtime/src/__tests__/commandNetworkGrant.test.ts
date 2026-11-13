import { ENV_GAP_INSTALL_TIMEOUT_MS, E2E_SANDBOX_MEMORY, E2E_TEST_TIMEOUT_MS, Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { describe, expect, it } from "vitest";
import { createCommandTools } from "../tools/commandTools";
import { ToolExecutionContext } from "../types";

/**
 * `docs/236` §4.2：**网络按命令授予**。
 *
 * 验收原文：「`build` / `test` / `preview` / 任意 shell 仍 `none`；`install` 命令有网」。
 * 这组用例断言的是**传给沙箱的 `network` 字段**——真跑 docker 的那条在
 * `packages/sandbox/src/__tests__/sandboxPnpm.e2e.test.ts` 的 registry 组里。
 */

const tools = new Map(createCommandTools().map((tool) => [tool.name, tool]));

function tool(name: string) {
  const found = tools.get(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const DEFAULT_SCRIPTS = { test: "vitest run", build: "vite build", lint: "eslint ." };

/** 记录每次 `runCommand` 的入参，返回成功结果。 */
function recordingSandbox(
  scripts: Record<string, string> = DEFAULT_SCRIPTS
): { sandbox: Sandbox; calls: SandboxCommand[] } {
  const calls: SandboxCommand[] = [];
  const sandbox: Sandbox = {
    async runCommand(_workspace, command): Promise<SandboxResult> {
      calls.push(command);
      return {
        command: command.command,
        exitCode: 0,
        // 探测命令要回一份能解析的 facts，其余随便。
        stdout: JSON.stringify({
          hasPackageJson: true,
          lockfiles: ["pnpm-lock.yaml"],
          scripts
        }),
        stderr: "",
        duration: 1,
        timedOut: false
      };
    }
  };
  return { sandbox, calls };
}

function context(sandbox: Sandbox, dependencyInstallAllowed?: boolean): ToolExecutionContext {
  return {
    requestId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "tool-call-1",
    actor: "test",
    workspacePath: process.cwd(),
    sandbox,
    timeoutMs: 20,
    ...(dependencyInstallAllowed === undefined ? {} : { dependencyInstallAllowed })
  };
}

describe("docs/236 §4.2：只有 install 命令拿 registry", () => {
  it("run_command 跑 `pnpm install` 且项目获准时 → network: registry", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute(
      { command: "pnpm install --frozen-lockfile" },
      context(sandbox, true)
    );
    expect(calls.at(-1)?.network).toBe("registry");
  });

  it.each([
    ["pnpm build", "run_command"],
    ["pnpm test", "run_command"],
    ["pnpm preview", "run_command"],
    ["ls -la", "run_command"],
    ["git status", "run_command"]
  ])("%s 不拿网（即使项目获准）", async (command) => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute({ command }, context(sandbox, true));
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  /**
   * 分层的两道门：拼接命令**先**被既有黑名单拒掉（`curl`），根本走不到网络判定。
   * 这条用例钉住的是「网络判定不会成为绕过黑名单的新路径」。
   */
  it("拼接命令在到网络判定之前就被既有策略拒绝", async () => {
    const { sandbox, calls } = recordingSandbox();
    await expect(
      tool("run_command").execute(
        { command: "pnpm install && curl http://1.1.1.1" },
        context(sandbox, true)
      )
    ).rejects.toThrow(/blocked by Phase 1 sandbox policy/);
    // 一次 `runCommand` 都没发生——策略在工具层就停了。
    expect(calls).toHaveLength(0);
  });

  it("不带黑名单关键词的拼接同样不拿网（分类器自己就拒绝了）", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute(
      { command: "pnpm install && node -e \"console.log(1)\"" },
      context(sandbox, true)
    );
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  it("项目**未**获准时 install 也无网（能力上限是项目级的）", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute({ command: "pnpm install" }, context(sandbox, false));
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  it("缺省（不传该字段）等价于未获准——既有调用方零行为变化", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute({ command: "pnpm install" }, context(sandbox));
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  it.each(["run_unit_test", "run_lint", "run_build"])(
    "%s 的默认命令永远不拿网（它们跑的是项目脚本，不是装依赖）",
    async (name) => {
      const { sandbox, calls } = recordingSandbox();
      await tool(name).execute({}, context(sandbox, true));
      expect(calls.at(-1)?.network).toBeUndefined();
    }
  );

  it("把 network 记进结果 data，便于批次归因", async () => {
    const { sandbox } = recordingSandbox();
    const data = (await tool("run_command").execute(
      { command: "pnpm install" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBe("registry");

    const plain = (await tool("run_command").execute(
      { command: "pnpm build" },
      context(sandbox, true)
    )) as { network?: string };
    // 没有网络时不写这个字段——保持既有结果形状不变。
    expect(plain.network).toBeUndefined();
  });
});

/**
 * N-57（`docs/232` §10）：**项目把 install 包进脚本**。
 *
 * 实测（F1 第二轮）：agent 跑的是 `pnpm run deps`，命令串本身不像 install ⇒ 无网 ⇒
 * 脚本内部的 `pnpm install` 只能命中镜像预热，registry 零请求。
 *
 * 这里钉的是「展开一层」的判定：脚本名只决定**要不要探测**，真正的判据是脚本体。
 */
describe("N-57：跑 install 脚本命令拿 registry", () => {
  it("`pnpm run deps`（脚本体是 pnpm install）→ network: registry", async () => {
    const { sandbox, calls } = recordingSandbox({ deps: "pnpm install --frozen-lockfile" });
    const data = (await tool("run_command").execute(
      { command: "pnpm run deps" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBe("registry");
    expect(calls.at(-1)?.command).toBe("pnpm run deps");
    expect(calls).toHaveLength(2); // 探测 + 命令
  });

  it("脚本体**不是** install（`deps` 只是个普通脚本）→ 无网", async () => {
    const { sandbox } = recordingSandbox({ deps: "echo nothing to do" });
    const data = (await tool("run_command").execute(
      { command: "pnpm run deps" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBeUndefined();
  });

  it("脚本体带 shell 语法（`&&` 串联）→ 无网（分类器自己就拒绝了）", async () => {
    const { sandbox } = recordingSandbox({ deps: "pnpm install && node -e \"console.log(1)\"" });
    const data = (await tool("run_command").execute(
      { command: "pnpm run deps" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBeUndefined();
  });

  it("项目**未**获准时不探测也不给网（能力上限是项目级的）", async () => {
    const { sandbox, calls } = recordingSandbox({ deps: "pnpm install" });
    await tool("run_command").execute({ command: "pnpm run deps" }, context(sandbox, false));
    expect(calls).toHaveLength(1); // 没有探测
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  it("已知非安装脚本（`test`）不探测脚本体——否则每条 pnpm test 都要起一个容器", async () => {
    const { sandbox, calls } = recordingSandbox({ test: "pnpm install" });
    await tool("run_command").execute({ command: "pnpm test" }, context(sandbox, true));
    // 可能还有 native-heal 探针，但不得展开 package.json 脚本体（N-57）。
    expect(calls.some((call) => /hasPackageJson|pnpmWorkspace/.test(call.command))).toBe(false);
    expect(calls.at(-1)?.command).toBe("pnpm test");
    expect(calls.at(-1)?.network).toBeUndefined();
  });

  /**
   * 黑名单而非白名单的理由：F1 的 `deps` 是 **agent 自己起的名字**，夹具模板里并没有它。
   * 任何「猜得到的安装脚本名清单」都会在下一次换个名字时静默失效——那正是 N-57 本身。
   */
  it("冷门脚本名也会探测（名字猜不到不等于拿不到网）", async () => {
    const { sandbox } = recordingSandbox({ "install-all": "pnpm install --frozen-lockfile" });
    const data = (await tool("run_command").execute(
      { command: "pnpm run install-all" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBe("registry");
  });

  it("run_build 带显式命令也能命中（F1 实测的正是这条路径）", async () => {
    const { sandbox } = recordingSandbox({ deps: "npm ci" });
    const data = (await tool("run_build").execute(
      { command: "pnpm run deps" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBe("registry");
  });

  it("探测失败 ⇒ fail closed（不因为探测挂了就给网）", async () => {
    const sandbox: Sandbox = {
      async runCommand(_workspace, command): Promise<SandboxResult> {
        const isProbe = command.command !== "pnpm run deps";
        return {
          command: command.command,
          exitCode: isProbe ? 1 : 0,
          stdout: "",
          stderr: isProbe ? "probe failed" : "",
          duration: 1,
          timedOut: false
        };
      }
    };
    const data = (await tool("run_command").execute(
      { command: "pnpm run deps" },
      context(sandbox, true)
    )) as { network?: string };
    expect(data.network).toBeUndefined();
  });
});


describe("docs/264：沙箱内 Playwright 浏览器安装被契约拒绝", () => {
  it("run_command playwright install is blocked instead of getting a registry grant", async () => {
    const { sandbox, calls } = recordingSandbox();
    await expect(
      tool("run_command").execute(
        { command: "npx playwright install chromium", timeoutMs: 20 },
        context(sandbox, true)
      )
    ).rejects.toThrow(/platform contract/i);
    expect(calls).toHaveLength(0);
  });

  it("npm run test:e2e:install is blocked and does not start a sandbox install", async () => {
    const { sandbox, calls } = recordingSandbox({
      "test:e2e:install": "playwright install chromium",
      test: "vitest run"
    });
    await expect(
      tool("run_lint").execute(
        { command: "npm run test:e2e:install" },
        context(sandbox, true)
      )
    ).rejects.toThrow(/platform contract/i);
    expect(calls).toHaveLength(0);
  });
});

describe("docs/256：Playwright test gets worker cap, 2g memory, and long timeout", () => {
  it("run_command npm run test:e2e appends --workers=2 and memory 2g", async () => {
    const { sandbox, calls } = recordingSandbox({
      "test:e2e": "playwright test",
      test: "vitest run"
    });
    await tool("run_command").execute(
      { command: "npm run test:e2e", timeoutMs: 20 },
      context(sandbox)
    );
    const last = calls.at(-1);
    expect(last?.command).toBe("npm run test:e2e -- --workers=2");
    expect(last?.memory).toBe(E2E_SANDBOX_MEMORY);
    expect(last?.timeoutMs).toBe(E2E_TEST_TIMEOUT_MS);
  });

  it("does not raise an existing --workers=1", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute(
      { command: "npx playwright test --workers=1" },
      context(sandbox)
    );
    const last = calls.at(-1);
    expect(last?.command).toBe("npx playwright test --workers=1");
    expect(last?.memory).toBe(E2E_SANDBOX_MEMORY);
  });

  it("leaves vitest unit tests on default limits", async () => {
    const { sandbox, calls } = recordingSandbox();
    await tool("run_command").execute({ command: "npm run test" }, context(sandbox));
    const last = calls.at(-1);
    expect(last?.command).toBe("npm run test");
    expect(last?.memory).toBeUndefined();
    expect(last?.timeoutMs).toBe(20);
  });
});
