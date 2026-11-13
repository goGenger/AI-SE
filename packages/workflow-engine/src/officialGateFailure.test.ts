import { describe, expect, it } from "vitest";
import {
  extractOfficialEvidenceFingerprint,
  extractOfficialGateFailureHint,
  formatOfficialGateFailureBriefing,
  mergeAcKeys,
  officialEvidenceFingerprintsEqual,
  withOfficialFailedGateBriefing
} from "./officialGateFailure";

const TASK_CRUD_STDOUT = `    Test timeout of 30000ms exceeded.

    Error: locator.click: Test timeout of 30000ms exceeded.
    Call log:
      - waiting for getByTestId('list-table').getByRole('row').filter({ hasText: '季度总结' }).getByRole('button', { name: '删除', exact: true })

  4) [chromium] › tests/e2e/task-crud.spec.ts:231:1 › [AC-14] 打开任务详情查看八个字段并在详情中修改状态后列表状态同步 ─────────

    Test timeout of 30000ms exceeded.

  4 failed
    [chromium] › tests/e2e/task-crud.spec.ts:147:1 › [AC-02] 编辑任务并保存后列表展示更新后的字段值 ───────────────────
    [chromium] › tests/e2e/task-crud.spec.ts:184:1 › [AC-03] 点击删除先弹出确认对话框，取消后任务仍然保留 ────────────────
    [chromium] › tests/e2e/task-crud.spec.ts:209:1 › [AC-03] 在确认对话框点击确认删除后目标任务从列表消失 ────────────────
    [chromium] › tests/e2e/task-crud.spec.ts:231:1 › [AC-14] 打开任务详情查看八个字段并在详情中修改状态后列表状态同步 ──────────
  27 passed (1.5m)
`;

describe("officialGateFailure (docs/258)", () => {
  it("extracts failed Playwright tests and AC keys from official e2e stdout", () => {
    const hint = extractOfficialGateFailureHint({
      mode: "enforce",
      verdict: "failed",
      checks: [
        { name: "test", passed: true, exitCode: 0 },
        { name: "e2e", passed: false, exitCode: 1, stdoutTail: TASK_CRUD_STDOUT },
        { name: "slice-boundary", passed: true, exitCode: 0 }
      ]
    });
    expect(hint?.failedChecks).toEqual(["e2e"]);
    expect(hint?.acKeys).toEqual(["AC-02", "AC-03", "AC-14"]);
    expect(hint?.failedTests.map((test) => test.acKey)).toEqual([
      "AC-02",
      "AC-03",
      "AC-03",
      "AC-14"
    ]);
    expect(hint?.failedTests.map((test) => test.title)).toEqual([
      "编辑任务并保存后列表展示更新后的字段值",
      "点击删除先弹出确认对话框，取消后任务仍然保留",
      "在确认对话框点击确认删除后目标任务从列表消失",
      "打开任务详情查看八个字段并在详情中修改状态后列表状态同步"
    ]);
    expect(hint?.failedTests.some((test) => test.file === "tests/e2e/task-crud.spec.ts")).toBe(true);
  });

  it("returns undefined when every official check passed or verification is missing", () => {
    expect(extractOfficialGateFailureHint(undefined)).toBeUndefined();
    expect(
      extractOfficialGateFailureHint({
        checks: [{ name: "e2e", passed: true, exitCode: 0, stdoutTail: "3 passed" }]
      })
    ).toBeUndefined();
  });

  it("still hints when a check failed but the log has no parseable test lines", () => {
    const hint = extractOfficialGateFailureHint({
      checks: [{ name: "e2e", passed: false, exitCode: 1, stdoutTail: "sandbox exploded" }]
    });
    expect(hint).toEqual({ failedChecks: ["e2e"], acKeys: [], failedTests: [] });
  });

  it("parses vitest FAIL lines", () => {
    const hint = extractOfficialGateFailureHint({
      checks: [
        {
          name: "test",
          passed: false,
          stdoutTail: " FAIL  tests/views/foo.spec.ts > [AC-09] dashboard sync"
        }
      ]
    });
    expect(hint?.acKeys).toEqual(["AC-09"]);
    expect(hint?.failedTests[0]).toMatchObject({
      file: "tests/views/foo.spec.ts",
      acKey: "AC-09"
    });
  });

  it("puts official failed AC keys first when merging", () => {
    expect(mergeAcKeys(["AC-07", "AC-08", "AC-02", "AC-19"], ["AC-02", "AC-03", "AC-14"])).toEqual([
      "AC-02",
      "AC-03",
      "AC-14",
      "AC-07",
      "AC-08",
      "AC-19"
    ]);
  });

  it("prefixes the repair brief with official failures", () => {
    const briefing = withOfficialFailedGateBriefing(
      "task-crud 不在本任务 AC 范围内，故未修改",
      { checks: [{ name: "e2e", passed: false, exitCode: 1, stdoutTail: TASK_CRUD_STDOUT }] }
    );
    expect(briefing.startsWith("官方门禁失败")).toBe(true);
    expect(briefing).toContain("不要因为源任务的 AC 列表未包含它们就当成范围外");
    expect(briefing).toContain("task-crud.spec.ts");
    expect(briefing).toContain("[AC-02]");
    expect(briefing).toContain("task-crud 不在本任务 AC 范围内，故未修改");
    expect(formatOfficialGateFailureBriefing(extractOfficialGateFailureHint({
      checks: [{ name: "e2e", passed: false, stdoutTail: TASK_CRUD_STDOUT }]
    })!)).toContain("- e2e");
  });
});

describe("official evidence fingerprint (docs/262)", () => {
  const digest = "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2";
  const command =
    "npm run test -- 'Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts'";

  it("collects failed-check digests and commands, ignoring passed checks", () => {
    const fingerprint = extractOfficialEvidenceFingerprint({
      checks: [
        { name: "lint", passed: true, outputDigest: "ignore-me", command: "npm run lint" },
        { name: "test", passed: false, outputDigest: digest, command },
        { name: "slice-boundary", passed: false, outputDigest: digest, command }
      ]
    });
    expect(fingerprint?.digests).toEqual([digest, digest].sort());
    expect(fingerprint?.commands).toEqual([command, command].sort());
  });

  it("treats the T-10-REPLAN-3 / REPLAN-4 shared digest as the same evidence", () => {
    const left = extractOfficialEvidenceFingerprint({
      checks: [
        { passed: false, outputDigest: digest, command },
        { passed: false, outputDigest: digest, command }
      ]
    });
    const right = extractOfficialEvidenceFingerprint({
      checks: [
        { passed: false, outputDigest: digest, command },
        { passed: false, outputDigest: digest, command }
      ]
    });
    expect(officialEvidenceFingerprintsEqual(left, right)).toBe(true);
    expect(officialEvidenceFingerprintsEqual(left, { digests: ["other"], commands: [command] })).toBe(
      false
    );
    expect(officialEvidenceFingerprintsEqual(undefined, right)).toBe(false);
  });

  it("returns undefined when every check passed or verification has no fingerprint", () => {
    expect(extractOfficialEvidenceFingerprint(undefined)).toBeUndefined();
    expect(
      extractOfficialEvidenceFingerprint({
        checks: [{ name: "test", passed: true, outputDigest: digest, command }]
      })
    ).toBeUndefined();
  });
});

describe("official evidence fingerprint (docs/264)", () => {
  const command = "npm run test:e2e -- --workers=2";

  it("treats the same official e2e ENV_GAP as one evidence when only durations differ", () => {
    const left = extractOfficialEvidenceFingerprint({
      failureCode: "ENV_GAP",
      checks: [
        {
          name: "e2e",
          passed: false,
          command,
          failureCode: "ENV_GAP",
          outputDigest: "digest-replan-6-with-12s",
          stderrTail:
            "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1254/ (ran in 12.3s)"
        }
      ]
    });
    const right = extractOfficialEvidenceFingerprint({
      failureCode: "ENV_GAP",
      checks: [
        {
          name: "e2e",
          passed: false,
          command,
          failureCode: "ENV_GAP",
          outputDigest: "digest-replan-7-with-18s",
          stderrTail:
            "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1254/ (ran in 18.1s)"
        }
      ]
    });
    expect(officialEvidenceFingerprintsEqual(left, right)).toBe(true);
  });

  it("still distinguishes a different official command or a non-ENV_GAP digest change", () => {
    const envGap = extractOfficialEvidenceFingerprint({
      checks: [
        {
          name: "e2e",
          passed: false,
          command,
          failureCode: "ENV_GAP",
          outputDigest: "aaa"
        }
      ]
    });
    const otherCommand = extractOfficialEvidenceFingerprint({
      checks: [
        {
          name: "e2e",
          passed: false,
          command: "npm run test:e2e:install",
          failureCode: "ENV_GAP",
          outputDigest: "bbb"
        }
      ]
    });
    const assertion = extractOfficialEvidenceFingerprint({
      checks: [
        {
          name: "test",
          passed: false,
          command: "npm run test -- tests/quality/t13.spec.ts",
          outputDigest: "one"
        }
      ]
    });
    const assertion2 = extractOfficialEvidenceFingerprint({
      checks: [
        {
          name: "test",
          passed: false,
          command: "npm run test -- tests/quality/t13.spec.ts",
          outputDigest: "two"
        }
      ]
    });
    expect(officialEvidenceFingerprintsEqual(envGap, otherCommand)).toBe(false);
    expect(officialEvidenceFingerprintsEqual(assertion, assertion2)).toBe(false);
  });
});

