import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CommandResult, CommandRunner } from "./oracle";
import { HarnessDeps, HttpDeps, RunOptions, runFixture } from "./harness";
import { noiseLine, summarize } from "./metrics";
import { buildResults, pickPreviousResults, renderSummaryMarkdown } from "./report";
import { EvalFailure, EvalFixture, EvalPolicy, EvalResults, EvalRunRecord } from "./types";

const PACKAGE_DIR = resolve(__dirname, "..");
const FIXTURES_DIR = join(PACKAGE_DIR, "fixtures");
const RESULTS_DIR = join(PACKAGE_DIR, "results");

/** P0 冻结的评测策略（docs/109 §架构判定 6）。**本批次不改它**——L1 走 `--autonomy-l1` 叠加。 */
const POLICY: EvalPolicy = {
  maxConcurrency: 1,
  maxRetries: 1,
  failureStrategy: "RETRY",
  allowRetry: true,
  allowReplan: false,
  approvalRequired: false
};

/**
 * 自治 L1 策略叠加（`docs/154` §3 M4 的 L1-8 批次）。取值与平台 `L1_WORKFLOW_POLICY` 一致，
 * 但**本地声明**——本包不导入任何 workspace 包（见 `types.ts` 头注）。
 *
 * 之所以做成叠加而不是改 `POLICY`：`POLICY` 是 P0 冻结的评测基线，静默改动会让此后所有批次
 * 失去可比性，也违反 `docs/146` §6 规则 8（默认值/模式变更须登记）。生效策略原样写进结果
 * JSON 的 `policy` 字段，批次自证口径。
 */
const L1_POLICY_OVERRIDE: Pick<
  EvalPolicy,
  | "autonomyLevel"
  | "deployFailureStrategy"
  | "failureStrategy"
  | "allowRetry"
  | "maxRetries"
  | "allowReplan"
> = {
  autonomyLevel: "L1",
  // PL-M18（N-11）：由 `RETRY` 改为 `REPLAN`、并打开 `allowReplan`。
  //
  // 起因：REVIEW 任务诚实的负结论被 `workflowTaskExecutor.ts:391` 记成「任务失败」，而在
  // `RETRY` 下唯一的下场是重试——重试不可能收敛（缺陷是确定性的、REVIEW 又没有写权限），
  // 于是链停在交付切片前。改为 `REPLAN` 后 `WorkflowEngine` 的 REPLAN 分支才可达，FIX 任务
  // 才可能被造出来（此前**全库 FIX-* = 0 条**）。
  //
  // 两处必须成对：`failureStrategy: "REPLAN"` 决定走哪条分支，`allowReplan: true` 是那条分支的
  // 闸门（`WorkflowEngine.ts` 的 `strategy === "REPLAN" && workflow.policy.allowReplan`）。
  // 只改后者**不生效**（`failureRouter` 在生产未接线，`strategy` 就取自 `failureStrategy`）。
  //
  // 与平台 `L1_WORKFLOW_POLICY`（`@ai-se/shared`）**同步改动，两份保持一致**。
  failureStrategy: "REPLAN",
  allowRetry: true,
  maxRetries: 2,
  allowReplan: true,
  deployFailureStrategy: "ROLLBACK"
};

interface CliArgs {
  fixtures: string[] | null;
  runs: number;
  replan: boolean;
  cleanup: boolean;
  baseUrl: string;
  out: string | null;
  autonomyL1: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixtures: null,
    runs: 3,
    replan: false,
    cleanup: false,
    baseUrl: process.env.EVAL_BASE_URL ?? "http://127.0.0.1:3000",
    out: null,
    autonomyL1: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--fixtures") args.fixtures = (argv[++index] ?? "").split(",").filter(Boolean);
    else if (flag === "--runs") args.runs = Number(argv[++index] ?? "3");
    else if (flag === "--replan") args.replan = true;
    else if (flag === "--cleanup") args.cleanup = true;
    else if (flag === "--autonomy-l1") args.autonomyL1 = true;
    else if (flag === "--base-url") args.baseUrl = argv[++index] ?? args.baseUrl;
    else if (flag === "--out") args.out = argv[++index] ?? null;
  }
  return args;
}

async function loadFixtures(ids: string[] | null): Promise<EvalFixture[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const fixtures: EvalFixture[] = [];
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (ids && !ids.includes(entry.name)) continue;
    const raw = await readFile(join(FIXTURES_DIR, entry.name, "fixture.json"), "utf8");
    fixtures.push(JSON.parse(raw) as EvalFixture);
  }
  if (fixtures.length === 0) throw new Error(`未找到夹具（--fixtures ${ids?.join(",") ?? ""}）`);
  return fixtures;
}

function realCommands(): CommandRunner {
  return {
    run: (command, args, options) =>
      new Promise<CommandResult>((resolvePromise) => {
        const child = spawn(command, args, {
          cwd: options?.cwd,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = options?.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs)
          : null;
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolvePromise({ exitCode: timedOut ? null : code, stdout, stderr });
        });
      })
  };
}

function realHttp(baseUrl: string): HttpDeps {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = (payload as { error?: { message?: string } } | null)?.error?.message ?? text;
      throw new Error(`${method} ${path} → HTTP ${response.status}：${message}`);
    }
    return payload;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    // N-73：环境的 upsert 走 PUT（`/api/environments`）。
    put: (path, body) => call("PUT", path, body ?? {}),
    del: async (path) => {
      await call("DELETE", path);
    }
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy: EvalPolicy = args.autonomyL1 ? { ...POLICY, ...L1_POLICY_OVERRIDE } : POLICY;
  const workspaceRoot =
    process.env.EVAL_WORKSPACE_ROOT ?? join(process.env.HOME ?? ".", "Desktop/study/ai-se-eval");
  await mkdir(workspaceRoot, { recursive: true });
  const fixtures = await loadFixtures(args.fixtures);
  const commands = realCommands();
  console.log(`生效策略：${JSON.stringify(policy)}`);

  const deps: HarnessDeps = {
    http: realHttp(args.baseUrl),
    commands,
    baseUrl: args.baseUrl,
    policy,
    packageDir: PACKAGE_DIR,
    log: (message) => console.log(message),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    prepareWorkspace: async (fixture, runIndex) => {
      const workspacePath = join(workspaceRoot, fixture.id, `run-${runIndex}`);
      await rm(workspacePath, { recursive: true, force: true });
      await mkdir(dirname(workspacePath), { recursive: true });
      await cp(join(FIXTURES_DIR, fixture.id, "template"), workspacePath, { recursive: true });
      const git = (gitArgs: string[]) =>
        commands.run(
          "git",
          ["-c", "user.name=ai-se-eval", "-c", "user.email=eval@ai-se.local", ...gitArgs],
          {
            cwd: workspacePath
          }
        );
      await git(["init", "-q"]);
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", `eval baseline ${fixture.id} run-${runIndex}`]);
      return workspacePath;
    }
  };

  const options: RunOptions = {
    runs: args.runs,
    replan: args.replan,
    runTimeoutMs: 45 * 60 * 1000,
    pollIntervalMs: 3000,
    oracleTimeoutMs: 60 * 1000
  };

  const records: EvalRunRecord[] = [];
  const failures: EvalFailure[] = [];
  for (const fixture of fixtures) {
    // 夹具可覆盖超时（E1 为长运行：oracle ≤ 20 min、单次 run ≤ 120 min；缺省沿用全局值）。
    const outcome = await runFixture(deps, fixture, {
      ...options,
      oracleTimeoutMs: fixture.oracleTimeoutMs ?? options.oracleTimeoutMs,
      runTimeoutMs: fixture.runTimeoutMs ?? options.runTimeoutMs,
      perTaskTimeoutMs: fixture.perTaskTimeoutMs ?? options.perTaskTimeoutMs
    });
    records.push(...outcome.records);
    failures.push(...outcome.failures);
  }
  if (failures.length > 0) {
    console.log(`\n注意：${failures.length} 处失败被隔离（见汇总「未完成夹具」）。`);
  }

  const generatedAt = new Date().toISOString();
  const results = buildResults({
    generatedAt,
    baseUrl: args.baseUrl,
    policy,
    records,
    failures
  });
  const summary = summarize(records);

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const outPath = args.out ?? join(RESULTS_DIR, `${stamp}.json`);
  // `docs/189` §4.5：基线取**本次输出所在目录**的上一份，而不是 `results/` 根目录的最新一份
  // （批次脚本写进 `results/<批次>/run-N.json`，旧口径会让 run 2 去比历史批次）。
  const previous = await findPreviousResults(dirname(outPath), outPath);
  const noise = previous ? noiseLine(previous.summary, summary) : undefined;

  await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const mdPath = outPath.replace(/\.json$/, "-summary.md");
  await writeFile(mdPath, `${renderSummaryMarkdown(results, noise)}\n`, "utf8");
  console.log(`\n结果：${outPath}\n汇总：${mdPath}`);
  if (previous) console.log(`噪声线（相对 ${previous.generatedAt}）：${JSON.stringify(noise)}`);

  if (args.cleanup) {
    for (const fixture of fixtures) {
      const projects = (await deps.http.get("/api/projects")) as {
        data?: Array<{ id: string; name?: string }>;
      };
      const target = (projects.data ?? []).find(
        (project) => project.name === `[eval] ${fixture.id}`
      );
      if (target) {
        await deps.http.del(`/api/projects/${target.id}`);
        console.log(`清理项目 [eval] ${fixture.id}`);
      }
    }
  }
}

/**
 * `docs/189` §4.5：噪声线基线的读取面——**本次输出所在目录**里的结果文件（排除本次输出）。
 * 挑「上一份」的口径在 `pickPreviousResults`（纯函数，可测）；这里只负责读目录与解析，
 * 读不动或解析失败一律返回 null（噪声线是观察项，不得让批次失败）。
 */
async function findPreviousResults(dir: string, excludePath: string): Promise<EvalResults | null> {
  try {
    const entries = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    const candidates: Array<{ path: string; results: EvalResults }> = [];
    for (const name of entries) {
      const path = join(dir, name);
      if (path === excludePath) continue;
      try {
        candidates.push({
          path,
          results: JSON.parse(await readFile(path, "utf8")) as EvalResults
        });
      } catch {
        // 不是结果文件（或读取失败）——跳过。
      }
    }
    return pickPreviousResults(candidates, excludePath);
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
