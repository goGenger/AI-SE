import { sanitizeLogData } from "@ai-se/observability";
import { CiExecutionResult, DeliveryOperations, ReleaseExecutionResult } from "@ai-se/tool-runtime";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRADICTORY_TEST_EXPECTATIONS,
  formatContradictoryTestFindings,
  scanContradictoryTestExpectations
} from "./contradictoryTestExpectations";
import { parseAcResults } from "./taskVerifierRules";
import { urlProbeProgramArgs, parseUiSmokeOutput } from "./uiSmoke";

/**
 * N-45（`docs/232` §9.7）：**本地 CI 只带被测项目该看到的环境变量**。
 *
 * 旧实现 `env: process.env` 把平台自己的启动参数漏进了工作区的六步契约：平台用 `PORT=47558` 起，
 * 项目的 `pnpm test` 就继承 47558，E1 的「未设置 PORT 时默认 3000」当场失败——三次 CI 全挂在同一条
 * AC-01 上，而 oracle 在工作区里 29/29 全过（假阴性）。
 *
 * 白名单只留**执行所需的定位/本地化/代理**变量：平台自己的端口、库连接串、闸门开关、密钥一律不带。
 * 与 `@ai-se/sandbox` 对容器只透传显式 `env` 的口径一致。
 */
const CI_ENV_ALLOWLIST: readonly string[] = [
  // 可执行文件与用户目录
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TMPDIR",
  "TMP",
  "TEMP",
  // 本地化与时区
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // 包管理器 / 工具链的安装位置
  "COREPACK_HOME",
  // 出网（私有 registry / CA）
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  // 容器工具需要连接哪台 daemon
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_BUILDKIT"
];

export function ciEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CI_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function output(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-4_000);
}

function githubRepository(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error("GitHub Actions requires an https://github.com/owner/repo URL");
  return match[1];
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.text();
  return `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`;
}

export class GitHubActionsOperations implements Pick<DeliveryOperations, "runCi"> {
  constructor(
    private readonly options: {
      token: string;
      apiUrl?: string;
      pollIntervalMs?: number;
      timeoutMs?: number;
    }
  ) {}

  async runCi(
    input: Parameters<DeliveryOperations["runCi"]>[0],
    context: Parameters<DeliveryOperations["runCi"]>[1]
  ): Promise<CiExecutionResult> {
    // N-73：`repository` 现在是可选的（static 适配器不需要）；外部 CI 仍然必须有。
    if (!input.repository) throw new Error("GitHub Actions requires a repository URL");
    const repository = githubRepository(input.repository);
    const apiUrl = this.options.apiUrl ?? "https://api.github.com";
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.options.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    const commitResponse = await fetch(
      `${apiUrl}/repos/${repository}/commits/${encodeURIComponent(input.ref)}`,
      { headers, signal: context.signal }
    );
    if (!commitResponse.ok) {
      throw new Error(`GitHub ref lookup failed: ${await responseMessage(commitResponse)}`);
    }
    const requestedCommit = String(((await commitResponse.json()) as { sha?: string }).sha ?? "");
    const dispatchedAt = Date.now();
    const dispatch = await fetch(
      `${apiUrl}/repos/${repository}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: input.ref }),
        signal: context.signal
      }
    );
    if (!dispatch.ok)
      throw new Error(`GitHub workflow dispatch failed: ${await responseMessage(dispatch)}`);

    const deadline = Date.now() + (this.options.timeoutMs ?? 20 * 60_000);
    let run: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(
        `${apiUrl}/repos/${repository}/actions/workflows/${encodeURIComponent(input.workflowFile)}/runs?event=workflow_dispatch&per_page=20`,
        { headers, signal: context.signal }
      );
      if (!response.ok)
        throw new Error(`GitHub run lookup failed: ${await responseMessage(response)}`);
      const payload = (await response.json()) as { workflow_runs?: Record<string, unknown>[] };
      run = payload.workflow_runs?.find((candidate) => {
        const created = Date.parse(String(candidate.created_at ?? ""));
        return (
          created >= dispatchedAt - 5_000 &&
          String(candidate.head_branch) === input.ref &&
          String(candidate.head_sha) === requestedCommit
        );
      });
      if (run && String(run.status) === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 2_000));
    }
    if (!run || String(run.status) !== "completed") throw new Error("GitHub Actions run timed out");

    const conclusion = String(run.conclusion ?? "failure");
    const gitCommit = String(run.head_sha ?? "");
    const pullRequests = Array.isArray(run.pull_requests)
      ? (run.pull_requests as Array<Record<string, unknown>>)
      : [];
    return {
      providerRunId: String(run.id),
      status:
        conclusion === "success" ? "SUCCESS" : conclusion === "cancelled" ? "CANCELLED" : "FAILED",
      gitCommit,
      pullRequest: typeof pullRequests[0]?.number === "number" ? pullRequests[0].number : undefined,
      image: `${input.imageRepository}:${gitCommit}`,
      url: typeof run.html_url === "string" ? run.html_url : undefined,
      logs: [`GitHub Actions ${String(run.id)} completed with ${conclusion}`],
      error: conclusion === "success" ? undefined : `GitHub Actions concluded with ${conclusion}`
    };
  }
}

/**
 * N-73：**static 适配器的版本号**——工作区没有 git，不能假装成 commit。
 * 用 `package.json` + 锁文件的内容摘要（同一份源码永远得到同一个版本号，便于对账）。
 */
function workspaceVersion(workspacePath: string): string {
  const hash = createHash("sha256");
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    try {
      hash.update(readFileSync(join(workspacePath, name)));
    } catch {
      hash.update(`${name}:missing`);
    }
  }
  return `static-${hash.digest("hex").slice(0, 12)}`;
}

export class LocalCiOperations implements Pick<DeliveryOperations, "runCi"> {
  async runCi(
    input: Parameters<DeliveryOperations["runCi"]>[0],
    context: Parameters<DeliveryOperations["runCi"]>[1]
  ): Promise<CiExecutionResult> {
    const logs: string[] = [];
    // N-45：六步契约在**隔离环境**里跑——平台自己的 PORT / 库连接串 / 闸门开关不进被测项目。
    const env = ciEnvironment();
    // N-73：static 适配器（工作区优先的前端项目）没有 git、也不建镜像。
    const staticMode = input.adapter === "static";
    let gitCommit: string;
    if (staticMode) {
      gitCommit = workspaceVersion(context.workspacePath);
      logs.push(`static adapter: version ${gitCommit} (workspace digest, no git)`);
    } else {
      const git = await command("git", ["rev-parse", "HEAD"], {
        cwd: context.workspacePath,
        env,
        signal: context.signal
      });
      if (git.exitCode !== 0) throw new Error(`Cannot resolve Git commit: ${output(git)}`);
      gitCommit = git.stdout.trim();
    }
    const image = staticMode ? `static:${gitCommit}` : `${input.imageRepository}:${gitCommit}`;
    // 生成测试互斥期望门禁：同一用例对同一查询先全量再筛后子集 → 假阴性。pnpm test 前早停。
    const hygiene = scanContradictoryTestExpectations(context.workspacePath);
    if (hygiene.findings.length > 0) {
      const summary = formatContradictoryTestFindings(hygiene.findings);
      logs.push(
        `test-expectation-hygiene: scanned ${hygiene.scannedFiles} file(s), ${hygiene.findings.length} finding(s)`
      );
      logs.push(summary);
      return {
        providerRunId: `local-${randomUUID()}`,
        status: "FAILED",
        gitCommit,
        image,
        logs,
        error: `${CONTRADICTORY_TEST_EXPECTATIONS}: ${hygiene.findings.length} contradictory expectation(s) in generated tests (fail-fast before pnpm test)\n${summary}`
      };
    }
    const steps: Array<[string, string[]]> = [
      ["pnpm", ["install", "--frozen-lockfile"]],
      ["pnpm", ["lint"]],
      ["pnpm", ["typecheck"]],
      ["pnpm", ["test"]],
      ["pnpm", ["build"]],
      ...(staticMode ? [] : ([["docker", ["build", "-t", image, "."]]] as Array<[string, string[]]>))
    ];
    // F1-5（FX-18）：交付前全量测试的逐条 AC 结果——在最终集成的 commit 上运行，供追溯表「以这一次为准」。
    let testResults: Record<string, "passed" | "failed"> | undefined;
    for (const [executable, args] of steps) {
      const result = await command(executable, args, {
        cwd: context.workspacePath,
        env,
        signal: context.signal
      });
      logs.push(`${executable} ${args.join(" ")}: ${output(result) || "ok"}`);
      if (executable === "pnpm" && args[0] === "test") {
        testResults = parseAcResults(`${result.stdout}\n${result.stderr}`);
      }
      if (result.exitCode !== 0) {
        return {
          providerRunId: `local-${randomUUID()}`,
          status: "FAILED",
          gitCommit,
          image,
          logs,
          error: `${executable} failed with exit code ${result.exitCode}`,
          ...(testResults && Object.keys(testResults).length > 0 ? { testResults } : {})
        };
      }
    }
    return {
      providerRunId: `local-${randomUUID()}`,
      status: "SUCCESS",
      gitCommit,
      image,
      logs,
      ...(testResults && Object.keys(testResults).length > 0 ? { testResults } : {})
    };
  }
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function port(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : fallback;
}

/**
 * F1-7（FX-21）：部署配置声明的卷——`"host|volume-name:container-path[:ro|rw]"`。
 * 用于持久化数据（如 E1 的「重启后数据仍在」AC：把数据目录挂到宿主/命名卷）。
 */
function volumeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      'deployment configuration.volumes must be an array like ["/host/data:/data:rw"]'
    );
  }
  const args: string[] = [];
  for (const entry of value) {
    const spec = typeof entry === "string" ? entry.trim() : "";
    if (!/^[^\s:]+:\/[^\s:]+(?::(?:ro|rw))?$/.test(spec)) {
      throw new Error(`Invalid deployment volume declaration: ${String(entry)}`);
    }
    args.push("--volume", spec);
  }
  return args;
}

/** F1-7（FX-21）：部署配置声明的环境变量（键约束 shell 标识符；值不得含换行/NUL）。 */
function environmentArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("deployment configuration.env must be an object of string values");
  }
  const args: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid deployment env key: ${key}`);
    }
    if (typeof entry !== "string" || entry.includes("\u0000") || /[\n\r]/.test(entry)) {
      throw new Error(`Invalid deployment env value for ${key}`);
    }
    args.push("--env", `${key}=${entry}`);
  }
  return args;
}

async function checkEndpoint(
  endpoint: string,
  signal?: AbortSignal
): Promise<ReleaseExecutionResult> {
  const checks: Record<string, unknown> = {};
  const logs: string[] = [];
  for (const path of ["/health", "/ready"]) {
    const url = new URL(path, endpoint).toString();
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        response = await fetch(url, { signal });
        if (response.ok) break;
      } catch (error) {
        if (attempt === 20) logs.push(`${path}: ${String(sanitizeLogData(error))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    checks[path] = response?.status ?? 0;
    logs.push(`${path}: ${response?.status ?? "unreachable"}`);
    if (!response?.ok) {
      return { status: "FAILED", healthCheck: checks, logs, error: `${path} failed` };
    }
  }
  return { status: "SUCCESS", healthCheck: checks, logs };
}

export class LocalDockerOperations implements Omit<DeliveryOperations, "runCi"> {
  constructor(private readonly dockerCommand = "docker") {}

  async deploy(
    input: Parameters<DeliveryOperations["deploy"]>[0],
    context: Parameters<DeliveryOperations["deploy"]>[1]
  ): Promise<ReleaseExecutionResult> {
    const configuration = input.configuration ?? {};
    const containerName = text(
      configuration.containerName,
      `ai-se-${input.environment}-${input.deploymentId.slice(0, 8)}`
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(containerName)) {
      throw new Error("Invalid deployment containerName");
    }
    const hostPort = port(configuration.hostPort, 18_000);
    const containerPort = port(configuration.containerPort, 3_000);
    // F1-7（FX-21）：按声明挂载卷与环境变量（声明非法 → 明确报错，不静默忽略）。
    const mounts = volumeArgs(configuration.volumes);
    const envs = environmentArgs(configuration.env);
    await command(this.dockerCommand, ["rm", "-f", containerName], { signal: context.signal });
    const run = await command(
      this.dockerCommand,
      [
        "run",
        "-d",
        "--name",
        containerName,
        "--restart",
        "unless-stopped",
        "-p",
        `${hostPort}:${containerPort}`,
        ...mounts,
        ...envs,
        input.image
      ],
      { signal: context.signal }
    );
    const logs = [`docker run ${containerName}: ${output(run)}`];
    if (run.exitCode !== 0) {
      return { status: "FAILED", healthCheck: {}, logs, error: "Docker deployment failed" };
    }
    const health = await checkEndpoint(input.endpoint, context.signal);
    return { ...health, logs: [...logs, ...health.logs] };
  }

  async verify(
    input: Parameters<DeliveryOperations["verify"]>[0],
    context: Parameters<DeliveryOperations["verify"]>[1]
  ): Promise<ReleaseExecutionResult> {
    return await checkEndpoint(input.endpoint, context.signal);
  }

  async rollback(
    input: Parameters<DeliveryOperations["rollback"]>[0],
    context: Parameters<DeliveryOperations["rollback"]>[1]
  ): Promise<ReleaseExecutionResult> {
    return await this.deploy(input, context);
  }
}

/**
 * N-73（`docs/232` §10）：**static 适配器**——工作区优先的前端项目（无仓库、无 Dockerfile）。
 *
 * | 步骤 | 语义（`docs/233` §5.4） |
 * | --- | --- |
 * | DEPLOY | 起一个常驻的静态预览（`npm start`，端口取自 `environment.endpoint`） |
 * | VERIFY | 用浏览器探**这个已存在的 URL**，按 AC 点名的 testid 断言页面真的渲染了 |
 * | ROLLBACK | 等价于重新部署（静态产物没有镜像层可回退） |
 */
export class LocalStaticOperations implements Omit<DeliveryOperations, "runCi"> {
  async deploy(
    input: Parameters<DeliveryOperations["deploy"]>[0],
    context: Parameters<DeliveryOperations["deploy"]>[1]
  ): Promise<ReleaseExecutionResult> {
    const port = endpointPort(input.endpoint);
    if (port === null) {
      return { status: "FAILED", healthCheck: {}, logs: [], error: "invalid endpoint" };
    }
    const logs: string[] = [];
    // 上一次部署可能还占着端口：先停掉，否则 `--strictPort` 会让新进程直接退出，
    // 而 VERIFY 会对着**旧 dist** 给出假绿。
    const stopped = await stopListening(port);
    if (stopped.length > 0) logs.push(`stopped previous preview on :${port} (${stopped.join(",")})`);

    const child = spawn("npm", ["start"], {
      cwd: context.workspacePath,
      env: { ...ciEnvironment(), PORT: String(port), NODE_ENV: "production" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    // vite / node 多数启动日志走 stdout；只收 stderr 时失败信息会变成空串（F1 round17）。
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.unref();
    const ready = await waitForEndpoint(input.endpoint, 30_000, context.signal);
    if (!ready) {
      const detail = (stderr.trim() || stdout.trim()).slice(-500);
      const exited =
        child.exitCode !== null
          ? ` (exit ${child.exitCode})`
          : child.signalCode
            ? ` (signal ${child.signalCode})`
            : "";
      return {
        status: "FAILED",
        healthCheck: { endpoint: input.endpoint, ready: false },
        logs: [...logs, `cwd=${context.workspacePath}`],
        error: `preview did not answer on ${input.endpoint}${exited}${detail ? `: ${detail}` : ""}`
      };
    }
    logs.push(`static preview ready on ${input.endpoint} (version ${input.version})`);
    return {
      status: "SUCCESS",
      healthCheck: { endpoint: input.endpoint, ready: true, version: input.version },
      logs
    };
  }

  async verify(
    input: Parameters<DeliveryOperations["verify"]>[0],
    context: Parameters<DeliveryOperations["verify"]>[1]
  ): Promise<ReleaseExecutionResult> {
    const configuration = input.configuration ?? {};
    const testIds = Array.isArray(configuration.testIds)
      ? configuration.testIds.filter((id): id is string => typeof id === "string")
      : [];
    const probe = parseUiSmokeOutput(
      await runUrlProbe(input.endpoint, context.signal, configuration)
    );
    if (!probe) {
      return { status: "FAILED", healthCheck: {}, logs: [], error: "probe produced no output" };
    }
    const logs = [
      `page ${probe.pageStatus ?? "-"} via ${probe.browser}`,
      `present: ${probe.present.join(", ") || "(none)"}`
    ];
    if (probe.pageStatus !== 200) {
      return {
        status: "FAILED",
        healthCheck: { pageStatus: probe.pageStatus, present: probe.present },
        logs,
        error: `staging page did not answer 200 (got ${probe.pageStatus ?? "no response"})`
      };
    }
    // 与 `ui-smoke` 同一口径：required 一个都没命中才判死（避免把「这条 AC 的交互元素
    // 要点击后才出现」误判成页面坏了）。
    const missing = testIds.filter((id) => !probe.present.includes(id));
    if (probe.browser === "playwright" && testIds.length > 0 && missing.length === testIds.length) {
      return {
        status: "FAILED",
        healthCheck: { pageStatus: probe.pageStatus, present: probe.present, required: testIds },
        logs,
        error: `none of the required elements rendered (missing: ${missing.join(", ")})`
      };
    }
    return {
      status: "SUCCESS",
      healthCheck: {
        pageStatus: probe.pageStatus,
        present: probe.present,
        ...(missing.length > 0 ? { missing } : {}),
        consoleErrors: probe.consoleErrors.length
      },
      logs
    };
  }

  async rollback(
    input: Parameters<DeliveryOperations["rollback"]>[0],
    context: Parameters<DeliveryOperations["rollback"]>[1]
  ): Promise<ReleaseExecutionResult> {
    return this.deploy(input, context);
  }
}

function endpointPort(endpoint: string): number | null {
  try {
    const parsed = new URL(endpoint);
    return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** 停掉**监听**该端口的进程。
 *
 * 必须带 `-sTCP:LISTEN`：不带时 `lsof -ti tcp:<port>` 会把**连过**这个端口的进程也列出来
 * （客户端套接字同样匹配），照着杀会误伤无关进程——实测第一次实现就把跑测试的 worker 杀了。
 * `lsof` 不存在时静默跳过：端口被占用会在启动阶段的 `--strictPort` 上暴露。
 */
async function stopListening(port: number): Promise<string[]> {
  try {
    const result = await command("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    if (result.exitCode !== 0) return [];
    const pids = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // 已经退出
      }
    }
    return pids;
  } catch {
    return [];
  }
}

async function waitForEndpoint(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runUrlProbe(
  url: string,
  signal: AbortSignal | undefined,
  configuration: Record<string, unknown> | undefined
): Promise<string> {
  const probeTimeoutMs =
    typeof configuration?.probeTimeoutMs === "number" ? configuration.probeTimeoutMs : undefined;
  const settleMs =
    typeof configuration?.settleMs === "number" ? configuration.settleMs : undefined;
  const result = await command(
    process.execPath,
    [
      "-e",
      ...urlProbeProgramArgs({ url, ...(probeTimeoutMs ? { probeTimeoutMs } : {}), ...(settleMs ? { settleMs } : {}) })
    ],
    { signal }
  );
  return result.stdout;
}

export function createDeliveryOperations(input: {
  ci: Pick<DeliveryOperations, "runCi">;
  docker: Omit<DeliveryOperations, "runCi">;
  /** N-73：static 适配器（工作区优先的前端项目）；缺省即启用本地静态预览实现。 */
  static?: Omit<DeliveryOperations, "runCi">;
}): DeliveryOperations {
  // N-73：按请求里的 `adapter` 分发——同一进程既能跑 docker 项目（E1）也能跑工作区优先的前端（F1）。
  const staticOps = input.static ?? new LocalStaticOperations();
  const pick = <T>(
    request: { adapter?: "docker" | "static" },
    run: (ops: Omit<DeliveryOperations, "runCi">) => Promise<T>
  ): Promise<T> => run(request.adapter === "static" ? staticOps : input.docker);
  return {
    runCi: (request, context) => input.ci.runCi(request, context),
    deploy: (request, context) => pick(request, (ops) => ops.deploy(request, context)),
    verify: (request, context) => pick(request, (ops) => ops.verify(request, context)),
    rollback: (request, context) => pick(request, (ops) => ops.rollback(request, context))
  };
}
