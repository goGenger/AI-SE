/**
 * docs/258：官方门禁失败项要带进下一轮修复任务。
 *
 * 修复任务若只继承源任务 acKeys，并用上一轮 Agent 的自报摘要当 brief，
 * 官方 E2E 红项（例如 task-crud 的 AC-02/03/14）会被当成「不在本任务范围」而漏修。
 */

export type OfficialFailedTest = {
  file?: string;
  acKey?: string;
  title: string;
};

export type OfficialGateFailureHint = {
  failedChecks: string[];
  acKeys: string[];
  failedTests: OfficialFailedTest[];
};

const AC_KEY_RE = /\[AC-(\d+)\]/i;
const FAILED_COUNT_RE = /^\s+\d+\s+failed\b/i;
const PLAYWRIGHT_TEST_RE =
  /^(?:\s*)(?:\d+\)\s+)?(?:\[[^\]]+\]\s*›\s+)?([\w./-]+\.(?:spec|test)\.[jt]sx?)(?::\d+(?::\d+)?)?\s*›\s*(.+)$/;
const VITEST_FAIL_RE =
  /^\s*(?:FAIL|✕|×)\s+([\w./-]+\.(?:spec|test)\.[jt]sx?)\s*(?:>\s*)?(.*)$/;

export function normalizeAcKey(raw: string): string | undefined {
  const match = raw.trim().toUpperCase().replace(/^\[|\]$/g, "").match(/^AC-0*(\d+)$/);
  if (!match) return undefined;
  return `AC-${match[1].padStart(2, "0")}`;
}

export function mergeAcKeys(existing: unknown, official: string[]): string[] {
  const inherited = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...official, ...inherited]) {
    const key = normalizeAcKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  return merged;
}

function acKeyFromText(text: string): string | undefined {
  const match = text.match(AC_KEY_RE);
  return match ? normalizeAcKey(`AC-${match[1]}`) : undefined;
}

function titleFromRest(rest: string): string {
  return rest.replace(/[─—–-]+$/g, "").replace(/^\[AC-\d+\]\s*/i, "").trim();
}

function collectFromLine(line: string, into: OfficialFailedTest[]): void {
  const playwright = line.match(PLAYWRIGHT_TEST_RE);
  if (playwright) {
    const rawRest = playwright[2] ?? "";
    into.push({
      file: playwright[1],
      acKey: acKeyFromText(rawRest),
      title: titleFromRest(rawRest)
    });
    return;
  }
  const vitest = line.match(VITEST_FAIL_RE);
  if (vitest) {
    const rawRest = vitest[2] ?? "";
    into.push({
      file: vitest[1],
      acKey: acKeyFromText(`${vitest[1]} ${rawRest}`),
      title: titleFromRest(rawRest) || vitest[1]
    });
  }
}

function uniqueTests(tests: OfficialFailedTest[]): OfficialFailedTest[] {
  const seen = new Set<string>();
  const result: OfficialFailedTest[] = [];
  for (const test of tests) {
    const key = `${test.file ?? ""}|${test.acKey ?? ""}|${test.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(test);
  }
  return result.slice(0, 20);
}

function checkOutput(check: Record<string, unknown>): string {
  const parts = [check.stdoutTail, check.stderrTail, check.stdout, check.stderr];
  return parts.filter((value): value is string => typeof value === "string").join("\n");
}

export function extractOfficialGateFailureHint(
  verification: unknown
): OfficialGateFailureHint | undefined {
  if (!verification || typeof verification !== "object") return undefined;
  const checks = (verification as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return undefined;

  const failedChecks: string[] = [];
  const parsed: OfficialFailedTest[] = [];

  for (const raw of checks) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    if (check.passed === true) continue;
    const name = typeof check.name === "string" && check.name.trim() ? check.name.trim() : "check";
    failedChecks.push(name);

    const lines = checkOutput(check).split(/\r?\n/);
    const fromSummary: OfficialFailedTest[] = [];
    const fromHeaders: OfficialFailedTest[] = [];
    let inFailedList = false;
    for (const line of lines) {
      if (FAILED_COUNT_RE.test(line)) {
        inFailedList = true;
        continue;
      }
      if (inFailedList && /^\s*\d+\s+passed\b/i.test(line)) {
        inFailedList = false;
        continue;
      }
      if (inFailedList) collectFromLine(line, fromSummary);
      else if (/^\s*\d+\)\s+/.test(line)) collectFromLine(line, fromHeaders);
    }
    const chosen = fromSummary.length > 0 ? fromSummary : fromHeaders;
    if (chosen.length > 0) parsed.push(...chosen);
    else {
      for (const line of lines) collectFromLine(line, parsed);
    }
  }

  if (failedChecks.length === 0) return undefined;

  const failedTests = uniqueTests(parsed);
  const acKeys: string[] = [];
  const seenAc = new Set<string>();
  for (const test of failedTests) {
    if (!test.acKey || seenAc.has(test.acKey)) continue;
    seenAc.add(test.acKey);
    acKeys.push(test.acKey);
  }
  return { failedChecks, acKeys, failedTests };
}

export function formatOfficialGateFailureBriefing(hint: OfficialGateFailureHint): string {
  const lines = [
    "官方门禁失败，必须先修下列红项后再宣称成功；不要因为源任务的 AC 列表未包含它们就当成范围外："
  ];
  for (const name of hint.failedChecks) {
    lines.push(`- ${name}`);
  }
  for (const test of hint.failedTests) {
    const bits = [test.file, test.acKey ? `[${test.acKey}]` : undefined, test.title].filter(Boolean);
    lines.push(`  - ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

export function withOfficialFailedGateBriefing(description: string, verification: unknown): string {
  const hint = extractOfficialGateFailureHint(verification);
  if (!hint) return description;
  return `${formatOfficialGateFailureBriefing(hint)}\n\n${description}`;
}

/**
 * docs/262：官方失败证据指纹（失败检查的 outputDigest + command）。
 * docs/264：同一官方 e2e ENV_GAP 不得因耗时数字不同就被当成新证据。
 * 写入下一轮修复任务 input.priorOfficialEvidence，用于「同证据同类型同写范围只修一轮」。
 */
export type OfficialEvidenceFingerprint = {
  digests: string[];
  commands: string[];
  failureCodes?: string[];
  stableDigests?: string[];
};

/** 去掉耗时/duration，避免同一官方失败因 12.3s vs 15.1s 换了 digest。 */
export function stripOutputDurations(text: string): string {
  return text
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|minutes?|seconds?|millis(?:econds?)?)\b/gi, "<dur>")
    .replace(/\bdurationMs\s*[:=]\s*\d+/gi, "durationMs=<dur>")
    .replace(/\b(?:elapsed|took|in)\s+\d+(?:\.\d+)?\s*(?:ms|s)\b/gi, "<dur>");
}

function fingerprintKey(values: string[]): string {
  return values.join("\0");
}

export function extractOfficialEvidenceFingerprint(
  verification: unknown
): OfficialEvidenceFingerprint | undefined {
  if (!verification || typeof verification !== "object") return undefined;
  const checks = (verification as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return undefined;
  const digests: string[] = [];
  const commands: string[] = [];
  const failureCodes: string[] = [];
  const stableDigests: string[] = [];
  for (const raw of checks) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    if (check.passed === true) continue;
    const digest = typeof check.outputDigest === "string" ? check.outputDigest.trim() : "";
    const command = typeof check.command === "string" ? check.command.trim() : "";
    const failureCode = typeof check.failureCode === "string" ? check.failureCode.trim() : "";
    const tails = [check.stdoutTail, check.stderrTail, check.stdout, check.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (digest) digests.push(digest);
    if (command) commands.push(command);
    if (failureCode) failureCodes.push(failureCode);
    // 只对真正的输出尾巴做去耗时稳定化；空尾巴不能用来抹平不同 digest 的断言失败。
    const stable = stripOutputDurations(tails).trim();
    if (stable) stableDigests.push(`${command}\n${failureCode}\n${stable}`);
  }
  if (digests.length === 0 && commands.length === 0 && failureCodes.length === 0) return undefined;
  digests.sort();
  commands.sort();
  failureCodes.sort();
  stableDigests.sort();
  return {
    digests,
    commands,
    ...(failureCodes.length > 0 ? { failureCodes } : {}),
    ...(stableDigests.length > 0 ? { stableDigests } : {})
  };
}

export function officialEvidenceFingerprintsEqual(
  left?: OfficialEvidenceFingerprint,
  right?: OfficialEvidenceFingerprint
): boolean {
  if (!left || !right) return false;
  if (left.digests.length === 0 && left.commands.length === 0 && !(left.failureCodes?.length)) {
    return false;
  }
  if (fingerprintKey(left.commands) !== fingerprintKey(right.commands)) return false;
  const leftCodes = left.failureCodes ?? [];
  const rightCodes = right.failureCodes ?? [];
  const sameCodes = leftCodes.length > 0 && fingerprintKey(leftCodes) === fingerprintKey(rightCodes);
  // docs/264：官方 e2e 已打上同一 ENV_GAP 时，耗时不同的 digest 仍是同一证据。
  if (sameCodes && leftCodes.every((code) => code === "ENV_GAP")) return true;
  const leftStable = left.stableDigests ?? [];
  const rightStable = right.stableDigests ?? [];
  if (leftStable.length > 0 && fingerprintKey(leftStable) === fingerprintKey(rightStable)) {
    return true;
  }
  if (fingerprintKey(left.digests) !== fingerprintKey(right.digests)) return false;
  return true;
}
