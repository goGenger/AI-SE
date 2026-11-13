import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { redactEvidenceContent } from "@ai-se/evidence";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import { capPlaywrightWorkers, E2E_TEST_TIMEOUT_MS, inspectWorkspacePlaywright, playwrightContractMismatchReason, Sandbox } from "@ai-se/sandbox";
import {
  DEFAULT_CAPABILITY_PROFILE,
  JsonObject,
  Task,
  WorkflowRun,
  sliceAcKeys,
  taskAcKeys,
  type CapabilityProfile
} from "@ai-se/shared";
import {
  ToolCallRecorder,
  ToolExecutionContext,
  ToolResult,
  ToolRuntime,
  createPhase1Tools
} from "@ai-se/tool-runtime";
import { isFailureResolved, TaskExecutionResult } from "@ai-se/workflow-engine";
import { Logger } from "pino";
import {
  buildAcScopedTestCommand,
  buildAcTestFileProbeCommand,
  buildDependencyProbeCommand,
  buildProtectedContentCommand,
  buildProtectedSnapshotCommand,
  buildTestIdUsageScanCommand,
  changedProtectedFiles,
  detectTestOutputTruncation,
  digestText,
  effectiveCheckType,
  isDevTaskType,
  missingNativePackagesFromProbe,
  nativeDependencyHealCommand,
  parseAcResults,
  parseAcTestFileProbe,
  parseDependencyProbe,
  scopedCommandUsesNonCanonicalTestFiles,
  parseProtectedContents,
  classifyProtectedChanges,
  isProtectedTestPath,
  parseProtectedSnapshot,
  parseTestIdUsageScan,
  isRepairTaskForOfficialGates,
  resolveVerificationChecks,
  tailText,
  testIdContractViolations,
  withTestReporter,
  type AcScopingMode,
  type VerificationCheckName,
  type VerificationCheckPlan,
  type VerificationMode,
  type VerificationVerdict
} from "./taskVerifierRules";
import {
  buildPackageFactsProbeCommand,
  dependencyInstallCommand,
  packageRunnerFor,
  parsePackageFacts,
  planPackageScriptCommand,
  type PackageFacts
} from "@ai-se/tool-runtime";
import {
  auditWriteScope,
  diffPorcelain,
  type WriteScopeAudit,
  type WriteScopeMode
} from "./writeScopeAudit";
import {
  acceptanceTexts,
  buildServerSmokeCommand,
  businessRoutes,
  evaluateServerSmoke,
  extractHttpRoutes,
  parseServerSmokeOutput,
  SMOKE_BOOT_TIMEOUT_MS,
  SMOKE_COMMAND_TIMEOUT_MS,
  SMOKE_PROBE_TIMEOUT_MS,
  SMOKE_ROUTE_LIMIT,
  type ServerSmokeResult,
  type ServerSmokeVerdict
} from "./serverSmoke";
import {
  buildUiSmokeCommand,
  evaluateUiSmoke,
  extractContractTestIds,
  extractTestIds,
  parseUiSmokeOutput,
  staticTestIds,
  uiTestIdSkipReason,
  UI_SMOKE_BOOT_TIMEOUT_MS,
  UI_SMOKE_COMMAND_TIMEOUT_MS,
  UI_SMOKE_PROBE_TIMEOUT_MS,
  UI_SMOKE_SETTLE_MS,
  type UiSmokeResult,
  type UiSmokeVerdict
} from "./uiSmoke";
import {
  e2eBrowserPreflight,
  matchesPlaywrightEnvGap
} from "./e2eBrowserPreflight";
import {
  OFFICIAL_VISUAL_CHECK_NAME,
  OFFICIAL_VISUAL_COMMAND_TIMEOUT_MS,
  buildOfficialVisualCommand,
  buildVisualInventory,
  evaluateOfficialVisualIntent,
  isOfficialVisualFailureCode,
  isUiFacingVisualWork,
  officialVisualProjection,
  parseOfficialVisualOutput,
  resolveVisualAppScriptName,
  type OfficialVisualBaseline,
  type OfficialVisualFailureCode,
  type VisualIntentJudgeResult
} from "./officialVisualGate";

/**
 * C-3（T1）/ C-4（N4）确定性验证门：任务自报成功后，按其类型执行客观检查（经 Tool Runtime → Sandbox）——
 * TEST（qa）任务的测试检查为**红灯检查**（命令必须失败：空转测试被拦截；E-0：全部覆盖 AC 已有实现
 * 证据时翻转为绿灯回归验证，见 resolveCheckOutcome）；其余为绿灯验证。
 * 失败覆盖自报（enforce）/ 仅记录（observe）；含逐条 AC 结果与防篡改（受保护测试文件哈希比对）。
 * 证据经 @ai-se/evidence 单一脱敏 sink 后落 task.output.verification 与工作流事件。
 */

/** 任务 ↔ 检查工具映射（检查命令一律经 Tool Runtime 的既有检查工具进入沙箱）。 */
const CHECK_TOOL_BY_NAME: Record<VerificationCheckName, string> = {
  build: "run_build",
  test: "run_unit_test",
  lint: "run_lint",
  typecheck: "run_lint",
  "migrate-up": "run_command",
  "migrate-down": "run_command",
  "slice-boundary": "run_unit_test",
  "server-smoke": "run_command",
  "ui-smoke": "run_command",
  "testid-contract": "run_command",
  e2e: "run_unit_test",
  visual: "run_command"
};

const VERIFIER_TOOL_NAMES = new Set(["run_command", "run_build", "run_unit_test", "run_lint"]);

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

/** docs/256：切片末官方 E2E 超时（与沙箱 Playwright 测试超时一致）。 */
export const E2E_CHECK_TIMEOUT_MS = E2E_TEST_TIMEOUT_MS;

/**
 * docs/260：官方全量（无 AC 选取）`test` 检查超时。
 *
 * 不抬 `DEFAULT_CHECK_TIMEOUT_MS`：lint / typecheck / build 以及作用域
 * `--test-name-pattern` / 文件 glob 命令仍走 120s 预算（`acScopedTestTimeoutMs`）。
 * 也不抬工具 schema 的 120s 上限（防 agent 乱填）。官方 E2E 已用专用超时；
 * 全量 test 同样把预算放在运行时 context，不走 zod 入参。
 *
 * 取值 8 分钟：taskflow-vue 全量 Vitest 约 3–4 分钟（components 单段已约 113s，
 * 分段合计 quality+views/assembly ~77s + unit ~50s + components ~113s），
 * 官方门是一条未过滤命令，120s 不够；8 分钟约 2 倍实测墙钟，给单 CPU 沙箱
 * 和 verbose reporter 留余量，仍明显短于官方 E2E 的 10 分钟。
 */
export const FULL_SUITE_TEST_TIMEOUT_MS = 480_000;

/** 官方 test 检查用的命令超时：全量套件走 8 分钟，作用域命令仍走默认 120s。 */
export function officialTestCheckTimeoutMs(command: string): number {
  return isFullSuiteTestCommand(command) ? FULL_SUITE_TEST_TIMEOUT_MS : DEFAULT_CHECK_TIMEOUT_MS;
}

const E2E_SCRIPT_CANDIDATES = ["test:e2e", "e2e"] as const;

export function resolveSliceEndE2eScriptName(scripts: Record<string, unknown>): string | undefined {
  for (const name of E2E_SCRIPT_CANDIDATES) {
    if (typeof scripts[name] === "string") return name;
  }
  return undefined;
}

/** docs/255：未带 AC 选取（--test-name-pattern / 文件 glob）的全量测试命令。 */
export function isFullSuiteTestCommand(command: string | undefined): boolean {
  if (!command) return false;
  if (/--test-name-pattern\b|--testNamePattern\b|--grep\b/.test(command)) return false;
  // 作用域文件 glob（probeAcTestFiles 追加的 quoted test files）——带引号路径时不算全量。
  if (/'[^']+\.(test|spec)\.[a-z0-9]+'/i.test(command)) return false;
  return /(?:npm|pnpm|yarn)(?:\s+run)?\s+test\b/.test(command) || /\bvitest\b/.test(command);
}


/**
 * docs/255 / docs/260：全量套件超时不得单独打成 EVIDENCE_MISSING 或 VACUOUS_TEST；
 * 若作用域/分段证据已经点亮本任务 AC，则忽略这次全量超时。
 */
export function waiveFullSuiteTimeoutIfScopedAcsGreen(input: {
  checks: VerificationCheckEvidence[];
  acKeys: string[];
  acResults: Record<string, "passed" | "failed">;
}): void {
  const acKeys = input.acKeys.map(canonicalAcKey);
  const passedKeys = (results: Record<string, "passed" | "failed"> | undefined): Set<string> =>
    new Set(
      Object.entries(results ?? {})
        .filter(([, value]) => value === "passed")
        .map(([key]) => canonicalAcKey(key))
    );
  for (const check of input.checks) {
    if (check.passed || check.name !== "test") continue;
    if (!isFullSuiteTestCommand(check.command)) continue;
    if (
      !(
        check.timedOut ||
        check.failureCode === "CHECK_TIMEOUT" ||
        check.failureCode === "EVIDENCE_MISSING"
      )
    ) {
      continue;
    }
    const scopedGreen =
      acKeys.length > 0 && acKeys.every((key) => passedKeys(input.acResults).has(key));
    const selfGreen =
      acKeys.length > 0 && acKeys.every((key) => passedKeys(check.acResults).has(key));
    if (scopedGreen || selfGreen) {
      check.passed = true;
      check.failureCode = undefined;
      check.warnings = [
        ...(check.warnings ?? []),
        "full-suite timeout ignored because scoped/segmented AC evidence is green"
      ];
    } else if (check.failureCode === "EVIDENCE_MISSING" && check.timedOut) {
      check.failureCode = CHECK_TIMEOUT_FAILURE_CODE;
    }
  }
}


/**
 * F1-6（FX-20）：红灯检查失败诊断码——`VACUOUS_TEST`（证据可读：无实现时测试通过）与
 * `EVIDENCE_MISSING`（证据面缺失导致 fail-closed）。历史数据不回写；新批次按新码统计。
 *
 * N-13（PL-M20）：追加 `CHECK_TIMEOUT`——检查**没有返回**（超时），与「测试确实失败」不是一回事。
 * 此前两者同为裸 `checks failed: <name>`，于是「作用域内 AC 全过却被判失败」在批次账本上
 * 只能记成「验证门失败」，被反复误读为产物质量差。本码进既有的 `verificationFailureCodes`
 * 分布，**不改变 `failureLayers` 的分层**（任务级 errorType 仍是 `VERIFICATION_FAILED`）。
 */
export type VerificationFailureCode =
  | "VACUOUS_TEST"
  | "EVIDENCE_MISSING"
  | "CHECK_TIMEOUT"
  /** N-49：`start` 脚本起不来（进程退出 / 端口无响应）。 */
  | "BOOT_FAILED"
  /** N-49：进程活着，但切片 AC 里点名的业务路由**全部 404**（路由没挂上）。 */
  | "SURFACE_UNMOUNTED"
  /** `docs/233` §5.2：UI 冒烟——页面起不来（预览进程退出 / 首页不可达）。 */
  | "PAGE_UNREACHABLE"
  /** `docs/233` §5.2：页面 200，但 AC 点名的 testid **一个都不在页面上**（`SURFACE_UNMOUNTED` 的 UI 版）。 */
  | "SURFACE_MISSING"
  /** `docs/233` §5.2：元素挂上了，但载入期间控制台有 error。 */
  | "CONSOLE_ERROR"
  /** N-64（`docs/232` §10）：源码里出现了需求没声明过的 testid（命名契约被自创）。 */
  | "TESTID_CONTRACT_VIOLATION"
  /**
   * N-67（`docs/232` §10）：**工作区缺依赖**，检查跑不起来。
   *
   * 与「代码不合格」必须分开：第七轮 `sh: 1: vite: not found` 被记成 `VERIFICATION_FAILED`，
   * 于是 REPLAN 派 DEBUG 任务去"修代码"，三次同一堵墙——而那份源码在装完依赖后 oracle 24/24。
   */
  | "DEPENDENCIES_MISSING"
  /**
   * docs/254：Playwright / Chromium 浏览器二进制缺失（ENV_GAP）。
   * 与 npm 依赖缺失分开——不得再派 FRONTEND 空烧 REPLAN。
   */
  | "ENV_GAP"
  /**
   * 任务有 AC 作用域，但当前 test runner 构造不出 command-filter（如裸 jest）。
   * 拒绝静默退回全量套件（result-filter）——仓库一大就会 CHECK_TIMEOUT。
   */
  | "AC_SCOPE_UNSUPPORTED"
  /**
   * docs/262：官方 AC 文件探测未落到正规测试根（tests/ / test/ / __tests__/ / e2e），
   * 或作用域命令只会跑嵌套残留 / 非项目树。这是探测/配置失败，不得再派同一类型 TEST 空烧。
   */
  | "PROBE_FAILURE"
  /** docs/265：UI 向需求缺少可用视觉基线，官方视觉审查不得静默跳过。 */
  | "VISUAL_BASELINE_MISSING"
  /** docs/265：规定关键态未能在运行中的应用里打开。 */
  | "VISUAL_STATE_UNREACHABLE"
  /** docs/265：关键态露出组件库默认皮肤（例如默认日期面板插画/超大箭头）。 */
  | "VISUAL_DEFAULT_SKIN"
  /** docs/265：与已挂视觉基线的设计意图明显不符。 */
  | "VISUAL_INTENT_MISMATCH"
  /** docs/265：未能在跑起来的应用里完成官方截图（禁止 file://）。 */
  | "VISUAL_CAPTURE_FAILED"
  /** docs/265：没有完成确定性对照，不能把视觉项标绿。 */
  | "VISUAL_JUDGE_UNAVAILABLE";


/** docs/262：作用域命令构造失败时区分「runner 不支持」与「探测只有垃圾路径」。 */
function acScopeCommandFailure(input: {
  name: VerificationCheckName;
  expected: "pass" | "fail";
  baseCommand: string;
  acKeys: string[];
  probedTestFiles?: string[];
  commitSha?: string;
}): VerificationCheckEvidence {
  const probedEmpty = Array.isArray(input.probedTestFiles) && input.probedTestFiles.length === 0;
  const reason = probedEmpty
    ? "AC file probe found no canonical test files under tests/, test/, __tests__/ or e2e/; refusing to run leftover or non-project paths"
    : "AC scope present but cannot build command-level test filter for this runner; refusing full-suite result-filter fallback";
  return {
    name: input.name,
    command: input.baseCommand,
    expected: input.expected,
    passed: false,
    exitCode: null,
    timedOut: false,
    attempts: [],
    flaked: false,
    outputDigest: digestText(reason),
    stdoutTail: "",
    stderrTail: reason,
    durationMs: 0,
    failureCode: probedEmpty ? "PROBE_FAILURE" : "AC_SCOPE_UNSUPPORTED",
    scopedAcKeys: [...input.acKeys],
    ...(input.commitSha ? { commitSha: input.commitSha } : {})
  };
}

/** N-13（PL-M20）：检查未返回（超时）的诊断码。 */
export const CHECK_TIMEOUT_FAILURE_CODE = "CHECK_TIMEOUT" satisfies VerificationFailureCode;

export interface VerificationCheckAttempt {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface VerificationCheckEvidence {
  name: VerificationCheckName;
  command: string;
  /** 期望结果（pass = 绿灯验证；fail = 红灯检查）。 */
  expected: "pass" | "fail";
  /** 期望是否达成（红灯检查下 = 命令确实失败）。 */
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  attempts: VerificationCheckAttempt[];
  flaked: boolean;
  outputDigest: string;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** 测试检查：全量输出按测试名中 AC 编号解析出的逐条结果（供 N5）。 */
  acResults?: Record<string, "passed" | "failed">;
  /**
   * F1-6（FX-20）：红灯检查失败的诊断码——`VACUOUS_TEST`（证据可读：无实现时测试通过）
   * 与 `EVIDENCE_MISSING`（证据面缺失导致 fail-closed）。仅红灯失败时出现；历史数据不回写。
   */
  failureCode?: VerificationFailureCode;
  /**
   * PL-M18（N-10）(c)：红灯判 `VACUOUS_TEST` 时，**缺实现证据**的作用域 AC 编号。
   * 改动前 reason 与记录都只写检查名（`test`），生产日志看不出是哪个 AC 把判定拖死。
   */
  uncoveredAcKeys?: string[];
  /**
   * N-55（`docs/232` §9.27）：输出被沙箱截断（只保留最后 96KB），作用域覆盖**无法判定**——
   * 本次按命令退出码裁决。没有这条的话，「排在前面的用例被丢掉」会被读成「这些 AC 没有覆盖」。
   */
  coverageTruncated?: boolean;
  /** F1-5（FX-18）：证据对应的 Git commit（验证时工作区 HEAD；不可得时缺省）。 */
  commitSha?: string;
  /** F1-5（FX-16/17）：本检查的 AC 作用域（任务级 / 切片边界；缺省 = 未作用域）。 */
  scopedAcKeys?: string[];
  /** F1-5：作用域实现方式（command-filter = `--test-name-pattern` 真选取；result-filter = 全量 + 结果面选取）。 */
  scopingMode?: AcScopingMode;
  /** F1-7（FX-25）：探测告警（如多锁文件并存按固定顺序选择）。 */
  warnings?: string[];
  /** N-49：真实进程冒烟证据（起进程 + 按切片 AC 点名的路由打 HTTP 的结果）。 */
  smoke?: {
    routes: string[];
    booted: boolean;
    detectedPort?: number;
    controlStatus?: number | null;
    probes: Array<{ route: string; status: number | null; error?: string }>;
    processStderrTail?: string;
    detail?: string;
  };
  /** `docs/233` §5.2：UI 边界冒烟证据（起预览 + 真浏览器按 AC 点名的 testid 断言 DOM）。 */
  ui?: {
    testIds: string[];
    present: string[];
    pageStatus: number | null;
    /** `unavailable` = 工作区里没有可用的浏览器，DOM 这一步**没跑**（跳过已留痕）。 */
    browser: "playwright" | "unavailable";
    consoleErrors: string[];
    browserError?: string;
    processStderrTail?: string;
    detail?: string;
    /** N-71：mock 是否起来了；没起来时页面首屏必然在错误态。 */
    mockBooted?: boolean;
    /** N-71：按 mock 端口重建的退出码（`null` = 超时被中止）。 */
    buildExitCode?: number | null;
  };
  /**
   * docs/265：切片末官方视觉审查证据（运行中的应用 + 关键态截图 + 设计意图对照）。
   * 像素热力图 / 差分比若出现也只是辅助，不单独作为通过条件。
   */
  visual?: Record<string, unknown>;
}

export interface ProtectedSnapshot {
  files: Map<string, string>;
  /**
   * N-14（`docs/189` §4.1）：受保护文件的**内容**（`null` = 读取失败或超过上限）。
   * 缺省 = 未采集。docs/259：内容不可证不再判为改弱，记入 `unread` 或跳过判定。
   */
  contents?: Map<string, string | null>;
  error?: string;
}

export interface TaskVerificationRecord {
  mode: VerificationMode;
  verdict: VerificationVerdict;
  verified: boolean;
  taskType: string;
  reason?: string;
  /**
   * PL-M9 9a：本类型**有**候选检查、但工作区缺对应 script 的检查名（检查因此无法判定）。
   * 与「本类型没有客观检查」（ANALYSIS/DESIGN/REVIEW，字段缺省）是两件事——前者是证据面缺失。
   * 9c：TEST 任务落到这一情形时判 `failed` + `EVIDENCE_MISSING`（不可裁决 → fail-closed）。
   */
  missingChecks?: VerificationCheckName[];
  /**
   * PL-M40 后续观测：切片边界检查**为什么没跑**。原因码：`no-workflow-tasks-dependency` /
   * `no-slice-key` / `no-test-script` / `load-tasks-failed` / `siblings-unfinished:<key:status,...>` /
   * `no-ac-keys`。**只观测、不参与判定**；`checks` 里出现 `slice-boundary` 时本字段缺省。
   */
  boundarySkipped?: string;
  /**
   * N-49（`docs/232` §9.14）：真实进程冒烟**为什么没跑**。原因码：`no-start-script` / `no-routes` /
   * `ONLY_PARAMETERIZED_ROUTES` / `BOOT_ENV_UNRESOLVED` / `PROBE_ERROR`。只观测、不参与判定。
   */
  smokeSkipped?: string;
  /**
   * N-64（`docs/232` §10）：testid 命名契约检查**为什么没跑**。原因码：
   * `no-requirement-text` / `no-contracted-testids` / `PROBE_ERROR` / `boundary-check-disabled`。
   * 只观测、不参与判定（没有契约文本就没有判据）。
   */
  testIdContractSkipped?: string;
  /**
   * docs/265：官方视觉审查为什么没跑。原因码：`not-ui-facing` /
   * `no-visual-baselines-loader`。只观测、不参与判定。UI 向需求缺基线不会走这里，
   * 而是留下失败的 `visual` 检查（`VISUAL_BASELINE_MISSING`）。
   */
  visualSkipped?: string;
  /**
   * N-67（`docs/232` §10）：检查**之前**确保依赖就位的结果。
   * 只有真的缺依赖并尝试过安装时才出现；`ok: false` 时 `VERIFICATION_FAILED` 会被改判为
   * `DEPENDENCIES_MISSING`。
   */
  dependencyInstall?: {
    attempted: boolean;
    ok: boolean;
    command?: string;
    reason?: string;
  };
  /**
   * N-47（`docs/232` §9.11）：**没有参与判定**的检查及原因码。目前唯一的一种是
   * `test` + `NO_AC_SCOPE`——dev 任务自身没有声明 acKeys、却能通过 PL-M8 的兜底拿到本切片 AC 并集。
   * 那种兜底让逐任务的绿灯测试无从界定范围：整片测试由先行的 TEST 任务一次写完，中间的实现任务
   * 不可能独自点亮整组 AC（实测：仓库层任务被建任务的测试判死，DEBUG/REPLAN 五次同一命令）。
   * 这些任务的绿灯职责由 `build` 与切片边界检查承担；本字段只留痕，不参与判定。
   */
  skippedChecks?: Array<{ name: VerificationCheckName; reason: "NO_AC_SCOPE" }>;
  /** F1-6（FX-20）：红灯失败诊断码（多样本时取唯一值；混合时缺省）。 */
  failureCode?: VerificationFailureCode;
  checks: VerificationCheckEvidence[];
  acResults?: Record<string, "passed" | "failed">;
  acSummary?: { total: number; passed: number; failed: number };
  antiTamper?: {
    verdict: "passed" | "failed" | "skipped";
    /** 哈希比对得出的「已变化」受保护文件（改动前在快照里、改动后哈希不同或已消失）。 */
    changed?: string[];
    /**
     * N-14 / docs/259：`changed` 中**改弱**的子集（既有断言行消失，或文件被删除）。
     * **只有它非空才判 failed**——「纯增量」记 `passed` 但保留 `changed` 作为证据。
     * 内容读不到的路径进 `unread`，不判 failed。
     */
    weakened?: string[];
    unread?: string[];
    reason?: string;
  };
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** F1-5（FX-18）：本次验证证据对应的 Git commit（工作区 HEAD；非 git 工作区缺省）。 */
  commitSha?: string;
  /** F2-1（FX-29/30）：写范围审计结果（observe/enforce；off 或缺省时不出现在记录中）。 */
  writeScope?: WriteScopeAudit;
}

export interface VerificationEventSink {
  create(input: {
    workflowRunId: string;
    taskId?: string;
    agentRunId?: string;
    eventType: string;
    payload: JsonObject;
  }): Promise<unknown>;
}

export interface TaskVerifierDependencies {
  sandbox: Sandbox;
  mode: VerificationMode;
  toolCalls?: ToolCallRecorder;
  events?: VerificationEventSink;
  logger?: Logger;
  /** 单条检查命令的沙箱超时（lint/typecheck/build 与作用域 test 默认 120s；官方全量 test 走 FULL_SUITE_TEST_TIMEOUT_MS；Playwright 安装走 ENV_GAP_INSTALL_TIMEOUT_MS）。 */
  timeoutMs?: number;
  /** E-0：红灯期望解析——读取同工作流运行时任务（切片边界检查仍使用）；缺省时保守保持原语义（fail-closed）。 */
  workflowTasks?: (workflowRunId: string) => Promise<Task[]>;
  /**
   * G1（GX-01/02）：红灯翻转的实现证据面——同需求全部运行时任务（跨切片 / 跨 run / 跨批次）。
   * 缺省时翻转不可裁决（fail-closed → EVIDENCE_MISSING）。
   */
  requirementTasks?: (requirementId: string) => Promise<Task[]>;
  /**
   * N-64（`docs/232` §10）：**需求原文**——testid 命名契约的来源。
   *
   * 缺省（或取不到内容）时 `testid-contract` 检查跳过并留痕，**不判交付缺陷**：没有契约文本就没有
   * 判据，宁可少判也不凭空判死。
   */
  requirementText?: (requirementId: string) => Promise<string | undefined>;
  /**
   * docs/265：官方视觉基线（需求上已挂的 UI 图）。生产路径从 `UI_REFERENCE` 文档读取。
   * 依赖缺省时本检查不跑（与未装配 workflowTasks 时不跑边界检查同口径，避免打坏既有单测）。
   * 依赖已装配但返回空：UI 向需求记 `VISUAL_BASELINE_MISSING`，不得静默跳过。
   */
  visualBaselines?: (requirementId: string) => Promise<OfficialVisualBaseline[]>;
  /**
   * 可选设计意图判断器。未配置时只跑确定性层，不得假装 VLM 已对照通过。
   */
  visualIntentJudge?: (input: {
    baselines: OfficialVisualBaseline[];
    capture: unknown;
  }) => Promise<VisualIntentJudgeResult>;
  /**
   * F2-1（FX-29/30/31）：写范围审计（observe 默认；enforce 启用前需 observe 数据齐备）。
   * `blockedCommandAttempts`：该 agent run 被策略拦截的命令次数（用于 POLICY_EVASION_SUSPECTED）。
   * `deniedWriteAttempts`（N-19，`docs/191`）：该 agent run 被**写权限**拒绝的尝试数与路径——
   * 与 `blockedCommandAttempts` 是**两条不同的通道**（后者匹配 `"blocked"`，写权限拒绝的消息是
   * `Path is not writable:`），故并列而非合并。缺省时按 0 计（不阻塞验证）。
   */
  /**
   * `docs/235` §4.3：**能力 profile**——切片边界门用哪一种（`boundaryCheck`）。
   * 缺省 `backend-node`（`server`）⇒ 既有行为一字不改；`frontend-vue` 走 `ui`。
   */
  profile?: CapabilityProfile;
  writeScope?: {
    mode: WriteScopeMode;
    blockedCommandAttempts?: (agentRunId: string) => Promise<number>;
    deniedWriteAttempts?: (
      agentRunId: string
    ) => Promise<{ attempts: number; paths: string[] }>;
  };
}

/** AC 键规范化（前缀大写 + 数字去零），用于跨来源比较（AC-01 ≡ AC-1 ≡ ac-01）。 */
function canonicalAcKey(key: string): string {
  const match = /^([A-Za-z]{2,})-(\d+)$/.exec(key.trim());
  if (!match) return key;
  return `${match[1].toUpperCase()}-${String(Number(match[2]))}`;
}

/** 任务对 AC 的覆盖证据：input.acKeys 计划覆盖，或 verification.checks[].acResults 实测通过。 */
function taskCoversAc(task: Task, acKey: string): boolean {
  const canonical = canonicalAcKey(acKey);
  const planned = task.input.acKeys;
  if (
    Array.isArray(planned) &&
    planned.some((entry) => canonicalAcKey(String(entry)) === canonical)
  ) {
    return true;
  }
  const verification = toObject(task.output?.verification);
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  return checks.some((entry) => {
    const acResults = toObject(toObject(entry).acResults);
    return Object.entries(acResults).some(
      ([key, value]) => value === "passed" && canonicalAcKey(key) === canonical
    );
  });
}

/**
 * G1（GX-03）：红灯翻转的作用域键——任务声明的 acKeys 与解析结果按规范键相交；
 * 无声明 / 无交集时回退全量解析键（保持既有语义；与 F1-5 result-filter 同族）。
 */
/**
 * 红灯检查的作用域键。
 * 1. 任务自己声明的 `acKeys` ∩ 解析键（F1-5 result-filter / G1-B 既有行为，逐字不变）；
 * 2. 无可用锚点时，回退到**本任务所在切片**声明过的 AC ∩ 解析键（PL-M18 / N-10）；
 * 3. 再否则回退全量解析键（既有兜底，保留）。
 *
 * PL-M18 / N-10：改动前第 3 条是唯一兜底，而解析键来自**全量测试套件**——套件里任何一条标题
 * 带 `[XX-nn]` 记号（`BRACKETED_MARKER_PATTERN`）都会进入作用域，其中不属于本切片的键既没有
 * 实现证据、也永远不会有 ⇒ `acKeys.every(...)` 恒假 ⇒ `VACUOUS_TEST` 恒成立，与 agent 产出无关。
 * 实测（L1-M4i run 1 的 `T10`）：作用域 5 键全部 passed，唯一阻塞键是 `FR-06`——一个由测试标题
 * 里的 FR 编号解析出来的键，本需求**没有任何任务声明过它**。而仓库自己的 AC-30 契约测试**要求**
 * 标题带 `FR-x.y/AC-xx` 记号，两条规则互相打架。第 2 条把作用域收回本切片，同时保留
 * 「本切片的 AC 没有实现证据即判空转」的原意（该原意由反向对照用例守护）。
 *
 * 第 2 条**只在任务确实带 `sliceKey` 时启用**——无切片信息时行为与改动前逐字相同。
 */
function scopedEvidenceKeys(
  task: Task,
  parsedKeys: string[],
  requirementTasks: Task[]
): string[] {
  const declared = task.input.acKeys;
  if (Array.isArray(declared)) {
    const scope = new Set(
      declared
        .filter((key): key is string => typeof key === "string")
        .map((key) => canonicalAcKey(key))
    );
    if (scope.size > 0) {
      const scoped = parsedKeys.filter((key) => scope.has(canonicalAcKey(key)));
      return scoped.length > 0 ? scoped : parsedKeys;
    }
  }
  const sliceKey = task.sliceKey;
  if (typeof sliceKey === "string" && sliceKey.length > 0) {
    const scope = sliceDeclaredAcKeys(requirementTasks, sliceKey);
    if (scope.size > 0) {
      const scoped = parsedKeys.filter((key) => scope.has(canonicalAcKey(key)));
      if (scoped.length > 0) return scoped;
    }
  }
  return parsedKeys;
}

/** PL-M18 / N-10：同一需求内、同一 `sliceKey` 的任务声明过的 AC 键（规范化）。 */
function sliceDeclaredAcKeys(requirementTasks: Task[], sliceKey: string): Set<string> {
  const scope = new Set<string>();
  for (const entry of requirementTasks) {
    if (entry.sliceKey !== sliceKey) continue;
    const declared = entry.input.acKeys;
    if (!Array.isArray(declared)) continue;
    for (const key of declared) {
      if (typeof key === "string") scope.add(canonicalAcKey(key));
    }
  }
  return scope;
}

/**
 * docs/260：汇总红灯失败的 reason / 记录级 failureCode。
 *
 * 历史实现把「不是 EVIDENCE_MISSING」的红灯全部算进 VACUOUS_TEST 桶，
 * 于是 `expected: "fail"` 的官方 test 一旦超时（failureCode 已是 CHECK_TIMEOUT），
 * 总原因仍被写成「red-light check passed without implementation (VACUOUS_TEST)」。
 * 超时必须只保留 CHECK_TIMEOUT；真正的空转（命令成功退出且无实现证据）仍是 VACUOUS_TEST。
 */
export function summarizeRedLightFailures(redLight: VerificationCheckEvidence[]): {
  reason: string;
  failureCode?: VerificationFailureCode;
} {
  const codeOf = (check: VerificationCheckEvidence): VerificationFailureCode =>
    check.failureCode ?? (check.timedOut ? CHECK_TIMEOUT_FAILURE_CODE : "VACUOUS_TEST");

  const vacuous = redLight.filter((check) => codeOf(check) === "VACUOUS_TEST");
  const missing = redLight.filter((check) => codeOf(check) === "EVIDENCE_MISSING");
  const timedOut = redLight.filter((check) => codeOf(check) === "CHECK_TIMEOUT");
  const other = redLight.filter((check) => {
    const code = codeOf(check);
    return code !== "VACUOUS_TEST" && code !== "EVIDENCE_MISSING" && code !== "CHECK_TIMEOUT";
  });
  const names = (checks: VerificationCheckEvidence[]): string =>
    checks.map((check) => check.name).join(", ");
  const uncoveredNames = [
    ...new Set(vacuous.flatMap((check) => check.uncoveredAcKeys ?? []))
  ].join(",");
  const vacuousDetail = uncoveredNames
    ? `${names(vacuous)} (uncovered: ${uncoveredNames})`
    : names(vacuous);
  const missingNames = names(missing);

  let reason: string;
  if (timedOut.length === 0 && other.length === 0) {
    if (vacuous.length > 0 && missing.length > 0) {
      reason = `red-light check failed (VACUOUS_TEST: ${vacuousDetail}; EVIDENCE_MISSING: ${missingNames})`;
    } else if (vacuous.length > 0) {
      reason = `red-light check passed without implementation (VACUOUS_TEST): ${vacuousDetail}`;
    } else {
      reason = `red-light check not adjudicable (EVIDENCE_MISSING): ${missingNames}`;
    }
  } else if (timedOut.length > 0 && vacuous.length === 0 && missing.length === 0 && other.length === 0) {
    reason = `red-light check timed out (CHECK_TIMEOUT): ${names(timedOut)}`;
  } else {
    const bits: string[] = [];
    if (vacuous.length > 0) bits.push(`VACUOUS_TEST: ${vacuousDetail}`);
    if (missing.length > 0) bits.push(`EVIDENCE_MISSING: ${missingNames}`);
    if (timedOut.length > 0) bits.push(`CHECK_TIMEOUT: ${names(timedOut)}`);
    for (const check of other) {
      bits.push(`${codeOf(check)}: ${check.name}`);
    }
    reason = `red-light check failed (${bits.join("; ")})`;
  }

  const codes = new Set(redLight.map((check) => codeOf(check)));
  return {
    reason,
    ...(codes.size === 1 ? { failureCode: [...codes][0] } : {})
  };
}

/** 与执行器一致的工作区解析：任务输入优先，其次工作流输入。 */
export function resolveTaskWorkspace(workflow: WorkflowRun, task: Task): string {
  const taskPath = task.input.workspacePath;
  const workflowPath = workflow.input.workspacePath;
  if (typeof taskPath === "string" && taskPath.length > 0) return taskPath;
  if (typeof workflowPath === "string" && workflowPath.length > 0) return workflowPath;
  return process.cwd();
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function outputField(result: ToolResult, key: string): unknown {
  if (result.success) return toObject(result.data)[key];
  return toObject(result.error?.details)[key];
}

function outputText(result: ToolResult, key: "stdout" | "stderr"): string {
  const value = outputField(result, key);
  return typeof value === "string" ? value : "";
}

/**
 * PL-M2（`docs/158` §3）：交付链任务（带 `delivery` 块）——由 `DeliveryOrchestrator` 执行
 * （CI / DEPLOY / ROLLBACK / VERIFY，见其 `canHandle`），**不经过本验证门**，故不能作切片边界锚点。
 */
function hasDeliveryBlock(task: Task): boolean {
  const delivery = task.input.delivery;
  return typeof delivery === "object" && delivery !== null;
}

// `taskAcKeys` / `sliceAcKeys` 已上移到 `@ai-se/shared`（N-40：任务提示词与校验器
// 必须用同一份「切片 AC 范围」定义，否则两处必然漂移）。


const MAX_PROTECTED_CONTENT_CHARS = 262_144;

/**
 * docs/259：从宿主机工作区直接读取受保护测试文件内容，避开沙箱 stdout 96KB 上限。
 * 工作区目录不存在，或指定路径在磁盘上一个都找不到时返回 `undefined`，让调用方回退沙箱命令
 * （单测 FakeSandbox 没有真实工作区文件）。
 */
export function readProtectedContentsFromWorkspace(
  workspacePath: string,
  paths?: readonly string[]
): Map<string, string | null> | undefined {
  let root: string;
  try {
    if (!workspacePath || !statSync(workspacePath).isDirectory()) return undefined;
    root = path.resolve(workspacePath);
  } catch {
    return undefined;
  }
  const targets = (paths ?? []).map((relPath) => relPath.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (targets.length === 0) return undefined;
  const contents = new Map<string, string | null>();
  let found = 0;
  for (const relPath of targets) {
    if (!relPath || relPath.includes("..") || !isProtectedTestPath(relPath)) continue;
    const absolute = path.resolve(root, relPath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      if (!existsSync(absolute)) {
        contents.set(relPath, null);
        continue;
      }
      found += 1;
      const text = readFileSync(absolute, "utf8");
      contents.set(relPath, text.length <= MAX_PROTECTED_CONTENT_CHARS ? text : null);
    } catch {
      contents.set(relPath, null);
    }
  }
  return found > 0 ? contents : undefined;
}

export class TaskVerifier {
  private readonly logger: Logger;
  private readonly runtime: ToolRuntime;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: TaskVerifierDependencies) {
    this.logger = dependencies.logger ?? createLogger();
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.runtime = new ToolRuntime({
      tools: createPhase1Tools().filter((tool) => VERIFIER_TOOL_NAMES.has(tool.name))
    });
  }

  /** 受保护测试文件哈希快照（dev 类任务执行前后各一次；失败以 error 说明，不抛出）。 */
  async snapshotProtectedFiles(
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<ProtectedSnapshot> {
    const result = await this.runTool(
      "run_command",
      { command: buildProtectedSnapshotCommand(), timeoutMs: 60_000 },
      { task, workspacePath, agentRunId, checkName: "protected-snapshot" }
    );
    if (!result.success) {
      return {
        files: new Map(),
        error: result.error?.message ?? "protected snapshot command failed"
      };
    }
    const files = parseProtectedSnapshot(outputText(result, "stdout"));
    return {
      files,
      contents: await this.snapshotProtectedContents(workspacePath, task, agentRunId, [
        ...files.keys()
      ])
    };
  }

  /**
   * N-14 / docs/259：受保护文件的**内容**快照——改弱判定的证据面。
   * 优先从宿主机工作区直接读（避开沙箱 96KB stdout 上限）；读不到再回退到沙箱命令。
   * 传入 `paths` 时只读这些文件（哈希比对后的变更集）。采不到返回 `undefined`。
   *
   * 这里必须自带 try/catch：`ToolRuntime` 没有兜底 catch，沙箱抛出的异常会一路上抛，
   * 而内容快照只是**附加证据**——它失败绝不能让整个验证变成 `unavailable`。
   */
  private async snapshotProtectedContents(
    workspacePath: string,
    task: Task,
    agentRunId?: string,
    paths?: readonly string[]
  ): Promise<Map<string, string | null> | undefined> {
    const host = readProtectedContentsFromWorkspace(workspacePath, paths);
    if (host) return host;
    try {
      const result = await this.runTool(
        "run_command",
        { command: buildProtectedContentCommand(paths), timeoutMs: 60_000 },
        { task, workspacePath, agentRunId, checkName: "protected-content" }
      );
      if (!result.success) return undefined;
      const raw = outputText(result, "stdout");
      const parsed = parseProtectedContents(raw);
      // 截断后的 JSON 解析失败会得到空 Map，不能当成「已采集」。
      if (parsed.size === 0 && (paths?.length ?? 0) > 0) return undefined;
      if (parsed.size === 0 && raw.trim() !== "{}" && raw.trim() !== "") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async verify(input: {
    workflow: WorkflowRun;
    task: Task;
    result: TaskExecutionResult;
    before?: ProtectedSnapshot;
    /** F2-1：任务执行前的 git 状态快照（写范围审计基线；由包装层捕获）。 */
    scopeBefore?: { porcelain: string };
    /**
     * 生效的验证模式（自治 L1 下包装层按工作流取 enforce）。缺省 = 构造时的模式。
     * 只影响记录的 `mode` 字段——判定分支在包装层，本方法不做 observe/enforce 区分。
     */
    mode?: VerificationMode;
  }): Promise<TaskVerificationRecord> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const { workflow, task, result } = input;
    const workspacePath = resolveTaskWorkspace(workflow, task);
    const agentRunId = result.agentRunId;

    const facts = await this.probePackageFacts(workspacePath, task, agentRunId);
    // F1-5（FX-18）：证据 commit 归属——工作区 HEAD（best-effort；非 git 工作区缺省，不影响验证）。
    const commitSha = await this.probeCommitSha(workspacePath, task, agentRunId);
    // N-15′：DEBUG 任务派发到**目标类型**的 agent（`AgentRegistry.ts:318-319`）⇒ 该受目标类型的
    // 检查。`effectiveCheckType` 对非 DEBUG 任务恒等于 `task.type`，对目标缺失的 DEBUG 回落到 DEBUG
    // （= 今天的行为）。红/绿灯语义仍在 `resolveVerificationChecks` 里按 `task.type` 判定。
    const plan = resolveVerificationChecks(
      task.type,
      facts.scripts,
      effectiveCheckType(task.type, task.input.targetTaskType),
      // `docs/235` §6.5：检查候选来自本进程的能力 profile（缺省 `backend-node`，零行为变化）。
      this.dependencies.profile,
      // docs/261：REPLAN / DYNAMIC 修复任务不得再用红灯「期望失败」把仍红的 AC 判成 verified。
      { officialTestExpectsPass: isRepairTaskForOfficialGates(task) }
    );
    // N-47（`docs/232` §9.11）：dev 任务自身没有 acKeys → 不跑逐任务的绿灯 `test` 检查。
    // 此前它按「本切片 AC 并集」兜底，于是仓库层任务被 API 任务的测试判死（且 DEBUG/REPLAN 全部继承
    // 同一份空 acKeys、反复跑同一条命令）。没有 AC 的任务本来就不声称交付某条 AC，绿灯交给
    // `build` 与切片边界检查；跳过的事实以 `skippedChecks` 留痕，不静默。
    // DEBUG 指向 TEST 任务时跑的是**红灯**检查（空转测试必须失败），那是另一套语义，不跳过。
    // N-47（`docs/232` §9.11）：dev 任务自身没有 acKeys、却能从本切片并集拿到 AC 范围时——**不跑**
    // 逐任务的绿灯 `test` 检查。这个兜底（PL-M8）会让仓库层任务被判成「API 任务的测试没通过」，
    // 而整片测试是先行的 TEST 任务一次写完的，中间实现任务不可能独自点亮整组 AC
    // （实测 DEBUG/REPLAN 五次继承同一份空 acKeys、五次同一条命令）。切片内根本没有 AC 记录时
    // 不存在「AC 作用域」，维持旧口径（无作用域的全量套件）。
    const scopeFallback = await this.sliceScopeFallback(workflow, task);
    const ownAcKeys = taskAcKeys(task);
    const skipTestCheck =
      isDevTaskType(task.type) &&
      ownAcKeys.length === 0 &&
      scopeFallback.length > 0 &&
      effectiveCheckType(task.type, task.input.targetTaskType) !== "TEST";
    const plannedChecks = skipTestCheck
      ? plan.plans.filter((entry) => entry.name !== "test")
      : plan.plans;
    // N-67（`docs/232` §10）：跑检查**之前**先把依赖装上。检查跑的是项目 scripts，
    // 工作区没有 `node_modules` 时每条都会以 `sh: 1: vite: not found` 失败——那不是代码缺陷。
    const dependencyState = await this.ensureDependencies({
      task,
      workspacePath,
      agentRunId,
      facts
    });
    const checks: VerificationCheckEvidence[] = [];
    for (const planned of plannedChecks) {
      checks.push(
        await this.runCheckWithRetry(planned, workspacePath, task, workflow, agentRunId, {
          facts,
          ...(commitSha ? { commitSha } : {}),
          ...this.taskTestScope(task)
        })
      );
    }
    // F1-5（FX-17）/ PL-M2：切片边界检查——本任务为该切片最后一个经验证门的任务时，
    // 运行该切片全部任务涉及的 AC 的测试。
    const boundaryOutcome = await this.maybeSliceBoundaryCheck({
      workflow,
      task,
      workspacePath,
      agentRunId,
      facts,
      ...(commitSha ? { commitSha } : {})
    });
    if (boundaryOutcome.checks.length > 0) checks.push(...boundaryOutcome.checks);

    // 逐条 AC 结果：合并测试检查的解析结果（同名 fail 优先）。
    const acResults: Record<string, "passed" | "failed"> = {};
    for (const check of checks) {
      if (!check.acResults) continue;
      for (const [key, value] of Object.entries(check.acResults)) {
        if (acResults[key] === "failed") continue;
        acResults[key] = value;
      }
    }
    const hasAcResults = Object.keys(acResults).length > 0;

    // 防篡改：dev 类任务不得**改弱**既有受保护测试文件。
    // N-14（`docs/189` §4.1）：判据由「哈希变了」收紧为「既有断言行消失」——纯增量（如只补
    // import、只加用例）不再判死，而「把断言改弱」仍然拦下（`weakenedProtectedFiles`）。
    let antiTamper: TaskVerificationRecord["antiTamper"];
    if (isDevTaskType(task.type)) {
      if (!input.before) {
        antiTamper = { verdict: "skipped", reason: "no before snapshot" };
      } else if (input.before.error) {
        antiTamper = {
          verdict: "skipped",
          reason: `before snapshot failed: ${input.before.error}`
        };
      } else {
        const after = await this.snapshotProtectedFiles(workspacePath, task, agentRunId);
        if (after.error) {
          antiTamper = { verdict: "skipped", reason: `after snapshot failed: ${after.error}` };
        } else {
          const changed = changedProtectedFiles(input.before.files, after.files);
          const existingChanged = changed.filter((relPath) => after.files.has(relPath));
          // docs/259：只回读哈希变化且仍然存在的文件；删除项不需要内容即可判改弱。
          if (existingChanged.length > 0) {
            const afterContents = await this.snapshotProtectedContents(
              workspacePath,
              task,
              agentRunId,
              existingChanged
            );
            after.contents = afterContents ?? after.contents;
          } else if (changed.length > 0) {
            after.contents = after.contents ?? new Map();
          }
          const classified = classifyProtectedChanges(
            changed,
            input.before.contents,
            after.contents,
            after.files
          );
          const { weakened, unread } = classified;
          // N-14 / docs/259：只有「改弱」（断言消失或文件被删）才判 failed。
          // 内容读不到记 unread 并跳过，不再写成「削弱」。
          if (weakened.length > 0) {
            antiTamper = {
              verdict: "failed",
              changed,
              weakened,
              ...(unread.length > 0 ? { unread } : {})
            };
          } else if (unread.length > 0) {
            antiTamper = {
              verdict: "skipped",
              changed,
              unread,
              reason: `protected contents unavailable: ${unread.join(", ")}`
            };
          } else if (changed.length > 0) {
            antiTamper = { verdict: "passed", changed };
          } else {
            antiTamper = { verdict: "passed" };
          }
        }
      }
    }

    // docs/255：全量套件超时 vs 已绿的作用域/分段 AC 证据。
    waiveFullSuiteTimeoutIfScopedAcsGreen({
      checks,
      acKeys: taskAcKeys(task),
      acResults
    });
    const failedChecks = checks.filter((check) => !check.passed);
    // F2-1（FX-29/30）：写范围审计（observe = 只记录/事件；enforce = 送失败判定，见下）。
    const writeScope = await this.auditTaskWriteScope({
      workflow,
      task,
      workspacePath,
      agentRunId,
      scopeBefore: input.scopeBefore
    });
    let verdict: VerificationVerdict;
    let reason: string | undefined;
    let recordFailureCode: VerificationFailureCode | undefined;
    if (failedChecks.length > 0) {
      verdict = "failed";
      const redLight = failedChecks.filter((check) => check.expected === "fail");
      if (redLight.length > 0) {
        // F1-6（FX-20）+ docs/260：红灯失败按诊断码分组。
        // 超时只归 CHECK_TIMEOUT，不得再被默认桶写成 VACUOUS_TEST。
        const summary = summarizeRedLightFailures(redLight);
        reason = summary.reason;
        recordFailureCode = summary.failureCode;
      } else {
        reason = `checks failed: ${failedChecks.map((check) => check.name).join(", ")}`;
        // N-49：冒烟失败要能按诊断码统计（批次账本读 `verificationFailureCodes`）——
        // `BOOT_FAILED`（起不来）与 `SURFACE_UNMOUNTED`（起来了但路由没挂）是两种不同的缺陷。
        // `docs/233` §5.2：UI 冒烟同理（`PAGE_UNREACHABLE` / `SURFACE_MISSING` / `CONSOLE_ERROR`），
        // 两种边界门共用这一处提取，不另立第二套记账。
        const smokeFailure = failedChecks.find(
          (check) =>
            (check.name === "server-smoke" ||
              check.name === "ui-smoke" ||
              // N-64：命名契约失败要能按诊断码统计，否则批次账本只会看到「checks failed」。
              check.name === "testid-contract" ||
              check.name === "visual") &&
            check.failureCode !== undefined
        );
        if (smokeFailure?.failureCode) recordFailureCode = smokeFailure.failureCode;
      }
    } else if (antiTamper?.verdict === "failed") {
      verdict = "failed";
      reason = `protected test files weakened: ${(antiTamper.weakened ?? []).join(", ")}`;
    } else if (writeScope?.outcome === "violation" && writeScope.mode === "enforce") {
      verdict = "failed";
      reason = `write scope violation (enforce): ${writeScope.violations.join(", ")}`;
    } else if (plan.plans.length === 0 && plan.missing.length > 0 && task.type === "TEST") {
      // PL-M9 9c：TEST 任务的检查**不可裁决**（工作区缺 `test` script）→ fail-closed。
      // 依据本文件既有教义（resolveCheckOutcome 注释：「不可裁决一律 fail-closed 标 EVIDENCE_MISSING」）
      // ——红灯检查是 TEST 任务存在的全部理由，跑不起来即等于什么都没验证。
      // 成因见 `docs/166` §2.1 ②：创建 package.json 与其 scripts 的任务被排在消费者之后。
      // N-15′：条件用**任务自身**类型（不是 `effectiveCheckType`）——「红灯检查是它存在的全部理由」
      // 只对 TEST 任务成立；`DEBUG→TEST` 的任务是去修测试，不可裁决时按 `unavailable` + `missingChecks`
      // 记账（下一分支），不 fail-closed。
      verdict = "failed";
      reason =
        `test check not adjudicable (EVIDENCE_MISSING): the workspace has no ` +
        `${plan.missing.join(", ")} script, so this TEST task's red-light check could not run — ` +
        `the task that creates package.json and its scripts must run before it`;
      recordFailureCode = "EVIDENCE_MISSING";
    } else if (plan.plans.length === 0) {
      verdict = "unavailable";
      reason = `no available checks for task type ${task.type}`;
    } else {
      verdict = "verified";
    }
    // N-67（`docs/232` §10）：**依赖没装好**导致的失败不是代码缺陷，覆盖上面的通用归因。
    // 第七轮三次 `sh: 1: vite: not found` 被记成 `VERIFICATION_FAILED`，REPLAN 于是派 DEBUG
    // 任务去"修代码"，三次撞同一堵墙——而同一份源码装完依赖后 oracle 24/24。
    // AFC-M4：heal/重装失败即 F2 证据——即使当时还没跑出 failedChecks（空计划 / unavailable），
    // 也 fail-closed 为 DEPENDENCIES_MISSING，避免静默后让 QA 再报一次。
    if (dependencyState.missing) {
      verdict = "failed";
      reason =
        (failedChecks.length > 0
          ? `checks failed because dependencies are not installed`
          : `dependencies missing or heal failed before objective checks`) +
        (dependencyState.install?.reason
          ? `: ${dependencyState.install.reason}`
          : " (install not attempted)");
      recordFailureCode = "DEPENDENCIES_MISSING";
    }
    // docs/254：Playwright 浏览器缺失优先于泛化门禁码（仍次于 npm DEPENDENCIES_MISSING 上面的覆盖）。
    if (recordFailureCode !== "DEPENDENCIES_MISSING") {
      const envGapCheck = failedChecks.find((check) => check.failureCode === "ENV_GAP");
      // docs/265：官方视觉失败不得被截图日志里的 Playwright 字样收成 ENV_GAP。
      const envGapText = failedChecks
        .filter((check) => check.name !== "visual" && !isOfficialVisualFailureCode(check.failureCode))
        .map((check) => [check.stderrTail ?? "", check.stdoutTail ?? "", check.command].join("\n"))
        .join("\n");
      const visualCode = isOfficialVisualFailureCode(recordFailureCode);
      if (
        !visualCode &&
        (envGapCheck || matchesPlaywrightEnvGap(envGapText) || matchesPlaywrightEnvGap(reason ?? ""))
      ) {
        verdict = "failed";
        reason =
          envGapCheck?.stderrTail ||
          reason ||
          "Playwright browser binaries missing (ENV_GAP)";
        recordFailureCode = "ENV_GAP";
      }
    }
    // PL-M9 9a：本类型有候选检查、但工作区缺 script（检查因此无法判定）——与「本类型没有客观检查」
    // 分开记账，并让它在批次指标里可见（此前 `unavailable` 不进任何计数，`docs/166` §2.1 ③）。
    const missingChecks = plan.plans.length === 0 && plan.missing.length > 0 ? plan.missing : undefined;

    const finishedAt = new Date();
    const record: TaskVerificationRecord = {
      mode: input.mode ?? this.dependencies.mode,
      verdict,
      verified: verdict === "verified",
      taskType: task.type,
      ...(reason ? { reason } : {}),
      ...(missingChecks ? { missingChecks } : {}),
      // 观测（PL-M40 后续）：边界检查没跑的原因。批次后可直接查
      // `output->'verification'->>'boundarySkipped'` 定位，不必翻服务日志。
      ...(boundaryOutcome.skipped ? { boundarySkipped: boundaryOutcome.skipped } : {}),
      ...(boundaryOutcome.smokeSkipped ? { smokeSkipped: boundaryOutcome.smokeSkipped } : {}),
      ...(boundaryOutcome.testIdContractSkipped
        ? { testIdContractSkipped: boundaryOutcome.testIdContractSkipped }
        : {}),
      ...(boundaryOutcome.visualSkipped ? { visualSkipped: boundaryOutcome.visualSkipped } : {}),
      ...(dependencyState.install ? { dependencyInstall: dependencyState.install } : {}),
      // N-47：没有 AC 作用域的 dev 任务不跑绿灯 test 检查——跳过的事实必须留痕。
      ...(skipTestCheck ? { skippedChecks: [{ name: "test" as const, reason: "NO_AC_SCOPE" as const }] } : {}),
      ...(recordFailureCode ? { failureCode: recordFailureCode } : {}),
      checks,
      ...(hasAcResults
        ? {
            acResults,
            acSummary: {
              total: Object.keys(acResults).length,
              passed: Object.values(acResults).filter((entry) => entry === "passed").length,
              failed: Object.values(acResults).filter((entry) => entry === "failed").length
            }
          }
        : {}),
      ...(antiTamper ? { antiTamper } : {}),
      ...(writeScope ? { writeScope } : {}),
      durationMs: finishedAt.getTime() - startedMs,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(commitSha ? { commitSha } : {})
    };

    await this.recordEvent(workflow, task, agentRunId, record);
    // PL-M9 9a：观察事件——只在此前**完全不可见**的「有候选检查但缺 script」情形下发出
    // （verdict 为 `unavailable` 时；9c 的 TEST fail-closed 已由 TASK_VERIFICATION 的失败码承载）。
    // payload **不含 errorCode**，因此不会被 `collectFailureLayers` 误计入失败层（同 PL-M7 7b）。
    if (record.verdict === "unavailable" && missingChecks) {
      await this.recordUndecidableCheckEvent(workflow, task, agentRunId, missingChecks);
    }
    return redactEvidenceContent(record) as TaskVerificationRecord;
  }

  /**
   * F1-7（FX-25）：与工具面共用同一探测模块——探测失败按「无可用检查」处理（既有语义不变）。
   */
  private async probePackageFacts(
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<PackageFacts> {
    const result = await this.runTool(
      "run_command",
      { command: buildPackageFactsProbeCommand(), timeoutMs: 60_000 },
      { task, workspacePath, agentRunId, checkName: "package-probe" }
    );
    if (!result.success) {
      return { hasPackageJson: true, lockfiles: [], scripts: {} };
    }
    return parsePackageFacts(outputText(result, "stdout"));
  }

  /**
   * N-34（PL-M35）：探测提到本切片 AC 的测试文件。
   * 探测失败 / 无法解析 → `undefined`（调用方按「未探测」处理，保持既有的名称筛选形态）。
   */
  private async probeAcTestFiles(
    acKeys: string[],
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<string[] | undefined> {
    const command = buildAcTestFileProbeCommand(acKeys);
    if (!command) return undefined;
    const result = await this.runTool(
      "run_command",
      { command, timeoutMs: 60_000 },
      { task, workspacePath, agentRunId, checkName: "ac-test-file-probe" }
    );
    if (!result.success) return undefined;
    return parseAcTestFileProbe(outputText(result, "stdout")) ?? undefined;
  }

  /**
   * F1-5（FX-16）：dev 任务的 test 检查作用域。
   * PL-M8（`docs/164` §3 / §4 裁定 3）：任务**未声明** acKeys 时回退到本切片 AC 范围
   * （`fallbackAcKeys`）。只补「无锚点」这一种情形——已声明 acKeys 的任务行为**逐字不变**，故本次
   * 改动对既有通过集是**严格放宽**：判定式 `result.success || (范围内 AC 结果非空且全过)` 只多了一个
   * 作用域来源，`result.success` 不变。两处都空（无 AC 记录的项目）→ 维持不作用域（全量套件）。
   */
  /**
   * dev 任务的 test 检查作用域：**只取任务自身声明的 acKeys**。
   * N-47（`docs/232` §9.11）：PL-M8 的「无锚点 → 本切片并集」不再作为检查作用域使用——那种兜底
   * 让中间的实现任务被整片的测试判死。切片并集只在 `verify()` 里用于判定「要不要跳过这条检查」。
   */
  private taskTestScope(task: Task): { scope?: { acKeys: string[]; kind: "task" } } {
    // docs/255：TEST 官方门禁在有 AC 时也必须 command-filter，不再跑全量 npm run test。
    if (!isDevTaskType(task.type) && task.type !== "TEST") return {};
    const own = taskAcKeys(task);
    return own.length > 0 ? { scope: { acKeys: own, kind: "task" } } : {};
  }

  /** PL-M8：本切片 AC 范围（读库失败 / 无切片 / 无 workflowTasks 依赖 → 空 = 无兜底可谈）。 */
  private async sliceScopeFallback(workflow: WorkflowRun, task: Task): Promise<string[]> {
    // 只有「dev 任务且自身未声明锚点」才需要求值；其余情形不会被用到，省一次读库。
    if (!isDevTaskType(task.type) || taskAcKeys(task).length > 0) return [];
    const loadTasks = this.dependencies.workflowTasks;
    if (!loadTasks || !task.sliceKey) return [];
    let tasks: Task[];
    try {
      tasks = await loadTasks(workflow.id);
    } catch {
      return [];
    }
    return sliceAcKeys(tasks.filter((entry) => entry.sliceKey === task.sliceKey));
  }

  /** N-67：装依赖的命令超时（工具 schema 允许的上限就是 120s）。 */
  private static readonly DEPENDENCY_INSTALL_TIMEOUT_MS = 120_000;

  /**
   * N-67（`docs/232` §10）：**跑检查之前先确保依赖就位**（修法 A）。
   *
   * 检查跑的是项目 scripts（`pnpm build` / `vue-tsc`），工作区没有 `node_modules` 时每条都会以
   * `sh: 1: vite: not found` 失败——那不是代码缺陷。实测第七轮三次逐字相同、REPLAN 不收敛，
   * 而同一份源码在 oracle 里装完依赖后 **24/24**（等于把可用交付判死）。
   *
   * 三条边界：
   * - 只在**获准装依赖的能力面**（`profile.dependencyNetwork === "registry"`）上做，其余 profile
   *   行为不变；
   * - 探针**说不准时不动手**（`"unknown"` 当作「存在」），不因为探针抖动就去装；
   * - 只在真的缺依赖时安装，装完就停——每个工作区最多两次命令（`--frozen-lockfile` 失败后
   *   退回普通安装），不会每条检查都重装。
   */
  private async ensureDependencies(input: {
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
  }): Promise<{
    missing: boolean;
    install?: { attempted: boolean; ok: boolean; command?: string; reason?: string };
  }> {
    const { task, workspacePath, agentRunId, facts } = input;
    if (!facts.hasPackageJson) return { missing: false };
    const profile = this.dependencies.profile ?? DEFAULT_CAPABILITY_PROFILE;
    if (profile.dependencyNetwork !== "registry") return { missing: false };

    let present: boolean | "unknown";
    let probeStdout = "";
    try {
      const probe = await this.runTool(
        "run_command",
        { command: buildDependencyProbeCommand(), timeoutMs: 30_000 },
        { task, workspacePath, agentRunId, checkName: "dependencies" }
      );
      probeStdout = outputText(probe, "stdout");
      present = parseDependencyProbe(probeStdout);
    } catch {
      present = "unknown";
    }
    if (present !== false) return { missing: false };

    // 优先只补齐平台原生 optional（macOS 树挂进 Linux 沙箱的常见形态），避免 npm ci 抹掉宿主机包。
    const nativeMissing = missingNativePackagesFromProbe(probeStdout);
    const heal = nativeDependencyHealCommand(nativeMissing);
    if (heal) {
      const healed = await this.tryDependencyInstall(heal, task, workspacePath, agentRunId);
      if (healed.ok) {
        return { missing: false, install: { attempted: true, ok: true, command: healed.command } };
      }
    }

    const runner = packageRunnerFor(facts);
    const frozen = await this.tryDependencyInstall(
      dependencyInstallCommand(runner, true),
      task,
      workspacePath,
      agentRunId
    );
    if (frozen.ok) {
      return { missing: false, install: { attempted: true, ok: true, command: frozen.command } };
    }
    // 锁文件与 package.json 不一致时 `--frozen-lockfile` 必然失败（实测常见）⇒ 退回普通安装。
    const relaxed = await this.tryDependencyInstall(
      dependencyInstallCommand(runner, false),
      task,
      workspacePath,
      agentRunId
    );
    return {
      missing: !relaxed.ok,
      install: {
        attempted: true,
        ok: relaxed.ok,
        command: relaxed.ok ? relaxed.command : frozen.command,
        ...(relaxed.ok ? {} : { reason: relaxed.reason ?? frozen.reason })
      }
    };
  }

  private async tryDependencyInstall(
    command: string,
    task: Task,
    workspacePath: string,
    agentRunId?: string
  ): Promise<{ ok: boolean; command: string; reason?: string }> {
    try {
      const run = await this.runTool(
        "run_command",
        { command, timeoutMs: TaskVerifier.DEPENDENCY_INSTALL_TIMEOUT_MS },
        { task, workspacePath, agentRunId, checkName: "dependencies" }
      );
      if (outputField(run, "exitCode") === 0) return { ok: true, command };
      return {
        ok: false,
        command,
        reason: tailText(outputText(run, "stderr") || outputText(run, "stdout"), 300)
      };
    } catch (error) {
      const data = (error as { data?: Record<string, unknown> }).data;
      const text = data
        ? `${String(data.stdout ?? "")}\n${String(data.stderr ?? "")}`
        : error instanceof Error
          ? error.message
          : String(error);
      return { ok: false, command, reason: tailText(text, 300) };
    }
  }

  private async runCheckWithRetry(
    planned: VerificationCheckPlan,
    workspacePath: string,
    task: Task,
    workflow: WorkflowRun,
    agentRunId?: string,
    context: {
      facts: PackageFacts;
      commitSha?: string;
      scope?: { acKeys: string[]; kind: "task" | "slice" };
    } = { facts: { hasPackageJson: true, lockfiles: [], scripts: {} } }
  ): Promise<VerificationCheckEvidence> {
    // F1-7（FX-25）：基础命令按项目 runner 解析（与工具面共用探测模块；解析失败回退 npm run <script>）。
    const commandPlan = planPackageScriptCommand(planned.scriptName, context.facts);
    const baseCommand = commandPlan.command ?? `npm run ${planned.scriptName}`;
    // F1-5（FX-16）：dev 任务的作用域测试检查——`node --test` / vitest 按 AC 真选取（command-filter）。
    // 有 AC 却构造不出作用域命令时 fail-closed（AC_SCOPE_UNSUPPORTED），不得再跑全量套件。
    // TEST 任务红灯语义保持既有 E-0 行为。
    // docs/255：有 AC 时官方 test 门一律 command-filter（含 TEST 红灯），禁止回退全量套件。
    const scoping =
      planned.name === "test" &&
      context.scope &&
      context.scope.acKeys.length > 0
        ? context.scope
        : undefined;
    const scriptText =
      typeof context.facts.scripts.test === "string" ? context.facts.scripts.test : "";
    const probedTestFiles = scoping
      ? await this.probeAcTestFiles(scoping.acKeys, workspacePath, task, agentRunId)
      : undefined;
    const scopedCommand = scoping
      ? buildAcScopedTestCommand(
          baseCommand,
          scoping.acKeys,
          scriptText,
          this.timeoutMs,
          // N-34（PL-M35）：先探测「哪些测试文件提到了这些 AC」，按文件选取而非只筛测试名。
          probedTestFiles
        )
      : null;
    if (scoping && !scopedCommand) {
      return acScopeCommandFailure({
        name: planned.name,
        expected: planned.expectation,
        baseCommand,
        acKeys: scoping.acKeys,
        probedTestFiles
      });
    }
    // docs/262：命令若仍只含非正规测试路径，fail-closed，不跑垃圾树。
    if (scoping && scopedCommand && scopedCommandUsesNonCanonicalTestFiles(scopedCommand)) {
      return acScopeCommandFailure({
        name: planned.name,
        expected: planned.expectation,
        baseCommand: scopedCommand,
        acKeys: scoping.acKeys,
        probedTestFiles: probedTestFiles ?? []
      });
    }
    const scopingMode: AcScopingMode | undefined = scoping ? "command-filter" : undefined;
    // `docs/235` §6.8：非 TAP runner 要有逐条结果，否则作用域判定拿不到任何 AC 证据。
    // **只对 test 检查生效**——把它也加到 build/lint 上会得到 `npm run build -- --reporter=verbose`，
    // 那是每个前端任务都会踩的假失败（本条由单测抓出，见 taskVerifier §6.8 用例）。
    const command =
      planned.name === "test"
        ? withTestReporter(
            scopedCommand ?? baseCommand,
            scriptText,
            (this.dependencies.profile ?? DEFAULT_CAPABILITY_PROFILE).testParser
          )
        : (scopedCommand ?? baseCommand);
    const attempts: VerificationCheckAttempt[] = [];
    const startedMs = Date.now();
    let last: ToolResult | undefined;
    let passed = false;
    let expected = planned.expectation;
    let failureCode: VerificationFailureCode | undefined;
    let uncoveredAcKeys: string[] | undefined;
    let coverageTruncated: boolean | undefined;

    // docs/254：test 门若像 E2E/Playwright，先探针浏览器二进制——缺则 ENV_GAP fail-closed，不空跑套件。
    // docs/264：产品 Playwright 若要的 revision 不在镜像里，按契约不一致 fail-fast，禁止在沙箱安装。
    if (planned.name === "test") {
      const preflight = e2eBrowserPreflight({
        scripts: context.facts.scripts,
        command,
        workspaceRoot: workspacePath
      });
      if (preflight) {
        const contract = inspectWorkspacePlaywright({ workspaceRoot: workspacePath });
        if (contract.contractMismatch) {
          const reason = playwrightContractMismatchReason(contract);
          return {
            name: planned.name,
            command,
            expected: planned.expectation,
            passed: false,
            exitCode: null,
            timedOut: false,
            attempts: [],
            flaked: false,
            outputDigest: digestText(reason),
            stdoutTail: "",
            stderrTail: reason,
            durationMs: Date.now() - startedMs,
            failureCode: "ENV_GAP",
            ...(scoping ? { scopedAcKeys: [...scoping.acKeys], scopingMode } : {}),
            ...(context.commitSha ? { commitSha: context.commitSha } : {})
          };
        }
      }
      if (preflight && !preflight.ok) {
        return {
          name: planned.name,
          command,
          expected: planned.expectation,
          passed: false,
          exitCode: null,
          timedOut: false,
          attempts: [],
          flaked: false,
          outputDigest: digestText(preflight.reason),
          stdoutTail: "",
          stderrTail: preflight.reason,
          durationMs: Date.now() - startedMs,
          failureCode: "ENV_GAP",
          ...(scoping ? { scopedAcKeys: [...scoping.acKeys], scopingMode } : {}),
          ...(context.commitSha ? { commitSha: context.commitSha } : {})
        };
      }
    }

    // N-26（`docs/146`）：**两种作用域模式共用同一条判定规则**——「本切片 AC 全过」即通过。
    // 模式只决定**跑哪条命令**（command-filter 用 `--test-name-pattern` 真选取，result-filter 跑全量），
    // **不决定怎么判**。原先只有 result-filter 享受这条放宽，command-filter 额外要求整条命令成功；
    // 但 `--test-name-pattern` 只筛**测试名**，`node --test` 仍会加载 `test/` 下的**每个**文件并执行
    // 其顶层钩子（`taskVerifierRules.ts:301` 的注释已写明这点）⇒ **兄弟切片**的测试文件钩子一失败
    // （例如它要的接口还没实现 ⇒ `ERR_SERVER_NOT_RUNNING`），整条命令就非零退出，而本切片 AC **全过**
    // ⇒ 本切片被误判失败（L1-M4p run 1 的 `T-008` 就是这样死的）。
    const scopeFilter = scoping ? { acKeys: scoping.acKeys } : undefined;
    // docs/260：官方全量 test 用专用超时（走 context，不写工具入参，避开 schema 120s 上限）。
    // lint / typecheck / build / 作用域 test 仍用默认 120s。
    const officialTestTimeoutMs =
      planned.name === "test" ? officialTestCheckTimeoutMs(command) : this.timeoutMs;
    const officialFullSuiteTest =
      planned.name === "test" && officialTestTimeoutMs !== this.timeoutMs && officialTestTimeoutMs > this.timeoutMs;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      last = await this.runTool(
        CHECK_TOOL_BY_NAME[planned.name],
        officialFullSuiteTest ? { command } : { command, timeoutMs: this.timeoutMs },
        {
          task,
          workspacePath,
          agentRunId,
          checkName: planned.name,
          ...(officialFullSuiteTest ? { timeoutMs: officialTestTimeoutMs } : {})
        }
      );
      const exitCode = outputField(last, "exitCode");
      const exitCodeNumber = typeof exitCode === "number" ? exitCode : null;
      const timedOut =
        outputField(last, "timedOut") === true || last.error?.code === "TIMEOUT_ERROR";
      attempts.push({
        exitCode: exitCodeNumber,
        durationMs: last.duration,
        timedOut
      });
      // 取消语义不变：abort 不重试。
      if (last.error?.code === "CANCELLED_ERROR") break;
      const outcome = await this.resolveCheckOutcome(
        planned,
        task,
        workflow,
        last,
        scopeFilter,
        new Date(startedMs),
        scopingMode === "command-filter"
      );
      expected = outcome.expected;
      coverageTruncated = outcome.coverageTruncated;
      if (outcome.achieved) {
        passed = true;
        failureCode = undefined;
        uncoveredAcKeys = undefined;
        break;
      }
      // F1-6（FX-20）：红灯失败码随尝试结果记录（未翻转时取末次尝试的诊断码）。
      failureCode = outcome.failureCode;
      // PL-M18（N-10）(c)：缺证据的 AC 编号同样取末次尝试。
      uncoveredAcKeys = outcome.uncoveredAcKeys;
    }

    const stdout = last ? outputText(last, "stdout") : "";
    const stderr = last ? outputText(last, "stderr") : "";
    const finalAttempt = attempts[attempts.length - 1];
    // N-13（PL-M20）：检查**超时**也是一种可命名的失败——与「测试确实失败」区分开。
    // 红灯检查自己的诊断码优先（它更具体），没有时再看是不是没返回。
    let resolvedFailureCode = passed
      ? undefined
      : (failureCode ?? (finalAttempt?.timedOut ? CHECK_TIMEOUT_FAILURE_CODE : undefined));
    // docs/254：套件已跑但证据指向缺浏览器 → 覆盖为 ENV_GAP（避免泛化 VERIFICATION_FAILED→FRONTEND）。
    if (!passed && planned.name === "test") {
      const evidenceText = `${stdout}\n${stderr}`;
      if (
        resolvedFailureCode !== "ENV_GAP" &&
        matchesPlaywrightEnvGap(evidenceText)
      ) {
        resolvedFailureCode = "ENV_GAP";
      }
    }
    const checkAcResults =
      planned.name === "test" ? parseAcResults(`${stdout}\n${stderr}`) : undefined;
    // docs/262：套件已跑但 0 覆盖且命令只点了非正规测试树 → 覆盖为 PROBE_FAILURE。
    if (
      !passed &&
      planned.name === "test" &&
      scoping &&
      resolvedFailureCode !== "ENV_GAP" &&
      resolvedFailureCode !== "CHECK_TIMEOUT" &&
      scopedCommandUsesNonCanonicalTestFiles(command)
    ) {
      const scope = new Set(scoping.acKeys.map(canonicalAcKey));
      const relevantCount = checkAcResults
        ? Object.keys(checkAcResults).filter((key) => scope.has(canonicalAcKey(key))).length
        : 0;
      if (relevantCount === 0) {
        resolvedFailureCode = "PROBE_FAILURE";
      }
    }
    return {
      name: planned.name,
      command,
      expected,
      passed,
      exitCode: finalAttempt?.exitCode ?? null,
      timedOut: finalAttempt?.timedOut ?? false,
      attempts,
      flaked: passed && attempts.length > 1,
      outputDigest: digestText(`${stdout}\n${stderr}`),
      stdoutTail: tailText(stdout),
      stderrTail: tailText(stderr),
      durationMs: Date.now() - startedMs,
      ...(checkAcResults && Object.keys(checkAcResults).length > 0
        ? { acResults: checkAcResults }
        : {}),
      ...(resolvedFailureCode ? { failureCode: resolvedFailureCode } : {}),
      ...(!passed && uncoveredAcKeys && uncoveredAcKeys.length > 0 ? { uncoveredAcKeys } : {}),
      ...(coverageTruncated ? { coverageTruncated: true } : {}),
      ...(commandPlan.warnings.length > 0 ? { warnings: commandPlan.warnings } : {}),
      ...(context.commitSha ? { commitSha: context.commitSha } : {}),
      ...(scoping ? { scopedAcKeys: [...scoping.acKeys], scopingMode } : {})
    };
  }

  /**
   * E-0 检查结果判定：红灯检查（TEST 任务）在「套件全绿」时不再一律判空转——
   * 若本轮解析出的全部 AC（G1/GX-03：任务声明 acKeys 时收窄为作用域内 AC）均有实现证据
   * （G1/GX-01/02：同需求全部工作流「已成功 + 开发类 + 完成于检查时刻前」任务；
   * input.acKeys 计划覆盖，或该任务 verification.acResults 实测通过），
   * 期望翻转为绿灯回归验证；证据不全（无证据 / 自引用 / 解析不出 AC）时保守保持红灯（fail-closed）。
   */
  private async resolveCheckOutcome(
    planned: VerificationCheckPlan,
    task: Task,
    workflow: WorkflowRun,
    result: ToolResult,
    scopeFilter: { acKeys: string[] } | undefined,
    evidenceCutoff: Date,
    /** 本次检查是否用了 `--test-name-pattern` 命令筛选（N-27 的判定前提）。 */
    commandFiltered = false
  ): Promise<{
    achieved: boolean;
    expected: "pass" | "fail";
    failureCode?: VerificationFailureCode;
    /** PL-M18（N-10）(c)：红灯判定时缺实现证据的作用域 AC 编号（诊断用；缺省 = 无）。 */
    uncoveredAcKeys?: string[];
    /** N-55：输出被截断、覆盖无法判定（本次按退出码裁决）。 */
    coverageTruncated?: boolean;
  }> {
    if (planned.expectation !== "fail") {
      // F1-5（FX-16）+ N-26：命令失败时，若任务作用域 AC 的结果全部通过（且至少一条可解析），
      // 不因**其他任务的**测试失败而失败；作用域外失败不参与本任务判定。
      // N-26：这条对 **command-filter 同样成立**——`--test-name-pattern` 不阻止兄弟文件被加载，
      // 它们的钩子失败会让整条命令非零退出（见上文 `scopeFilter` 的定义注释）。
      const timedOut =
        outputField(result, "timedOut") === true || result.error?.code === "TIMEOUT_ERROR";
      // N-26 的反向边界（同时也是 PL-M20 / N-13）：**超时不吃这条放宽**。
      // 命令没返回 ⇒ 输出只是残片、不能当裁决证据；「作用域 AC 过了但命令没返回」正是 L1-M4k 的
      // `CHECK_TIMEOUT` 形态，必须仍判失败。区分因子是 **`timedOut`**，不是 `success`。
      if (!timedOut && scopeFilter && scopeFilter.acKeys.length > 0) {
        const testOutput = `${outputText(result, "stdout")}\n${outputText(result, "stderr")}`;
        const parsed = parseAcResults(testOutput);
        const scope = new Set(scopeFilter.acKeys.map(canonicalAcKey));
        const relevant = Object.entries(parsed).filter(([key]) => scope.has(canonicalAcKey(key)));
        if (commandFiltered) {
          // N-27（PL-M36）：**零匹配不是通过证据**。
          // 旧行为在本分支只看 `result.success`，而零匹配的 `node --test --test-name-pattern '…'`
          // 退出码是 **0**（TAP `1..0` / `# tests 0`）⇒ **空转通过**。L1-M4q 三个 run 各复现 1 次，
          // 三次全部来自同一个任务 `T1`（`docs/209` §4）。
          // 只在 command-filter 下收紧：result-filter（非 `node --test` 的项目）里「没有 AC 结果」
          // 可能只是测试名没打 `[AC-xx]` 标记，那是 runner 约定分歧，不是空转。
          if (relevant.length === 0) {
            // N-55（`docs/232` §9.27）：**但被截断的输出里「没看到」不等于「没有」**。沙箱只保留最后
            // 96KB（`packages/sandbox/src/index.ts:69-76`），258 条用例的真实输出 137KB ⇒ 排在前面的
            // 用例整段消失，于是「exit 0 + 258/258 全绿」却报 uncoveredAcKeys（第十一次回归 `T7`）。
            // 判不了覆盖就按退出码裁决，并把这个事实写进证据。
            if (detectTestOutputTruncation(testOutput)) {
              return {
                achieved: result.success,
                expected: planned.expectation,
                coverageTruncated: true
              };
            }
            return {
              achieved: false,
              expected: planned.expectation,
              // 报告**计划里的原始写法**（`AC-01`），不是规范化键（`AC-1`）——诊断要对得上计划。
              uncoveredAcKeys: [...new Set(scopeFilter.acKeys)]
            };
          }
          if (relevant.every(([, value]) => value === "passed")) {
            return { achieved: true, expected: "pass" };
          }
          const failed = new Set(
            relevant.filter(([, value]) => value !== "passed").map(([key]) => canonicalAcKey(key))
          );
          return {
            achieved: false,
            expected: planned.expectation,
            uncoveredAcKeys: [...new Set(scopeFilter.acKeys)].filter((key) =>
              failed.has(canonicalAcKey(key))
            )
          };
        }
        // result-filter：只在命令**失败**时才放宽（N-26 原样保留）。
        if (!result.success && relevant.length > 0 && relevant.every(([, value]) => value === "passed")) {
          return { achieved: true, expected: "pass" };
        }
      }
      return { achieved: result.success, expected: planned.expectation };
    }
    const exitCode = outputField(result, "exitCode");
    const exitCodeNumber = typeof exitCode === "number" ? exitCode : null;
    if (!result.success && exitCodeNumber !== null && exitCodeNumber !== 0) {
      // 红灯已亮：命令以非零退出码失败。
      return { achieved: true, expected: "fail" };
    }
    // F1-6（FX-20）：诊断码拆分——绿灯翻转判定与证据面诊断分离，不可裁决一律 fail-closed 标 EVIDENCE_MISSING。
    if (!result.success && exitCodeNumber === null) {
      // docs/255 / docs/260：全量/作用域套件超时是 CHECK_TIMEOUT，
      // 不得单凭超时打成 EVIDENCE_MISSING 或 VACUOUS_TEST。
      const timedOut =
        outputField(result, "timedOut") === true || result.error?.code === "TIMEOUT_ERROR";
      return {
        achieved: false,
        expected: "fail",
        failureCode: timedOut ? CHECK_TIMEOUT_FAILURE_CODE : "EVIDENCE_MISSING"
      };
    }
    // 首次尝试即绿灯是 E-0 期望的「翻转」信号；解析不出任何测试结果 → 证据面缺失。
    const acResults = parseAcResults(
      `${outputText(result, "stdout")}\n${outputText(result, "stderr")}`
    );
    const parsedKeys = Object.keys(acResults);
    if (parsedKeys.length === 0) {
      return { achieved: false, expected: "fail", failureCode: "EVIDENCE_MISSING" };
    }
    // G1（GX-03）+ PL-M18（N-10）：作用域键——任务声明的 acKeys 优先，无锚点时回退本切片 AC。
    const requirementTasks = await this.loadRequirementTasks(workflow);
    const keys = scopedEvidenceKeys(task, parsedKeys, requirementTasks ?? []);
    const evidence =
      requirementTasks === null
        ? null
        : this.implementationEvidence(requirementTasks, task, keys, evidenceCutoff);
    if (evidence === null) {
      return { achieved: false, expected: "fail", failureCode: "EVIDENCE_MISSING" };
    }
    const allPassed = keys.every((key) => acResults[key] === "passed");
    if (result.success && allPassed && evidence.uncovered.length === 0) {
      return { achieved: true, expected: "pass" };
    }
    // 证据可读但未全数具备实现证据（无实现/部分覆盖/自引用/绿灯不一致）→ 空转红灯。
    // PL-M18（N-10）(c)：把缺证据的 AC 编号一并带回，供 reason 与检查记录落盘。
    return {
      achieved: false,
      expected: "fail",
      failureCode: "VACUOUS_TEST",
      ...(evidence.uncovered.length > 0 ? { uncoveredAcKeys: evidence.uncovered } : {})
    };
  }

  /**
   * F1-6（FX-20）+ G1（GX-01/02）：红灯翻转所需的实现证据面（同 requirement 全部运行时任务，
   * 跨切片 / 跨 run / 跨批次；经 workflow_runs.requirement_id 关联）。
   * 通道缺失 / 读取失败 → `null`（调用方 fail-closed 判证据面缺失）。
   * PL-M18（N-10）：任务集改为调用方一次性载入——作用域键的切片回退（`scopedEvidenceKeys`）也要用它，
   * 避免同一检查读两次库。
   */
  private async loadRequirementTasks(workflow: WorkflowRun): Promise<Task[] | null> {
    const loadTasks = this.dependencies.requirementTasks;
    if (!loadTasks) return null;
    const requirementId = workflow.requirementId;
    if (!requirementId) return null;
    try {
      return await loadTasks(requirementId);
    } catch {
      return null;
    }
  }

  /**
   * 实现证据判定（纯函数）：`uncovered` 为空即「全部作用域 AC 均有同需求『已成功 + 开发类 +
   * 完成于检查时刻前』任务覆盖（自引用除外）」；非空即「证据可读但覆盖不足 → 空转」。
   * PL-M18（N-10）(c)：`uncovered` 同时供 reason 落盘，让生产日志能指出是哪个 AC 把判定拖死
   * （改动前 reason 只写检查名 `test`，定位代价高）。
   */
  private implementationEvidence(
    requirementTasks: Task[],
    task: Task,
    acKeys: string[],
    cutoff: Date
  ): { uncovered: string[] } {
    const evidence = requirementTasks.filter(
      (entry) =>
        entry.id !== task.id &&
        entry.status === "SUCCESS" &&
        isDevTaskType(entry.type) &&
        entry.finishedAt !== undefined &&
        new Date(entry.finishedAt).getTime() < cutoff.getTime()
    );
    return {
      uncovered: acKeys.filter((key) => !evidence.some((entry) => taskCoversAc(entry, key)))
    };
  }

  /** F2-1：写范围审计模式（包装层据此决定是否捕获基线快照）。 */
  get writeScopeMode(): WriteScopeMode {
    return this.dependencies.writeScope?.mode ?? "off";
  }

  /** F2-1：任务执行前的 git 状态快照（best-effort；非 git 工作区/命令失败 → undefined，审计转 skipped）。 */
  async snapshotWriteScope(
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<{ porcelain: string } | undefined> {
    if (this.writeScopeMode === "off") return undefined;
    return await this.gitStatusPorcelain(workspacePath, task, agentRunId);
  }

  private async gitStatusPorcelain(
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<{ porcelain: string } | undefined> {
    try {
      const result = await this.runTool(
        "run_command",
        { command: "git status --porcelain", timeoutMs: 30_000 },
        { task, workspacePath, agentRunId, checkName: "git-status" }
      );
      if (!result.success) return undefined;
      return { porcelain: outputText(result, "stdout") };
    } catch {
      return undefined;
    }
  }

  /**
   * N-19（`docs/191`）：本 agent run 被**写权限**拒绝的路径——取自 `tool_calls`，**不依赖 git**，
   * 故非 git 工作区（审计整体 `skipped` 的情形）同样能读到。
   *
   * 失败安全：取不到即按 0 计（与 `blockedCommandAttempts` 同口径）——**它只记录，不参与判定**，
   * 故读失败绝不能让整个验证作废（`ToolRuntime` 无 catch，抛出去会void 掉整次验证）。
   */
  private async collectDeniedWrites(
    agentRunId?: string
  ): Promise<{ deniedAttempts: number; deniedPaths: string[] }> {
    if (!agentRunId) return { deniedAttempts: 0, deniedPaths: [] };
    try {
      const result = await this.dependencies.writeScope?.deniedWriteAttempts?.(agentRunId);
      return {
        deniedAttempts: result?.attempts ?? 0,
        deniedPaths: result?.paths ?? []
      };
    } catch {
      return { deniedAttempts: 0, deniedPaths: [] };
    }
  }

  /**
   * F2-1（FX-29/30）：写范围审计——任务结束后（验证门内）对「任务自身写入的路径」做白名单判定；
   * 越界发 `SCOPE_VIOLATION`；同 run 有被策略拦截的命令尝试时并记 `POLICY_EVASION_SUSPECTED`（FX-33）。
   *
   * N-19（`docs/191`）：另记 `deniedAttempts` / `deniedPaths`——被拒写入**不产生 diff**，
   * diff 式审计看不见它。两个面并列记录，`outcome` 只由 `violations` 决定（被拒不改判）。
   */
  private async auditTaskWriteScope(input: {
    workflow: WorkflowRun;
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    scopeBefore?: { porcelain: string };
  }): Promise<WriteScopeAudit | undefined> {
    const mode = this.writeScopeMode;
    if (mode === "off") return undefined;
    const denied = await this.collectDeniedWrites(input.agentRunId);
    if (!input.scopeBefore) {
      return {
        mode,
        outcome: "skipped",
        checked: 0,
        violations: [],
        changedPaths: [],
        ...denied,
        reason: "no before snapshot"
      };
    }
    const after = await this.gitStatusPorcelain(input.workspacePath, input.task, input.agentRunId);
    if (!after) {
      return {
        mode,
        outcome: "skipped",
        checked: 0,
        violations: [],
        changedPaths: [],
        ...denied,
        reason: "git status unavailable (non-git workspace?)"
      };
    }
    const changedPaths = diffPorcelain(input.scopeBefore.porcelain, after.porcelain);
    const audit = auditWriteScope({ taskType: input.task.type, changedPaths });
    const result: WriteScopeAudit = {
      mode,
      outcome: audit.violations.length > 0 ? "violation" : "passed",
      checked: audit.checked,
      violations: audit.violations,
      changedPaths,
      ...denied
    };
    if (audit.violations.length > 0) {
      await this.writeScopeEvents(input, result);
    }
    return result;
  }

  private async writeScopeEvents(
    input: { workflow: WorkflowRun; task: Task; agentRunId?: string },
    audit: WriteScopeAudit
  ): Promise<void> {
    const events = this.dependencies.events;
    if (!events) return;
    await events.create({
      workflowRunId: input.workflow.id,
      taskId: input.task.id,
      agentRunId: input.agentRunId,
      eventType: "SCOPE_VIOLATION",
      payload: sanitizeLogData({
        taskKey: input.task.taskKey,
        taskType: input.task.type,
        mode: audit.mode,
        violations: audit.violations,
        totalChanged: audit.checked
      }) as JsonObject
    });
    const blockedAttempts = await (async () => {
      try {
        return (
          (await this.dependencies.writeScope?.blockedCommandAttempts?.(input.agentRunId ?? "")) ??
          0
        );
      } catch {
        return 0;
      }
    })();
    if (blockedAttempts > 0) {
      // F2-2（FX-33）：被拦截后改走其他通道完成同一目标——写范围审计兜底检出时并记可疑规避。
      await events.create({
        workflowRunId: input.workflow.id,
        taskId: input.task.id,
        agentRunId: input.agentRunId,
        eventType: "POLICY_EVASION_SUSPECTED",
        payload: sanitizeLogData({
          taskKey: input.task.taskKey,
          taskType: input.task.type,
          blockedAttempts,
          violations: audit.violations
        }) as JsonObject
      });
    }
  }

  /**
   * F1-5（FX-18）：工作区 HEAD 捕获（best-effort；非 git / 失败 → undefined，不改变验证语义）。
   */
  private async probeCommitSha(
    workspacePath: string,
    task: Task,
    agentRunId?: string
  ): Promise<string | undefined> {
    try {
      const result = await this.runTool(
        "run_command",
        { command: "git rev-parse HEAD", timeoutMs: 15_000 },
        { task, workspacePath, agentRunId, checkName: "git-commit" }
      );
      if (!result.success) return undefined;
      const head = outputText(result, "stdout").trim().split("\n")[0]?.trim() ?? "";
      return /^[0-9a-f]{7,40}$/.test(head) ? head : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * F1-5（FX-17）/ PL-M2（`docs/158` §3）：切片边界检查——由**该切片最后一个经验证门的任务**
   * （其余同类任务均已 SUCCESS）运行，运行该切片**全部**任务涉及的 AC 的测试（AC 并集）：
   * node --test 走 pattern 真选取，其余走全量 + 结果面选取。
   * 失败作为检查失败进入判定（enforce 下随失败策略）；`SLICE_BOUNDARY_CHECKED` 事件留痕。
   *
   * PL-M2 的两处放宽（原为「切片最后一个**实现**任务 + 只取实现任务的 AC」）：
   * - **锚点**：不再要求锚点是实现类任务——只有 TEST 任务的切片此前没有锚点，边界检查永不触发，
   *   红测试因此一路走到 CI 才炸（`docs/158` §1.3）。
   * - **AC 范围**：并集改为取**切片全部任务**的 `acKeys`。原实现只取实现任务的，导致只被 TEST
   *   任务引用的 AC（run 3 slice-5 的 AC-24/25/26/29/30）**从不进入边界检查的范围**。
   *
   * 交付链任务（带 `delivery` 块，由 DeliveryOrchestrator 执行）**不作锚点**：它们不经过本验证门，
   * 且总在切片末尾 PENDING（CI 在 REVIEW 之后、DEPLOY 更后），计入锚点条件会让检查**永不触发**——
   * 那正是本项要消除的失效模式。它们的 `acKeys` 仍计入范围（只是可能没有对应测试）。
   */
  private async maybeSliceBoundaryCheck(input: {
    workflow: WorkflowRun;
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
    commitSha?: string;
  }): Promise<{
    checks: VerificationCheckEvidence[];
    skipped: string | null;
    smokeSkipped?: string;
    testIdContractSkipped?: string;
    visualSkipped?: string;
  }> {
    const { workflow, task, workspacePath, agentRunId, facts, commitSha } = input;
    const loadTasks = this.dependencies.workflowTasks;
    if (!loadTasks) return { checks: [], skipped: "no-workflow-tasks-dependency" };
    if (!task.sliceKey) return { checks: [], skipped: "no-slice-key" };
    const scriptText = typeof facts.scripts.test === "string" ? facts.scripts.test : "";

    let tasks: Task[];
    try {
      tasks = await loadTasks(workflow.id);
    } catch {
      return { checks: [], skipped: "load-tasks-failed" };
    }
    const sliceTasks = tasks.filter((entry) => entry.sliceKey === task.sliceKey);
    const anchorSiblings = sliceTasks.filter(
      (entry) => entry.id !== task.id && !hasDeliveryBlock(entry)
    );
    // 仅当其余（非交付链）任务均已收尾——本任务即切片最后一个经验证门的任务。
    //
    // N-35（`docs/146`）：**不能用 `status !== "SUCCESS"` 直接判**。replan 之后**源任务行永远是
    // `FAILED`**（重试是另一行新任务，`source_task_id` 指回），于是「发生过 replan 的切片」
    // 一律拿不到边界检查——全库普查 169 个含 FAILED 的工作流里 **145 个（86%）没有任何边界检查**。
    // 判定改走 PL-M19 的 `isFailureResolved`（沿 `resolvedByTaskId` 链走到头），**不另立第二套
    //「已解决」定义**（`docs/160` 的漂移成因）。`BLOCKED` / `CANCELLED` / 仍在跑的一律仍算未收尾。
    //
    // N-50（`docs/232` §9.16）：本方法在 verify 内部跑，此刻**正在验证的这个任务**那一行还是
    // `RUNNING`（SUCCESS 是验证通过之后才写回）。replan 出的解决者恰好就是切片最后一个任务时，
    // `isFailureResolved` 沿链走到它、见「非 SUCCESS」就判源任务未解决 ⇒ 边界检查恒不触发
    // （第七次回归的 S1：工作流 SUCCESS、`SLICE_BOUNDARY_CHECKED` 零条）。故把「当前任务」
    // 作为 `pendingSuccessId` 交给同一个判定函数——它马上就成功；若它验证失败，任务本来就判失败，
    // 边界检查的结论不影响任何东西。
    const byId = new Map(tasks.map((entry) => [entry.id, entry]));
    const pendingSiblings = anchorSiblings.filter(
      (entry) =>
        entry.status !== "SUCCESS" &&
        !(
          entry.status === "FAILED" &&
          isFailureResolved(entry, byId, { pendingSuccessId: task.id })
        )
    );
    if (pendingSiblings.length > 0) {
      // 观测（PL-M40 后续）：把「谁没收尾」写进跳过原因，批次后可直接查库定位。
      const detail = pendingSiblings
        .map((entry) => `${entry.taskKey}:${entry.status}`)
        .join(",");
      return { checks: [], skipped: `siblings-unfinished:${detail}` };
    }

    // N-49（`docs/232` §9.14）：先做**真实进程**冒烟，再做下面那条「同一条测试命令再跑一遍」。
    // 起进程与打路由必须在同一条沙箱命令里完成（每条命令都是新容器），见 `serverSmoke.ts`。
    //
    // `docs/235` §4.3 / `docs/233` §5.2：**边界门由能力 profile 选**——`server` 探 HTTP 路由，
    // `ui` 探页面与 testid，`none` 不设边界门。缺省 profile 仍是 `backend-node`（`server`），
    // 所以既有批次的行为一字不改；这也是第 3 步「切回 server 即回滚」的落点。
    const checks: VerificationCheckEvidence[] = [];
    const boundaryKind = (this.dependencies.profile ?? DEFAULT_CAPABILITY_PROFILE).boundaryCheck;
    const smokeInput = {
      task,
      workspacePath,
      agentRunId,
      facts,
      sliceTasks,
      ...(commitSha ? { commitSha } : {})
    };
    const smoke =
      boundaryKind === "ui"
        ? await this.uiSmokeCheck(smokeInput)
        : boundaryKind === "server"
          ? await this.serverSmokeCheck(smokeInput)
          : { check: null, skipped: "boundary-check-disabled" };
    if (smoke.check) checks.push(smoke.check);
    const smokeSkipped = smoke.skipped ?? undefined;
    // N-64（`docs/232` §10）：testid 命名契约。**与冒烟解耦**——冒烟要起进程、要 start 脚本，
    // 而「名字是不是自创的」只看源码，起不来进程时同样要判。
    const contract =
      boundaryKind === "ui"
        ? await this.testIdContractCheck({ task, workspacePath, agentRunId })
        : { check: null, skipped: "boundary-check-disabled" };
    if (contract.check) checks.push(contract.check);
    const testIdContractSkipped = contract.skipped ?? undefined;

    // docs/256：官方 Playwright E2E 只在切片末（本方法的锚点）跑，不进中间任务的 test 门。
    const e2eOutcome = await this.sliceEndE2eCheck({
      task,
      workspacePath,
      agentRunId,
      facts,
      ...(commitSha ? { commitSha } : {})
    });
    if (e2eOutcome.check) checks.push(e2eOutcome.check);

    const visualOutcome = await this.sliceEndVisualCheck({
      workflow,
      task,
      workspacePath,
      agentRunId,
      facts,
      sliceTasks,
      ...(commitSha ? { commitSha } : {})
    });
    if (visualOutcome.check) checks.push(visualOutcome.check);
    const visualSkipped = visualOutcome.skipped ?? undefined;

    const finish = (
      skipped: string | null
    ): {
      checks: VerificationCheckEvidence[];
      skipped: string | null;
      smokeSkipped?: string;
      testIdContractSkipped?: string;
      visualSkipped?: string;
    } => ({
      checks,
      skipped,
      ...(smokeSkipped ? { smokeSkipped } : {}),
      ...(testIdContractSkipped ? { testIdContractSkipped } : {}),
      ...(visualSkipped ? { visualSkipped } : {})
    });

    // PL-M8：本任务的 AC 在前、同切片其余任务在后（保持 F1-5 既有的顺序语义）。
    const acKeys = sliceAcKeys(sliceTasks, task);
    if (scriptText === "") return finish("no-test-script");
    if (acKeys.length === 0) return finish("no-ac-keys");

    const boundaryPlan = planPackageScriptCommand("test", facts);
    const baseCommand = boundaryPlan.command ?? "npm run test";
    const probedTestFiles = await this.probeAcTestFiles(acKeys, workspacePath, task, agentRunId);
    const scopedCommand = buildAcScopedTestCommand(
      baseCommand,
      acKeys,
      scriptText,
      this.timeoutMs,
      probedTestFiles
    );
    if (!scopedCommand || scopedCommandUsesNonCanonicalTestFiles(scopedCommand)) {
      const boundaryCheck = acScopeCommandFailure({
        name: "slice-boundary",
        expected: "pass",
        baseCommand: scopedCommand ?? baseCommand,
        acKeys,
        probedTestFiles: !scopedCommand ? probedTestFiles : probedTestFiles ?? [],
        commitSha
      });
      checks.push(boundaryCheck);
      await this.sliceBoundaryEvent(workflow, task, agentRunId, false, acKeys);
      return finish(null);
    }
    const scopingMode: AcScopingMode = "command-filter";
    // `docs/235` §6.8：同因——边界检查的「作用域 AC 全过」也需要逐条结果。
    const command = withTestReporter(
      scopedCommand,
      scriptText,
      (this.dependencies.profile ?? DEFAULT_CAPABILITY_PROFILE).testParser
    );
    const scope = new Set(acKeys.map(canonicalAcKey));

    const attempts: VerificationCheckAttempt[] = [];
    const startedMs = Date.now();
    let last: ToolResult | undefined;
    let passed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      last = await this.runTool(
        "run_unit_test",
        { command, timeoutMs: this.timeoutMs },
        { task, workspacePath, agentRunId, checkName: "slice-boundary" }
      );
      const exitCode = outputField(last, "exitCode");
      const exitCodeNumber = typeof exitCode === "number" ? exitCode : null;
      const timedOut =
        outputField(last, "timedOut") === true || last.error?.code === "TIMEOUT_ERROR";
      attempts.push({ exitCode: exitCodeNumber, durationMs: last.duration, timedOut });
      if (last.error?.code === "CANCELLED_ERROR") break;
      const parsed = parseAcResults(`${outputText(last, "stdout")}\n${outputText(last, "stderr")}`);
      const relevant = Object.entries(parsed).filter(([key]) => scope.has(canonicalAcKey(key)));
      const allRelevantPassed =
        relevant.length > 0 && relevant.every(([, value]) => value === "passed");
      // N-26（`docs/146`）：command-filter 判定——「切片 AC 全过」即通过（兄弟钩子失败不拖死本切片）。
      // `allRelevantPassed` 自带 `relevant.length > 0` 的前置条件 ⇒ **一条 AC 结果都没解析出来仍然判失败**
      // （N-10 的空转防线不放松）。
      // 反向边界（PL-M20 / N-13）：**超时不适用这条放宽**——命令没返回就不算有证据。
      const achieved = !timedOut && allRelevantPassed;
      if (achieved) {
        passed = true;
        break;
      }
    }

    const stdout = last ? outputText(last, "stdout") : "";
    const stderr = last ? outputText(last, "stderr") : "";
    const finalAttempt = attempts[attempts.length - 1];
    const checkAcResults = parseAcResults(`${stdout}\n${stderr}`);
    const relevantResults = Object.fromEntries(
      Object.entries(checkAcResults).filter(([key]) => scope.has(canonicalAcKey(key)))
    );
    await this.sliceBoundaryEvent(workflow, task, agentRunId, passed, acKeys);
    const boundaryCheck: VerificationCheckEvidence = {
      name: "slice-boundary",
      command,
      expected: "pass",
      passed,
      exitCode: finalAttempt?.exitCode ?? null,
      timedOut: finalAttempt?.timedOut ?? false,
      // N-13（PL-M20）：与 `test` 检查同口径——这条检查跑的是**同一条**作用域命令，
      // 它没返回时同样要能命名，否则账本上只有一半的挂死是可见的。
      ...(!passed && finalAttempt?.timedOut
        ? { failureCode: CHECK_TIMEOUT_FAILURE_CODE }
        : !passed &&
            Object.keys(relevantResults).length === 0 &&
            scopedCommandUsesNonCanonicalTestFiles(command)
          ? { failureCode: "PROBE_FAILURE" as const }
          : {}),
      attempts,
      flaked: passed && attempts.length > 1,
      outputDigest: digestText(`${stdout}\n${stderr}`),
      stdoutTail: tailText(stdout),
      stderrTail: tailText(stderr),
      durationMs: Date.now() - startedMs,
      ...(Object.keys(relevantResults).length > 0 ? { acResults: relevantResults } : {}),
      ...(commitSha ? { commitSha } : {}),
      scopedAcKeys: [...acKeys],
      scopingMode
    };
    checks.push(boundaryCheck);
    return finish(null);
  }

  /**
   * docs/256：切片末官方 Playwright E2E。
   * 只在 `maybeSliceBoundaryCheck` 的锚点（切片最后一个经验证门的任务）调用；
   * 中间 FRONTEND / TEST / BUILD 的计划检查不会加入这条。
   */
  private async sliceEndE2eCheck(input: {
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
    commitSha?: string;
  }): Promise<{ check: VerificationCheckEvidence | null; skipped?: string }> {
    const { task, workspacePath, agentRunId, facts, commitSha } = input;
    const scriptName = resolveSliceEndE2eScriptName(facts.scripts);
    if (!scriptName) return { check: null, skipped: "no-e2e-script" };
    const commandPlan = planPackageScriptCommand(scriptName, facts);
    const command = capPlaywrightWorkers(commandPlan.command ?? `npm run ${scriptName}`);
    const startedMs = Date.now();
    const contract = inspectWorkspacePlaywright({ workspaceRoot: workspacePath });
    if (contract.contractMismatch) {
      const reason = playwrightContractMismatchReason(contract);
      return {
        check: {
          name: "e2e",
          command,
          expected: "pass",
          passed: false,
          exitCode: null,
          timedOut: false,
          attempts: [],
          flaked: false,
          outputDigest: digestText(reason),
          stdoutTail: "",
          stderrTail: reason,
          durationMs: Date.now() - startedMs,
          failureCode: "ENV_GAP",
          ...(commitSha ? { commitSha } : {})
        }
      };
    }
    const preflight = e2eBrowserPreflight({
      scripts: facts.scripts,
      command,
      workspaceRoot: workspacePath
    });
    if (preflight && !preflight.ok) {
      return {
        check: {
          name: "e2e",
          command,
          expected: "pass",
          passed: false,
          exitCode: null,
          timedOut: false,
          attempts: [],
          flaked: false,
          outputDigest: digestText(preflight.reason),
          stdoutTail: "",
          stderrTail: preflight.reason,
          durationMs: Date.now() - startedMs,
          failureCode: "ENV_GAP",
          ...(commitSha ? { commitSha } : {})
        }
      };
    }

    // 工具入参 timeoutMs 上限仍是 120s（防 agent 乱填）；官方 E2E 把超时放在
    // 运行时 context 和 commandTools 的 Playwright 抬升里，不走 schema。
    const last = await this.runTool(
      "run_unit_test",
      { command },
      { task, workspacePath, agentRunId, checkName: "e2e", timeoutMs: E2E_CHECK_TIMEOUT_MS }
    );
    const exitCode = outputField(last, "exitCode");
    const exitCodeNumber = typeof exitCode === "number" ? exitCode : null;
    const timedOut = outputField(last, "timedOut") === true || last.error?.code === "TIMEOUT_ERROR";
    const stdout = outputText(last, "stdout");
    const stderr = outputText(last, "stderr");
    const passed = !timedOut && last.error?.code !== "CANCELLED_ERROR" && exitCodeNumber === 0;
    let failureCode: VerificationFailureCode | undefined;
    if (!passed) {
      if (matchesPlaywrightEnvGap(`${stdout}\n${stderr}`)) failureCode = "ENV_GAP";
      else if (timedOut) failureCode = CHECK_TIMEOUT_FAILURE_CODE;
    }
    return {
      check: {
        name: "e2e",
        command,
        expected: "pass",
        passed,
        exitCode: exitCodeNumber,
        timedOut,
        attempts: [{ exitCode: exitCodeNumber, durationMs: last.duration, timedOut }],
        flaked: false,
        outputDigest: digestText(`${stdout}\n${stderr}`),
        stdoutTail: tailText(stdout),
        stderrTail: tailText(stderr),
        durationMs: Date.now() - startedMs,
        ...(failureCode ? { failureCode } : {}),
        ...(commandPlan.warnings.length > 0 ? { warnings: commandPlan.warnings } : {}),
        ...(commitSha ? { commitSha } : {})
      }
    };
  }

  /**
   * docs/265：切片末官方视觉审查。时机与官方 E2E 相同（本方法只由 maybeSliceBoundaryCheck 调用）。
   * 在跑起来的应用里打开关键态，对照已挂 UI 基线做设计意图验收，不是像素还原。
   */
  private async sliceEndVisualCheck(input: {
    workflow: WorkflowRun;
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
    sliceTasks: Task[];
    commitSha?: string;
  }): Promise<{ check: VerificationCheckEvidence | null; skipped?: string }> {
    const { workflow, task, workspacePath, agentRunId, facts, sliceTasks, commitSha } = input;
    const profile = this.dependencies.profile;
    const uiFacing = isUiFacingVisualWork({ profile, sliceTasks });
    if (!uiFacing) return { check: null, skipped: "not-ui-facing" };
    const loadBaselines = this.dependencies.visualBaselines;
    if (!loadBaselines) return { check: null, skipped: "no-visual-baselines-loader" };

    const startedMs = Date.now();
    const requirementId = workflow.requirementId;
    const baselines = requirementId ? await loadBaselines(requirementId) : [];
    const requirementText =
      requirementId && this.dependencies.requirementText
        ? await this.dependencies.requirementText(requirementId)
        : undefined;
    const inventory = buildVisualInventory({
      baselines,
      ...(requirementText ? { requirementText } : {})
    });

    const failedCheck = (
      failureCode: OfficialVisualFailureCode,
      reason: string,
      command: string,
      extra?: {
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
        timedOut?: boolean;
        capture?: NonNullable<ReturnType<typeof parseOfficialVisualOutput>>;
        judged?: "deterministic" | "deterministic+intent-judge" | "none";
      }
    ): { check: VerificationCheckEvidence } => ({
      check: {
        name: OFFICIAL_VISUAL_CHECK_NAME,
        command,
        expected: "pass",
        passed: false,
        exitCode: extra?.exitCode ?? null,
        timedOut: extra?.timedOut ?? false,
        attempts: [
          {
            exitCode: extra?.exitCode ?? null,
            durationMs: Date.now() - startedMs,
            timedOut: extra?.timedOut ?? false
          }
        ],
        flaked: false,
        outputDigest: digestText(`${extra?.stdout ?? ""}\n${extra?.stderr ?? reason}`),
        stdoutTail: tailText(extra?.stdout ?? ""),
        stderrTail: tailText(extra?.stderr ?? reason),
        durationMs: Date.now() - startedMs,
        failureCode,
        ...(commitSha ? { commitSha } : {}),
        visual: officialVisualProjection({
          passed: false,
          failureCode,
          reason,
          inventory,
          judged: extra?.judged ?? "deterministic",
          ...(extra?.capture ? { capture: extra.capture } : {})
        })
      }
    });

    const missingEval = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory
    });
    if (missingEval.failureCode === "VISUAL_BASELINE_MISSING") {
      return failedCheck(
        "VISUAL_BASELINE_MISSING",
        missingEval.reason,
        "official-visual-gate:baseline"
      );
    }

    const scriptName = resolveVisualAppScriptName(facts.scripts);
    if (!scriptName) {
      return failedCheck(
        "VISUAL_CAPTURE_FAILED",
        "工作区没有 start / preview / dev 脚本，无法在跑起来的应用里做官方视觉审查",
        "official-visual-gate:no-app-script"
      );
    }

    const startCommand =
      planPackageScriptCommand(scriptName, facts).command ?? `npm run ${scriptName}`;
    const appPort = 48000 + Math.floor(Math.random() * 3000);
    const mockCommand = planPackageScriptCommand("mock", facts).command;
    const buildCommand = planPackageScriptCommand("build", facts).command;
    const command = buildOfficialVisualCommand({
      startCommand,
      port: appPort,
      inventory,
      ...(mockCommand
        ? {
            mockCommand,
            mockPort: appPort + 3000,
            ...(buildCommand ? { buildCommand } : {})
          }
        : {})
    });

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    try {
      const run = await this.runTool(
        "run_command",
        { command, timeoutMs: OFFICIAL_VISUAL_COMMAND_TIMEOUT_MS },
        {
          task,
          workspacePath,
          agentRunId,
          checkName: "visual",
          timeoutMs: OFFICIAL_VISUAL_COMMAND_TIMEOUT_MS
        }
      );
      stdout = outputText(run, "stdout");
      stderr = outputText(run, "stderr");
      const rawExit = outputField(run, "exitCode");
      exitCode = typeof rawExit === "number" ? rawExit : null;
      timedOut = outputField(run, "timedOut") === true || run.error?.code === "TIMEOUT_ERROR";
    } catch (error) {
      const data = (error as { data?: Record<string, unknown> }).data;
      if (data) {
        stdout = typeof data.stdout === "string" ? data.stdout : stdout;
        stderr = typeof data.stderr === "string" ? data.stderr : stderr;
        timedOut = data.timedOut === true;
      } else {
        stderr = error instanceof Error ? error.message : String(error);
      }
    }

    const capture = parseOfficialVisualOutput(stdout);
    if (!capture) {
      return failedCheck(
        "VISUAL_CAPTURE_FAILED",
        "官方视觉探针没有返回可解析的对照记录",
        command,
        {
          stdout,
          stderr: stderr || "official visual probe produced no JSON capture",
          exitCode,
          timedOut
        }
      );
    }

    let judge: VisualIntentJudgeResult | undefined;
    if (this.dependencies.visualIntentJudge) {
      try {
        judge = await this.dependencies.visualIntentJudge({ baselines, capture });
      } catch (error) {
        judge = {
          available: false,
          detail: error instanceof Error ? error.message : String(error)
        };
      }
    } else {
      judge = { available: false };
    }

    const evaluation = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture,
      judge
    });
    return {
      check: {
        name: OFFICIAL_VISUAL_CHECK_NAME,
        command,
        expected: "pass",
        passed: evaluation.passed,
        exitCode,
        timedOut,
        attempts: [{ exitCode, durationMs: Date.now() - startedMs, timedOut }],
        flaked: false,
        outputDigest: digestText(`${stdout}\n${stderr}`),
        stdoutTail: tailText(stdout),
        stderrTail: tailText(stderr || (evaluation.passed ? "" : evaluation.reason)),
        durationMs: Date.now() - startedMs,
        ...(!evaluation.passed && evaluation.failureCode
          ? { failureCode: evaluation.failureCode }
          : {}),
        ...(commitSha ? { commitSha } : {}),
        visual: officialVisualProjection({
          passed: evaluation.passed,
          ...(evaluation.failureCode ? { failureCode: evaluation.failureCode } : {}),
          reason: evaluation.reason,
          inventory: evaluation.inventory,
          capture,
          judged: evaluation.judged
        })
      }
    };
  }

  /**
   * N-49（`docs/232` §9.14）：**真实进程冒烟**。
   *
   * 第六次回归里 slice-auth-persistence 的边界检查判 `passed`（作用域 AC-01..AC-13），而同一时刻
   * `GET /api/register` 是 404——交付的是「模块 + 单元测试」，没人把路由挂进服务器；项目自己的
   * 136 条测试里 135 条是绿的（它们直接调 handler，不启动服务）。逐任务检查与边界检查跑的都是
   * **项目自己的测试**，只有 oracle 这个黑盒能看见「路由没挂」。
   *
   * 本检查补的就是黑盒视角：用项目声明的 `start` 脚本起一次真实进程，再按本切片验收标准里**点名**
   * 的路由打一遍 HTTP。判据只有一条——业务端点是否真的挂在运行中的服务上（健康端点只证明进程活着，
   * 不参与判定；业务正确性仍归测试与 oracle）。
   *
   * 跳过是**留痕**的（`smokeSkipped`），不静默：没有 `start` 脚本 / AC 文本里没点名任何业务路由 /
   * 启动失败属于环境问题（沙箱无外网、缺依赖）都不判交付缺陷。
   */
  private async serverSmokeCheck(input: {
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
    sliceTasks: Task[];
    commitSha?: string;
  }): Promise<{ check: VerificationCheckEvidence | null; skipped: string | null }> {
    const { task, workspacePath, agentRunId, facts, sliceTasks, commitSha } = input;
    const startScript = typeof facts.scripts.start === "string" ? facts.scripts.start : "";
    if (startScript === "") return { check: null, skipped: "no-start-script" };

    const routes = extractHttpRoutes(
      acceptanceTexts(sliceTasks.map((entry) => entry.input)),
      SMOKE_ROUTE_LIMIT
    );
    if (businessRoutes(routes).length === 0) return { check: null, skipped: "no-routes" };

    const startCommand = planPackageScriptCommand("start", facts).command ?? "npm run start";
    const command = buildServerSmokeCommand({
      startCommand,
      port: 43000 + Math.floor(Math.random() * 4000),
      routes,
      bootTimeoutMs: SMOKE_BOOT_TIMEOUT_MS,
      probeTimeoutMs: SMOKE_PROBE_TIMEOUT_MS
    });

    const startedMs = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let result: ServerSmokeResult | null;
    try {
      const run = await this.runTool(
        "run_command",
        { command, timeoutMs: SMOKE_COMMAND_TIMEOUT_MS },
        { task, workspacePath, agentRunId, checkName: "server-smoke" }
      );
      stdout = outputText(run, "stdout");
      stderr = outputText(run, "stderr");
      const rawExit = outputField(run, "exitCode");
      exitCode = typeof rawExit === "number" ? rawExit : null;
      timedOut = outputField(run, "timedOut") === true;
      result = parseServerSmokeOutput(stdout);
    } catch (error) {
      const data = (error as { data?: Record<string, unknown> }).data;
      if (data) {
        stdout = typeof data.stdout === "string" ? data.stdout : stdout;
        stderr = typeof data.stderr === "string" ? data.stderr : stderr;
        timedOut = data.timedOut === true;
      }
      result = parseServerSmokeOutput(stdout);
    }

    // 探测自身没跑出结论（命令没被执行 / 程序自身出错）时**不判交付缺陷**：门不能因为自己的探针坏了
    // 就把切片判死；跳过的事实进 `smokeSkipped`，批次后可见。
    if (!result) return { check: null, skipped: "PROBE_ERROR" };
    const verdict: ServerSmokeVerdict = evaluateServerSmoke(result, routes);
    // 环境类启动失败不判交付缺陷（沙箱无外网 / 缺依赖），但**留痕**——否则「没跑」会被读成「跑过了」。
    if (verdict.kind === "skipped") return { check: null, skipped: verdict.reason };
    const passed = verdict.kind === "passed";

    const evidence: VerificationCheckEvidence = {
      name: "server-smoke",
      command,
      expected: "pass",
      passed,
      exitCode,
      timedOut,
      attempts: [{ exitCode, durationMs: Date.now() - startedMs, timedOut }],
      flaked: false,
      outputDigest: digestText(`${stdout}\n${stderr}`),
      stdoutTail: tailText(stdout),
      stderrTail: tailText(stderr),
      durationMs: Date.now() - startedMs,
      ...(verdict.kind === "failed" ? { failureCode: verdict.failureCode } : {}),
      ...(commitSha ? { commitSha } : {}),
      smoke: {
        routes: routes.map((route) => `${route.method} ${route.path}`),
        booted: result?.booted ?? false,
        ...(result?.detectedPort ? { detectedPort: result.detectedPort } : {}),
        ...(result?.control ? { controlStatus: result.control.status } : {}),
        probes: (result?.probes ?? []).map((probe) => ({
          route: `${probe.method} ${probe.path}`,
          status: probe.status,
          ...(probe.error ? { error: probe.error } : {})
        })),
        ...(result?.stderrTail ? { processStderrTail: tailText(result.stderrTail) } : {}),
        ...(verdict.kind === "failed" ? { detail: verdict.detail } : {})
      }
    };
    return { check: evidence, skipped: null };
  }

  /**
   * `docs/233` §5.2 / `docs/235` §6 第 3 步：**UI 边界冒烟**——与 `serverSmokeCheck` 同一范式，
   * 只是判据从「业务路由挂没挂」换成「AC 点名的 testid 在不在渲染后的页面上」。
   *
   * 它补的是逐任务门看不见的那一块：一个 Vite SPA 可以 `build` 过、`lint` 过、单测全绿而页面白屏
   * （入口报错、组件没挂载），而那三个检查都不打开页面。
   *
   * 跳过一律留痕（`smokeSkipped`）：没有 `start` 脚本 / AC 没点名任何 testid / 只点名动态 testid /
   * 工作区没有可用浏览器 / 启动失败属于环境问题，都不判交付缺陷。
   */
  private async uiSmokeCheck(input: {
    task: Task;
    workspacePath: string;
    agentRunId?: string;
    facts: PackageFacts;
    sliceTasks: Task[];
    commitSha?: string;
  }): Promise<{ check: VerificationCheckEvidence | null; skipped: string | null }> {
    const { task, workspacePath, agentRunId, facts, sliceTasks, commitSha } = input;
    const startScript = typeof facts.scripts.start === "string" ? facts.scripts.start : "";
    if (startScript === "") return { check: null, skipped: "no-start-script" };

    const ids = extractTestIds(acceptanceTexts(sliceTasks.map((entry) => entry.input)));
    // 没点名任何 testid（或只点名运行期拼出来的）时**不跑**：起一次预览 + 开一次浏览器是实打实的成本，
    // 而结论只会是「没有可断言的东西」。跳过原因与 `evaluateUiSmoke` 同源。
    const skipReason = uiTestIdSkipReason(ids);
    if (skipReason) return { check: null, skipped: skipReason };

    const startCommand = planPackageScriptCommand("start", facts).command ?? "npm run start";
    // N-71（`docs/232` §10）：**起 mock 再探页面**。没有 `/api/tasks` 时应用首屏必然进错误态，
    // 列表项永远不在——只点名列表项 testid 的验收标准会被结构性判死（参考实现同样过不了）。
    // 与 oracle 同一套做法：先用 mock 端口重建（`VITE_API_BASE` 构建期内联），再起 mock、起应用。
    const appPort = 47000 + Math.floor(Math.random() * 3000);
    const mockCommand = planPackageScriptCommand("mock", facts).command;
    const buildCommand = planPackageScriptCommand("build", facts).command;
    const command = buildUiSmokeCommand({
      startCommand,
      port: appPort,
      testIds: staticTestIds(ids),
      bootTimeoutMs: UI_SMOKE_BOOT_TIMEOUT_MS,
      probeTimeoutMs: UI_SMOKE_PROBE_TIMEOUT_MS,
      settleMs: UI_SMOKE_SETTLE_MS,
      ...(mockCommand
        ? {
            mockCommand,
            mockPort: appPort + 3000,
            ...(buildCommand ? { buildCommand } : {})
          }
        : {})
    });

    const startedMs = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let result: UiSmokeResult | null;
    try {
      const run = await this.runTool(
        "run_command",
        { command, timeoutMs: UI_SMOKE_COMMAND_TIMEOUT_MS },
        { task, workspacePath, agentRunId, checkName: "ui-smoke" }
      );
      stdout = outputText(run, "stdout");
      stderr = outputText(run, "stderr");
      const rawExit = outputField(run, "exitCode");
      exitCode = typeof rawExit === "number" ? rawExit : null;
      timedOut = outputField(run, "timedOut") === true;
      result = parseUiSmokeOutput(stdout);
    } catch (error) {
      const data = (error as { data?: Record<string, unknown> }).data;
      if (data) {
        stdout = typeof data.stdout === "string" ? data.stdout : stdout;
        stderr = typeof data.stderr === "string" ? data.stderr : stderr;
        timedOut = data.timedOut === true;
      }
      result = parseUiSmokeOutput(stdout);
    }

    // 探针自身出错不判交付缺陷（门不能因为自己的探针坏了就把切片判死）。
    if (!result) return { check: null, skipped: "PROBE_ERROR" };
    const verdict: UiSmokeVerdict = evaluateUiSmoke(result, ids);
    if (verdict.kind === "skipped") return { check: null, skipped: verdict.reason };
    const passed = verdict.kind === "passed";

    const evidence: VerificationCheckEvidence = {
      name: "ui-smoke",
      command,
      expected: "pass",
      passed,
      exitCode,
      timedOut,
      attempts: [{ exitCode, durationMs: Date.now() - startedMs, timedOut }],
      flaked: false,
      outputDigest: digestText(`${stdout}\n${stderr}`),
      stdoutTail: tailText(stdout),
      stderrTail: tailText(stderr),
      durationMs: Date.now() - startedMs,
      ...(verdict.kind === "failed" ? { failureCode: verdict.failureCode } : {}),
      ...(commitSha ? { commitSha } : {}),
      ui: {
        testIds: staticTestIds(ids),
        present: result.present,
        pageStatus: result.pageStatus,
        browser: result.browser,
        consoleErrors: result.consoleErrors,
        ...(result.browserError ? { browserError: tailText(result.browserError) } : {}),
        ...(result.stderrTail ? { processStderrTail: tailText(result.stderrTail) } : {}),
        ...(typeof result.mockBooted === "boolean" ? { mockBooted: result.mockBooted } : {}),
        ...(result.buildExitCode !== undefined ? { buildExitCode: result.buildExitCode } : {}),
        ...(verdict.kind === "failed" ? { detail: verdict.detail } : {})
      }
    };
    return { check: evidence, skipped: null };
  }

  /**
   * N-64（`docs/232` §10）：**testid 命名契约**——源码里不得出现需求没声明过的 testid。
   *
   * 实测（2026-10-29 F1 第四轮）：PRD 第四节给了一张 testid 定值表并写明「命名不得自创、不得改写」，
   * 而 `task-title-input` **在任何一条 AC 文本里都没出现** ⇒ `ui-smoke` 的判据（「AC 点名的 testid
   * 在不在页面上」）对它视而不见 ⇒ agent 写成 `new-task-title`，AC-07/08/09/10 四条 Must 全失败。
   *
   * 判据方向刻意是「**不得自创**」而不是「必须全部到位」：后者会把还没写到的那部分判死，而
   * 「出现了需求里没有的名字」在任何一个切片边界上都成立，因而能早判、判得准。
   *
   * 取不到需求原文 / 需求没声明任何契约名 ⇒ 跳过并留痕（`no-requirement-text` /
   * `no-contracted-testids`），**不判交付缺陷**——没有契约文本就没有判据。
   */
  private async testIdContractCheck(input: {
    task: Task;
    workspacePath: string;
    agentRunId?: string;
  }): Promise<{ check: VerificationCheckEvidence | null; skipped: string | null }> {
    const { task, workspacePath, agentRunId } = input;
    const requirementId = task.input.requirementId;
    const loadText = this.dependencies.requirementText;
    if (typeof requirementId !== "string" || loadText === undefined) {
      return { check: null, skipped: "no-requirement-text" };
    }
    let text: string | undefined;
    try {
      text = await loadText(requirementId);
    } catch {
      return { check: null, skipped: "no-requirement-text" };
    }
    if (typeof text !== "string" || text.trim() === "") {
      return { check: null, skipped: "no-requirement-text" };
    }
    const allowed = extractContractTestIds(text);
    if (allowed.length === 0) return { check: null, skipped: "no-contracted-testids" };

    const command = buildTestIdUsageScanCommand();
    const startedMs = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let used: ReturnType<typeof parseTestIdUsageScan>;
    try {
      const run = await this.runTool(
        "run_command",
        { command, timeoutMs: UI_SMOKE_COMMAND_TIMEOUT_MS },
        { task, workspacePath, agentRunId, checkName: "testid-contract" }
      );
      stdout = outputText(run, "stdout");
      stderr = outputText(run, "stderr");
      const rawExit = outputField(run, "exitCode");
      exitCode = typeof rawExit === "number" ? rawExit : null;
      timedOut = outputField(run, "timedOut") === true;
      used = parseTestIdUsageScan(stdout);
    } catch (error) {
      const data = (error as { data?: Record<string, unknown> }).data;
      if (data) {
        stdout = typeof data.stdout === "string" ? data.stdout : stdout;
        stderr = typeof data.stderr === "string" ? data.stderr : stderr;
        timedOut = data.timedOut === true;
      }
      used = parseTestIdUsageScan(stdout);
    }
    // 探针自身出错不判交付缺陷（门不能因为自己的探针坏了就把切片判死），与两条冒烟同一口径。
    if (!used) return { check: null, skipped: "PROBE_ERROR" };

    const violations = testIdContractViolations(used, allowed);
    const passed = violations.length === 0;
    const detail = violations.map((entry) => `${entry.id} (${entry.file || "?"})`).join("\n");
    const evidence: VerificationCheckEvidence = {
      name: "testid-contract",
      command,
      expected: "pass",
      passed,
      exitCode,
      timedOut,
      attempts: [{ exitCode, durationMs: Date.now() - startedMs, timedOut }],
      flaked: false,
      outputDigest: digestText(`${stdout}\n${stderr}`),
      // 失败时把「哪个名字、在哪个文件」直接放进证据——批次归因不必再去复现扫描。
      stdoutTail: tailText(passed ? stdout : detail),
      stderrTail: tailText(stderr),
      durationMs: Date.now() - startedMs,
      ...(passed ? {} : { failureCode: "TESTID_CONTRACT_VIOLATION" as const })
    };
    return { check: evidence, skipped: null };
  }

  private async sliceBoundaryEvent(
    workflow: WorkflowRun,
    task: Task,
    agentRunId: string | undefined,
    passed: boolean,
    acKeys: string[]
  ): Promise<void> {
    if (!this.dependencies.events) return;
    await this.dependencies.events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId,
      eventType: "SLICE_BOUNDARY_CHECKED",
      payload: sanitizeLogData({
        sliceKey: task.sliceKey,
        taskKey: task.taskKey,
        verdict: passed ? "passed" : "failed",
        acKeys
      }) as JsonObject
    });
  }

  private async runTool(
    toolName: string,
    input: JsonObject,
    options: { task: Task; workspacePath: string; agentRunId?: string; checkName: string; timeoutMs?: number }
  ): Promise<ToolResult> {
    const context: ToolExecutionContext = {
      requestId: randomUUID(),
      projectId: options.task.projectId,
      // 7-A：验证检查的工具日志也带工作流（任务本身即属于该工作流）。
      workflowRunId: options.task.workflowRunId,
      taskId: options.task.id,
      agentRunId: options.agentRunId ?? randomUUID(),
      toolCallId: randomUUID(),
      actor: "TaskVerifier",
      workspacePath: options.workspacePath,
      sandbox: this.dependencies.sandbox,
      logger: this.logger,
      // 沙箱自身超时先于运行时超时触发（超时以沙箱结果形式回来，错误更清晰）。
      timeoutMs: (options.timeoutMs ?? this.timeoutMs) + 5_000,
      metadata: { verification: true, check: options.checkName },
      // N-67：检查前装依赖要拿到 registry 网络。判据与执行器**同源**——由能力面决定，
      // 不由调用方参数决定（否则 agent 又能通过构造参数给自己开网）。
      ...((this.dependencies.profile ?? DEFAULT_CAPABILITY_PROFILE).dependencyNetwork === "registry"
        ? { dependencyInstallAllowed: true }
        : {}),
      ...(options.agentRunId && this.dependencies.toolCalls
        ? { toolCallRecorder: this.dependencies.toolCalls }
        : {})
    };
    return this.runtime.execute(toolName, input, context);
  }

  private async recordEvent(
    workflow: WorkflowRun,
    task: Task,
    agentRunId: string | undefined,
    record: TaskVerificationRecord
  ): Promise<void> {
    if (!this.dependencies.events) return;
    await this.dependencies.events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId,
      eventType: "TASK_VERIFICATION",
      payload: sanitizeLogData({
        mode: record.mode,
        verdict: record.verdict,
        taskType: record.taskType,
        reason: record.reason,
        // F1-6（FX-20）：新批次按诊断码统计（checks[].code / failureCode）。
        ...(record.failureCode ? { failureCode: record.failureCode } : {}),
        checks: record.checks.map((check) => ({
          name: check.name,
          passed: check.passed,
          exitCode: check.exitCode,
          attempts: check.attempts.length,
          flaked: check.flaked,
          ...(check.failureCode ? { code: check.failureCode } : {})
        })),
        acChecked: record.acSummary?.total ?? 0,
        acFailed: record.acSummary?.failed ?? 0,
        antiTamper: record.antiTamper?.verdict,
        durationMs: record.durationMs,
        ...(record.commitSha ? { commitSha: record.commitSha } : {}),
        ...(record.writeScope
          ? {
              writeScope: {
                mode: record.writeScope.mode,
                outcome: record.writeScope.outcome,
                violations: record.writeScope.violations.length,
                checked: record.writeScope.checked,
                ...(record.writeScope.reason ? { scopeReason: record.writeScope.reason } : {})
              }
            }
          : {})
      }) as JsonObject
    });
  }

  /**
   * PL-M9 9a（`docs/166` §3）：检查不可判定事件——本类型**有**候选检查、但工作区缺对应 script，
   * 因此该任务一条检查都没跑。此前这种情形与「本类型没有客观检查」共用一个 `unavailable` 记录，
   * 在批次层面完全不可见（红灯检查整片缺席而无人知晓）。
   * 纯观察：不产生错误码、不影响判定；与 PL-M7 7b 的 `PLAN_TEST_TASK_UNANCHORED` 同一处置。
   */
  private async recordUndecidableCheckEvent(
    workflow: WorkflowRun,
    task: Task,
    agentRunId: string | undefined,
    missingChecks: VerificationCheckName[]
  ): Promise<void> {
    if (!this.dependencies.events) return;
    await this.dependencies.events.create({
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId,
      eventType: "TASK_CHECK_UNAVAILABLE",
      payload: sanitizeLogData({
        stage: "task_verification",
        taskKey: task.taskKey,
        taskType: task.type,
        sliceKey: task.sliceKey ?? null,
        missing: [...missingChecks]
      }) as JsonObject
    });
  }
}
