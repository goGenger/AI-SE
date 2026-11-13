import {
  isPathUnderPrefixes,
  isProjectManifestPath,
  isRootDeliveryArtifactPath,
  TaskType
} from "@ai-se/shared";
import { writePathsForTaskType } from "@ai-se/agent-core";

/**
 * F2-1（FX-29/30/31）：工作区写范围审计（确定性的按任务类型白名单，不新增规划字段）。
 *
 * - observe（默认）：越界只记录 + 告警 + `SCOPE_VIOLATION` 事件留痕，不覆盖任务结果；
 * - enforce：越界 → 验证失败（与防篡改同路径，走既有失败策略）——**启用前需 observe 数据齐备（FX-31）**；
 * - 变更取自 git：任务执行前后各取一次 `git status --porcelain`，「任务自身写入」= 新增/变化的条目
 *   （已脏且再次修改同一文件属已知盲区，v1 口径，见 docs/129）。
 * - 白名单稳定后可演进为规划阶段声明的 `touchedPaths`（与 T3a 合并）。
 */

export type WriteScopeMode = "off" | "observe" | "enforce";

export interface WriteScopeAudit {
  mode: WriteScopeMode;
  outcome: "passed" | "violation" | "skipped";
  checked: number;
  violations: string[];
  /** 任务自身写入的路径（审计输入，便于报告分布）。 */
  changedPaths: string[];
  /**
   * N-19（`docs/191`）：本 agent run **被写权限拒绝**的尝试数与路径。
   *
   * 与 `changedPaths` 是**互补的两个面**：审计是 diff 式的（`git status --porcelain` 前后比对），
   * 被拒的写入**不产生 diff**，故 `changedPaths` 结构上看不见它——而它恰恰是「平台自己的拒绝」，
   * 最不该被漏掉。数据取自 `tool_calls` 的 `input.denied = 'write'`（N-19 新增的结构化标记），
   * **不依赖 git**，故非 git 工作区同样可读。
   *
   * **只记录，不改变 `outcome`**：一次被拒写入不等于任务失败——实测 L1-M4m 全批有几十个
   * SUCCESS 任务带被拒写入，其中大量是 agent 框架自身的草稿路径（`conversation_history/`、
   * `large_tool_results/`），一刀切判失败会产生大面积误报（见 `docs/191` §2）。
   */
  deniedAttempts: number;
  deniedPaths: string[];
  reason?: string;
}

const TEST_PATH = [
  /^(tests?|__tests__|spec)\//,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_test\.[a-z0-9]+$/i
];
/**
 * PL-M10（`docs/168` §4 裁定 4）：工程清单/配置的判据**上移 `@ai-se/shared`**，与强制侧
 * （`AgentRegistry` 的 `writeProjectManifests` + `ToolRuntimeBackend`）共用同一份实现。
 *
 * 修前这里是**第二份定义**：正则表 `CONFIG_PATH` 早已把根级 `package.json` / `pnpm-lock.yaml`
 * / `tsconfig*.json` / `.gitignore` 判为 BACKEND 等实现类任务的**合法**写入，而强制侧的前缀
 * 白名单把它们全部拒绝——同一个仓库、同一时刻，一边说合法、一边说不合法。工程骨架任务因此
 * 写不出 `package.json`（L1-M4b run 1 在第一个任务上即致败）。「重复定义必然漂移」已由
 * `docs/160` 记为本仓库的缺陷成因类型，本次是它的第一个致败级实例。
 */
const CONFIG_PATH: ScopeRule[] = [isProjectManifestPath];
/**
 * PL-M11（`docs/170` §4 裁定 4）：仓库根**交付物**的判据同样上移 `@ai-se/shared`。
 *
 * 修前 `DEVOPS_PATH` 里那四条正则（`Dockerfile` / `docker-compose*.yml` / `.dockerignore` /
 * `README`）只挂在 `DEPLOY` 上，而计划把这两件事都派成了 `BACKEND` 任务：L1-M4c run 2 的
 * S4-10（「编写 Dockerfile … 保证 `docker build -t taskboard .` 成功」）与 S4-13（「编写
 * README …」）。强制侧无人能写仓库根，oracle 的容器段在仓库根跑不出构建上下文，
 * AC-24/25/26/29 四条 Must 全灭。
 */
const ROOT_DELIVERY: ScopeRule[] = [isRootDeliveryArtifactPath];
const DOC_PATH = [/^docs\//, /\.md$/i];
/** DOCS_GAP：仅 docs/ 前缀（README.md 走 ROOT_DELIVERY）；避免把任意 *.md 并进 BUILD。 */
const DOCS_DIR_PATH: ScopeRule[] = [/^docs\//];

/** 单条判据：正则，或来自 `@ai-se/shared` 的谓词（两侧共用一份实现）。 */
type ScopeRule = RegExp | ((path: string) => boolean);

function matchesAny(path: string, rules: ScopeRule[]): boolean {
  return rules.some((rule) => (typeof rule === "function" ? rule(path) : rule.test(path)));
}

const IMPLEMENTATION_TASK_TYPES: readonly TaskType[] = ["BACKEND", "FRONTEND", "DATABASE"];

/**
 * PL-M12（`docs/170` §4 裁定 7）：实现类任务的可写路径**取自对应 agent 的 `writePaths`**
 * （强制侧的**唯一**来源），而不是再手抄一张正则表。
 *
 * 修前这里是一张手抄的 `SOURCE_PATH`，它描述的是 `app/`（单数）、`pages/`、`lib/`、
 * `components/` 这类**本仓库并不存在**的布局，而本仓库的顶层是 `apps/` 与 `packages/`
 * （`AGENTS.md` §2）——于是它对真实路径一律误报越界（L1-M4c run 2 实测
 * `violations:["apps/"]`，而 `apps/` 是顶层应用目录）。
 *
 * `taskType === null` 取实现类并集，供**没有承接 agent** 的运行期类型（`DEBUG`）使用——
 * 它的目标类型由任务输入决定，审计侧看不到。
 */
function agentScope(taskType: TaskType | null): ScopeRule[] {
  const prefixes =
    taskType === null
      ? IMPLEMENTATION_TASK_TYPES.flatMap((type) => writePathsForTaskType(type) ?? [])
      : (writePathsForTaskType(taskType) ?? []);
  return [(path: string) => isPathUnderPrefixes(path, prefixes)];
}

/**
 * N-18（`docs/190` §2）：devops 的范围——**取自强制侧**，不再手抄正则。
 *
 * 修前这里是一张手抄的 `DEVOPS_PATH`，它把 `scripts/` / `bin/` / `.github/` / 根级 `*.ya?ml` /
 * `Makefile` 都算作 devops 的范围，而强制侧（`devops-agent.permissions.writePaths`）**一格都没有**
 * ——审计说合法、写层说非法，同一族漂移的第五例（前四例：PL-M5 / PL-M10 / PL-M11 / PL-M12）。
 * 实测代价：计划点名的 `scripts/verify-contract.mjs` **无人可写**，L1-M4m 的 run 1 / run 2 各有一条
 * 完整的 slice-1 TEST 链死在这里；run 2 里 `slice-1-task-8-REPLAN-1`（BUILD）的写入被拒后
 * **仍判 SUCCESS**。
 *
 * `DEPLOY` **没有承接 agent**（`writePathsForTaskType` 对它返回 `undefined`），但交付链与构建链
 * 动的是同一套文件（`Dockerfile` / compose / `scripts/` / CI 配置），故两者共用本组。
 * 根级交付物与工程清单由 `ROOT_DELIVERY` / `CONFIG_PATH` 分别并入，与本组并列。
 */
const DEVOPS_SCOPE: ScopeRule[] = agentScope("BUILD");

const SCOPE_RULES: Partial<Record<TaskType, ScopeRule[][]>> = {
  // QA 只可写测试目录（任务书 FX-29）。docs/261：writePaths 另含根目录 `.prettierignore`，
  // 审计必须与强制侧同源，否则 TEST 修好配置会在 observe 下被记成越界。
  TEST: [TEST_PATH, agentScope("TEST")],
  // 实现类：agent 写范围 + 配置 + 根交付物 + 测试文件（与 writeTestFiles 对齐；
  // AFC fixture：FRONTEND 修 tests/assembly 夹具时审计不得误报越界；断言改弱仍由 anti-tamper 拦）。
  BACKEND: [agentScope("BACKEND"), CONFIG_PATH, ROOT_DELIVERY, TEST_PATH],
  FRONTEND: [agentScope("FRONTEND"), CONFIG_PATH, ROOT_DELIVERY, TEST_PATH],
  DATABASE: [agentScope("DATABASE"), CONFIG_PATH, ROOT_DELIVERY, TEST_PATH],
  DEBUG: [agentScope(null), CONFIG_PATH, ROOT_DELIVERY, TEST_PATH],
  // PL-M12（12b）：`BUILD` 原先**没有条目**，落进默认组（`SOURCE_PATH` + 配置 + 测试），于是
  // devops-agent 的 `infrastructure/` 与 `Dockerfile` 一律被判越界。devops 的职责正是构建，
  // 故与 `DEPLOY` 同组。
  // DOCS_GAP（docs/253）：BUILD 还可写 docs/**（delivery-report 等）；README.md 已由 ROOT_DELIVERY 覆盖。
  BUILD: [DEVOPS_SCOPE, CONFIG_PATH, ROOT_DELIVERY, DOCS_DIR_PATH],
  // DEVOPS：Dockerfile、脚本、CI 配置、`infrastructure/`（+ 通用配置 + 根交付物）。
  DEPLOY: [DEVOPS_SCOPE, CONFIG_PATH, ROOT_DELIVERY],
  // 分析/设计：文档类。
  ANALYSIS: [DOC_PATH, CONFIG_PATH],
  DESIGN: [DOC_PATH, CONFIG_PATH]
};

function allowedGroups(taskType: TaskType): ScopeRule[][] {
  return SCOPE_RULES[taskType] ?? [agentScope(null), CONFIG_PATH, TEST_PATH, ROOT_DELIVERY];
}

/** 单路径是否在白名单内（供单测与报告使用）。 */
export function isPathInWriteScope(taskType: TaskType, path: string): boolean {
  const normalized = path.replace(/^\.\//, "").trim();
  return allowedGroups(taskType).some((group) => matchesAny(normalized, group));
}

/**
 * PL-M12：git porcelain 会把**整片未跟踪的目录**折叠成一行（`?? apps/`）。该行是**摘要**，
 * 不是一次写入——它只说明「这个目录是新的」，对「里面写了什么」零信息（里面的文件 git 根本没
 * 列出来，审计本来也看不到）。把它算作越界是纯粹的假阳性：L1-M4c run 2 实测
 * `violations:["apps/"]`，而 `apps/` 正是 `AGENTS.md` §2 规定的顶层应用目录。
 */
function isDirectorySummaryLine(path: string): boolean {
  return path.endsWith("/");
}

/**
 * F2-1：对「任务自身写入的路径集」做白名单审计。
 */
export function auditWriteScope(input: { taskType: TaskType; changedPaths: string[] }): {
  checked: number;
  violations: string[];
} {
  const changed = [...new Set(input.changedPaths.map((path) => path.replace(/^\.\//, "").trim()))]
    .filter((path) => path !== "")
    .sort();
  const violations = changed.filter(
    (path) => !isDirectorySummaryLine(path) && !isPathInWriteScope(input.taskType, path)
  );
  return { checked: changed.length, violations };
}

/** git status --porcelain 单行 → 路径（renames 取新路径，同时并入旧路径）。 */
export function parsePorcelainPath(line: string): string[] {
  const raw = line.replace(/^[ MADRCU?!]{1,2} /, "").trim();
  if (raw === "") return [];
  if (raw.includes(" -> ")) {
    const [from, to] = raw.split(" -> ");
    return [from.trim().replace(/^"|"$/g, ""), to.trim().replace(/^"|"$/g, "")];
  }
  return [raw.replace(/^"|"$/g, "")];
}

/** 任务自身写入 = after 有、before 无的 porcelain 行（行级比较，含状态变化）。 */
export function diffPorcelain(before: string, after: string): string[] {
  const beforeLines = new Set(
    before
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const paths = new Set<string>();
  for (const line of after
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    if (beforeLines.has(line)) continue;
    for (const path of parsePorcelainPath(line)) paths.add(path);
  }
  return [...paths].sort();
}

export const DEFAULT_WRITE_SCOPE_MODE: WriteScopeMode = "observe";
