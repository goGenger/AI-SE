import { z } from "zod";

/**
 * F1-7（FX-25）：项目包管理器探测——工具默认命令（run_unit_test / run_lint / run_build）与
 * 验证门共用同一模块，杜绝两处逻辑分叉。
 *
 * 决策顺序：`packageManager` 字段 → 唯一锁文件（多个并存按固定顺序选择 + 警告）→ 回退 `npm run <script>`。
 * docs/263：若 `pnpm-lock.yaml` 与 `package-lock.json` 并存，且 `pnpm-workspace.yaml` 缺失或没有 `packages` 字段，
 * 不得静默优先 pnpm（官方会因 `packages field missing or empty` 立刻失败）。
 * （npm 随 node 镜像自带；pnpm/yarn 由沙箱镜像预置，见 packages/sandbox/Dockerfile。）
 */

export interface PackageFacts {
  hasPackageJson: boolean;
  /** package.json 的 packageManager 字段原值（如 "pnpm@9.15.0"）；缺省 = 未声明。 */
  packageManager?: string;
  /** 工作区根目录存在的锁文件（按探测固定顺序）。 */
  lockfiles: string[];
  /**
   * docs/263：`pnpm-workspace.yaml` 探测结果。缺省 = 旧探测器未采集，resolveRunner 保持历史锁文件顺序。
   * `hasPackages` 为 false 表示文件不存在或没有可用的 `packages` 字段。
   */
  pnpmWorkspace?: { present: boolean; hasPackages: boolean };
  /** package.json scripts 的原始映射（未解析出时为空对象）。 */
  scripts: Record<string, unknown>;
}

export type PackageRunner = "pnpm" | "yarn" | "npm";

export interface PackageCommandPlan {
  runner: PackageRunner;
  /** 解析出的命令（如 `pnpm test` / `npm run test`）；error 时为 undefined。 */
  command?: string;
  warnings: string[];
  error?: "PROBE_FAILED" | "NO_PACKAGE_JSON" | "SCRIPT_NOT_FOUND";
  errorMessage?: string;
}

/** 多锁文件并存时的固定选择顺序（先入先选）。 */
export const LOCKFILE_ORDER = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json"
] as const;

const RUNNER_BY_LOCKFILE: Record<(typeof LOCKFILE_ORDER)[number], PackageRunner> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm"
};

const SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9:_-]+$/;

/**
 * docs/263：`pnpm-workspace.yaml` 是否声明了非空 `packages`。
 * 仅有 `allowBuilds:` 占位、或 `packages: []`，不算可用的 workspace。
 */
export function pnpmWorkspaceHasPackagesField(source: string): boolean {
  if (!source) return false;
  if (!/(?:^|\n)packages\s*:/m.test(source)) return false;
  if (/(?:^|\n)packages\s*:\s*\[\s*\]/m.test(source)) return false;
  if (/(?:^|\n)packages\s*:\s*\{\s*\}/m.test(source)) return false;
  const match = source.match(/(?:^|\n)packages\s*:\s*(.*)/);
  const rest = (match?.[1] ?? "").trim();
  if (rest.length > 0) return true;
  return /(?:^|\n)packages\s*:\s*\n[ \t]+-[ \t]+\S/.test(source);
}

function shouldPreferNpmOverPnpm(facts: PackageFacts): boolean {
  const hasPnpmLock = facts.lockfiles.includes("pnpm-lock.yaml");
  const hasNpmLock =
    facts.lockfiles.includes("package-lock.json") || facts.lockfiles.includes("npm-shrinkwrap.json");
  if (!hasPnpmLock || !hasNpmLock) return false;
  const workspace = facts.pnpmWorkspace;
  // 已探测且（无 yaml 或没有 packages 字段）时，不得因 LOCKFILE_ORDER 把官方命令切到 pnpm。
  if (!workspace) return false;
  return !workspace.present || !workspace.hasPackages;
}


/**
 * 单命令采集探测事实（在沙箱内以 node -e 运行；输出 JSON）。
 * 输出形状：{ hasPackageJson, packageManager?, lockfiles, scripts }。
 */
export function buildPackageFactsProbeCommand(): string {
  return (
    "node -e \"const fs=require('fs');const out={hasPackageJson:false,lockfiles:[],scripts:{}};" +
    "try{const raw=JSON.parse(fs.readFileSync('package.json','utf8'));out.hasPackageJson=true;" +
    "out.scripts=(raw&&typeof raw.scripts==='object'&&raw.scripts)||{};" +
    "if(typeof raw.packageManager==='string')out.packageManager=raw.packageManager;}catch(e){}" +
    "for(const f of ['pnpm-lock.yaml','yarn.lock','package-lock.json','npm-shrinkwrap.json'])" +
    "{try{fs.statSync(f);out.lockfiles.push(f)}catch(e){}}" +
    "out.pnpmWorkspace={present:false,hasPackages:false};" +
    "try{const w=fs.readFileSync('pnpm-workspace.yaml','utf8');" +
    "out.pnpmWorkspace={present:true,hasPackages:/(^|\\n)packages\\s*:\\s*(\\S|\\s*\\n\\s*-)/.test(w)&&!/(^|\\n)packages\\s*:\\s*\\[\\s*\\]/.test(w)}}" +
    "catch(e){}" +
    'process.stdout.write(JSON.stringify(out))"'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析探测输出。兼容旧版探测器形状（直接输出 scripts 映射；视为未声明 packageManager / 无锁文件 →
 * npm 回退），保证既有夹具与历史回放语义不变。
 */
export function parsePackageFacts(stdout: string): PackageFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === "" ? "{}" : stdout.trim());
  } catch {
    parsed = {};
  }
  const record = isRecord(parsed) ? parsed : {};
  if (typeof record.hasPackageJson === "boolean") {
    const lockfiles = Array.isArray(record.lockfiles)
      ? LOCKFILE_ORDER.filter((name) => (record.lockfiles as unknown[]).includes(name))
      : [];
    const workspaceRaw = isRecord(record.pnpmWorkspace) ? record.pnpmWorkspace : undefined;
    const pnpmWorkspace = workspaceRaw
      ? {
          present: workspaceRaw.present === true,
          hasPackages: workspaceRaw.hasPackages === true
        }
      : undefined;
    return {
      hasPackageJson: record.hasPackageJson,
      ...(typeof record.packageManager === "string"
        ? { packageManager: record.packageManager }
        : {}),
      lockfiles,
      ...(pnpmWorkspace ? { pnpmWorkspace } : {}),
      scripts: isRecord(record.scripts) ? record.scripts : {}
    };
  }
  // 旧形状：整个对象即 scripts 映射。
  return { hasPackageJson: true, lockfiles: [], scripts: record };
}

function resolveRunner(facts: PackageFacts, warnings: string[]): PackageRunner {
  const declared = facts.packageManager?.split("@")[0]?.trim().toLowerCase();
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") {
    return declared;
  }
  const present = LOCKFILE_ORDER.filter((name) => facts.lockfiles.includes(name));
  const usable =
    shouldPreferNpmOverPnpm(facts)
      ? present.filter((name) => name !== "pnpm-lock.yaml")
      : present;
  const chosen = usable.length > 0 ? usable : present;
  if (chosen.length === 1) {
    if (usable.length !== present.length) {
      warnings.push(
        `pnpm-lock.yaml present with package-lock.json but pnpm-workspace.yaml is missing or has no packages field; using npm`
      );
    }
    return RUNNER_BY_LOCKFILE[chosen[0]];
  }
  if (chosen.length > 1) {
    const reason =
      usable.length !== present.length
        ? `pnpm-lock.yaml ignored (workspace yaml missing or has no packages field); using ${chosen[0]}`
        : `using ${chosen[0]} by fixed order`;
    warnings.push(`multiple lockfiles present (${present.join(", ")}); ${reason}`);
    return RUNNER_BY_LOCKFILE[chosen[0]];
  }
  return "npm";
}

/** 生成 `run <script>` 命令（npm 显式 `npm run`；pnpm/yarn 短形式）。 */
export function buildRunnerCommand(runner: PackageRunner, scriptName: string): string {
  return runner === "npm" ? `npm run ${scriptName}` : `${runner} ${scriptName}`;
}

/**
 * N-67（`docs/232` §10）：**该用哪个包管理器**——`resolveRunner` 的对外出口。
 *
 * 验证门要在跑 build/lint 前确保依赖就位，需要与默认命令解析**同一条**判定
 * （`packageManager` 字段 → 唯一锁文件 → 回退 npm），否则会出现「默认命令用 pnpm、装依赖用 npm」
 * 这种自相矛盾的组合。
 */
export function packageRunnerFor(facts: PackageFacts): PackageRunner {
  return resolveRunner(facts, []);
}

/**
 * N-67：装依赖的命令。`frozen` 时要求锁文件精确匹配（npm 用 `ci`，其余用 `--frozen-lockfile`）。
 *
 * 三种形态都能通过 `isDependencyInstallCommand`（`install` / `ci` 都在安装动词表里），
 * 因此在获准的项目里会拿到 registry 网络。
 */
export function dependencyInstallCommand(runner: PackageRunner, frozen: boolean): string {
  if (runner === "npm") return frozen ? "npm ci" : "npm install";
  return frozen ? `${runner} install --frozen-lockfile` : `${runner} install`;
}

/**
 * 按探测事实解析某脚本的默认命令。仅当无 package.json 或脚本不存在时报错。
 */
export function planPackageScriptCommand(
  scriptName: string,
  facts: PackageFacts
): PackageCommandPlan {
  const warnings: string[] = [];
  if (!SCRIPT_NAME_PATTERN.test(scriptName)) {
    return {
      runner: "npm",
      warnings,
      error: "SCRIPT_NOT_FOUND",
      errorMessage: `invalid script name: ${scriptName}`
    };
  }
  if (!facts.hasPackageJson) {
    return {
      runner: "npm",
      warnings,
      error: "NO_PACKAGE_JSON",
      errorMessage: "package.json not found; cannot resolve default command"
    };
  }
  const value = facts.scripts[scriptName];
  if (typeof value !== "string") {
    return {
      runner: "npm",
      warnings,
      error: "SCRIPT_NOT_FOUND",
      errorMessage: `script "${scriptName}" not found in package.json`
    };
  }
  const runner = resolveRunner(facts, warnings);
  return { runner, command: buildRunnerCommand(runner, scriptName), warnings };
}

export const PackageFactsSchema = z.object({
  hasPackageJson: z.boolean(),
  packageManager: z.string().optional(),
  lockfiles: z.array(z.string()),
  scripts: z.record(z.string(), z.unknown())
});

/**
 * F2-2（FX-34）：构建/测试类工具的命令面收口——只接受「项目脚本」形态的命令：
 *   - `<npm|pnpm|yarn> [run] <script>`（+ 可选 `-- <透传参数>`）
 *   - `node --test ...`（项目测试文件运行器）
 * 任意命令串（shell 管道/重定向/连接/替换、node -e、bash -c、包管理器的 dlx/exec/install 等）
 * 一律拒绝（由 run_command 承载通用 shell；关键词扫描让位于允许清单）。
 */
const SCRIPT_NAME = /^[a-zA-Z][a-zA-Z0-9:_.-]*$/;
const RESERVED_RUNNERS: Record<string, Set<string>> = {
  pnpm: new Set([
    "add",
    "audit",
    "create",
    "deploy",
    "dlx",
    "exec",
    "import",
    "init",
    "install",
    "link",
    "list",
    "outdated",
    "patch",
    "prune",
    "publish",
    "rebuild",
    "remove",
    "setup",
    "store",
    "update",
    "why"
  ]),
  yarn: new Set([
    "add",
    "audit",
    "cache",
    "config",
    "create",
    "dlx",
    "exec",
    "import",
    "init",
    "install",
    "link",
    "npm",
    "pack",
    "plugin",
    "policies",
    "publish",
    "remove",
    "set",
    "unplug",
    "up",
    "upgrade",
    "why"
  ])
};

/** 引号外的 shell 语法检测（引号内允许通配/竖线等测试模式字符；命令替换始终拒绝）。 */
export function containsUnquotedShellSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "`" || char === "$") return true;
      else if (char === "\\") index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (";|&<>`$".includes(char) || char === "\n" || char === "\r") return true;
  }
  return quote !== null; // 未闭合引号
}

function scriptInvocationTarget(
  tokens: string[],
  runner: "npm" | "pnpm" | "yarn"
): string | undefined {
  const rest = tokens.slice(1);
  if (runner === "npm") {
    if (rest[0] === "test" || rest[0] === "start") {
      return trailingArgsAllowed(rest.slice(1)) ? rest[0] : undefined;
    }
    if (rest[0] !== "run") return undefined;
    const name = rest[1] ?? "";
    if (!SCRIPT_NAME.test(name)) return undefined;
    return trailingArgsAllowed(rest.slice(2)) ? name : undefined;
  }
  const name = rest[0] === "run" ? (rest[1] ?? "") : (rest[0] ?? "");
  if (!SCRIPT_NAME.test(name)) return undefined;
  if (RESERVED_RUNNERS[runner]?.has(name)) return undefined;
  const consumed = rest[0] === "run" ? 3 : 1;
  return trailingArgsAllowed(rest.slice(consumed)) ? name : undefined;
}

function isScriptInvocation(tokens: string[], runner: "npm" | "pnpm" | "yarn"): boolean {
  return scriptInvocationTarget(tokens, runner) !== undefined;
}

/** 脚本名之后：空，或 `--` 开头（透传参数；shell 语法已另行拒绝）。 */
function trailingArgsAllowed(rest: string[]): boolean {
  if (rest.length === 0) return true;
  return rest[0] === "--";
}

export function isScriptOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "" || containsUnquotedShellSyntax(trimmed)) return false;  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (head === "node") {
    if (tokens[1] === "--test") return true;
    // 项目脚本文件（frontend 约定 `node scripts/build.mjs`）：相对路径 + 脚本扩展名；
    // 旗标解释器形态（node -e / --eval / -p）、绝对路径与 `..` 逃逸一律拒绝。
    const path = tokens[1] ?? "";
    if (!/^(?!\/)(?!.*\.\.)[^\s]+\.(c|m)?js$/.test(path)) return false;
    return trailingArgsAllowed(tokens.slice(2));
  }
  if (head === "npm" || head === "pnpm" || head === "yarn") {
    return isScriptInvocation(tokens, head);
  }
  return false;
}

/**
 * `docs/236` §4.2：**命令分类**——只有装依赖拿得出网，其余一律留在无网沙箱。
 *
 * 规则刻意保守（原文：「宁可拒绝联网，也不放过拼接」）：
 *
 * 1. 含**引号外**的 shell 语法（`;` `|` `&` `<` `>` `` ` `` `$` 换行）或未闭合引号 ⇒ 不是
 *    install。这一条同时堵住 `&&` 串联、管道、命令替换，以及 `sh -c "pnpm install"` 的绕道
 *    （`sh` 的命令头本身不匹配）。
 * 2. 命令头必须是 `pnpm` / `npm` / `yarn`。
 * 3. 第一个子命令必须**恰好**是安装动词：`install` / `i` / `ci` / `add`。
 *
 * 拿不到网络时这些命令仍可运行——只是走离线 store；分类只决定**给不给 registry**，不改
 * 命令能否执行。
 */
export function isDependencyInstallCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "" || containsUnquotedShellSyntax(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0] ?? "";
  if (!INSTALL_RUNNERS.has(head)) return false;

  const sub = tokens[1] ?? "";
  return INSTALL_SUBCOMMANDS.has(sub);
}

const INSTALL_RUNNERS = new Set(["pnpm", "npm", "yarn"]);

/** 只认显式安装动词。`pnpm add` / `npm i` 是 alias，别名要覆盖；`update`/`upgrade` 不在此列。 */
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "ci", "add"]);

/**
 * N-57（`docs/232` §10）：**把「跑某个项目脚本」的命令解析成脚本名**。
 *
 * 与 `isScriptInvocation` 同一套保守规则（引号外 shell 语法一律拒绝、脚本名合法、
 * 不是包管理器的保留子命令、脚本名之后只允许 `--`）。解析不出/不合法 ⇒ `undefined`。
 */
export function scriptInvocationName(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === "" || containsUnquotedShellSyntax(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0] ?? "";
  if (head !== "npm" && head !== "pnpm" && head !== "yarn") return undefined;
  return scriptInvocationTarget(tokens, head);
}

/**
 * docs/255：Playwright / 浏览器二进制安装命令（不是 npm 依赖安装）。
 *
 * 包括 `playwright install chromium`、`npx playwright install`、
 * `pnpm exec playwright install`，以及 `npm run test:e2e:install` 这类脚本名。
 * 与 `isDependencyInstallCommand` 分开：命令头不是 pnpm/npm/yarn 的 install 动词，
 * 但同样需要更长超时；registry 网络对 CDN 无用，给不给由工具层决定。
 */
export function isPlaywrightBrowserInstallCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "" || containsUnquotedShellSyntax(trimmed)) return false;
  const script = scriptInvocationName(trimmed);
  if (script && /install/i.test(script) && /e2e|playwright|browser/i.test(script)) {
    return true;
  }
  const tokens = trimmed.split(/\s+/);
  const joined = tokens.join(" ");
  return /(?:^|\s)(?:npx|pnpm\s+exec|npm\s+exec|yarn\s+exec)\s+playwright(?:@[\w.-]+)?\s+install(?:\s|$)/i.test(
    joined
  ) || /(?:^|\s)playwright(?:@[\w.-]+)?\s+install(?:\s|$)/i.test(joined);
}

/**
 * N-57：**哪些脚本名可以跳过探测**。
 *
 * 这份清单**不是判定**，只省掉探测（每次探测要起一个容器）。判定权在 package.json 里那条
 * 脚本体本身（见 `commandTools.resolveCommandNetwork`）。
 *
 * 刻意用**黑名单**而不是白名单：F1 第二轮的 `deps` 脚本是 **agent 自己起的名字**
 * （夹具模板里并没有它），任何「猜得到安装脚本名」的白名单都会在下一次换个名字时静默失效
 * ——那正是 N-57 本身。代价只是给冷门脚本多跑一次探测；漏判的代价是安装静默离线，两者不对称。
 */
const NON_INSTALL_SCRIPT_NAMES = new Set([
  "test",
  "build",
  "lint",
  "dev",
  "start",
  "serve",
  "preview",
  "mock",
  "watch",
  "typecheck",
  "check",
  "format",
  "clean"
]);

export function shouldProbeScriptBody(scriptName: string): boolean {
  return !NON_INSTALL_SCRIPT_NAMES.has(scriptName);
}
