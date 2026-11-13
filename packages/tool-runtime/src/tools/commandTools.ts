import {
  capPlaywrightWorkers,
  commandAttemptsPlaywrightBump,
  commandIsSandboxPlaywrightBrowserInstall,
  e2eSandboxCommandLimits,
  E2E_TEST_TIMEOUT_MS,
  ENV_GAP_INSTALL_TIMEOUT_MS,
  isPlaywrightTestCommand,
  PLATFORM_PLAYWRIGHT_VERSION,
  SandboxResult
} from "@ai-se/sandbox";
import { z } from "zod";
import { ToolExecutionError } from "../errors";
import { ToolDefinition } from "../types";
import {
  buildPackageFactsProbeCommand,
  isDependencyInstallCommand,
  isPlaywrightBrowserInstallCommand,
  isScriptOnlyCommand,
  parsePackageFacts,
  planPackageScriptCommand,
  scriptInvocationName,
  shouldProbeScriptBody
} from "./packageManager";
import { commandFailureDetails, normalizeRelativePath } from "./shell";

const CommandInputSchema = z.object({
  command: z.string().trim().min(1),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Workspace-relative path; omit for the workspace root"),
  timeoutMs: z.number().int().positive().max(120_000).optional()
});

const EmptyCommandInputSchema = z.object({
  command: z.string().trim().min(1).optional(),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Workspace-relative path; omit for the workspace root"),
  timeoutMs: z.number().int().positive().max(120_000).optional()
});

/**
 * N-44（`docs/232` §9.5）：黑名单只匹配**会被执行的那个词**，不再对整串命令做正则。
 *
 * 旧实现 `/\b(docker|curl|…)\b/.test(command)` 把**参数里的数据**也当成命令：AC 作用域检查拼出的
 * `pnpm test -- 'test/docker-entrypoint.test.js' …` 因为路径里有 `docker` 被整条拒绝（`-` 是词边界），
 * 命令在沙箱里根本没跑起来（`exitCode: null`，1–5ms），任务被判 `checks failed: test`——而同一串手工
 * 执行是 16/16 通过。slice-5 的 5 次失败全部由这一个假阳性产生，且 DEBUG 每修一次就多一个 docker
 * 命名的测试文件，越修越死。
 *
 * 新口径：
 * - 命令头按 basename 精确匹配（`/usr/bin/docker` 仍然拦）；
 * - 其余**未加引号**的 token 必须与黑名单**完全相等**才拦（`sudo docker`、`xargs docker` 覆盖到，
 *   `test/docker`、`docker-entrypoint.test.js` 这类路径放行）；
 * - 引号内是数据，与 `containsUnquotedShellSyntax` 对引号内容的口径一致；唯一的例外是解释器的
 *   `-c/-e` 载荷——那是**要执行的代码**，仍按旧口径整串严格匹配，堵住 `sh -c "docker …"` 的绕道。
 */
const BLOCKED_EXECUTABLES = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "docker",
  "kubectl",
  "nc",
  "telnet"
]);

/** 解释器里「后面那串是要执行的代码」的旗标。 */
const CODE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print"]);

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "node"]);

/** 只用于解释器载荷（内部代码）的整串匹配，保持旧口径。 */
const BLOCKED_WORD = /\b(curl|wget|ssh|scp|docker|kubectl|nc|telnet)\b/;

interface CommandToken {
  text: string;
  quoted: boolean;
}

/** 引号感知的分词：引号内的空白不切分，反斜杠转义原样保留。
 *  `quoted` 只在 token **整段都被引号包住**时为真——`doc'ker'` 这种半引号形态仍按命令词匹配，
 *  避免用拼接引号绕过黑名单。 */
function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let text = "";
  let fullyQuoted = false;
  let quote: "'" | '"' | null = null;
  let started = false;

  const flush = (): void => {
    if (!started) return;
    tokens.push({ text, quoted: fullyQuoted });
    text = "";
    fullyQuoted = false;
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      else text += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\") {
        text += command[index + 1] ?? "";
        index += 1;
      } else text += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (!started) fullyQuoted = true;
      else fullyQuoted = false;
      started = true;
      continue;
    }
    if (char === "\\") {
      text += command[index + 1] ?? "";
      index += 1;
      started = true;
      fullyQuoted = false;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    text += char;
    started = true;
    fullyQuoted = false;
  }
  flush();
  return tokens;
}

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

export function createCommandTools(): ToolDefinition<unknown, unknown>[] {
  return [runCommandTool, runUnitTestTool, runLintTool, runBuildTool];
}

export function assertCommandAllowed(command: string): void {
  const blocked = (): never => {
    throw new ToolExecutionError("TOOL_ERROR", "Command is blocked by Phase 1 sandbox policy");
  };

  // docs/264：浏览器由平台镜像预置。禁止在无网沙箱里现装，也禁止把 Playwright 当普通依赖升级。
  if (commandIsSandboxPlaywrightBrowserInstall(command)) {
    throw new ToolExecutionError(
      "TOOL_ERROR",
      "Playwright browsers are a platform contract (docs/264): do not run playwright install / test:e2e:install in the sandbox. Use the baked Chromium for " +
        PLATFORM_PLAYWRIGHT_VERSION +
        " or fail closed as a contract mismatch."
    );
  }
  if (commandAttemptsPlaywrightBump(command)) {
    throw new ToolExecutionError(
      "TOOL_ERROR",
      "Playwright is a platform contract (docs/264): do not bump playwright / @playwright/test. Pin " +
        PLATFORM_PLAYWRIGHT_VERSION +
        " and do not treat it as an ordinary dependency upgrade."
    );
  }

  const tokens = tokenizeCommand(command);
  const head = tokens[0];
  if (!head) return;
  if (BLOCKED_EXECUTABLES.has(basename(head.text))) blocked();

  for (const token of tokens.slice(1)) {
    if (token.quoted) continue;
    if (BLOCKED_EXECUTABLES.has(token.text)) blocked();
  }

  if (!INTERPRETERS.has(basename(head.text))) return;
  for (let index = 1; index < tokens.length; index += 1) {
    if (!CODE_FLAGS.has(tokens[index]?.text ?? "")) continue;
    const payload = tokens[index + 1];
    if (payload && BLOCKED_WORD.test(payload.text)) blocked();
  }
}

/**
 * F1-7（FX-25）：默认命令按项目探测——`packageManager` 字段 → 唯一锁文件 → 回退 `npm run <script>`；
 * 仅当无 package.json 或脚本不存在时报错。显式 `command` 覆盖优先级不变（不触发探测）。
 */
async function resolveDefaultCommand(
  toolName: string,
  scriptName: string,
  context: Parameters<ToolDefinition<z.infer<typeof CommandInputSchema>, unknown>["execute"]>[1],
  errorCode: "COMMAND_ERROR" | "TEST_ERROR"
): Promise<{ command: string; warnings: string[] }> {
  const probe = await context.sandbox.runCommand(
    context.workspacePath,
    {
      command: buildPackageFactsProbeCommand(),
      timeoutMs: Math.min(context.timeoutMs ?? 30_000, 30_000)
    },
    context.signal
  );
  if (probe.exitCode !== 0) {
    throw new ToolExecutionError(errorCode, `${toolName}: package manager probe failed`, {
      command: probe.command,
      exitCode: probe.exitCode
    });
  }
  const plan = planPackageScriptCommand(scriptName, parsePackageFacts(probe.stdout));
  if (!plan.command) {
    throw new ToolExecutionError(errorCode, plan.errorMessage ?? "cannot resolve default command", {
      errorCode: plan.error ?? "PROBE_FAILED"
    });
  }
  return { command: plan.command, warnings: plan.warnings };
}

/**
 * N-57（`docs/232` §10）：**项目脚本里的 install**。
 *
 * 实测（`docs/239` §4.2，F1 第二轮）：项目把安装包成 `deps` 脚本后，agent 执行的是
 * `pnpm run deps`——分类器只看这条命令串，判不出 install ⇒ `network` 不传 ⇒ 脚本**内部的**
 * `pnpm install` 在无网容器里跑，只能命中镜像预热；`ai-se-registry` 该时段**零请求**。
 *
 * 修法是把脚本**展开一层**，但判定权仍在「命令内容」上：脚本名只用来决定**要不要探测**
 * （`test` / `build` 这类已知非安装脚本跳过，其余一律探测——见 `shouldProbeScriptBody`），
 * 真正的判据是 package.json 里那条脚本体本身是否 install 形态。探测在沙箱内进行——
 * 工具层不直接读宿主机文件。
 *
 * 探测失败、脚本不存在、脚本体不像 install ⇒ 一律不给网（fail closed）。
 * 脚本体经 `isDependencyInstallCommand` 检查，因此带 `&&` / 管道 / 命令替换的脚本拿不到网。
 */
async function installScriptBody(
  scriptName: string,
  context: Parameters<ToolDefinition<z.infer<typeof CommandInputSchema>, unknown>["execute"]>[1]
): Promise<string | undefined> {
  if (!shouldProbeScriptBody(scriptName)) return undefined;
  try {
    const probe = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: buildPackageFactsProbeCommand(),
        timeoutMs: Math.min(context.timeoutMs ?? 30_000, 30_000)
      },
      context.signal
    );
    if (probe.exitCode !== 0) return undefined;
    const body = parsePackageFacts(probe.stdout).scripts[scriptName];
    return typeof body === "string" ? body : undefined;
  } catch {
    return undefined;
  }
}

async function resolveCommandNetwork(
  command: string,
  context: Parameters<ToolDefinition<z.infer<typeof CommandInputSchema>, unknown>["execute"]>[1]
): Promise<"registry" | undefined> {
  if (!context.dependencyInstallAllowed) return undefined;
  if (isDependencyInstallCommand(command) || isPlaywrightBrowserInstallCommand(command)) {
    return "registry";
  }
  const scriptName = scriptInvocationName(command);
  if (!scriptName) return undefined;
  const body = await installScriptBody(scriptName, context);
  return body !== undefined &&
    (isDependencyInstallCommand(body) || isPlaywrightBrowserInstallCommand(body))
    ? "registry"
    : undefined;
}

/**
 * 宿主机 macOS 的 node_modules 挂进 Linux 沙箱时，rollup/esbuild 的 optional native
 * 会对不上。QA/Agent 直接 `npm run test|build` 会在 `Cannot find module @rollup/rollup-linux-*`
 * 处挂掉。这里在获准装依赖的项目里，于跑包管理脚本前静默补齐当前平台包（--no-save，可与 darwin 并存）。
 */
function looksLikePackageScript(command: string): boolean {
  return /(?:^|[\s;|&])(?:npm|pnpm|yarn)(?:\s+run)?\s+(?:test|build|lint|type-?check|vitest|vite)\b/i.test(
    command
  );
}

async function healNativeDependenciesIfNeeded(
  context: Parameters<ToolDefinition<z.infer<typeof CommandInputSchema>, unknown>["execute"]>[1]
): Promise<void> {
  if (!context.dependencyInstallAllowed) return;
  try {
    const probe = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command:
          "node -e \"const fs=require('fs');const path=require('path');" +
          "const has=fs.existsSync('node_modules');" +
          "const missing=[];" +
          "if(has){const nm=(p)=>fs.existsSync(path.join('node_modules',...p.split('/')));" +
          "const plat=process.platform;const arch=process.arch;" +
          "if(nm('rollup')||nm('vite')||nm('vitest')){const r=plat==='linux'?('@rollup/rollup-linux-'+arch+'-gnu'):('@rollup/rollup-'+plat+'-'+arch);if(!nm(r))missing.push(r)}" +
          "if(nm('esbuild')||nm('vite')){const e=plat==='linux'?('@esbuild/linux-'+arch):('@esbuild/'+plat+'-'+arch);if(!nm(e))missing.push(e)}" +
          "}" +
          "process.stdout.write(JSON.stringify({hasNodeModules:has,missingNative:missing}))\"",
        timeoutMs: 30_000
      },
      context.signal
    );
    if (probe.exitCode !== 0) return;
    let parsed: { hasNodeModules?: boolean; missingNative?: string[] } = {};
    try {
      parsed = JSON.parse(probe.stdout.trim() || "{}") as {
        hasNodeModules?: boolean;
        missingNative?: string[];
      };
    } catch {
      return;
    }
    const missing = Array.isArray(parsed.missingNative) ? parsed.missingNative : [];
    if (!parsed.hasNodeModules || missing.length === 0) return;
    const heal = `npm install --no-save --no-audit --no-fund ${missing
      .map((pkg) => JSON.stringify(pkg))
      .join(" ")}`;
    await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: heal,
        timeoutMs: Math.min(context.timeoutMs ?? 120_000, 120_000),
        network: "registry"
      },
      context.signal
    );
  } catch {
    // 自愈失败不阻断原命令——由原命令自己暴露缺依赖错误。
  }
}

async function runSandboxCommand(
  toolName: string,
  input: z.infer<typeof EmptyCommandInputSchema>,
  context: Parameters<ToolDefinition<z.infer<typeof CommandInputSchema>, unknown>["execute"]>[1],
  errorCode: "COMMAND_ERROR" | "TEST_ERROR",
  /** F1-7（FX-25）：缺省命令探测所需的脚本名（显式 command 时忽略）。 */
  defaultScriptName?: string,
  /** F2-2（FX-34）：构建/测试类工具只接受项目脚本形态的命令（run_command 不受限）。 */
  scriptOnly = false
) {
  const resolved = input.command
    ? { command: input.command, warnings: [] as string[] }
    : await resolveDefaultCommand(toolName, defaultScriptName ?? "test", context, errorCode);
  const command = capPlaywrightWorkers(resolved.command);
  assertCommandAllowed(command);
  if (scriptOnly && !isScriptOnlyCommand(command)) {
    throw new ToolExecutionError(
      "TOOL_ERROR",
      `${toolName} is blocked by script-only policy: accepts only project script commands (e.g. \`npm run <script>\`, \`node --test\`); use run_command for general shell`
    );
  }
  const cwd = input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined;
  // `docs/236` §4.2：**只有 install 类命令**在获准的项目里拿 registry 网络。
  // 分类判据是命令内容，不是调用方参数——agent 没有任何网络入口。
  // N-57：命令内容包含「跑一个 install 脚本」（`pnpm run deps`），见 `resolveCommandNetwork`。
  const network = await resolveCommandNetwork(command, context);
  if (!network && looksLikePackageScript(command)) {
    await healNativeDependenciesIfNeeded(context);
  }
  // docs/255：浏览器安装不能沿用 120s 工具上限（schema 仍限制 agent 入参，
  // 平台在这里把实际沙箱超时抬到 ENV_GAP_INSTALL_TIMEOUT_MS）。
  const browserInstall = isPlaywrightBrowserInstallCommand(command);
  const playwrightTest = isPlaywrightTestCommand(command);
  const timeoutMs = browserInstall
    ? Math.max(input.timeoutMs ?? 0, context.timeoutMs ?? 0, ENV_GAP_INSTALL_TIMEOUT_MS)
    : playwrightTest
      ? Math.max(input.timeoutMs ?? 0, context.timeoutMs ?? 0, E2E_TEST_TIMEOUT_MS)
      : (input.timeoutMs ?? context.timeoutMs);
  const e2eLimits = e2eSandboxCommandLimits(command);
  const result = await context.sandbox.runCommand(
    context.workspacePath,
    {
      command,
      cwd,
      timeoutMs,
      ...(network ? { network } : {}),
      ...e2eLimits
    },
    context.signal
  );

  const data = {
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration: result.duration,
    timedOut: result.timedOut,
    ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
    ...(network ? { network } : {}),
    // `docs/236` §7：安装产物入证据，走既有的 `tool_calls.output` 通道（不新增表）。
    ...(network ? { dependencyInstall: dependencyInstallEvidence(result) } : {}),
    summary:
      result.stderr.trim() || result.stdout.trim() || `Command exited with ${result.exitCode}`
  };

  if (result.timedOut) {
    throw new ToolExecutionError("TIMEOUT_ERROR", `${toolName} timed out`, data);
  }

  if (result.exitCode !== 0) {
    const details = commandFailureDetails(
      result.command,
      result.exitCode,
      result.stdout,
      result.stderr
    );
    // `docs/236` §4.3：registry 不可达要**可判别**，且不回退到直连、不换地址重试。
    // 不新造 `RuntimeErrorCode`（`AGENTS.md` §10 禁止第二套错误码体系）——落在既有
    // 码的 `details.reason` 上，与 `commandFailureDetails` 的其他字段同层。
    const registryFailure = classifyRegistryFailure(result, network);
    throw new ToolExecutionError(errorCode, `${toolName} failed`, {
      ...details,
      ...(registryFailure ? { reason: registryFailure } : {})
    });
  }

  return data;
}

/**
 * `docs/236` §4.3 的三种失败模式里，只有「registry 不可达」需要单独判别：
 * 包不存在就该原样返回 pnpm 的 `ERR_PNPM_FETCH_404`，命令被策略拒绝在 `assertCommandAllowed`
 * 那一步已经用 `COMMAND_POLICY_BLOCKED` 之外的方式拦掉了（见下）。
 *
 * 判据取 pnpm 自己的报错文本，而不是自己猜 exit code：exit 1 既可能是网络也可能是依赖冲突，
 * 靠输出关键词能唯一地区分（实测样张见 `docs/238`）。
 */
function classifyRegistryFailure(
  result: SandboxResult,
  network: "registry" | undefined
): string | undefined {
  if (network !== "registry") return undefined;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION|404 Not Found/i.test(output)) {
    return undefined;
  }
  if (
    /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|registry.*unavailable/i.test(
      output
    )
  ) {
    return "REGISTRY_UNAVAILABLE";
  }
  return undefined;
}

/**
 * `docs/236` §7：安装结果的结构化证据。字段刻意只取**能复核**的几项：
 *
 * - `packages`：pnpm 输出里 `+ name version` 的行（安装成功后才有）；
 * - `durationMs`：从沙箱结果直接取；
 * - `ok` / `exitCode`：成败与退出码。
 *
 * **不记录** lockfile 摘要：那要再读一次工作区，而 `--frozen-lockfile` 失败时恰好是最需要
 * 证据的时候——多一次读会让失败路径更脆。lockfile 本身在 `git diff` 与工作区里。
 */
function dependencyInstallEvidence(result: SandboxResult): Record<string, unknown> {
  const output = `${result.stdout}\n${result.stderr}`;
  const packages = [
    ...new Set(
      output
        .split("\n")
        .map((line) => /^\s*\+\s+(\S+)\s+(\S+)/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => `${match[1]}@${match[2]}`)
    )
  ];
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs: result.duration,
    ...(packages.length > 0 ? { packages } : {})
  };
}

const runCommandTool: ToolDefinition<
  z.infer<typeof CommandInputSchema>,
  Awaited<ReturnType<typeof runSandboxCommand>>
> = {
  name: "run_command",
  description: "Run an allowlisted shell command inside the sandbox workspace.",
  riskLevel: "MEDIUM",
  inputSchema: CommandInputSchema,
  async execute(input, context) {
    return await runSandboxCommand("run_command", input, context, "COMMAND_ERROR");
  }
};

const runUnitTestTool: ToolDefinition<
  z.infer<typeof EmptyCommandInputSchema>,
  Awaited<ReturnType<typeof runSandboxCommand>>
> = {
  name: "run_unit_test",
  description: "Run unit tests inside the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: EmptyCommandInputSchema,
  async execute(input, context) {
    return await runSandboxCommand("run_unit_test", input, context, "TEST_ERROR", "test", true);
  }
};

const runLintTool: ToolDefinition<
  z.infer<typeof EmptyCommandInputSchema>,
  Awaited<ReturnType<typeof runSandboxCommand>>
> = {
  name: "run_lint",
  description: "Run lint checks inside the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: EmptyCommandInputSchema,
  async execute(input, context) {
    return await runSandboxCommand("run_lint", input, context, "COMMAND_ERROR", "lint", true);
  }
};

const runBuildTool: ToolDefinition<
  z.infer<typeof EmptyCommandInputSchema>,
  Awaited<ReturnType<typeof runSandboxCommand>>
> = {
  name: "run_build",
  description: "Run build checks inside the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: EmptyCommandInputSchema,
  async execute(input, context) {
    return await runSandboxCommand("run_build", input, context, "COMMAND_ERROR", "build", true);
  }
};
