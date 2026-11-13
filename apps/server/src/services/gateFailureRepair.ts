import {
  DEFAULT_CAPABILITY_PROFILE,
  isAutonomyAtLeastL1,
  isProfileAllowedRepairType,
  type CapabilityProfile,
  type JsonObject,
  type Task,
  type WorkflowPolicy
} from "@ai-se/shared";
import {
  extractOfficialEvidenceFingerprint,
  officialEvidenceFingerprintsEqual,
  type OfficialEvidenceFingerprint
} from "@ai-se/workflow-engine";
import {
  isStaleOrClearedPlaywrightEnvGapNarrative,
  matchesPlaywrightEnvGap,
  matchesPlaywrightResourceEnvGap,
  matchesPlaywrightMissingBinaryEnvGap
} from "./e2eBrowserPreflight";
import { scopedCommandUsesNonCanonicalTestFiles } from "./taskVerifierRules";
import { isOfficialVisualFailureCode } from "./officialVisualGate";

/**
 * 门禁 / QA / 验证门 / 超时 / 依赖失败 → 自治修复路由（纯函数）。
 *
 * 产品规则（docs/250）：工作流内、平台重试后仍失败的问题，只要有可行动证据，
 * 就必须进 REPLAN 修复，而不是停在「Approval withheld / 审批不通过 / FAIL_FAST 终态」。
 * 客观证据优先于 Agent 自报 SUCCESS。生产 DEPLOY 人工审批不在此绕过。
 */

const GATE_EVIDENCE_PATTERNS: readonly RegExp[] = [
  /\bexit(?:\s+code)?\s*[:=]?\s*127\b/i,
  /\bsh:\s*\d+:\s*\S+:\s*not found\b/i,
  /\b(?:vue-tsc|eslint|vitest|vite|tsc|webpack|rollup):\s*not found\b/i,
  /\bnpm\s+ERR!\b/i,
  /\bDEPENDENCIES_MISSING\b/,
  /\bVERIFICATION_FAILED\b/,
  /\bGATE_FAILURE\b/,
  /\bAGENT_TIMEOUT\b/,
  /\bTIMEOUT_ERROR\b/,
  /\bINFRA_RETRY_EXHAUSTED\b/,
  /\bSPEC_CONFLICT\b/,
  /\bTEST_FIXTURE_GAP\b/,
  /getActivePinia/i,
  /No active Pinia/i,
  /did you forget to install/i,
  /inject\(\) can only be used/i,
  /\bOBJECTIVE_EVIDENCE_FAILED\b/,
  /\bchecks?\s+failed\b/i,
  /\btype-check\b/i,
  /\blint\b.*\bfail/i,
  /\bApproval withheld\b/i,
  /\bapproval withheld\b/i,
  /\bAC-\d+\b.*\bnot met\b/i,
  /\bnode_modules\/\.bin\b/i,
  /Cannot find module @rollup\/rollup-linux/i,
  /Cannot find module @esbuild\/linux/i,
  /@rollup\/rollup-(linux|darwin)/i,
  /\btimed?\s*out\b/i,
  /\bECONNRESET\b/i,
  /\bsandbox\b.*\bfail/i,
  /\bENV_GAP\b/,
  /\bPROBE_FAILURE\b/,
  /\/opt\/ms-playwright\b/i,
  /chromium_headless_shell/i,
  /browserType\.launch/i,
  /Executable doesn'?t exist/i,
  /Please\s+run\s+npx\s+playwright\s+install/i,
  /\bDOCS_GAP\b/,
  /readme\.ac\d+/i,
  /engineering-gates.*README|README.*engineering-gates/i,
  /docs\/delivery-report/i,
  /项目介绍/,
  /目录结构/,
  /不在本次交付范围/
];

/** 自报 SUCCESS 时用于强制 FAILED 的更严证据（避免「提到 type-check」误杀）。 */
const OBJECTIVE_RED_PATTERNS: readonly RegExp[] = [
  /\bApproval withheld\b/i,
  /\bapproval withheld\b/i,
  /\bexit(?:\s+code)?\s*[:=]?\s*127\b/i,
  /\bsh:\s*\d+:\s*\S+:\s*not found\b/i,
  /\b(?:vue-tsc|eslint|vitest|vite|tsc):\s*not found\b/i,
  /Cannot find module @rollup\/rollup-linux/i,
  /Cannot find module @esbuild\/linux/i,
  /\btype-check fails?\b/i,
  /\bnpm run type-check fails?\b/i,
  /\bstill fail/i,
  /\bAC-\d+\b.*\bnot met\b/i,
  /\b\d+\s+(?:\[AC-[^\]]+\]\s+)?cases?\b.*\bstill fail/i,
  /\bTS\d{4}\b/,
  /\bVERIFICATION_FAILED\b/,
  /\bDEPENDENCIES_MISSING\b/,
  /\bVACUOUS_TEST\b/,
  /\bEVIDENCE_MISSING\b/,
  /\bOBJECTIVE_EVIDENCE_FAILED\b/,
  /\bchecks?\s+failed\b/i,
  /\bcontradictory\b.*\b(?:test|spec|assert)/i,
  /\bspec(?:ification)?\s+conflict\b/i,
  /\bENV_GAP\b/,
  /Executable doesn'?t exist/i,
  /\bDOCS_GAP\b/,
  /readme\.ac\d+/i,
  /docs\/delivery-report(?:\.md)?[^\n]{0,60}\b(?:is\s+)?(?:missing|absent|not found|not met|assertion(?:\s+fail)?)/i,
  /\b(?:missing|absent|not found|not met|assertion(?:\s+fail)?)\b[^\n]{0,60}docs\/delivery-report/i
];

const REPAIRABLE_ERROR_TYPES = new Set([
  "VERIFICATION_FAILED",
  "DEPENDENCIES_MISSING",
  "REPLAN_REQUESTED",
  "CI_FAILED",
  "BUILD_FAILED",
  "TEST_FAILED",
  "VACUOUS_TEST",
  "EVIDENCE_MISSING",
  "GATE_FAILURE",
  "AGENT_TIMEOUT",
  "TIMEOUT_ERROR",
  "INFRA_RETRY_EXHAUSTED",
  "SPEC_CONFLICT",
  "TEST_FIXTURE_GAP",
  "DOCS_GAP",
  "ENV_GAP",
  "PROBE_FAILURE",
  "OBJECTIVE_EVIDENCE_FAILED",
  "CHECK_TIMEOUT"
]);

/** 切片客观收尾闸覆盖的任务类型（docs/250 AFC-M1）。
 * DEBUG 不在此列：诊断任务由 VerifyingWorkflowTaskExecutor 强制 observe 收尾，
 * 产品门禁红不得覆盖诊断 SUCCESS（否则卡住 -REPLAN-N 依赖边）。
 */
export const OBJECTIVE_GATED_TASK_TYPES = new Set<Task["type"]>([
  "FRONTEND",
  "BACKEND",
  "DATABASE",
  "BUILD",
  "TEST",
  "REVIEW"
]);

export type AutonomyFailureClass =
  | "GATE_FAILURE"
  | "DEPENDENCIES_MISSING"
  | "AGENT_TIMEOUT"
  | "INFRA_RETRY_EXHAUSTED"
  | "SPEC_CONFLICT"
  | "TEST_FIXTURE_GAP"
  | "DOCS_GAP"
  | "ENV_GAP"
  | "PROBE_FAILURE"
  | "VISUAL"
  | "repair-exhausted"
  | "gate-failure";

export type GateRepairDecision =
  | {
      enter: true;
      strategy: "REPLAN";
      fixTaskType: string;
      reason: string;
      failureClass: AutonomyFailureClass;
      evidenceSummary: string;
    }
  | {
      enter: false;
      reason:
        | "no-evidence"
        | "repair-exhausted"
        | "unfixable-env-gap"
        | "unfixable-official-gate"
        | "production-deploy-approval"
        | "policy-disallows-replan";
      detail: string;
      failureClass?: AutonomyFailureClass;
      evidenceSummary?: string;
    };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectEvidenceText(parts: unknown[]): string {
  return parts
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (Array.isArray(part)) return part.map((entry) => String(entry));
      if (part && typeof part === "object") {
        try {
          return [JSON.stringify(part)];
        } catch {
          return [String(part)];
        }
      }
      return [];
    })
    .join("\n");
}

function evidenceBag(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

/** docs/257：E2E / 单测断言失败（Expected/Received、locator timeout、非零 FAIL 计数）。 */
export function matchesTestAssertionFailure(text: string): boolean {
  if (!text) return false;
  return [
    /\bExpected:\s/i,
    /\bReceived:\s/i,
    /\bError:\s*expect\(/i,
    /expect\([^)]*\)\.(?:to|not)/i,
    /locator\.[A-Za-z]+(?:\([^)]*\))?:\s*(?:Error:\s*)?Timeout/i,
    /\bTimeout\s+\d+ms\s+exceeded\b/i,
    /\bTest timeout of\s*\d+ms/i,
    /waiting for (?:locator|getByRole|getByText|getByLabel)/i,
    /\b\d+\s+passed\b[^\n]{0,80}\b\d+\s+failed\b/i,
    /\b\d+\s+failed\b[^\n]{0,80}\b\d+\s+passed\b/i,
    /\b[1-9]\d*\s+FAIL\b/,
    /\b[1-9]\d*\s+failed,?\s+\d+\s+(?:flaky|skipped|did not run|passed)/i
  ].some((pattern) => pattern.test(text));
}

/** 文本 / 结构化输出里是否含可行动的门禁或 QA 报错证据。 */
export function hasActionableFailureEvidence(input: {
  errorType?: string | undefined;
  errorMessage?: string | undefined;
  summary?: string | undefined;
  issues?: unknown;
  recommendations?: unknown;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
}): boolean {
  const errorType =
    asString(input.errorType) ??
    asString(input.output?.errorType) ??
    asString((input.verification as { failureCode?: unknown } | undefined)?.failureCode);
  if (errorType && REPAIRABLE_ERROR_TYPES.has(errorType)) return true;

  const verification = input.verification ?? (input.output?.verification as JsonObject | undefined);
  if (verification && typeof verification === "object") {
    const verdict = asString((verification as { verdict?: unknown }).verdict);
    if (verdict === "failed") return true;
    const checks = (verification as { checks?: unknown }).checks;
    if (Array.isArray(checks) && checks.some((check) => check && (check as { passed?: unknown }).passed === false)) {
      return true;
    }
  }

  const text = collectEvidenceText([
    input.errorMessage,
    input.summary,
    input.issues,
    input.recommendations,
    asString(input.output?.summary),
    input.output?.issues,
    input.output?.recommendations,
    asString(verification?.reason)
  ]);
  return GATE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text)) || matchesPlaywrightEnvGap(text);
}

/**
 * 自报 SUCCESS 但仍承认客观红灯（TASK-06 类）——比 hasActionableFailureEvidence 更严，
 * 避免「提到 type-check」误杀全绿交付。
 */
export function hasObjectiveRedEvidence(input: {
  errorType?: string | undefined;
  errorMessage?: string | undefined;
  summary?: string | undefined;
  issues?: unknown;
  recommendations?: unknown;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
}): boolean {
  const errorType =
    asString(input.errorType) ??
    asString(input.output?.errorType) ??
    asString((input.verification as { failureCode?: unknown } | undefined)?.failureCode);
  if (
    errorType &&
    REPAIRABLE_ERROR_TYPES.has(errorType) &&
    errorType !== "REPLAN_REQUESTED"
  ) {
    return true;
  }

  const verification = input.verification ?? (input.output?.verification as JsonObject | undefined);
  if (verification && typeof verification === "object") {
    const verdict = asString((verification as { verdict?: unknown }).verdict);
    if (verdict === "failed") return true;
    const checks = (verification as { checks?: unknown }).checks;
    if (Array.isArray(checks) && checks.some((check) => check && (check as { passed?: unknown }).passed === false)) {
      return true;
    }
  }

  const text = collectEvidenceText([
    input.errorMessage,
    input.summary,
    input.issues,
    input.recommendations,
    asString(input.output?.summary),
    input.output?.issues,
    input.output?.recommendations,
    asString(verification?.reason)
  ]);
  return OBJECTIVE_RED_PATTERNS.some((pattern) => pattern.test(text));
}


function failedOfficialChecks(verification?: JsonObject): Array<Record<string, unknown>> {
  const checks = Array.isArray(verification?.checks) ? verification!.checks : [];
  return checks.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { passed?: unknown }).passed !== true;
  });
}


const PACKAGES_FIELD_MISSING = /packages field missing or empty/i;

function officialFailedChecksText(verification?: JsonObject): string {
  return failedOfficialChecks(verification)
    .map((check) =>
      [asString(check.name), asString(check.command), asString(check.stderrTail), asString(check.stdoutTail), asString(check.failureCode)]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n")
    )
    .join("\n");
}

function isOfficialE2eOrInstallCheck(check: Record<string, unknown>): boolean {
  const name = asString(check.name) ?? "";
  const command = asString(check.command) ?? "";
  return (
    name === "e2e" ||
    /test:e2e(?:[:\s-]?install)?|playwright\s+install|npx\s+playwright|privileged playwright install/i.test(
      `${name} ${command}`
    )
  );
}

function officialE2eOrInstallText(verification?: JsonObject): string {
  return failedOfficialChecks(verification)
    .filter(isOfficialE2eOrInstallCheck)
    .map((check) =>
      [asString(check.name), asString(check.command), asString(check.stderrTail), asString(check.stdoutTail), asString(check.failureCode)]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n")
    )
    .join("\n");
}

/** docs/263：官方失败检查显示 pnpm workspace 配置错误，且官方 e2e/install 并未真正跑到浏览器。 */
export function officialLooksLikePackageWorkspaceFailure(verification?: JsonObject): boolean {
  const text = officialFailedChecksText(verification);
  if (!PACKAGES_FIELD_MISSING.test(text)) return false;
  return !officialLooksLikeCurrentEnvGap(verification);
}

/** docs/263：官方 e2e / install 检查本身出现了当前浏览器/安装 ENV_GAP。 */
/** docs/264：已盖上的 check/verification failureCode=ENV_GAP 也算，不只看可能被截断的 stdout/stderr。 */
function officialLooksLikeVisualFailure(
  verification?: JsonObject,
  errorType?: string
): boolean {
  if (isOfficialVisualFailureCode(errorType)) return true;
  if (isOfficialVisualFailureCode(asString(verification?.failureCode))) return true;
  return failedOfficialChecks(verification).some((check) => {
    const name = asString(check.name);
    const code = asString(check.failureCode);
    return name === "visual" && isOfficialVisualFailureCode(code);
  });
}

export function officialLooksLikeCurrentEnvGap(verification?: JsonObject): boolean {
  const e2eFailed = failedOfficialChecks(verification).filter(isOfficialE2eOrInstallCheck);
  if (e2eFailed.length === 0) return false;
  const text = officialE2eOrInstallText(verification);
  if (PACKAGES_FIELD_MISSING.test(text) && !matchesPlaywrightEnvGap(text) && !matchesPlaywrightResourceEnvGap(text)) {
    return false;
  }
  const stampedOnCheck = e2eFailed.some((check) => asString(check.failureCode) === "ENV_GAP");
  const stampedOnRecord = asString(verification?.failureCode) === "ENV_GAP";
  return (
    stampedOnCheck ||
    stampedOnRecord ||
    matchesPlaywrightEnvGap(text) ||
    matchesPlaywrightResourceEnvGap(text)
  );
}

/** docs/262：官方命令只点了嵌套残留 / 非正规测试根，且覆盖为 0。 */
export function officialLooksLikeProbeFailure(
  verification?: JsonObject,
  errorType?: string
): boolean {
  if (errorType === "PROBE_FAILURE") return true;
  if (asString(verification?.failureCode) === "PROBE_FAILURE") return true;
  const failed = failedOfficialChecks(verification);
  if (failed.some((check) => asString(check.failureCode) === "PROBE_FAILURE")) return true;
  for (const check of failed) {
    const name = asString(check.name);
    if (name !== "test" && name !== "slice-boundary") continue;
    const command = asString(check.command) ?? "";
    if (!scopedCommandUsesNonCanonicalTestFiles(command)) continue;
    const acResults = check.acResults;
    const resultKeys =
      acResults && typeof acResults === "object" && !Array.isArray(acResults)
        ? Object.keys(acResults as object)
        : [];
    if (resultKeys.length === 0) return true;
  }
  return false;
}

/**
 * docs/262：当前任务类型的写范围够不到官方红点
 * （探测路径 / 官方命令没跑到智能体改过的文件 / docs/** 被拒且红点就是文档）。
 */
export function isOfficialRedPointUnreachableByTaskType(input: {
  taskType?: Task["type"] | undefined;
  failureClass?: AutonomyFailureClass | undefined;
  errorType?: string | undefined;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
  summary?: string | undefined;
  issues?: unknown;
}): boolean {
  if (
    input.failureClass === "PROBE_FAILURE" ||
    officialLooksLikeProbeFailure(input.verification, input.errorType)
  ) {
    return true;
  }
  const writeScope = input.verification?.writeScope;
  const deniedPaths =
    writeScope && typeof writeScope === "object" && !Array.isArray(writeScope)
      ? (writeScope as { deniedPaths?: unknown }).deniedPaths
      : undefined;
  const denied = Array.isArray(deniedPaths)
    ? deniedPaths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const docsDenied = denied.some(
    (path) =>
      path === "docs" ||
      path.startsWith("docs/") ||
      path.includes("/docs/") ||
      (path.endsWith(".md") && path.includes("docs/"))
  );
  const text = collectEvidenceText([
    input.summary,
    input.issues,
    asString(input.verification?.reason),
    asString(input.verification?.failureCode),
    input.output
  ]);
  const officialRedIsDocs =
    input.failureClass === "DOCS_GAP" ||
    /Path is not writable:\s*docs\//i.test(text) ||
    (/docs\/(?:test-report|delivery-report)/i.test(text) &&
      /(?:assert|expect|not met|missing|未|缺少|不包含|Path is not writable)/i.test(text));
  if (!docsDenied || !officialRedIsDocs) return false;
  return (
    input.taskType === "TEST" ||
    input.taskType === "FRONTEND" ||
    input.taskType === "REVIEW"
  );
}

export function isRepeatedOfficialEvidence(input: {
  verification?: JsonObject | undefined;
  priorOfficialEvidence?: OfficialEvidenceFingerprint | undefined;
}): boolean {
  const current = extractOfficialEvidenceFingerprint(input.verification);
  return officialEvidenceFingerprintsEqual(input.priorOfficialEvidence, current);
}

/** 按错误码 + 证据文本归入自治失败类（AFC-M2）。 */
export function classifyAutonomyFailure(input: {
  errorType?: string | undefined;
  summary?: string | undefined;
  issues?: unknown;
  recommendations?: unknown;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
}): AutonomyFailureClass {
  const errorType =
    asString(input.errorType) ??
    asString(input.output?.errorType) ??
    asString((input.verification as { failureCode?: unknown } | undefined)?.failureCode) ??
    "";
  const text = collectEvidenceText([
    input.summary,
    input.issues,
    input.recommendations,
    asString(input.output?.summary),
    input.output?.issues,
    input.output?.recommendations,
    asString((input.verification as { reason?: unknown } | undefined)?.reason)
  ]);

  // docs/263：官方检查的 stderr/stdout 优先于智能体叙述。
  // 「packages field missing or empty」是 workspace/CONFIG（GATE_FAILURE），
  // 不得被摘要里的 browserType.launch / test:e2e:install / EAI_AGAIN 收成 ENV_GAP。
  if (officialLooksLikePackageWorkspaceFailure(input.verification)) {
    return "GATE_FAILURE";
  }
  // docs/265：官方视觉失败（缺基线 / 默认皮肤 / 关键态打不开等）走 VISUAL，
  // 不得被截图日志里的 Playwright / Chromium 字样收成 ENV_GAP，更不要开 BUILD 去装浏览器。
  if (
    officialLooksLikeVisualFailure(input.verification, errorType) ||
    isOfficialVisualFailureCode(errorType)
  ) {
    return "VISUAL";
  }
  // ENV_GAP before DEPENDENCIES_MISSING: missing binaries *or* resource-limit kills
  // must not route to FRONTEND product repair (docs/254 / docs/256).
  // docs/261：过期报告里的 BLOCKED / browserType.launch，或「ENV_GAP 已清除 /
  // chromium 已安装 / smoke 通过」不得再判成当前 ENV_GAP；真实断言失败走后面的 GATE_FAILURE。
  // docs/263：若已有官方检查，当前 ENV_GAP 必须来自官方 e2e/install 证据，不能只凭智能体叙述。
  const officialChecksPresent = failedOfficialChecks(input.verification).length > 0;
  const currentEnvGap = officialChecksPresent
    ? officialLooksLikeCurrentEnvGap(input.verification)
    : (errorType === "ENV_GAP" && !isStaleOrClearedPlaywrightEnvGapNarrative(text)) ||
      matchesPlaywrightEnvGap(text);
  if (currentEnvGap) {
    return "ENV_GAP";
  }
  // docs/262：官方探测/作用域命令没落到正规测试根，不得再当成产品 GATE_FAILURE 派同一类型 TEST。
  if (
    errorType === "PROBE_FAILURE" ||
    officialLooksLikeProbeFailure(input.verification, errorType)
  ) {
    return "PROBE_FAILURE";
  }
  if (
    errorType === "DEPENDENCIES_MISSING" ||
    /exits?(?:\s+code)?\s*[:=]?\s*127/i.test(text) ||
    /:\s*not found\b/i.test(text) ||
    /\b(?:vue-tsc|eslint|vitest|vite|tsc|webpack|rollup)(?:\/[\w.-]+)*\s+not found\b/i.test(text) ||
    /Cannot find module @(?:rollup|esbuild)\//i.test(text) ||
    /node_modules\/\.bin/i.test(text) ||
    /empty\s+\.bin/i.test(text)
  ) {
    return "DEPENDENCIES_MISSING";
  }
  if (
    errorType === "SPEC_CONFLICT" ||
    /contradictory/i.test(text) ||
    /spec(?:ification)?\s+conflict/i.test(text) ||
    /foundation.*persist|persist.*foundation/i.test(text)
  ) {
    return "SPEC_CONFLICT";
  }
  // AFC fixture subtype：装配/挂载夹具缺失（Pinia/router/plugin），与「断言改弱」分开。
  if (
    errorType === "TEST_FIXTURE_GAP" ||
    /getActivePinia/i.test(text) ||
    /No active Pinia/i.test(text) ||
    /did you forget to install/i.test(text) ||
    /inject\(\) can only be used/i.test(text) ||
    /must be called.*(?:setup|install)|(?:setup|install).*must be called/i.test(text) ||
    (/createPinia\(\)/i.test(text) && /(?:fail|error|throw|TypeError)/i.test(text)) ||
    /missing (?:pinia|router|plugin)|(?:pinia|router) (?:is )?not (?:installed|provided)/i.test(text)
  ) {
    return "TEST_FIXTURE_GAP";
  }
  // docs/257：E2E/单测断言失败优先于 locator timeout→AGENT_TIMEOUT，以及交付报告里提到 README 就收成 DOCS_GAP。
  if (matchesTestAssertionFailure(text)) {
    return "GATE_FAILURE";
  }
  if (
    errorType === "AGENT_TIMEOUT" ||
    errorType === "TIMEOUT_ERROR" ||
    errorType === "CHECK_TIMEOUT" ||
    /\btimed?\s*out\b/i.test(text)
  ) {
    return "AGENT_TIMEOUT";
  }
  if (
    errorType === "INFRA_RETRY_EXHAUSTED" ||
    /\bECONNRESET\b/i.test(text) ||
    /\bsandbox\b.*\b(?:fail|unavailable|exhaust)/i.test(text) ||
    /\bENOSPC\b|\bENOMEM\b/i.test(text)
  ) {
    return "INFRA_RETRY_EXHAUSTED";
  }
  // README / docs deliverable assertions (v9: FRONTEND burned retries on README content).
  // docs/257：不能仅因报告提到 docs/delivery-report、项目介绍、目录结构就定为 DOCS_GAP。
  if (
    errorType === "DOCS_GAP" ||
    /readme\.ac\d+/i.test(text) ||
    (/\breadme\.md\b/i.test(text) &&
      (/(?:assert|expect|fail|not met|missing|未|缺少|不包含)/i.test(text) ||
        /项目介绍|目录结构|不在本次交付范围/.test(text) ||
        /not writable|write (?:policy|scope)|Path is not writable/i.test(text))) ||
    (/engineering-gates/i.test(text) && /README/i.test(text)) ||
    (/docs\/delivery-report/i.test(text) &&
      /(?:assert|expect|not met|missing|not found|absent|未|缺少|不包含|Path is not writable)/i.test(text)) ||
    (/Path is not writable:\s*docs\//i.test(text)) ||
    /write (?:policy|scope).*(?:README|docs\/)|(?:README|docs\/).*write (?:policy|scope)/i.test(text)
  ) {
    return "DOCS_GAP";
  }
  return "GATE_FAILURE";
}

/** 修复任务提示模板（装进 reason，供 DEBUG/修复任务上下文引用）。 */
export function repairHintForFailureClass(failureClass: AutonomyFailureClass): string {
  switch (failureClass) {
    case "DEPENDENCIES_MISSING":
      return "Dependency/env repair: ensure Node>=20.19, reinstall node_modules, heal platform native optional packages (@rollup/@esbuild), verify node_modules/.bin is non-empty, then re-run type-check/lint/test/build.";
    case "AGENT_TIMEOUT":
      return "Timeout repair: resume from last durable progress, avoid repeating finished steps, keep changes minimal, then re-submit with objective gates green.";
    case "INFRA_RETRY_EXHAUSTED":
      return "Infra repair: verify sandbox/docker/disk/network, retry the same contract once environment is healthy; do not invent product-scope changes.";
    case "SPEC_CONFLICT":
      return "Spec alignment: reconcile contradictory AC/tests with the current slice contract (update stale specs or code to match this slice), then re-run gates.";
    case "TEST_FIXTURE_GAP":
      return "Test fixture/setup repair: fix assembly/mount harness only (createPinia(), router plugins, provide/inject stubs). Do not weaken or delete AC assertions; anti-tamper still applies. Then re-run scoped gates.";
    case "DOCS_GAP":
      return "Docs/README repair: edit README.md and/or docs/** (e.g. docs/delivery-report.md) so assertion literals match (项目介绍, 目录结构, 不在本次交付范围, etc.). Do not weaken or delete the failing tests; anti-tamper still applies to test files. Prefer BUILD write scope — not FRONTEND product code.";
    case "ENV_GAP":
      return "Env/browser repair: if Playwright Chromium (or other browser binaries) are missing, BUILD/infra should run `npx playwright install chromium` (or restore the sandbox browser image). If the browser launched but was killed by sandbox resource limits (pthread_create / Resource temporarily unavailable / Target crashed / pids-limit), do not open another install BUILD — treat as unfixable resource ENV_GAP, raise E2E sandbox limits, or mark daily-gate E2E non-blocking with evidence. If install is impossible, mark E2E non-blocking with explicit ENV_GAP evidence. Do not open FRONTEND REPLAN or burn product retries.";
    case "PROBE_FAILURE":
      return "Official AC file probe / scoped command missed canonical test roots (tests/, test/, __tests__/, e2e). This is a platform probe/CONFIG failure. Do not open another same-type TEST repair or stuff leftover Users/ or workspace/ trees into the official command.";
    case "VISUAL":
      return "Visual/design-intent repair: wrap default component-library controls, match the attached UI baselines' hierarchy, typography, and primary control appearance, and reopen the official visual gate. Do not chase pixel diffs or slight spacing/color drift. Do not open a BUILD task to install browsers.";
    case "repair-exhausted":
      return "Repair budget exhausted; surface final evidence for human review.";
    case "GATE_FAILURE":
    case "gate-failure":
    default:
      return "Code/gate repair: fix failing type-check/lint/test/build (or QA withheld reasons), keep slice scope, then re-run objective gates.";
  }
}

/**
 * 修复应派给谁：agent 显式 fixTaskType 优先（须被当前能力面允许），否则用能力面
 * fixFallback（frontend-vue → FRONTEND）。非法/越权显式值（如 frontend-vue 下的 BACKEND）
 * 被忽略并回退。生产 DEPLOY 不在这里改写为自动绕过审批。
 * SPEC_CONFLICT / 矛盾测试可优先落到 TEST（与既有 contradictory 路由一致）。
 * TEST_FIXTURE_GAP 优先同类型（FRONTEND 等）修夹具，否则 TEST。
 * DOCS_GAP（README/docs 断言）→ BUILD（可写 README.md + docs/**）；优先于 agent 误报的 FRONTEND。
 * ENV_GAP（Playwright/Chromium 缺失）→ BUILD（基建安装浏览器或声明 E2E 跳过）；禁止 FRONTEND 空烧。
 * 资源限额杀死浏览器（docs/256）不走 BUILD 安装，见 decideGateFailureRepair 的 unfixable-env-gap。
 * docs/257：E2E/单测断言失败 → TEST（必要时再由 TEST 转 FRONTEND），不要开 BUILD。
 */

/**
 * docs/261：智能体在证据里写的 CONFIG / DOCUMENTATION 不是平台任务类型枚举值。
 * CONFIG → BUILD（根目录配置 / `.prettierignore`）；DOCUMENTATION / DOCS → TEST
 *（可写 `tests/reports/**`，并重基线报告合同）。
 */
export function normalizeRequestedRepairType(explicit?: string): string | undefined {
  if (!explicit) return undefined;
  const key = explicit.trim().toUpperCase();
  if (key === "CONFIG") return "BUILD";
  if (key === "DOCUMENTATION" || key === "DOCS") return "TEST";
  return explicit;
}

export function resolveRepairFixTaskType(input: {
  explicitFixTaskType?: string | undefined;
  profile?: CapabilityProfile | undefined;
  taskType?: Task["type"] | undefined;
  deliveryEnvironment?: string | undefined;
  failureClass?: AutonomyFailureClass | undefined;
  evidenceText?: string | undefined;
}): string | undefined {
  if (input.taskType === "DEPLOY" && input.deliveryEnvironment === "production") {
    return undefined;
  }
  const profile = input.profile ?? DEFAULT_CAPABILITY_PROFILE;
  const explicitRaw = asString(input.explicitFixTaskType);
  const explicit = normalizeRequestedRepairType(explicitRaw);
  const evidence = input.evidenceText ?? "";
  const currentEnvGap =
    input.failureClass === "ENV_GAP" && !isStaleOrClearedPlaywrightEnvGapNarrative(evidence);
  // 当前 ENV_GAP 仍默认 BUILD（安装浏览器），不被显式 FRONTEND / TEST 压过。
  // DOCS_GAP 默认 BUILD，但显式 TEST / DOCUMENTATION（已归一成 TEST）必须保留。
  // 过期/已清除的 ENV_GAP 叙述不走此分支，显式 CONFIG→BUILD、DOCUMENTATION→TEST 才能生效。
  if (currentEnvGap) {
    if (isProfileAllowedRepairType("BUILD", profile)) return "BUILD";
    return profile.taskTypes.fixFallback;
  }
  if (input.failureClass === "DOCS_GAP") {
    if (explicit === "TEST" && isProfileAllowedRepairType("TEST", profile)) return "TEST";
    if (isProfileAllowedRepairType("BUILD", profile)) return "BUILD";
    return profile.taskTypes.fixFallback;
  }
  // docs/263：官方 pnpm workspace 配置失败由 BUILD 修清单/锁文件，不要派 FRONTEND。
  if (PACKAGES_FIELD_MISSING.test(evidence) && isProfileAllowedRepairType("BUILD", profile)) {
    return "BUILD";
  }
  if (explicit && isProfileAllowedRepairType(explicit, profile)) return explicit;
  if (input.failureClass === "SPEC_CONFLICT") return "TEST";
  // docs/265：官方视觉失败修产品 UI，走 FRONTEND（或能力面 fixFallback），禁止 BUILD 装浏览器。
  if (input.failureClass === "VISUAL") {
    if (isProfileAllowedRepairType("FRONTEND", profile)) return "FRONTEND";
    return profile.taskTypes.fixFallback;
  }
  // docs/257：E2E/断言失败开 TEST，而不是能力面默认的 FRONTEND，更不要再开 BUILD。
  // DOCS_GAP / ENV_GAP 已在上方返回，这里不会再碰到。
  if (matchesTestAssertionFailure(input.evidenceText ?? "")) {
    if (isProfileAllowedRepairType("TEST", profile)) return "TEST";
  }
  // 夹具缺口：优先让源任务同类型修复（FRONTEND 可读可写 tests/）；否则落到 TEST。
  if (input.failureClass === "TEST_FIXTURE_GAP") {
    if (
      input.taskType === "FRONTEND" ||
      input.taskType === "BACKEND" ||
      input.taskType === "DATABASE" ||
      input.taskType === "TEST"
    ) {
      if (isProfileAllowedRepairType(input.taskType, profile)) return input.taskType;
    }
    if (isProfileAllowedRepairType("TEST", profile)) return "TEST";
    return profile.taskTypes.fixFallback;
  }
  return profile.taskTypes.fixFallback;
}

/**
 * 诊断/REPLAN_REQUESTED 已点名另一类任务，且该类尚未在本任务上用过 type-switch 额度时，
 * 即使 executionAttempt 已触顶，也不应直接 repair-exhausted——否则会把「该派 FRONTEND」
 * 误判成「TEST 修不动、自治耗尽」（taskflow-vue v8）。
 */
export function canTypeSwitchPastExhaustion(input: {
  executionAttempt: number;
  maxRetries: number;
  taskType?: Task["type"] | undefined;
  explicitFixTaskType?: string | undefined;
  errorType?: string | undefined;
  typeSwitchUsed?: boolean | undefined;
  profile?: CapabilityProfile | undefined;
}): { allowed: boolean; fixTaskType?: string } {
  if (input.executionAttempt < input.maxRetries) return { allowed: false };
  if (input.typeSwitchUsed) return { allowed: false };
  const profile = input.profile ?? DEFAULT_CAPABILITY_PROFILE;
  const fix = resolveRepairFixTaskType({
    explicitFixTaskType: input.explicitFixTaskType,
    profile,
    taskType: input.taskType
  });
  if (!fix || fix === input.taskType) return { allowed: false };
  // 仅在 agent 明确请求换类型（或显式给出了与当前不同的 fixTaskType）时放行。
  const requested =
    input.errorType === "REPLAN_REQUESTED" ||
    (typeof input.explicitFixTaskType === "string" &&
      isProfileAllowedRepairType(input.explicitFixTaskType, profile));
  if (!requested) return { allowed: false };
  return { allowed: true, fixTaskType: fix };
}

/**
 * docs/255：BUILD 已经尝试过浏览器安装，且安装被证明不可能
 * （超时无进度、二进制仍缺失、无可用网络/缓存、只读根文件系统）时，
 * 不得再开一个一模一样的 ENV_GAP→BUILD。
 */
export function isProvenUnfixableEnvGap(input: {
  taskType?: Task["type"] | undefined;
  failureClass?: AutonomyFailureClass | undefined;
  errorType?: string | undefined;
  errorMessage?: string | undefined;
  summary?: string | undefined;
  issues?: unknown;
  recommendations?: unknown;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
}): boolean {
  if (input.taskType !== "BUILD") return false;
  const verification = input.verification;
  // docs/263：官方检查若只是 pnpm workspace 配置错误，不得凭智能体「我装过浏览器」叙述收口。
  if (officialLooksLikePackageWorkspaceFailure(verification)) return false;
  const officialText = officialE2eOrInstallText(verification);
  if (!officialText && !officialLooksLikeCurrentEnvGap(verification)) return false;
  const officialE2eEnvGap = failedOfficialChecks(verification)
    .filter(isOfficialE2eOrInstallCheck)
    .some((check) => asString(check.failureCode) === "ENV_GAP");
  const failureIsEnvGap =
    input.failureClass === "ENV_GAP" ||
    asString(verification?.failureCode) === "ENV_GAP" ||
    officialE2eEnvGap ||
    officialLooksLikeCurrentEnvGap(verification);
  if (!failureIsEnvGap) return false;
  // docs/256：进程被限额杀掉（即便 install 已经 exit 0）不得再开同类 BUILD。须见官方 e2e 证据。
  if (officialText && matchesPlaywrightResourceEnvGap(officialText)) return true;
  // docs/264：BUILD 之后官方 e2e 已是 ENV_GAP（缺二进制 / 契约不一致）即足够收口。
  // 切片末不会跑安装命令，不得再要求 official install 文本。
  if (officialLooksLikeCurrentEnvGap(verification) && (officialE2eEnvGap || asString(verification?.failureCode) === "ENV_GAP" || matchesPlaywrightMissingBinaryEnvGap(officialText) || /PLAYWRIGHT_CONTRACT_MISMATCH/.test(officialText))) {
    return true;
  }
  const installAttempted =
    /playwright\s+install|test:e2e:install|npx\s+playwright\s+install|privileged playwright install/i.test(
      officialText
    );
  if (!installAttempted) return false;
  const installImpossible =
    /timed out|TIMEOUT_ERROR|CHECK_TIMEOUT|timedOut|Executable doesn'?t exist|binaries missing|EACCES|read-only file system|EROFS|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNREFUSED|network none|no download progress|still missing|install is impossible/i.test(
      officialText
    );
  return installImpossible;
}

/**
 * 路由决策：有报错证据 + 策略允许 REPLAN + 未耗尽尝试 ⇒ 进入修复；
 * 生产 DEPLOY 审批、无证据、策略禁 REPLAN、尝试耗尽 ⇒ 不进入。
 */
export function decideGateFailureRepair(input: {
  policy: WorkflowPolicy;
  executionAttempt: number;
  errorType?: string | undefined;
  errorMessage?: string | undefined;
  summary?: string | undefined;
  issues?: unknown;
  recommendations?: unknown;
  verification?: JsonObject | undefined;
  output?: JsonObject | undefined;
  explicitFixTaskType?: string | undefined;
  taskType?: Task["type"] | undefined;
  deliveryEnvironment?: string | undefined;
  profile?: CapabilityProfile | undefined;
  /** 本修复链是否已经用过一次「换类型」宽限（防 TEST↔FRONTEND 互甩）。 */
  typeSwitchUsed?: boolean | undefined;
  /** docs/262：上一轮官方失败指纹（由 WorkflowEngine.replan 写入 input.priorOfficialEvidence）。 */
  priorOfficialEvidence?: OfficialEvidenceFingerprint | undefined;
}): GateRepairDecision {
  if (input.taskType === "DEPLOY" && input.deliveryEnvironment === "production") {
    return {
      enter: false,
      reason: "production-deploy-approval",
      detail: "Production DEPLOY remains a human approval gate"
    };
  }

  const evidenceInput = {
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    summary: input.summary,
    issues: input.issues,
    recommendations: input.recommendations,
    verification: input.verification,
    output: input.output
  };
  const evidence = hasActionableFailureEvidence(evidenceInput);
  const evidenceSummary = evidenceBag(
    collectEvidenceText([
      input.errorMessage,
      input.summary,
      input.issues,
      asString(input.verification?.reason)
    ])
  );
  if (!evidence) {
    return {
      enter: false,
      reason: "no-evidence",
      detail: "No actionable gate/QA/verification error evidence"
    };
  }

  const failureClass = classifyAutonomyFailure(evidenceInput);
  const evidenceText = collectEvidenceText([
    input.errorMessage,
    input.summary,
    input.issues,
    input.recommendations,
    asString(input.verification?.reason),
    asString(input.verification?.failureCode),
    input.output
  ]);
  // docs/264：官方 e2e 已证明是平台浏览器契约不一致时，任何任务类型都不要开 BUILD 安装环。
  if (
    !officialLooksLikePackageWorkspaceFailure(input.verification) &&
    officialLooksLikeCurrentEnvGap(input.verification) &&
    /PLAYWRIGHT_CONTRACT_MISMATCH/.test(officialE2eOrInstallText(input.verification))
  ) {
    return {
      enter: false,
      reason: "unfixable-env-gap",
      detail:
        "Product Playwright requires a browser revision that is not baked into the sandbox image. Do not run playwright install in the sandbox and do not open a BUILD install loop. Realign to the platform pin or fail closed as a contract mismatch.",
      failureClass: "ENV_GAP",
      evidenceSummary
    };
  }
  // docs/256：资源限额杀死浏览器 — 任何任务类型都不要再开 BUILD 安装。
  // docs/263：须有官方 e2e 证据；官方只有 pnpm workspace 错误时不要走这条。
  if (
    !officialLooksLikePackageWorkspaceFailure(input.verification) &&
    (officialLooksLikeCurrentEnvGap(input.verification)
      ? matchesPlaywrightResourceEnvGap(officialE2eOrInstallText(input.verification))
      : failedOfficialChecks(input.verification).length === 0 &&
        matchesPlaywrightResourceEnvGap(evidenceText))
  ) {
    return {
      enter: false,
      reason: "unfixable-env-gap",
      detail:
        "Browser process was killed by sandbox resource limits (pids/memory/threads). Binaries are present or already installed; do not open a BUILD install task. Raise E2E sandbox limits or mark daily-gate E2E non-blocking with ENV_GAP evidence.",
      failureClass: "ENV_GAP",
      evidenceSummary
    };
  }
  if (
    isProvenUnfixableEnvGap({
      taskType: input.taskType,
      failureClass,
      errorType: input.errorType,
      errorMessage: input.errorMessage,
      summary: input.summary,
      issues: input.issues,
      recommendations: input.recommendations,
      verification: input.verification,
      output: input.output
    })
  ) {
    return {
      enter: false,
      reason: "unfixable-env-gap",
      detail:
        "BUILD already attempted Playwright/browser install and it is proven impossible in this sandbox; do not open another identical ENV_GAP BUILD. Mark E2E non-blocking with ENV_GAP evidence.",
      failureClass: "ENV_GAP",
      evidenceSummary
    };
  }
  // docs/262：官方红点当前类型够不到（探测路径 / 文档被拒且红点是文档 / 命令没跑到改过的文件）
  // → 停或换类型，不得再开一轮同样类型的修复。PROBE_FAILURE 是平台探测问题，不派产品 BUILD。
  const officialUnreachable = isOfficialRedPointUnreachableByTaskType({
    taskType: input.taskType,
    failureClass,
    errorType: input.errorType,
    verification: input.verification,
    output: input.output,
    summary: input.summary,
    issues: input.issues
  });
  const prospectiveFix = resolveRepairFixTaskType({
    explicitFixTaskType: input.explicitFixTaskType,
    profile: input.profile,
    taskType: input.taskType,
    deliveryEnvironment: input.deliveryEnvironment,
    failureClass,
    evidenceText
  });
  if (officialUnreachable && (failureClass === "PROBE_FAILURE" || !prospectiveFix || prospectiveFix === input.taskType)) {
    return {
      enter: false,
      reason: "unfixable-official-gate",
      detail:
        failureClass === "PROBE_FAILURE"
          ? "Official scoped test missed canonical test roots or used leftover non-project paths; do not open another same-type TEST repair."
          : "Current task type write scope cannot reach the official red point; do not open another repair of the same type.",
      failureClass,
      evidenceSummary
    };
  }

  // docs/262：同一官方证据（outputDigest + command）+ 同一任务类型 + 同一写范围，只允许修一轮。
  // 回归：T-10-REPLAN-3 与 T-10-REPLAN-4 共享 digest 54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2。
  if (
    isRepeatedOfficialEvidence({
      verification: input.verification,
      priorOfficialEvidence: input.priorOfficialEvidence
    }) &&
    (!prospectiveFix || prospectiveFix === input.taskType)
  ) {
    return {
      enter: false,
      reason: "repair-exhausted",
      detail:
        "Same official evidence (outputDigest + command) already used for one repair of this task type and write scope",
      failureClass: "repair-exhausted",
      evidenceSummary
    };
  }

  const strategyIsReplan = input.policy.failureStrategy === "REPLAN";
  const autonomyAllows = isAutonomyAtLeastL1(input.policy);
  if (!(input.policy.allowReplan && (strategyIsReplan || autonomyAllows))) {
    return {
      enter: false,
      reason: "policy-disallows-replan",
      detail: `policy failureStrategy=${input.policy.failureStrategy} allowReplan=${input.policy.allowReplan}`,
      failureClass,
      evidenceSummary
    };
  }

  const typeSwitch = canTypeSwitchPastExhaustion({
    executionAttempt: input.executionAttempt,
    maxRetries: input.policy.maxRetries,
    taskType: input.taskType,
    explicitFixTaskType: input.explicitFixTaskType,
    errorType: input.errorType,
    typeSwitchUsed: input.typeSwitchUsed,
    profile: input.profile
  });

  if (input.executionAttempt >= input.policy.maxRetries && !typeSwitch.allowed) {
    return {
      enter: false,
      reason: "repair-exhausted",
      detail: `executionAttempt ${input.executionAttempt} reached maxRetries ${input.policy.maxRetries}`,
      failureClass: "repair-exhausted",
      evidenceSummary
    };
  }

  const fixTaskType =
    typeSwitch.allowed && typeSwitch.fixTaskType
      ? typeSwitch.fixTaskType
      : resolveRepairFixTaskType({
          explicitFixTaskType: input.explicitFixTaskType,
          profile: input.profile,
          taskType: input.taskType,
          deliveryEnvironment: input.deliveryEnvironment,
          failureClass,
          evidenceText
        });
  if (!fixTaskType) {
    return {
      enter: false,
      reason: "production-deploy-approval",
      detail: "No repair fixTaskType for production deploy",
      failureClass,
      evidenceSummary
    };
  }

  const switchNote = typeSwitch.allowed ? `; type-switch → ${fixTaskType}` : "";
  return {
    enter: true,
    strategy: "REPLAN",
    fixTaskType,
    failureClass,
    evidenceSummary,
    reason: `${failureClass}: ${repairHintForFailureClass(failureClass)} (via ${fixTaskType})${switchNote}`
  };
}

/**
 * AFC-M1：自报 SUCCESS + 客观红证据 ⇒ 覆盖为 FAILED（供 VerifyingWorkflowTaskExecutor 使用）。
 * 返回 null 表示不覆盖。
 */
export function objectiveClosingOverride(input: {
  taskType: Task["type"];
  mode: "observe" | "enforce";
  resultStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
  output?: JsonObject | undefined;
  verificationVerdict?: string | undefined;
  verificationFailureCode?: string | undefined;
  verificationReason?: string | undefined;
  profile?: CapabilityProfile | undefined;
}): {
  errorType: string;
  fixTaskType?: string;
  message: string;
  failureClass: AutonomyFailureClass;
} | null {
  if (input.mode !== "enforce") return null;
  if (input.resultStatus !== "succeeded") return null;
  if (!OBJECTIVE_GATED_TASK_TYPES.has(input.taskType)) return null;

  const output = input.output ?? {};
  const verification =
    output.verification && typeof output.verification === "object"
      ? (output.verification as JsonObject)
      : undefined;

  const fromVerifier = input.verificationVerdict === "failed";
  const fromSelfReport = hasObjectiveRedEvidence({
    errorType: asString(output.errorType) ?? input.verificationFailureCode,
    summary: asString(output.summary),
    issues: output.issues,
    recommendations: output.recommendations,
    verification,
    output
  });

  if (!fromVerifier && !fromSelfReport) return null;

  const failureCode =
    input.verificationFailureCode ??
    asString(output.errorType) ??
    (fromVerifier ? "VERIFICATION_FAILED" : "OBJECTIVE_EVIDENCE_FAILED");
  const failureClass = classifyAutonomyFailure({
    errorType: failureCode,
    summary: asString(output.summary) ?? input.verificationReason,
    issues: output.issues,
    recommendations: output.recommendations,
    verification,
    output
  });
  const fixTaskType = resolveRepairFixTaskType({
    explicitFixTaskType: asString(output.fixTaskType),
    profile: input.profile,
    taskType: input.taskType,
    failureClass,
    evidenceText: collectEvidenceText([
      asString(output.summary) ?? input.verificationReason,
      output.issues,
      output.recommendations,
      input.verificationReason
    ])
  });
  const message = fromVerifier
    ? `Verification gate failed: ${input.verificationReason ?? "objective checks failed"}`
    : `Objective closing gate failed: self-reported SUCCESS with red evidence (${failureClass})`;
  return {
    errorType: failureCode,
    ...(fixTaskType ? { fixTaskType } : {}),
    message,
    failureClass
  };
}


function readPriorOfficialEvidence(input: Task["input"]): OfficialEvidenceFingerprint | undefined {
  const raw =
    input && typeof input === "object"
      ? (input as { priorOfficialEvidence?: unknown }).priorOfficialEvidence
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const digests = Array.isArray((raw as { digests?: unknown }).digests)
    ? (raw as { digests: unknown[] }).digests.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const commands = Array.isArray((raw as { commands?: unknown }).commands)
    ? (raw as { commands: unknown[] }).commands.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  if (digests.length === 0 && commands.length === 0) return undefined;
  return { digests: [...digests].sort(), commands: [...commands].sort() };
}

/** 把门禁失败决策接到引擎既有 FailureRouter（发 FAILURE_ROUTED，复用 REPLAN/FAIL 链）。 */
export function createAutonomyFailureRouter(
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): (input: {
  workflow: { policy: WorkflowPolicy; id?: string };
  task: Task;
}) =>
  | {
      strategy: "REPLAN" | "FAIL";
      reason: string;
      failureClass: string;
      attempt?: number;
      evidenceSummary?: string;
      errorType?: string;
      fixTaskType?: string;
    }
  | undefined {
  return ({ workflow, task }) => {
    const delivery =
      task.input && typeof task.input === "object"
        ? (task.input as { delivery?: { environment?: unknown } }).delivery
        : undefined;
    const deliveryEnvironment =
      delivery && typeof delivery.environment === "string" ? delivery.environment : undefined;
    const output = (task.output ?? {}) as JsonObject;
    const attemptRaw = task.input?.executionAttempt;
    const executionAttempt =
      typeof attemptRaw === "number"
        ? attemptRaw
        : typeof task.retryCount === "number"
          ? task.retryCount
          : 0;

    const typeSwitchUsed = task.input?.typeSwitchUsed === true;
    const priorOfficialEvidence = readPriorOfficialEvidence(task.input);
    const decision = decideGateFailureRepair({
      policy: workflow.policy,
      executionAttempt,
      errorType: typeof output.errorType === "string" ? output.errorType : undefined,
      errorMessage: typeof output.summary === "string" ? output.summary : undefined,
      summary: typeof output.summary === "string" ? output.summary : undefined,
      issues: output.issues,
      recommendations: output.recommendations,
      verification: output.verification as JsonObject | undefined,
      output,
      explicitFixTaskType:
        typeof output.fixTaskType === "string" ? output.fixTaskType : undefined,
      taskType: task.type,
      deliveryEnvironment,
      profile,
      typeSwitchUsed,
      priorOfficialEvidence
    });

    if (decision.enter) {
      return {
        strategy: "REPLAN",
        reason: decision.reason,
        failureClass: decision.failureClass,
        attempt: executionAttempt,
        evidenceSummary: decision.evidenceSummary,
        errorType: typeof output.errorType === "string" ? output.errorType : undefined,
        fixTaskType: decision.fixTaskType
      };
    }
    if (decision.reason === "unfixable-env-gap") {
      return {
        strategy: "FAIL",
        reason: `Unfixable ENV_GAP: ${decision.detail}${
          decision.evidenceSummary ? ` | last evidence: ${decision.evidenceSummary}` : ""
        }`,
        failureClass: "ENV_GAP",
        attempt: executionAttempt,
        evidenceSummary: decision.evidenceSummary,
        errorType: typeof output.errorType === "string" ? output.errorType : undefined
      };
    }
    if (decision.reason === "unfixable-official-gate") {
      return {
        strategy: "FAIL",
        reason: `Unfixable official gate: ${decision.detail}${
          decision.evidenceSummary ? ` | last evidence: ${decision.evidenceSummary}` : ""
        }`,
        failureClass: decision.failureClass ?? "PROBE_FAILURE",
        attempt: executionAttempt,
        evidenceSummary: decision.evidenceSummary,
        errorType: typeof output.errorType === "string" ? output.errorType : undefined
      };
    }
    if (decision.reason === "repair-exhausted") {
      return {
        strategy: "FAIL",
        reason: `Autonomy repair exhausted: ${decision.detail}${
          decision.evidenceSummary ? ` | last evidence: ${decision.evidenceSummary}` : ""
        }`,
        failureClass: "repair-exhausted",
        attempt: executionAttempt,
        evidenceSummary: decision.evidenceSummary,
        errorType: typeof output.errorType === "string" ? output.errorType : undefined
      };
    }
    // 切片任务 + 有报错证据，但工作流仍是旧 FAIL_FAST：强制进 REPLAN，
    // 避免「对失败切片点重试」继续死在 policy-disallows-replan。
    if (
      decision.reason === "policy-disallows-replan" &&
      typeof task.sliceKey === "string" &&
      task.sliceKey.length > 0 &&
      hasActionableFailureEvidence({
        errorType: typeof output.errorType === "string" ? output.errorType : undefined,
        errorMessage: typeof output.summary === "string" ? output.summary : undefined,
        summary: typeof output.summary === "string" ? output.summary : undefined,
        issues: output.issues,
        recommendations: output.recommendations,
        verification: output.verification as JsonObject | undefined,
        output
      })
    ) {
      const failureClass = classifyAutonomyFailure({
        errorType: typeof output.errorType === "string" ? output.errorType : undefined,
        summary: typeof output.summary === "string" ? output.summary : undefined,
        issues: output.issues,
        recommendations: output.recommendations,
        verification: output.verification as JsonObject | undefined,
        output
      });
      const fixTaskType = resolveRepairFixTaskType({
        explicitFixTaskType:
          typeof output.fixTaskType === "string" ? output.fixTaskType : undefined,
        profile,
        taskType: task.type,
        deliveryEnvironment,
        failureClass,
        evidenceText: collectEvidenceText([
          typeof output.summary === "string" ? output.summary : undefined,
          output.issues,
          output.recommendations
        ])
      });
      if (fixTaskType) {
        return {
          strategy: "REPLAN",
          reason: `Slice task ${task.taskKey} ${failureClass} on legacy FAIL_FAST → REPLAN via ${fixTaskType}`,
          failureClass,
          attempt: executionAttempt,
          evidenceSummary: decision.evidenceSummary,
          errorType: typeof output.errorType === "string" ? output.errorType : undefined,
          fixTaskType
        };
      }
    }
    // production-deploy-approval / no-evidence / policy-disallows → 交给引擎默认策略
    return undefined;
  };
}
