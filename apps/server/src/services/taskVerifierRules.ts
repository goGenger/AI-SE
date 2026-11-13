import { createHash } from "node:crypto";
import {
  DEFAULT_CAPABILITY_PROFILE,
  isTestFilePath,
  isUsableTargetTaskType,
  TaskType,
  type CapabilityProfile
} from "@ai-se/shared";

/**
 * C-3（T1）/ C-4（N4）验证门纯规则（无 IO、零 LLM）：
 *  - 按任务类型选择「可用性优先」的客观检查计划（package.json scripts 驱动；
 *    TEST 任务的测试检查 = 红灯检查，期望「失败＝红灯已亮」）；
 *  - 受保护测试文件判定 + 哈希快照解析/比对（防篡改）；
 *  - 测试输出中的 AC 编号逐条通过/失败解析（供 N5 追溯表）。
 * 代码权威于文档；规则说明见 docs/117 §C-3/§C-4。
 */

/** errorType 词表扩展：任务因验证门失败（既有词表：INVALID_AGENT_RESULT / TIMEOUT / EMPTY_FINAL_ANSWER 等）。 */
export const VERIFICATION_FAILED_ERROR_TYPE = "VERIFICATION_FAILED";

export type VerificationMode = "observe" | "enforce";
export type VerificationVerdict = "verified" | "failed" | "unavailable";
export type VerificationCheckName =
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "migrate-up"
  | "migrate-down"
  | "slice-boundary"
  | "server-smoke"
  /** `docs/233` §5.2 / `docs/235` §6 第 3 步：UI 边界冒烟（`boundaryCheck: "ui"` 时的边界门）。 */
  | "ui-smoke"
  /** N-64（`docs/232` §10）：testid 命名契约——源码里不得出现需求没声明过的 testid。 */
  | "testid-contract"
  /** docs/256：切片末官方 Playwright E2E（不进入中间任务的检查计划）。 */
  | "e2e"
  /** docs/265：切片末官方视觉审查（设计意图门禁，不进入中间任务的检查计划）。 */
  | "visual";

/**
 * F1-5（FX-16/17）：AC 作用域测试选择。
 * - command-filter：`node --test` / vitest 等——用名称模式（及可选文件列表）真选取，不跑全仓套件；
 * - result-filter：历史兜底（全量运行 + 结果面选取）。有 AC 作用域时门禁不得再静默退到这条——
 *   构造不出 command-filter 时应 fail-closed（见 TaskVerifier `AC_SCOPE_UNSUPPORTED`）。
 */
export type AcScopingMode = "command-filter" | "result-filter";

export interface VerificationCheckPlan {
  name: VerificationCheckName;
  /** 实际执行的 npm script 名（命令 = `npm run <scriptName>`）。 */
  scriptName: string;
  /**
   * 期望结果：pass = 命令必须成功（绿灯验证）；
   * fail = 红灯检查——命令必须失败（测试先行的红灯）。
   */
  expectation: "pass" | "fail";
}

/** 开发类任务（写源码/迁移）：其执行窗口内不得改动既有受保护测试文件（防篡改规则）。 */
const DEV_TASK_TYPES: readonly TaskType[] = ["BACKEND", "FRONTEND", "DATABASE", "DEBUG"];

/** 各任务类型的候选检查脚本（可用性过滤后即为计划；空计划 = verified=false）。 */
// `docs/235`：检查候选改由能力 profile 提供（`BACKEND_NODE_PROFILE.checks` 与迁移前的
// `CHECK_CANDIDATES` 逐字相同），本文件不再保留第二份表。

const MIGRATION_UP_SCRIPTS = ["db:migrate:up", "migrate:up"];
const MIGRATION_DOWN_SCRIPTS = ["db:migrate:down", "migrate:down"];

export function isDevTaskType(type: TaskType): boolean {
  return DEV_TASK_TYPES.includes(type);
}

/**
 * N-15′（`docs/146` §3 / `docs/188` §Known Issue 7′）：DEBUG 任务的**检查类型**＝其目标类型。
 *
 * **为什么**：DEBUG 任务不派给「DEBUG agent」——`AgentRegistry.ts:318-319` 把 `task.type` 换成
 * `input.targetTaskType` 再派发，于是 `DEBUG→DATABASE` 跑的是 **database agent**，会改
 * `src/schema.js` / `src/migrations.js` 这类生产文件。而 DEBUG **同时**在 `DEV_TASK_TYPES` 里
 * （第 46 行），平台**已经**把它当写代码的任务对待（防篡改快照 + 写范围审计）。**唯独检查面漏了**：
 * `CHECK_CANDIDATES`（今为 profile 的 `checks`）没有 DEBUG 项 ⇒ 计划恒为空 ⇒ 走 `plan.plans.length === 0` ⇒ verdict 恒为
 * `unavailable`（实测 33 条 DEBUG 记录的原因串逐字为 `no available checks for task type DEBUG`），
 * 而 `verifyingTaskExecutor.ts:77` 只覆盖 `verdict === "failed"` ⇒ 任务照判 SUCCESS。
 * **⇒ 一个会写生产代码的任务类型没有验证门。**
 *
 * **判据来源与派发侧、计划侧同源**：用 `@ai-se/shared` 的 `isUsableTargetTaskType`
 * （`WorkflowEngine.debugTargetType` 与 `AgentRegistry.debugTarget` 用的就是它），**不另立一张表**
 * ——「重复定义必然漂移」是本仓库已登记的缺陷成因类型（`docs/160`，PL-M10 / PL-M12 同因）。
 *
 * **目标缺失/不可用时回落到 `DEBUG` 自身** ⇒ 计划仍为空 ⇒ 与今天的行为一致（`unavailable`）。
 * **只会变好，不会把原本能判定的任务变成不可判定。**
 */
export function effectiveCheckType(taskType: TaskType, targetTaskType: unknown): TaskType {
  if (taskType !== "DEBUG") return taskType;
  return isUsableTargetTaskType(targetTaskType) ? targetTaskType : taskType;
}

/**
 * PL-M9 9a：检查计划的解析结果——把「该类型没有客观检查」与「有客观检查但工作区缺 script」
 * **分开**。前者（`missing.length === 0`，如 ANALYSIS/DESIGN/REVIEW）走 `unavailable` 是正确语义；
 * 后者（`missing.length > 0`）是**证据面缺失**——检查本该存在、只是跑不起来。
 * 二者在 PL-M9 之前被记成同一件事（`no available checks for task type …`），导致红灯检查整片缺席
 * 而无人知晓（`docs/166` §2.1 ②/③）。
 */
export interface VerificationCheckResolution {
  /** 可用性过滤后的检查计划（= `planVerificationChecks` 的返回值）。 */
  plans: VerificationCheckPlan[];
  /** 该类型**有**候选检查、但工作区缺对应 script 的检查名。 */
  missing: VerificationCheckName[];
}


/**
 * docs/261：官方 TEST 检查的红灯约定只适用于**初始** TEST 任务（先写失败测试）。
 * 修复 / 已实现后再跑的 DYNAMIC、带 sourceTaskId、或 taskKey 含 REPLAN 的任务，
 * 官方 test 必须期望通过——否则仍红的 AC 会被当成「红灯已亮」而误判 verified。
 */
export function isRepairTaskForOfficialGates(task: {
  origin?: string | undefined;
  sourceTaskId?: string | undefined;
  taskKey?: string | undefined;
}): boolean {
  if (task.origin === "DYNAMIC") return true;
  if (typeof task.sourceTaskId === "string" && task.sourceTaskId.trim().length > 0) return true;
  if (typeof task.taskKey === "string" && /REPLAN/i.test(task.taskKey)) return true;
  return false;
}

export function resolveVerificationChecks(
  taskType: TaskType,
  scripts: Record<string, unknown>,
  /**
   * N-15′：**检查选取**用的类型（DEBUG 走 `input.targetTaskType`，见 `effectiveCheckType`）。
   * 缺省等于 `taskType`（既有调用方一字不改）。
   *
   * **红/绿灯语义仍由 `taskType` 决定**——红灯表达的是「这个任务负责**写**测试」，属于任务**自身**
   * 的类型：`DEBUG→TEST` 的任务是去**修**测试，要求测试先红是错的。
   */
  checkType: TaskType = taskType,
  /**
   * `docs/235`：**能力 profile**。检查候选由它提供（`backend-node` 与迁移前的硬编码逐字相同），
   * 缺省用默认 profile ⇒ 既有调用方一字不改、行为不变。
   */
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE,
  /**
   * docs/261：修复 / 已实现的 TEST 任务把官方 test 设为期望通过。
   * 初始 TEST 任务保持红灯约定（expectation = fail）。
   */
  options?: { officialTestExpectsPass?: boolean }
): VerificationCheckResolution {
  const available = new Set(Object.keys(scripts).filter((key) => typeof scripts[key] === "string"));
  /**
   * N-1b（`docs/223`）：DATABASE 的检查**只在这个项目真的有迁移脚本时**才按迁移口径判。
   *
   * 两个迁移脚本都没有 ⇒ 本项目没有「迁移」这个概念（实测 E1 用 `DATA_DIR` 原子 JSON 存储），
   * 而旧的硬编码让该类型**永远**一条检查都没有——全库 **22 个实例 / 21 个 run**，每个 E1 最终切片一个，
   * DATABASE 任务（`DEV_TASK_TYPES` 成员，有防篡改与写范围审计）**零客观检查即判 SUCCESS**。
   * 完全缺失时回退到 BACKEND 的候选集（`build` + `test`）——那是该类型在本项目里**真正可用**的检查。
   *
   * **只在「完全缺失」时回退**：只剩一个迁移脚本说明这是有 DB 的项目（脚本写了一半），
   * 此时仍按严格口径报缺（`migrate-up` / `migrate-down` 成对才算可用），不放宽。
   */
  const hasMigrationScript =
    MIGRATION_UP_SCRIPTS.some((name) => available.has(name)) ||
    MIGRATION_DOWN_SCRIPTS.some((name) => available.has(name));
  if (checkType === "DATABASE" && hasMigrationScript) {
    // database = 迁移 up/down（成对声明才算可用）。
    const up = MIGRATION_UP_SCRIPTS.find((name) => available.has(name));
    const down = MIGRATION_DOWN_SCRIPTS.find((name) => available.has(name));
    const missing: VerificationCheckName[] = [];
    if (!up) missing.push("migrate-up");
    if (!down) missing.push("migrate-down");
    return {
      plans:
        up && down
          ? [
              { name: "migrate-up", scriptName: up, expectation: "pass" },
              { name: "migrate-down", scriptName: down, expectation: "pass" }
            ]
          : [],
      missing
    };
  }
  // N-1b：DATABASE 且无任何迁移脚本 ⇒ 落到 BACKEND 的候选集（build + test）。
  const candidates: readonly VerificationCheckName[] =
    profile.checks[checkType === "DATABASE" ? "BACKEND" : checkType] ?? [];
  const plans: VerificationCheckPlan[] = [];
  const missing: VerificationCheckName[] = [];
  for (const candidate of candidates) {
    if (candidate === "lint") {
      // AFC-M1：lint 与 type-check 能跑则都跑（TASK-06 曾因只跑 lint 漏掉 type-check 红灯）。
      // 脚本名兼容 `typecheck` 与常见的 `type-check`。
      const lintScript = available.has("lint") ? "lint" : undefined;
      const typecheckScript = ["typecheck", "type-check"].find((name) => available.has(name));
      if (lintScript) {
        plans.push({ name: "lint", scriptName: lintScript, expectation: "pass" });
      }
      if (typecheckScript) {
        plans.push({ name: "typecheck", scriptName: typecheckScript, expectation: "pass" });
      }
      if (!lintScript && !typecheckScript) {
        missing.push("lint");
      }
      continue;
    }
    if (available.has(candidate)) {
      // N4：TEST（qa）任务的测试检查是红灯检查——写测试后先跑出失败（空转测试被拦截）。
      // N-15′：这里的 `taskType` 是任务**自身**类型，**不是** `checkType`——见上方形参注释。
      plans.push({
        name: candidate,
        scriptName: candidate,
        expectation:
          candidate === "test" && taskType === "TEST" && !options?.officialTestExpectsPass
            ? "fail"
            : "pass"
      });
      continue;
    }
    missing.push(candidate);
  }
  return { plans, missing };
}

export function planVerificationChecks(
  taskType: TaskType,
  scripts: Record<string, unknown>,
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): VerificationCheckPlan[] {
  return resolveVerificationChecks(taskType, scripts, taskType, profile).plans;
}

/**
 * `docs/235` §6.8：**非 TAP runner 也要有逐条结果**。
 *
 * 实测（F1 run 2 的 `T-07`）：vitest 的**默认** reporter 只打印文件名与计数，**通过**的用例名一行
 * 都不出现 ⇒ `parseAcResults` 看不到本任务作用域的 AC ⇒ `resolveCheckOutcome` 的「作用域 AC 全过
 * 即通过」永远不成立 ⇒ 命令退出码一非零，**别的任务的测试红一次，每个任务都被判死**。
 * 这正是 N-26（`node --test` 上已修）的形状在非 TAP runner 上复发。
 *
 * 做法：追加 `--reporter=verbose`，输出形如 `✓ tests/x.spec.ts > [AC-03] …`，正是
 * `RUNNER_MARK_PATTERN` 认得的形式。三条不动的边界：
 * - profile 的 `testParser` 不是 `vitest`（别的 runner 传这个参数会直接报错，那是新的假失败）；
 * - `test` 脚本本身不是 vitest（脚本是 jest/mocha 时同理）；
 * - 命令里已经指定过 `--reporter`（用户的选择优先）。
 */
export function withTestReporter(
  command: string,
  scriptText: string,
  parser: CapabilityProfile["testParser"]
): string {
  if (parser !== "vitest") return command;
  if (!/\bvitest\b/.test(scriptText)) return command;
  if (/--reporter\b/.test(command)) return command;
  // 作用域命令已经带了 ` -- <flags>`（如 `--testNamePattern`）时，再插一次 `--` 会把
  // `--reporter` 变成无效位置参数；只追加 flag。
  if (/(?:^|\s)--(?:\s|$)/.test(command)) {
    return `${command} --reporter=verbose`;
  }
  return `${command} -- --reporter=verbose`;
}

/**
 * PL-M5（`docs/158` §3）+ docs/259：受保护测试文件判定以 `@ai-se/shared` 的
 * `isTestFilePath` 为基线，再排除交付报告。写权限仍走 `isTestFilePath`，两份定义
 * 不再混用反篡改口径。
 *
 * 交付报告 / 非测试源码的说明文件：位于 test、tests、__tests__ 目录下，但不是
 * `*.test.*` / `*.spec.*`。典型是 `tests/reports/test-execution-report.md`。
 *
 * 写权限仍走 `isTestFilePath`（TEST 任务可以更新报告）；反篡改不能把「同步报告计数」
 * 当成改弱断言（docs/259）。
 */
const SPEC_OR_TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestDeliveryReportPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized) return false;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const underTest = segments
    .slice(0, -1)
    .some((segment) => segment === "test" || segment === "tests" || segment === "__tests__");
  if (!underTest) return false;
  const base = segments[segments.length - 1] ?? "";
  if (SPEC_OR_TEST_FILE_NAME.test(base)) return false;
  if (segments.includes("reports")) return true;
  return /\.(md|markdown|txt|html)$/i.test(base);
}

export function isProtectedTestPath(relPath: string): boolean {
  return isTestFilePath(relPath) && !isTestDeliveryReportPath(relPath);
}

/**
 * 受保护测试文件的**候选集合**（find 表达式）。
 *
 * 注意它只是**候选**：真正的「受保护」判定由 host 侧的 `isProtectedTestPath`（= `@ai-se/shared`
 * 的 `isTestFilePath`）完成。沙箱命令因此不需要、也不得再复制一份 `isTestFilePath`——
 * 「重复定义必然漂移」是本仓库已登记的缺陷成因类型（`docs/160`）。
 *
 * N-14（`docs/189` §4.1）：哈希快照与**内容快照**必须共用这一份表达式，否则两者看到的
 * 候选集合会漂移，而「改弱判定」正是建立在两者之上。
 */
function buildProtectedFindCommand(): string {
  const names = [
    "*.test.js",
    "*.test.mjs",
    "*.test.cjs",
    "*.test.ts",
    "*.test.tsx",
    "*.test.jsx",
    "*.spec.js",
    "*.spec.mjs",
    "*.spec.cjs",
    "*.spec.ts",
    "*.spec.tsx",
    "*.spec.jsx"
  ];
  const nameClause = names.map((name) => `-name '${name}'`).join(" -o ");
  return (
    "find . -type d \\( -name node_modules -o -name .git \\) -prune -o " +
    `-type f \\( ${nameClause} \\) -print -o ` +
    "-type f -path '*/test/*' -print -o " +
    "-type f -path '*/tests/*' -print -o " +
    "-type f -path '*/__tests__/*' -print"
  );
}

/** 受保护测试文件哈希快照命令（经 Tool Runtime → Sandbox 执行；输出 `hash  ./path` 行）。 */
export function buildProtectedSnapshotCommand(): string {
  return `${buildProtectedFindCommand()} | sort | xargs -r sha256sum | sort -k2`;
}

/**
 * N-14（`docs/189` §4.1）+ docs/259：受保护测试文件的**内容**快照命令——把候选文件
 * 的内容读回来，输出一个 `{ "./path": "内容" | null }` 的 JSON 对象。
 *
 * `null` = 读取失败或超过 256 KiB。docs/259 起内容不可证不再判为改弱，由
 * `classifyProtectedChanges` 记入 `unread`。上限是避免把整仓测试源码塞进工具输出。
 *
 * 无 `paths` 时与哈希快照共用 find。传入 `paths` 时只回读这些相对路径（哈希比对后的变更集）。
 */
export function buildProtectedContentCommand(paths?: readonly string[]): string {
  const reader = [
    "const fs=require('fs');",
    "const out={};",
    "for(const line of fs.readFileSync(0,'utf8').split('\\n')){",
    "const p=line.trim();if(!p)continue;",
    "try{const s=fs.readFileSync(p,'utf8');out[p]=s.length<=262144?s:null}catch(e){out[p]=null}",
    "}",
    "process.stdout.write(JSON.stringify(out))"
  ].join("");
  const selected = (paths ?? [])
    .map((path) => path.replace(/^\.\//, ""))
    .filter((path) => SAFE_PROTECTED_CONTENT_PATH.test(path) && !path.includes(".."));
  if (selected.length === 0) {
    return `${buildProtectedFindCommand()} | sort | node -e "${reader}"`;
  }
  const printed = selected.map((path) => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  return `printf '%s\\n' ${printed} | node -e "${reader}"`;
}

const SAFE_PROTECTED_CONTENT_PATH = /^[A-Za-z0-9_./-]+$/;

/** 读取 package.json scripts 的探针命令（经 Tool Runtime → Sandbox 执行；缺文件/坏 JSON → {}）。 */
export function buildScriptsProbeCommand(): string {
  return (
    "node -e \"const fs=require('fs');let s={};" +
    "try{s=JSON.parse(fs.readFileSync('package.json','utf8')).scripts||{}}catch(e){};" +
    'process.stdout.write(JSON.stringify(s))"'
  );
}

/**
 * N-67（`docs/232` §10）：**工作区有没有可用的 `node_modules`**。
 *
 * 验证门跑的是项目 scripts（`pnpm build` / `vue-tsc`），依赖没装就是 `sh: 1: vite: not found`
 * ——实测第七轮三次逐字相同、REPLAN 不收敛，而同一份源码在 oracle 里装完依赖后 24/24。
 *
 * 额外钉住「宿主机 macOS 装的 node_modules 挂进 Linux 沙箱」：目录存在但
 * `@rollup/rollup-linux-*` / `@esbuild/linux-*` 缺失时，`vite`/`vitest` 会在
 * `Cannot find module @rollup/rollup-linux-arm64-gnu` 处 exit 1——这不是代码缺陷，
 * 必须先补齐当前平台的 optional native 包（可与 darwin 包并存）。
 */
export function buildDependencyProbeCommand(): string {
  return (
    "node -e \"const fs=require('fs');const path=require('path');" +
    "const has=fs.existsSync('node_modules');" +
    "const missing=[];" +
    "let binOk=true;" +
    "if(has){" +
    "const nm=(p)=>fs.existsSync(path.join('node_modules',...p.split('/')));" +
    "const plat=process.platform;const arch=process.arch;" +
    "if(nm('rollup')||nm('vite')||nm('vitest')){" +
    "const rollupPkg=plat==='linux'?('@rollup/rollup-linux-'+arch+'-gnu'):('@rollup/rollup-'+plat+'-'+arch);" +
    "if(!nm(rollupPkg)) missing.push(rollupPkg);" +
    "}" +
    "if(nm('esbuild')||nm('vite')){" +
    "const esbuildPkg=plat==='linux'?('@esbuild/linux-'+arch):('@esbuild/'+plat+'-'+arch);" +
    "if(!nm(esbuildPkg)) missing.push(esbuildPkg);" +
    "}" +
    // AFC-M4：目录在但 .bin 空（或部分树）→ 仍视为缺依赖，禁止「有 node_modules 就跳过」。
    "const binDir=path.join('node_modules','.bin');" +
    "try{const ents=fs.readdirSync(binDir);binOk=ents.length>0;}catch(e){binOk=false;}" +
    "}" +
    "process.stdout.write(JSON.stringify({hasNodeModules:has,nativeOk:missing.length===0,binOk:binOk,missingNative:missing}))\""
  );
}

/** 解析 `buildDependencyProbeCommand`；不可解析 → `"unknown"`（调用方按「不确定」处理，不擅自安装）。 */
export function parseDependencyProbe(stdout: string): boolean | "unknown" {
  const trimmed = stdout.trim();
  if (trimmed === "") return "unknown";
  try {
    const parsed = JSON.parse(trimmed) as {
      hasNodeModules?: unknown;
      nativeOk?: unknown;
      binOk?: unknown;
      missingNative?: unknown;
    };
    if (typeof parsed.hasNodeModules !== "boolean") return "unknown";
    if (!parsed.hasNodeModules) return false;
    // 旧探针只有 hasNodeModules；新探针带 nativeOk / binOk。不齐视为「需要安装」。
    if (parsed.nativeOk === false) return false;
    if (parsed.binOk === false) return false;
    return true;
  } catch {
    return "unknown";
  }
}

/** 从探针 stdout 取出需要补齐的平台原生包（供 `--no-save` 安装，不覆盖宿主机其它 optional）。 */
export function missingNativePackagesFromProbe(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed) as { missingNative?: unknown };
    if (!Array.isArray(parsed.missingNative)) return [];
    return parsed.missingNative.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

/** 只补齐当前沙箱平台的 optional native 包，避免 `npm ci` 把 darwin 树整棵换成 linux。 */
export function nativeDependencyHealCommand(packages: string[]): string | undefined {
  const unique = [...new Set(packages.map((entry) => entry.trim()).filter(Boolean))];
  if (unique.length === 0) return undefined;
  const args = unique.map((pkg) => JSON.stringify(pkg)).join(" ");
  return `npm install --no-save --no-audit --no-fund ${args}`;
}

/** F1-5：node --test 项目判定（可安全透传 `--test-name-pattern`）。 */
export function isNodeTestScript(scriptText: string): boolean {
  return /\bnode\s+--test\b/.test(scriptText);
}

/** vitest 项目判定（可安全透传 `--testNamePattern` / 文件选取）。 */
export function isVitestScript(scriptText: string): boolean {
  return /\bvitest\b/.test(scriptText);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** F1-5（FX-16/17）：AC 标记的规范化变体（未转义）：`AC-01` → `AC-01`、`AC-1`。 */
export function acMarkerKeys(acKeys: string[]): string[] {
  const keys = new Set<string>();
  for (const raw of acKeys) {
    const key = raw.trim();
    if (key === "") continue;
    keys.add(key);
    const canonical = /^([A-Za-z]{2,})-0*(\d+)$/.exec(key);
    if (canonical) {
      keys.add(`${canonical[1].toUpperCase()}-${canonical[2]}`);
    }
  }
  return [...keys];
}

/** F1-5（FX-16/17）：AC 名称模式——`\[AC-01\]|\[AC-02\]`（含规范键去重）。 */
export function buildAcNamePattern(acKeys: string[]): string {
  return acMarkerKeys(acKeys)
    .map((key) => `\\[${escapeRegex(key)}\\]`)
    .join("|");
}

/**
 * N-13（PL-M20 / PL-M24）：作用域命令里 `--test-timeout` 的取值——**必须容纳多个永不结束的文件**。
 *
 * **为什么不是「预算的 5/6」**：`--test-timeout` 是**按文件**计的——一个文件的文件级钩子永不结束，
 * 就烧掉**一整个** `--test-timeout`；而沙箱只有 **1 个 CPU**（`packages/sandbox/src/index.ts` 的
 * `cpus: 1`）⇒ 容器内 `os.availableParallelism() = 1` ⇒ Node **串行**跑测试文件
 * ⇒ **N 个这样的文件烧 N × 超时**。5/6 的余量只够**一个**文件：实测真实 E1 工作区 **N = 3~4**
 * （`[AC-01]`→4、`[AC-07/08]`→4、`[AC-02..06]`→3、`[AC-09/12/13]`→3），4 × 100s = 400s
 * ≫ 120s 预算 ⇒ `CHECK_TIMEOUT`。证据：`packages/eval/results/n13-e1-probe/`。
 *
 * 取值 = `预算 / (1 + 允许永不结束的文件数)`；允许 5 个 ⇒ 120s 预算下 20s。
 * 代价基线（真实 E1 工作区实测）：整份**串行**套件 **4.3s / 106 用例**、**最慢单测 0.67s**
 * ⇒ 约 30 倍余量，不会误杀正常测试。
 *
 * **必须严格小于整命令预算**：否则整命令超时会先触发，失败就归因不到文件级。
 */
export const MAX_NEVER_COMPLETING_TEST_FILES = 5;

/**
 * N-34（PL-M35）：作用域内**实际会跑的测试文件**上限。超过即放弃文件选取、退回全量运行
 * （命令行长度与预算都不可控）。取值 = 20 × 最小每文件超时 5.7s，仍在 120s 预算内。
 */
export const MAX_SCOPED_TEST_FILES = 20;

/**
 * `--test-timeout` 按**文件**计（见 `MAX_NEVER_COMPLETING_TEST_FILES`），所以取值必须按
 * **实际会跑的文件数**分摊预算，而不是按固定的 5 个。
 * PL-M35：文件选取后文件数通常降到 1~3，此时沿用 5 个的分母会白白浪费一半预算。
 */
export function acScopedTestTimeoutMs(
  checkTimeoutMs: number,
  fileCount: number = MAX_NEVER_COMPLETING_TEST_FILES
): number {
  const files = Math.max(1, Math.min(Math.floor(fileCount), MAX_SCOPED_TEST_FILES));
  return Math.max(1_000, Math.floor(checkTimeoutMs / (files + 1)));
}

/**
 * F1-5（FX-16/17）：AC 作用域测试命令——在既得基础命令（如 `npm run test` / `pnpm test`）后追加
 * 名称筛选（`node --test` 用 `--test-name-pattern`；vitest 用 `--testNamePattern`）。
 * 作用域为空、或 runner 不受支持 → null（调用方对有 AC 的门禁应 fail-closed，不得再跑全量套件）。
 *
 * N-13（PL-M20）：**同时追加 `--test-timeout`**。`--test-name-pattern` 只筛**测试名**，文件照跑；
 * 某个文件一条都不匹配时，Node 会在 `before` 钩子**还没结束**时就调用 `after`（实测：`after` 里
 * 持有的资源仍是 `undefined`），于是 `before` 随后起的子进程再也没人回收，测试进程被它拖着不退出，
 * `node --test` 永不返回——实测 E1 工作区 5/5 复现，而每次验证只有 120s。
 *
 * 为什么不是 `--test-force-exit`：它把「全绿但挂死」直接变成**通过**，等于关掉红灯门（实测该开关下
 * 最小复现 exit 0 / pass 1）。`--test-timeout` 把「不返回」变成**有界的失败**（实测 exit 1 /
 * `testTimeoutFailure`），方向安全。
 *
 * PL-M24：**这个超时是按文件计的**——取值必须容纳**多个**这样的文件，见 `acScopedTestTimeoutMs`。
 */
export function buildAcScopedTestCommand(
  baseCommand: string,
  acKeys: string[],
  scriptText: string,
  checkTimeoutMs: number,
  testFiles?: readonly string[]
): string | null {
  if (acKeys.length === 0) {
    return null;
  }
  const pattern = buildAcNamePattern(acKeys);
  if (pattern === "") return null;

  // vitest：`--testNamePattern` + 可选文件列表（真选取）。仓库一长大，全量 `vitest run` 会先
  // 撑爆门禁超时（v9 T-10 CHECK_TIMEOUT），不能再静默退到 result-filter。
  if (isVitestScript(scriptText)) {
    // docs/262：若已探测但过滤后没有正规测试文件（只剩嵌套残留等垃圾路径），
    // 不得把垃圾路径塞进官方命令，也不得静默退回全量名称筛选。
    if (testFiles !== undefined && selectCanonicalTestFiles(testFiles).length === 0) {
      return null;
    }
    const selected =
      testFiles === undefined ? null : selectCanonicalTestFiles(testFiles);
    const files = selected && selected.length > 0 ? selected : null;
    const testTimeoutMs = acScopedTestTimeoutMs(checkTimeoutMs, files?.length);
    const quoted = files ? files.map((file) => `'${file}'`).join(" ") : "";
    return `${baseCommand} --${quoted === "" ? "" : ` ${quoted}`} --testNamePattern '${pattern}' --testTimeout=${testTimeoutMs}`;
  }

  if (!isNodeTestScript(scriptText)) {
    return null;
  }
  // N-55b：脚本自带位置参数时，追加到末尾的标志会被 Node 当成测试文件的脚本参数**忽略**。最小实验：
  //   node --test --test-name-pattern '\[AC-24\]' a.test.js  → # tests 1（筛选生效）
  //   node --test a.test.js --test-name-pattern '\[AC-24\]'  → # tests 2（标志被忽略）
  // 而 `pnpm test -- <flags>` 只能追加到脚本末尾 ⇒ 这类最常见的脚本形态下 command-filter 从未真正生效。
  // 改写调用：标志排在位置参数之前。
  const inline = NODE_TEST_INLINE.exec(scriptText.trim());
  if (inline && hasTestPathArgument(inline[1] ?? "")) {
    // 过滤真正生效后，**兄弟切片的文件仍会被加载**、其顶层钩子挂到 `--test-timeout`（实测真实 E1
    // 工作区 19 个文件超时、命令 60s）。N-34 的按文件选取在这里同样适用：用探测结果替换脚本自带的
    // glob，只加载本切片相关的文件。探测不到时退回脚本原样的位置参数。
    if (testFiles !== undefined && selectCanonicalTestFiles(testFiles).length === 0) {
      return null;
    }
    const selected =
      testFiles === undefined ? null : selectCanonicalTestFiles(testFiles);
    const files = selected && selected.length > 0 ? selected : null;
    const testTimeoutMs = acScopedTestTimeoutMs(checkTimeoutMs, files?.length);
    const positionals = files
      ? files.map((file) => `'${file}'`).join(" ")
      : (inline[1] ?? "").trim();
    return `node --test --test-name-pattern '${pattern}' --test-timeout=${testTimeoutMs}${
      positionals === "" ? "" : ` ${positionals}`
    }`;
  }
  // docs/262：已探测但过滤后 0 个正规文件 → fail-closed，不得退回名称筛选（那仍会加载全树）。
  if (testFiles !== undefined && selectCanonicalTestFiles(testFiles).length === 0) {
    return null;
  }
  // N-34（PL-M35）：文件选取未探测 / 不可用时保持 PL-M24 的既有形态（命令逐字不变）。
  const selected = testFiles === undefined ? null : selectScopedTestFiles(scriptText, testFiles);
  if (!selected) {
    const testTimeoutMs = acScopedTestTimeoutMs(checkTimeoutMs);
    return `${baseCommand} -- --test-name-pattern '${pattern}' --test-timeout=${testTimeoutMs}`;
  }
  // 文件选取 + 名称筛选并用：文件层面不再加载兄弟切片的文件，文件内仍只跑本切片的用例。
  const testTimeoutMs = acScopedTestTimeoutMs(checkTimeoutMs, selected.length);
  const quoted = selected.map((file) => `'${file}'`).join(" ");
  return `${baseCommand} -- ${quoted} --test-name-pattern '${pattern}' --test-timeout=${testTimeoutMs}`;
}

/**
 * N-34（PL-M35）：**按文件选取**作用域测试。
 *
 * 缺陷：`--test-name-pattern` 只筛**测试名**，`node --test` 仍会加载 `test/` 下的**每个**文件并执行
 * 其文件级钩子（`taskVerifierRules.ts` 中 `--test-timeout` 那段注释已写明）。沙箱 `--cpus 1` 下 Node
 * 串行跑文件 ⇒ 兄弟切片的 N 个挂死文件各烧掉一整个 `--test-timeout`。参考实现只有 2 个测试文件、
 * `MAX_NEVER_COMPLETING_TEST_FILES` 按 5 校准，而实测代理写出的 E1 工作区有十几个 ⇒
 * **5 × 20s 撑不满、实际是 12+ × 20s** ⇒ 整条命令吃满 120s 预算 ⇒ `CHECK_TIMEOUT`，证据丢失。
 * 见批次 `l1-m4t` run 1/run 2（`T11` 的 `stdoutTail` 内 5 条 `testTimeoutFailure`、
 * attempts `120019ms` / `120030ms`）。
 *
 * 选取只在**裸 `node --test`** 脚本上做：脚本自带路径参数（如 `node --test test/`）时追加文件只会取
 * **并集**，反而跑得更多，故退回名称筛选。探测不到文件时同样退回——退回路径与 PL-M24 逐字一致。
 */
function selectScopedTestFiles(
  scriptText: string,
  testFiles: readonly string[]
): string[] | null {
  if (!isBareNodeTestScript(scriptText)) return null;
  const safe = selectCanonicalTestFiles(testFiles);
  if (safe.length === 0 || safe.length > MAX_SCOPED_TEST_FILES) return null;
  return [...safe];
}

/** 裸 `node --test`：无路径参数（只可能带 `--flag` / `--flag=value`）。 */
export function isBareNodeTestScript(scriptText: string): boolean {
  return /^node\s+--test(\s+--[A-Za-z0-9][A-Za-z0-9-]*(=\S+)?)*$/.test(scriptText.trim());
}

const NODE_TEST_INLINE = /^node\s+--test\b([\s\S]*)$/;

/** `node --test` 之后的位置参数（测试路径/glob）。标志值（如 `--test-timeout 20000`）不算。 */
function hasTestPathArgument(rest: string): boolean {
  for (const token of rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
    if (token.startsWith("-")) continue;
    const bare = token.replace(/^["']|["']$/g, "");
    if (bare.includes("/") || /\.(?:js|mjs|cjs)$/.test(bare) || bare === "test" || bare === "tests") {
      return true;
    }
  }
  return false;
}

/**
 * N-55（`docs/232` §9.27）：**输出是否被截断**。
 *
 * 沙箱的 `appendLimited`（`packages/sandbox/src/index.ts:69-76`）只保留 stdout 的最后 96,000 字节，
 * 而 AC 覆盖判定就在这段文本上做——排在前面的用例整段消失后，它们的 AC 会被判「未覆盖」，于是出现
 * 「退出码 0、258/258 全绿，却报 uncoveredAcKeys」的自相矛盾证据（第十一次回归 slice-3 `T7`）。
 *
 * 判据不依赖沙箱常量：Node 的 TAP 会打印 `# tests N`，把「汇总的用例数」与「实际解析到的结果行数」
 * 相比，少了就是被截断。没有汇总行（非 TAP 输出）时返回 false，不猜。
 */
export function detectTestOutputTruncation(text: string): boolean {
  let declared: number | null = null;
  let observed = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const summary = /^#\s*tests\s+(\d+)\s*$/.exec(line);
    if (summary) {
      declared = Number(summary[1]);
      continue;
    }
    if (/^(?:not ok|ok)\s+\d+\b/.test(line)) observed += 1;
  }
  return declared !== null && declared > observed;
}


const SAFE_TEST_FILE_PATH = /^[A-Za-z0-9_./-]+$/;

/** docs/262：官方探测只认这些仓库相对测试根，不认嵌套宿主路径 / workspace 副本。 */
export const CANONICAL_TEST_ROOTS = ["tests", "test", "__tests__", "e2e"] as const;

const JUNK_TEST_WALK_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "Users",
  "workspace"
]);

export function isSafeTestFilePath(path: string): boolean {
  if (!SAFE_TEST_FILE_PATH.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
    return false;
  }
  const parts = path.split("/");
  // 宿主前缀（Users/shixianbao/...）与 workspace 副本不得进入官方命令。
  if (parts.includes("Users") || parts[0] === "workspace") return false;
  return true;
}

export function isCanonicalTestFilePath(path: string): boolean {
  if (!isSafeTestFilePath(path)) return false;
  const root = path.replace(/^\.\//, "").split("/")[0];
  return (CANONICAL_TEST_ROOTS as readonly string[]).includes(root);
}

/** 先过滤到正规测试根，再截断到 MAX_SCOPED_TEST_FILES。 */
export function selectCanonicalTestFiles(testFiles: readonly string[]): string[] {
  return testFiles.filter(isCanonicalTestFilePath).slice(0, MAX_SCOPED_TEST_FILES);
}

export function probedTestFilesAreOnlyJunk(testFiles: readonly string[]): boolean {
  if (testFiles.length === 0) return false;
  return testFiles.every((file) => !isCanonicalTestFilePath(file));
}

export function scopedCommandUsesNonCanonicalTestFiles(command: string): boolean {
  if (!command) return false;
  const quoted = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "");
  const fileArgs = quoted.filter((entry) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry));
  return fileArgs.length > 0 && fileArgs.every((entry) => !isCanonicalTestFilePath(entry));
}

/**
 * N-34（PL-M35）：探测「哪些测试文件提到了本切片的 AC 标记」。
 *
 * 与 `buildPackageFactsProbeCommand` 同一范式：`node -e` 单命令、输出 JSON、由纯函数解析
 * （`run_unit_test` 只收脚本形态命令，`$(...)` 一类 shell 组合会被 `assertCommandAllowed` /
 * `isScriptOnlyCommand` 拒绝，所以选取必须在**另一次** `run_command` 里完成）。
 *
 * 返回 null = 无法探测（无安全 AC 键），调用方按「未探测」处理、保持既有名称筛选。
 */
export function buildAcTestFileProbeCommand(acKeys: string[]): string | null {
  // AC 键来自计划（LLM 产出），要拼进命令字符串 ⇒ 只放行字母数字与连字符，杜绝注入。
  const keys = acMarkerKeys(acKeys).filter((key) => /^[A-Za-z0-9-]+$/.test(key));
  if (keys.length === 0) return null;
  const keyList = keys.map((key) => `'${key}'`).join(",");
  // 命令经 `sh -lc` 执行（`packages/sandbox/src/index.ts` 的 `docker run … sh -lc`）⇒ 脚本体内
  // **不得出现 `$` 与反引号**，否则会被 shell 展开。故用 `endsWith` 判扩展名，不用 `$` 锚点。
  const script =
    "const fs=require('fs'),p=require('path');" +
    `const keys=[${keyList}];` +
    // 用 `includes` 而非 RegExp：字符串字面量里的 `\[` 会被 JS 吃掉反斜杠、退化成字符类。
    "const marks=keys.map(k=>'['+k+']');" +
    "const out=[];" +
    "const suffixes=['.test.js','.test.mjs','.test.cjs','.test.ts','.test.mts','.test.cts'," +
    "'.spec.js','.spec.mjs','.spec.cjs','.spec.ts','.spec.mts','.spec.cts'];" +
    "const roots=['tests','test','__tests__','e2e'];" +
    `const skip=new Set([${[...JUNK_TEST_WALK_DIRS].map((name) => `'${name}'`).join(",")}]);` +
    "const walk=d=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}" +
    "for(const e of es){if(skip.has(e.name))continue;" +
    "const q=p.join(d,e.name);" +
    "if(e.isDirectory()){walk(q);continue}" +
    "if(!suffixes.some(s=>e.name.endsWith(s)))continue;" +
    "let t;try{t=fs.readFileSync(q,'utf8')}catch(e){continue}" +
    "if(marks.some(m=>t.includes(m)))out.push(q)}};" +
    "for(const r of roots) walk(r);" +
    "process.stdout.write(JSON.stringify({files:out}))";
  return `node -e "${script}"`;
}

/** N-34（PL-M35）：解析 `buildAcTestFileProbeCommand` 的输出；不可解析 → null（视为未探测）。 */
export function parseAcTestFileProbe(stdout: string): string[] | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  return files
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter((entry) => isCanonicalTestFilePath(entry));
}

/** 一条实际使用中的 testid：值 + 首次出现的文件（证据用）。 */
export interface TestIdUsage {
  id: string;
  file: string;
}

/**
 * N-64（`docs/232` §10）：**扫描工作区源码里实际使用的 testid**。
 *
 * 与 `buildAcTestFileProbeCommand` 同一范式：`node -e` 单命令、输出 JSON、纯函数解析。
 * 约束也相同——命令经 `sh -lc` 执行，脚本体内**不得出现 `$`、反引号与双引号**
 * （双引号用 `String.fromCharCode(34)` 表达，单引号同理）。
 *
 * 收哪些：
 * - 只看 `data-testid=` 这个**非绑定**属性（`v-bind:data-testid` / `:data-testid` 的值是表达式，
 *   运行期才知道，拿来判契约必然误报）；
 * - 值必须是**静态字面量**（字母开头，其余字母/数字/`_ . -`）——带 `{}`/`:` 的动态拼接跳过；
 * - 跳过测试文件与 `node_modules`/`dist`/`coverage`，与受保护测试文件的遍历口径一致。
 */
export function buildTestIdUsageScanCommand(): string {
  const script = [
    "const fs=require('fs'),p=require('path');",
    "const DQ=String.fromCharCode(34),SQ=String.fromCharCode(39);",
    "const skip=new Set(['node_modules','.git','dist','coverage','.vite','.turbo']);",
    "const suffixes=['.vue','.js','.mjs','.cjs','.ts','.tsx','.jsx','.html'];",
    "const isLetter=c=>(c>=65&&c<=90)||(c>=97&&c<=122);",
    "const ok=c=>isLetter(c)||(c>=48&&c<=57)||c===45||c===95||c===46;",
    "const out=[];const seen=new Set();",
    "const walk=d=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}",
    "for(const e of es){if(skip.has(e.name))continue;",
    "const q=p.join(d,e.name);",
    "if(e.isDirectory()){walk(q);continue}",
    "if(e.name.includes('.test.')||e.name.includes('.spec.'))continue;",
    "if(!suffixes.some(s=>e.name.endsWith(s)))continue;",
    "let t;try{t=fs.readFileSync(q,'utf8')}catch(e){continue}",
    "let i=t.indexOf('data-testid');",
    "while(i>=0){",
    // 绑定的 `:data-testid` 前一个字符是 `:`，跳过。
    "if(i===0||t[i-1]!==':'){",
    "let j=i+11;",
    "while(j<t.length&&(t[j]===' '||t[j]==='\\t'))j++;",
    "if(t[j]==='='){j++;",
    "while(j<t.length&&(t[j]===' '||t[j]==='\\t'))j++;",
    "const qc=t[j];",
    "if(qc===DQ||qc===SQ){j++;const s=j;",
    "while(j<t.length&&t[j]!==qc)j++;",
    "const v=t.slice(s,j);",
    "if(v.length>0&&v.length<100&&isLetter(v.charCodeAt(0))&&Array.from(v).every(c=>ok(c.charCodeAt(0)))){",
    "if(!seen.has(v)&&out.length<500){seen.add(v);out.push({id:v,file:q})}",
    "}}}}",
    "i=t.indexOf('data-testid',i+11);",
    "}}};",
    "walk('.');",
    "process.stdout.write(JSON.stringify({used:out}))"
  ].join("");
  return `node -e "${script}"`;
}

/** 解析 `buildTestIdUsageScanCommand` 的输出；不可解析 → null（视为未探测，不判缺陷）。 */
export function parseTestIdUsageScan(stdout: string): TestIdUsage[] | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const used = (parsed as { used?: unknown }).used;
  if (!Array.isArray(used)) return null;
  const result: TestIdUsage[] = [];
  for (const entry of used) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    const file = (entry as { file?: unknown }).file;
    if (typeof id !== "string" || id.trim() === "") continue;
    result.push({
      id: id.trim(),
      file: typeof file === "string" ? file.replace(/^\.\//, "") : ""
    });
  }
  return result;
}

/**
 * N-64：**源码里出现、但需求没声明过的 testid**。
 *
 * 判据是「不得自创」，不是「必须全部到位」——后者会把还没写到的那部分判死，而前者在任何一个
 * 切片边界上都成立。空 `allowed` 表示需求没声明契约，调用方必须跳过（留痕），不能当成「全违规」。
 */
export function testIdContractViolations(
  used: readonly TestIdUsage[],
  allowed: readonly string[]
): TestIdUsage[] {
  const permitted = new Set(allowed);
  return used.filter((entry) => !permitted.has(entry.id));
}

/** F1-5：受保护集合之外的检查名（事件/记录用）。 */
export function isSliceBoundaryName(name: VerificationCheckName): boolean {
  return name === "slice-boundary" || name === "e2e" || name === "visual";
}
const SNAPSHOT_LINE_PATTERN = /^([0-9a-f]{64})\s+(.+)$/;

export function parseProtectedSnapshot(output: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = SNAPSHOT_LINE_PATTERN.exec(line);
    if (!match) continue;
    const relPath = match[2].replace(/^\.\//, "");
    if (!isProtectedTestPath(relPath)) continue;
    files.set(relPath, match[1]);
  }
  return files;
}

/** 比对前后快照：既有受保护测试文件被修改或删除（新增不算违例）。 */
export function changedProtectedFiles(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const changed: string[] = [];
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) changed.push(path);
  }
  return changed.sort();
}

/**
 * N-14：解析内容快照（`buildProtectedContentCommand` 的 JSON 输出）。
 * 与哈希快照同口径——**受保护判定仍由 host 侧的 `isProtectedTestPath` 完成**，
 * 沙箱命令只负责把候选文件的内容读回来。
 */
export function parseProtectedContents(output: string): Map<string, string | null> {
  const contents = new Map<string, string | null>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return contents;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return contents;
  for (const [rawPath, value] of Object.entries(parsed as Record<string, unknown>)) {
    const relPath = rawPath.replace(/^\.\//, "");
    if (!isProtectedTestPath(relPath)) continue;
    contents.set(relPath, typeof value === "string" ? value : null);
  }
  return contents;
}

/** 证据行：任何含 `assert` 的行（`assert.equal` / `assert(...)` / 导入 `assert` 皆中）。 */
const ASSERTION_LINE_PATTERN = /\bassert\b/;

function assertionLines(content: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of content.split("\n")) {
    // trim + 折叠内部空白：纯重排（缩进/换行）不应被当成改弱。
    const line = raw.trim().replace(/\s+/g, " ");
    if (line && ASSERTION_LINE_PATTERN.test(line)) lines.add(line);
  }
  return lines;
}

/**
 * N-14（`docs/189` §4.1）+ docs/259：受保护测试文件的「**改弱**」判定。
 *
 * `changedProtectedFiles` 只比对 sha256——它知道「变了」，分不出「加了一条测试」与
 * 「把一条既有断言改弱」。L1-M4l 实测两类混在同一道门里：`T3-DEBUG-1` 只给 import 表补了
 * 两个新导出（**纯增量，门拦错了**），`T-02-DEBUG-1-DEBUG-2` 把「短密钥必须被拒」的断言
 * 换成了「短密钥被接受」（**真篡改，门拦对了**）。
 *
 * 判据：**改动前每一行含 `assert` 的内容，改动后必须仍然存在**（按行 trim + 折叠空白后比对）。
 * 只增行、或只改 import ⇒ 判为增量。
 *
 * docs/259：内容不可证（快照截断、单文件超 256 KiB、命令失败）**不再当成改弱**。
 * 删除受保护测试文件仍判改弱。调用方应使用 `classifyProtectedChanges`。
 */
export interface ProtectedChangeClassification {
  /** 既有断言行消失，或受保护测试文件被删除。 */
  weakened: string[];
  /** 文件仍在，但至少一侧内容读不到，无法证明或否定改弱。 */
  unread: string[];
}

export function classifyProtectedChanges(
  changed: readonly string[],
  beforeContents: ReadonlyMap<string, string | null> | undefined,
  afterContents: ReadonlyMap<string, string | null> | undefined,
  afterFiles?: ReadonlyMap<string, string>
): ProtectedChangeClassification {
  const weakened: string[] = [];
  const unread: string[] = [];
  for (const path of changed) {
    if (afterFiles && !afterFiles.has(path)) {
      weakened.push(path);
      continue;
    }
    const before = beforeContents?.get(path);
    const after = afterContents?.get(path);
    if (typeof before !== "string" || typeof after !== "string") {
      unread.push(path);
      continue;
    }
    const remaining = assertionLines(after);
    for (const line of assertionLines(before)) {
      if (!remaining.has(line)) {
        weakened.push(path);
        break;
      }
    }
  }
  return { weakened: weakened.sort(), unread: unread.sort() };
}

/**
 * 只比较两侧都读到的内容：既有 `assert` 行必须仍在。内容缺失时返回空数组，
 * 交由 `classifyProtectedChanges` 区分「删除」与「读不到」。
 */
export function weakenedProtectedFiles(
  changed: readonly string[],
  beforeContents: ReadonlyMap<string, string | null> | undefined,
  afterContents: ReadonlyMap<string, string | null> | undefined
): string[] {
  return classifyProtectedChanges(changed, beforeContents, afterContents).weakened;
}

const TAP_RESULT_PATTERN = /^(not ok|ok) +\d+ +- +(.*)$/;
const RUNNER_MARK_PATTERN = /^\s*(✓|✔|×|✗|✘)\s+(.*)$/;
/**
 * ANSI 颜色序列（`\u001b[32m` 一类）。用字符码拼：字面量里直接写控制字符会触发 eslint 的
 * `no-control-regex`。
 */
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
/** 方括号 AC 标记（任意前缀命名空间，如 [AC-01] / [FR-001]）与兼容的无括号 AC-N 记号。 */
const BRACKETED_MARKER_PATTERN = /\[([A-Za-z]{2,})-(\d+)\]/g;
const LEGACY_AC_PATTERN = /AC-(\d+)/gi;

function acKeyOf(prefix: string, digits: string): string {
  const number = digits.length >= 2 ? digits : digits.padStart(2, "0");
  return `${prefix.toUpperCase()}-${number}`;
}

/** 逐条 AC 结果：TAP（node --test）与常见 runner 记号；同名多条合并时 fail 优先。 */
export function parseAcResults(text: string): Record<string, "passed" | "failed"> {
  const results: Record<string, "passed" | "failed"> = {};
  const apply = (name: string, passed: boolean) => {
    const keys = new Set<string>();
    for (const match of name.matchAll(BRACKETED_MARKER_PATTERN)) {
      keys.add(acKeyOf(match[1], match[2]));
    }
    for (const match of name.matchAll(LEGACY_AC_PATTERN)) {
      keys.add(acKeyOf("AC", match[1]));
    }
    for (const key of keys) {
      if (results[key] === "failed") continue;
      results[key] = passed ? "passed" : "failed";
    }
  };
  for (const rawLine of text.split("\n")) {
    // `docs/235` §6.8：runner 的输出带 ANSI 颜色（无 TTY 也带，实测 vitest 5 如此），
    // 不剥掉的话 `✓` 前面永远压着一段转义序列，逐条结果一行都解析不出来。
    const plain = rawLine.replace(ANSI_PATTERN, "");
    const line = plain.trim();
    const tap = TAP_RESULT_PATTERN.exec(line);
    if (tap) {
      apply(tap[2], tap[1] === "ok");
      continue;
    }
    const mark = RUNNER_MARK_PATTERN.exec(plain);
    if (mark) {
      apply(mark[2], mark[1] === "✓" || mark[1] === "✔");
    }
  }
  return results;
}

export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function tailText(text: string, maxLength = 2_000): string {
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}
