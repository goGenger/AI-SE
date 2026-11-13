import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, type CapabilityProfile } from "@ai-se/shared";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_NEVER_COMPLETING_TEST_FILES,
  MAX_SCOPED_TEST_FILES,
  acScopedTestTimeoutMs,
  buildAcScopedTestCommand,
  buildAcTestFileProbeCommand,
  buildDependencyProbeCommand,
  buildProtectedContentCommand,
  buildProtectedSnapshotCommand,
  buildScriptsProbeCommand,
  buildTestIdUsageScanCommand,
  changedProtectedFiles,
  classifyProtectedChanges,
  detectTestOutputTruncation,
  digestText,
  effectiveCheckType,
  isBareNodeTestScript,
  isDevTaskType,
  isVitestScript,
  isProtectedTestPath,
  isTestDeliveryReportPath,
  parseAcResults,
  parseAcTestFileProbe,
  isCanonicalTestFilePath,
  isSafeTestFilePath,
  selectCanonicalTestFiles,
  scopedCommandUsesNonCanonicalTestFiles,
  parseDependencyProbe,
  parseTestIdUsageScan,
  parseProtectedContents,
  parseProtectedSnapshot,
  isRepairTaskForOfficialGates,
  planVerificationChecks,
  resolveVerificationChecks,
  tailText,
  testIdContractViolations,
  weakenedProtectedFiles,
  withTestReporter,
  VERIFICATION_FAILED_ERROR_TYPE
} from "../services/taskVerifierRules";

/** C-3（T1）：验证门纯规则单测（无 IO）。 */

const TAP_SAMPLE = [
  "TAP version 13",
  "# Subtest: [AC-02] validates email format",
  "not ok 1 - [AC-02] validates email format",
  "  ---",
  "  duration_ms: 0.767",
  "  type: 'test'",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "# Subtest: plain test without ac number",
  "ok 2 - plain test without ac number",
  "  ---",
  "  duration_ms: 0.101292",
  "  ...",
  "# Subtest: [AC-01] accepts valid input",
  "ok 3 - [AC-01] accepts valid input",
  "  ---",
  "  duration_ms: 0.500375",
  "  ...",
  "# Subtest: [AC-03] rejects duplicate names",
  "ok 4 - [AC-03] rejects duplicate names",
  "  ---",
  "  duration_ms: 0.177042",
  "  ...",
  "1..4",
  "# tests 4",
  "# pass 3",
  "# fail 1"
].join("\n");

describe("taskVerifierRules", () => {
  it.each([
    ["test/api.test.mjs", true],
    ["tests/helpers/util.mjs", true],
    ["src/__tests__/todo.test.ts", true],
    ["api.spec.ts", true],
    ["src/components/Widget.test.tsx", true],
    ["./test/data.json", true],
    ["src/index.ts", false],
    ["README.md", false],
    ["node_modules/pkg/test/foo.test.js", false],
    ["dist/out.test.js", false],
    ["coverage/lcov-report/index.html", false],
    ["tests/reports/test-execution-report.md", false],
    ["tests/reports/notes.txt", false],
    ["src/__tests__/readme.md", false],
    ["tests/views/kanban-drag.ac-07-ac-08.spec.ts", true],
    ["tests/reports/accidental.spec.ts", true]
  ])("isProtectedTestPath(%s) => %s", (path, expected) => {
    expect(isProtectedTestPath(path)).toBe(expected);
  });

  it("treats delivery reports under tests/ as reports, not protected tests", () => {
    expect(isTestDeliveryReportPath("tests/reports/test-execution-report.md")).toBe(true);
    expect(isTestDeliveryReportPath("tests/views/kanban-drag.ac-07-ac-08.spec.ts")).toBe(false);
    expect(isTestDeliveryReportPath("README.md")).toBe(false);
  });

  it("classifies dev task types for anti-tamper snapshots", () => {
    expect(isDevTaskType("BACKEND")).toBe(true);
    expect(isDevTaskType("FRONTEND")).toBe(true);
    expect(isDevTaskType("DATABASE")).toBe(true);
    expect(isDevTaskType("TEST")).toBe(false);
    expect(isDevTaskType("REVIEW")).toBe(false);
    expect(isDevTaskType("ANALYSIS")).toBe(false);
  });

  it("plans availability-first checks per task type", () => {
    expect(planVerificationChecks("BACKEND", { build: "x", test: "y" }, BACKEND_NODE_PROFILE)).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "test", scriptName: "test", expectation: "pass" }
    ]);
    expect(planVerificationChecks("BACKEND", { test: "y" }, BACKEND_NODE_PROFILE)).toEqual([
      { name: "test", scriptName: "test", expectation: "pass" }
    ]);
    expect(planVerificationChecks("BACKEND", {}, BACKEND_NODE_PROFILE)).toEqual([]);
    expect(planVerificationChecks("FRONTEND", { build: "b", lint: "l" })).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "lint", scriptName: "lint", expectation: "pass" }
    ]);
    expect(planVerificationChecks("FRONTEND", { build: "b", typecheck: "t" })).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "typecheck", scriptName: "typecheck", expectation: "pass" }
    ]);
    // AFC-M1：`type-check` 别名也要进计划（Vue 脚手架常见脚本名）。
    expect(planVerificationChecks("FRONTEND", { build: "b", "type-check": "vue-tsc --noEmit" })).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "typecheck", scriptName: "type-check", expectation: "pass" }
    ]);
    // lint + type-check 同时存在时两者都跑（不再 lint 独占）。
    expect(
      planVerificationChecks("FRONTEND", { build: "b", lint: "eslint .", "type-check": "vue-tsc" })
    ).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "lint", scriptName: "lint", expectation: "pass" },
      { name: "typecheck", scriptName: "type-check", expectation: "pass" }
    ]);
    // N4：TEST（qa）任务的测试检查是红灯检查。
    expect(planVerificationChecks("TEST", { test: "t" })).toEqual([
      { name: "test", scriptName: "test", expectation: "fail" }
    ]);
    expect(planVerificationChecks("BUILD", { build: "b" })).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" }
    ]);
    expect(
      planVerificationChecks("DATABASE", { "db:migrate:up": "u", "db:migrate:down": "d" }, BACKEND_NODE_PROFILE)
    ).toEqual([
      { name: "migrate-up", scriptName: "db:migrate:up", expectation: "pass" },
      { name: "migrate-down", scriptName: "db:migrate:down", expectation: "pass" }
    ]);
    expect(planVerificationChecks("DATABASE", { "db:migrate:up": "u" }, BACKEND_NODE_PROFILE)).toEqual([]);
    expect(planVerificationChecks("DATABASE", {}, BACKEND_NODE_PROFILE)).toEqual([]);
    expect(planVerificationChecks("ANALYSIS", { build: "x", test: "y" })).toEqual([]);
    expect(planVerificationChecks("REVIEW", { build: "x" })).toEqual([]);
  });

  it("PL-M9 9a：区分「本类型没有客观检查」与「有候选检查但工作区缺 script」", () => {
    // 有候选检查、script 缺失 → missing 非空（证据面缺失）。
    expect(resolveVerificationChecks("TEST", {})).toEqual({ plans: [], missing: ["test"] });
    expect(resolveVerificationChecks("BACKEND", {}, "BACKEND", BACKEND_NODE_PROFILE)).toEqual({
      plans: [],
      missing: ["build", "test"]
    });
    expect(resolveVerificationChecks("BACKEND", { build: "x" }, "BACKEND", BACKEND_NODE_PROFILE)).toEqual({
      plans: [{ name: "build", scriptName: "build", expectation: "pass" }],
      missing: ["test"]
    });
    expect(resolveVerificationChecks("FRONTEND", { build: "b" }, "FRONTEND", FRONTEND_VUE_PROFILE)).toEqual({
      plans: [{ name: "build", scriptName: "build", expectation: "pass" }],
      missing: ["lint", "test"]
    });
    // typecheck 可回退 lint：有 typecheck 时 lint 不算缺失；frontend-vue 仍缺 test。
    expect(
      resolveVerificationChecks("FRONTEND", { typecheck: "t" }, "FRONTEND", FRONTEND_VUE_PROFILE).missing
    ).toEqual(["build", "test"]);
    expect(
      resolveVerificationChecks("FRONTEND", { build: "b", typecheck: "t" }, "FRONTEND", FRONTEND_VUE_PROFILE)
        .missing
    ).toEqual(["test"]);
    expect(
      resolveVerificationChecks("FRONTEND", { typecheck: "t" }, "FRONTEND", BACKEND_NODE_PROFILE).missing
    ).toEqual(["build"]);
    // N-1b（`docs/223`）：DATABASE 完全没有迁移脚本时回退到 BACKEND 候选集，
    // 所以「什么都没声明」缺的是 build / test，而不是 migrate-up / migrate-down。
    expect(resolveVerificationChecks("DATABASE", {}, "DATABASE", BACKEND_NODE_PROFILE)).toEqual({
      plans: [],
      missing: ["build", "test"]
    });
    expect(resolveVerificationChecks("DATABASE", { "db:migrate:up": "u" }, "DATABASE", BACKEND_NODE_PROFILE).missing).toEqual([
      "migrate-down"
    ]);
    // 本类型没有候选检查 → missing 为空（unavailable 是正确语义，不是缺陷）。
    expect(resolveVerificationChecks("ANALYSIS", { build: "x", test: "y" })).toEqual({
      plans: [],
      missing: []
    });
    expect(resolveVerificationChecks("DESIGN", {})).toEqual({ plans: [], missing: [] });
    expect(resolveVerificationChecks("REVIEW", { build: "x" })).toEqual({
      plans: [],
      missing: []
    });
    // script 存在时 plans 与 planVerificationChecks 逐字一致（未改判定）。
    expect(resolveVerificationChecks("TEST", { test: "t" }).plans).toEqual(
      planVerificationChecks("TEST", { test: "t" })
    );
  });

  /**
   * N-1b（`docs/223`）：DATABASE 任务在**没有迁移概念**的项目里原本一条检查都没有。
   * 实测 E1（`DATA_DIR` 原子 JSON 存储）：全库 22 个实例 / 21 个 run，每个最终切片一个，
   * 该任务有防篡改与写范围审计、却零客观检查即判 SUCCESS。
   */
  it("N-1b：DATABASE 完全无迁移脚本时回退 build+test；缺一半仍严格", () => {
    // 主判据：本项目没有迁移 ⇒ 用 BACKEND 的候选集，且不算证据面缺失。
    expect(resolveVerificationChecks("DATABASE", { build: "b", test: "t" }, "DATABASE", BACKEND_NODE_PROFILE)).toEqual({
      plans: [
        { name: "build", scriptName: "build", expectation: "pass" },
        { name: "test", scriptName: "test", expectation: "pass" }
      ],
      missing: []
    });
    // 只有一个迁移脚本 ⇒ 项目有 DB（脚本写了一半）⇒ 保持严格，不回退，且不掺 build/test。
    expect(
      resolveVerificationChecks("DATABASE", { "db:migrate:up": "u", build: "b", test: "t" }, "DATABASE", BACKEND_NODE_PROFILE)
    ).toEqual({ plans: [], missing: ["migrate-down"] });
    // 迁移齐全 ⇒ 只跑迁移，不掺 build/test。
    expect(
      planVerificationChecks("DATABASE", {
        "migrate:up": "u",
        "migrate:down": "d",
        build: "b",
        test: "t"
      }, BACKEND_NODE_PROFILE)
    ).toEqual([
      { name: "migrate-up", scriptName: "migrate:up", expectation: "pass" },
      { name: "migrate-down", scriptName: "migrate:down", expectation: "pass" }
    ]);
    // 回退后缺 build/test 是**证据面缺失**（missing 非空），不是「本类型没有检查」。
    expect(resolveVerificationChecks("DATABASE", { test: "t" }, "DATABASE", BACKEND_NODE_PROFILE)).toEqual({
      plans: [{ name: "test", scriptName: "test", expectation: "pass" }],
      missing: ["build"]
    });
    // DEBUG→DATABASE 同样走回退（N-15′ 的目标类型路径）。
    expect(
      resolveVerificationChecks(
        "DEBUG",
        { build: "b", test: "t" },
        "DATABASE",
        BACKEND_NODE_PROFILE
      ).plans
    ).toEqual([
      { name: "build", scriptName: "build", expectation: "pass" },
      { name: "test", scriptName: "test", expectation: "pass" }
    ]);
  });

  // N-15′（`docs/146` §3 / `docs/188` §Known Issue 7′）：DEBUG 任务派发到**目标类型**的 agent
  // （`AgentRegistry.ts:318-319`），因此它该受**目标类型**的检查，而不是「DEBUG 没有检查」。
  describe("N-15′：DEBUG 的检查类型走 `input.targetTaskType`", () => {
    it("非 DEBUG 任务不受 targetTaskType 影响（恒等于自身类型）", () => {
      expect(effectiveCheckType("BACKEND", "DATABASE")).toBe("BACKEND");
      expect(effectiveCheckType("TEST", undefined)).toBe("TEST");
      expect(effectiveCheckType("FRONTEND", "BUILD")).toBe("FRONTEND");
    });

    it("DEBUG 取可用目标；目标缺失/不可用则回落到 DEBUG（= 今天的行为）", () => {
      expect(effectiveCheckType("DEBUG", "BACKEND")).toBe("BACKEND");
      expect(effectiveCheckType("DEBUG", "DATABASE")).toBe("DATABASE");
      expect(effectiveCheckType("DEBUG", "BUILD")).toBe("BUILD");
      // DEPLOY 不是可用 DEBUG 目标（isUsableTargetTaskType 排除，交付编排独占）⇒ 回落 DEBUG。
      expect(effectiveCheckType("DEBUG", "DEPLOY")).toBe("DEBUG");
      // 不可用目标 = 非 `TaskType` 成员，或**运行期专属**类型（`RUNTIME_ONLY_TASK_TYPES` =
      // DEBUG / MONITOR / INCIDENT——`DEBUG` 指向自身同样没有 agent 可承接）。
      // 判据与**派发侧/计划侧同源**：`@ai-se/shared` 的 `isUsableTargetTaskType`，
      // `AgentRegistry.debugTarget` 与 `WorkflowEngine.debugTargetType` 用的就是它。
      expect(effectiveCheckType("DEBUG", "DEBUG")).toBe("DEBUG");
      expect(effectiveCheckType("DEBUG", "MONITOR")).toBe("DEBUG");
      expect(effectiveCheckType("DEBUG", "INCIDENT")).toBe("DEBUG");
      expect(effectiveCheckType("DEBUG", "IMPLEMENTATION")).toBe("DEBUG");
      expect(effectiveCheckType("DEBUG", undefined)).toBe("DEBUG");
      expect(effectiveCheckType("DEBUG", 42)).toBe("DEBUG");
    });

    it("目标**可用**但该类型本身没有候选检查时，仍是空计划（不凭空造检查）", () => {
      // DEPLOY / REVIEW / DESIGN 都是可用目标，但 `CHECK_CANDIDATES` 里没有它们
      // ⇒ 计划为空、missing 为空 ⇒ verdict 仍是 `unavailable`。**路由不等于造门。**
      for (const target of ["DEPLOY", "REVIEW", "DESIGN", "ANALYSIS"] as const) {
        expect(resolveVerificationChecks("DEBUG", { build: "b", test: "t" }, target)).toEqual({
          plans: [],
          missing: []
        });
      }
    });

    it("DEBUG 走目标类型的检查计划（这是本缺陷的修复点）", () => {
      expect(resolveVerificationChecks("DEBUG", { build: "b", test: "t" }, "BACKEND", BACKEND_NODE_PROFILE)).toEqual({
        plans: [
          { name: "build", scriptName: "build", expectation: "pass" },
          { name: "test", scriptName: "test", expectation: "pass" }
        ],
        missing: []
      });
      expect(
        resolveVerificationChecks(
          "DEBUG",
          { "db:migrate:up": "u", "db:migrate:down": "d" },
          "DATABASE"
        )
      ).toEqual({
        plans: [
          { name: "migrate-up", scriptName: "db:migrate:up", expectation: "pass" },
          { name: "migrate-down", scriptName: "db:migrate:down", expectation: "pass" }
        ],
        missing: []
      });
    });

    it("目标类型的 script 缺失时**证据面缺口可见**（PL-M9 9a 语义保留）", () => {
      expect(resolveVerificationChecks("DEBUG", {}, "BACKEND", BACKEND_NODE_PROFILE)).toEqual({
        plans: [],
        missing: ["build", "test"]
      });
      expect(resolveVerificationChecks("DEBUG", { build: "b" }, "BACKEND", BACKEND_NODE_PROFILE).missing).toEqual(["test"]);
    });

    it("目标缺失时回落到 DEBUG：计划与 missing 均为空（与今天逐字一致）", () => {
      expect(resolveVerificationChecks("DEBUG", { build: "b", test: "t" }, "DEBUG")).toEqual({
        plans: [],
        missing: []
      });
    });

    it("红灯仍按**任务自身**类型判定：DEBUG→TEST 不是红灯检查", () => {
      // TEST 任务的 test 检查是红灯（N4：写测试后先跑出失败，空转测试被拦截）。
      expect(resolveVerificationChecks("TEST", { test: "t" }).plans).toEqual([
        { name: "test", scriptName: "test", expectation: "fail" }
      ]);
      // DEBUG→TEST 是去**修**测试，要求测试先红是错的。
      expect(resolveVerificationChecks("DEBUG", { test: "t" }, "TEST").plans).toEqual([
        { name: "test", scriptName: "test", expectation: "pass" }
      ]);
    });

    it("docs/261：初始 TEST 仍是红灯；REPLAN / DYNAMIC 修复任务官方 test 期望通过", () => {
      expect(isRepairTaskForOfficialGates({ taskKey: "T-01", origin: "ORIGINAL" })).toBe(false);
      expect(isRepairTaskForOfficialGates({ taskKey: "T-06-REPLAN-3", origin: "DYNAMIC" })).toBe(
        true
      );
      expect(
        isRepairTaskForOfficialGates({ taskKey: "T-06-REPLAN-3", sourceTaskId: "task-06" })
      ).toBe(true);
      expect(isRepairTaskForOfficialGates({ taskKey: "T-10-REPLAN-1" })).toBe(true);

      expect(resolveVerificationChecks("TEST", { test: "t" }).plans).toEqual([
        { name: "test", scriptName: "test", expectation: "fail" }
      ]);
      expect(
        resolveVerificationChecks("TEST", { test: "t" }, "TEST", FRONTEND_VUE_PROFILE, {
          officialTestExpectsPass: true
        }).plans
      ).toEqual([{ name: "test", scriptName: "test", expectation: "pass" }]);
    });

    it("第三参缺省等于 taskType（既有调用方一字不改）", () => {
      expect(resolveVerificationChecks("BACKEND", { build: "b" })).toEqual(
        resolveVerificationChecks("BACKEND", { build: "b" }, "BACKEND")
      );
      expect(resolveVerificationChecks("ANALYSIS", {})).toEqual({
        plans: [],
        missing: []
      });
    });
  });

  it("parses real node --test TAP output into per-AC verdicts", () => {
    expect(parseAcResults(TAP_SAMPLE)).toEqual({
      "AC-01": "passed",
      "AC-02": "failed",
      "AC-03": "passed"
    });
  });

  it("supports runner marks and normalizes AC numbering", () => {
    const output = ["  ✓ [ac-1] works", "  × [AC-2] broken", "✔ [AC-04] fine"].join("\n");
    expect(parseAcResults(output)).toEqual({
      "AC-01": "passed",
      "AC-02": "failed",
      "AC-04": "passed"
    });
  });

  it("merges duplicate AC occurrences with failure priority", () => {
    const output = ["ok 1 - [AC-05] first run", "not ok 2 - [AC-05] second run"].join("\n");
    expect(parseAcResults(output)).toEqual({ "AC-05": "failed" });
    const reversed = ["not ok 1 - [AC-05] first run", "ok 2 - [AC-05] second run"].join("\n");
    expect(parseAcResults(reversed)).toEqual({ "AC-05": "failed" });
  });

  it("parses bracketed generic AC markers (FR-style namespaces)", () => {
    const output = [
      "ok 1 - [FR-001] lowercases input",
      "not ok 2 - [FR-008] keeps unicode letters",
      "ok 3 - [AC-04] classic marker"
    ].join("\n");
    expect(parseAcResults(output)).toEqual({
      "FR-001": "passed",
      "FR-008": "failed",
      "AC-04": "passed"
    });
  });

  it("ignores unbracketed tokens that merely look like keys (UTF-8 prose)", () => {
    const output = [
      "ok 1 - handles UTF-8 input gracefully",
      "ok 2 - [FR-001] real marker still parses"
    ].join("\n");
    expect(parseAcResults(output)).toEqual({ "FR-001": "passed" });
  });

  it("parses, filters, and compares protected snapshots", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const hashC = "c".repeat(64);
    const before = parseProtectedSnapshot(
      [
        `${hashA}  ./test/api.test.mjs`,
        `${hashB}  ./src/index.mjs`,
        `${hashC}  ./tests/util.mjs`
      ].join("\n")
    );
    expect([...before.keys()]).toEqual(["test/api.test.mjs", "tests/util.mjs"]);

    const after = parseProtectedSnapshot(
      [`${hashB}  ./test/api.test.mjs`, `${"d".repeat(64)}  ./tests/new.test.mjs`].join("\n")
    );
    expect(changedProtectedFiles(before, after)).toEqual(["test/api.test.mjs", "tests/util.mjs"]);
    expect(changedProtectedFiles(before, before)).toEqual([]);
  });

  it("N-14：把「既有断言被换掉」判为改弱（L1-M4l 的真实文本）", () => {
    // `T-02-DEBUG-1-DEBUG-2` → src/test/scaffold.test.js：把「短密钥必须被拒」
    // 换成了「短密钥被接受」——红灯门的经典绕法，门必须拦下（docs/189 §2.2）。
    const before = [
      "import assert from 'node:assert/strict';",
      "test('[AC-07] auth secret', () => {",
      "  assert.equal(parseAuthSecret(secret).toString('utf8'), secret);",
      "  assert.throws(() => parseAuthSecret('short'), (error) => !String(error?.message).includes('short'));",
      "});"
    ].join("\n");
    const after = [
      "import assert from 'node:assert/strict';",
      "test('[AC-07] auth secret', () => {",
      "  assert.equal(parseAuthSecret(secret).toString('utf8'), secret);",
      "  assert.equal(parseAuthSecret('short').toString('utf8'), 'short', 'no minimum length is imposed on a supplied secret');",
      "  assert.throws(() => parseAuthSecret(12345), (error) => !String(error?.message).includes('12345'));",
      "});"
    ].join("\n");

    expect(
      weakenedProtectedFiles(
        ["src/test/scaffold.test.js"],
        new Map([["src/test/scaffold.test.js", before]]),
        new Map([["src/test/scaffold.test.js", after]])
      )
    ).toEqual(["src/test/scaffold.test.js"]);
  });

  it("N-14：只补 import / 只加用例的改动不算改弱（L1-M4l 的真实文本）", () => {
    // `T3-DEBUG-1` → src/test/schema.test.js：只给 import 表补了它新写的两个导出。
    const before = [
      "import { MIGRATIONS, migrateState } from '../migrations.js';",
      "import assert from 'node:assert/strict';",
      "test('idempotent', () => {",
      "  assert.equal(migrateState({}).version, 1);",
      "});"
    ].join("\n");
    const after = [
      "import { MIGRATIONS, dedupeUsers, migrateState } from '../migrations.js';",
      "import assert from 'node:assert/strict';",
      "import { hasPasswordMaterial } from '../schema.js';",
      "test('idempotent', () => {",
      "  assert.equal(migrateState({}).version, 1);",
      "  assert.equal(hasPasswordMaterial({ password: 'x' }), true);",
      "});"
    ].join("\n");

    expect(
      weakenedProtectedFiles(
        ["src/test/schema.test.js"],
        new Map([["src/test/schema.test.js", before]]),
        new Map([["src/test/schema.test.js", after]])
      )
    ).toEqual([]);
  });

  it("N-14：纯缩进重排不算改弱", () => {
    const before = "test('x', () => {\n  assert.equal(a, b);\n});";
    const after = "test('x', () => {\n      assert.equal(a, b);\n});";
    expect(
      weakenedProtectedFiles(
        ["test/a.test.js"],
        new Map([["test/a.test.js", before]]),
        new Map([["test/a.test.js", after]])
      )
    ).toEqual([]);
  });

  it("docs/259：内容不可证不再判为改弱；删除受保护测试文件仍判改弱", () => {
    const changed = ["test/api.test.mjs"];
    const stillThere = new Map([["test/api.test.mjs", "b".repeat(64)]]);
    // 未采集 / 读不到 ⇒ unread，不是 weakened。
    expect(classifyProtectedChanges(changed, undefined, undefined, stillThere)).toEqual({
      weakened: [],
      unread: changed
    });
    expect(
      classifyProtectedChanges(
        changed,
        new Map([["test/api.test.mjs", "assert.ok(1)"]]),
        new Map([["test/api.test.mjs", null]]),
        stillThere
      )
    ).toEqual({ weakened: [], unread: changed });
    expect(weakenedProtectedFiles(changed, undefined, undefined)).toEqual([]);
    // 文件从 after 哈希快照中消失 ⇒ 删除，判改弱。
    expect(
      classifyProtectedChanges(
        changed,
        new Map([["test/api.test.mjs", "assert.ok(1)"]]),
        new Map(),
        new Map()
      )
    ).toEqual({ weakened: changed, unread: [] });
    // 无变化 ⇒ 不进入判定。
    expect(classifyProtectedChanges([], new Map(), new Map(), new Map())).toEqual({
      weakened: [],
      unread: []
    });
  });

  it("N-14：解析内容快照，受保护判定仍走 isProtectedTestPath", () => {
    const parsed = parseProtectedContents(
      JSON.stringify({
        "./test/api.test.mjs": "assert.ok(1)",
        "./src/index.mjs": "const a = 1",
        "./tests/gone.mjs": null
      })
    );
    expect([...parsed.keys()]).toEqual(["test/api.test.mjs", "tests/gone.mjs"]);
    expect(parsed.get("test/api.test.mjs")).toBe("assert.ok(1)");
    expect(parsed.get("tests/gone.mjs")).toBeNull();
    expect(parseProtectedContents("not json").size).toBe(0);
    expect(parseProtectedContents("[]").size).toBe(0);
  });

  it("exposes digests, tails, and the established command builders", () => {
    expect(digestText("abc")).toHaveLength(64);
    expect(tailText("abcdef", 3)).toBe("def");
    expect(tailText("abc", 10)).toBe("abc");
    expect(buildProtectedSnapshotCommand()).toContain("sha256sum");
    // N-14：内容快照与哈希快照必须共用同一份 find 表达式——候选集合漂移会让改弱判定失真。
    const findOf = (command: string) => command.split(" | ")[0];
    expect(buildProtectedContentCommand()).toContain("readFileSync(0,'utf8')");
    expect(findOf(buildProtectedContentCommand())).toBe(findOf(buildProtectedSnapshotCommand()));
    const scoped = buildProtectedContentCommand(["test/api.test.mjs", "tests/reports/test-execution-report.md"]);
    expect(scoped).toContain("printf");
    expect(scoped).toContain("test/api.test.mjs");
    expect(scoped).toContain("tests/reports/test-execution-report.md");
    expect(scoped).not.toContain("find .");
    expect(buildProtectedContentCommand(["../etc/passwd"])).toContain("find .");
    expect(buildScriptsProbeCommand()).toContain("package.json");
    expect(VERIFICATION_FAILED_ERROR_TYPE).toBe("VERIFICATION_FAILED");
  });

  it("scopes a node --test command and bounds it with --test-timeout (PL-M20 / N-13)", () => {
    // 作用域为空、或不支持的 runner → 不拼命令（调用方对有 AC 的门禁应 fail-closed）。
    expect(buildAcScopedTestCommand("npm run test", [], "node --test", 120_000)).toBeNull();
    expect(buildAcScopedTestCommand("npm run test", ["AC-01"], "jest", 120_000)).toBeNull();

    const command = buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test", 120_000);
    expect(command).toBe(
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000"
    );

    // N-13：`--test-name-pattern` 只筛测试名、文件照跑，不匹配的文件会把 before 起的子进程
    // 漏在那儿，命令永不返回。超时值必须**严格小于**验证器单次预算，否则整命令超时先触发，
    // 失败就归因不到文件级。
    const perFile = acScopedTestTimeoutMs(120_000);
    expect(perFile).toBe(20_000);
    expect(perFile).toBeLessThan(120_000);
    expect(command).toContain(`--test-timeout=${perFile}`);
    // 预算变小时随之变小，不写死。
    expect(acScopedTestTimeoutMs(30_000)).toBe(5_000);
  });

  it("sizes --test-timeout for MULTIPLE never-completing files, not just one (PL-M24)", () => {
    // 沙箱是 `--cpus 1`（`packages/sandbox/src/index.ts`）⇒ 容器内 `availableParallelism() = 1`
    // ⇒ Node 串行跑测试文件 ⇒ 每个永不结束的文件各烧掉一整个 `--test-timeout`。
    // 取值必须在容纳 MAX_NEVER_COMPLETING_TEST_FILES 个这样的文件后仍留在预算内。
    const budget = 120_000;
    const perFile = acScopedTestTimeoutMs(budget);
    expect(perFile * MAX_NEVER_COMPLETING_TEST_FILES).toBeLessThan(budget);

    // 反向对照：旧的「预算 5/6」只够**一个**文件——实测真实 E1 工作区 N = 3~4，那正是
    // L1-M4m run 3 七次 CHECK_TIMEOUT 的成因（`packages/eval/results/n13-e1-probe/`）。
    const legacy = Math.floor((budget * 5) / 6);
    expect(legacy).toBeGreaterThan(budget / 4);
    expect(legacy * 4).toBeGreaterThan(budget);
  });
});

/**
 * N-34（PL-M35）：作用域测试**按文件选取**。
 *
 * 缺陷：`--test-name-pattern` 只筛测试名，兄弟切片的文件照样加载、文件级钩子照样执行；
 * 沙箱 `--cpus 1` 串行跑文件 ⇒ N 个挂死文件各烧一整个 `--test-timeout`。批次 `l1-m4t`
 * run 1 的 `T11` 实测 `attempts = [120019ms, 120030ms]`、`stdoutTail` 内 5 条 `testTimeoutFailure`。
 */
describe("AC 作用域：按文件选取（N-34 / PL-M35）", () => {
  it("文件列表拼进命令；超时按实际文件数分摊而不是固定 5 个", () => {
    const command = buildAcScopedTestCommand(
      "npm run test",
      ["AC-01", "AC-02"],
      "node --test",
      120_000,
      ["test/api.test.mjs", "test/auth.test.mjs"]
    );
    expect(command).toBe(
      "npm run test -- 'test/api.test.mjs' 'test/auth.test.mjs' " +
        "--test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=40000"
    );
    // 2 个文件 ⇒ 预算 ÷ 3，比固定 ÷ 6 宽松；同时仍严格小于整命令预算。
    expect(acScopedTestTimeoutMs(120_000, 2)).toBe(40_000);
    expect(acScopedTestTimeoutMs(120_000, 2)).toBeLessThan(120_000);
    // 文件越多每个越紧，总和不超预算。
    expect(acScopedTestTimeoutMs(120_000, 10)).toBe(10_909);
    expect(acScopedTestTimeoutMs(120_000, 10) * 10).toBeLessThan(120_000);
    // 不传文件数 ⇒ 沿用 PL-M24 的固定 5 个（命令形态不变）。
    expect(acScopedTestTimeoutMs(120_000)).toBe(20_000);
  });

  it("脚本自带路径参数或探测不到文件时，退回既有的名称筛选形态（不是空命令）", () => {
    const nameOnly = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    // 脚本 `node --test test/`：追加文件只会取并集，反而跑得更多。
    expect(isBareNodeTestScript("node --test test/")).toBe(false);
    // N-55b：这一形状（自带位置参数）改为**改写调用**——标志排在位置参数之前，否则 Node 会把它们
    // 当成测试文件的脚本参数而忽略（`pnpm test -- <flags>` 只能追加到末尾）。探测到文件时**替换**
    // 脚本自带的路径（不是追加——追加只会取并集），只加载本切片相关的文件。
    expect(
      buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test test/", 120_000, [
        "test/api.test.mjs"
      ])
    ).toBe(
      "node --test --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=60000 'test/api.test.mjs'"
    );
    // docs/262：探测结果为空（含只有垃圾路径被滤掉）fail-closed，不得静默退回名称筛选。
    expect(buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test", 120_000, [])).toBeNull();
    // 文件数超上限：先过滤再截断到 MAX，使用前 MAX 个正规路径，而不是退回名称筛选。
    const tooMany = Array.from({ length: MAX_SCOPED_TEST_FILES + 1 }, (_, i) => `test/t${i}.test.mjs`);
    const truncated = buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test", 120_000, tooMany);
    expect(truncated).toContain("'test/t0.test.mjs'");
    expect(truncated).toContain(`'test/t${MAX_SCOPED_TEST_FILES - 1}.test.mjs'`);
    expect(truncated).not.toContain(`'test/t${MAX_SCOPED_TEST_FILES}.test.mjs'`);
    expect(truncated).not.toBe(nameOnly);
    // 未探测（undefined）与历史行为逐字一致。
    expect(buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test", 120_000)).toBe(
      nameOnly
    );
  });

  it("裸 node --test 判定：只放行旗标，不放行路径", () => {
    expect(isBareNodeTestScript("node --test")).toBe(true);
    expect(isBareNodeTestScript("  node   --test  ")).toBe(true);
    expect(isBareNodeTestScript("node --test --experimental-strip-types")).toBe(true);
    expect(isBareNodeTestScript("node --test --test-timeout=5000")).toBe(true);
    expect(isBareNodeTestScript("node --test test/")).toBe(false);
    expect(isBareNodeTestScript("node --test --watch")).toBe(true);
    expect(isBareNodeTestScript("node --test; rm -rf /")).toBe(false);
    expect(isBareNodeTestScript("vitest run")).toBe(false);
  });

  it("探测器命令：node -e 单命令、只含安全 AC 键、可注入的键被拒", () => {
    const command = buildAcTestFileProbeCommand(["AC-01", "AC-02"]);
    expect(command).toMatch(/^node -e "/);
    expect(command).toContain("const keys=['AC-01','AC-1','AC-02','AC-2'];");
    expect(command).toContain("node_modules");
    // 命令经 `sh -lc` 执行（docker run … sh -lc）：脚本体内出现 `$` 或反引号会被 shell 展开。
    expect(command).not.toContain("$");
    expect(command).not.toContain("`");
    // 计划里的 AC 键来自 LLM：带 shell 元字符 / 引号的一律丢弃。
    expect(buildAcTestFileProbeCommand(["AC-01'; rm -rf / #"])).toBeNull();
    expect(buildAcTestFileProbeCommand([])).toBeNull();
    const mixed = buildAcTestFileProbeCommand(["AC-01", "AC-02'; rm -rf /"]);
    expect(mixed).not.toBeNull();
    expect(mixed).not.toContain("rm -rf");
  });

  it("探测器输出解析：归一化相对路径，拒绝逃逸与非法字符", () => {
    expect(parseAcTestFileProbe('{"files":["./test/api.test.mjs","test/auth.test.mjs"]}')).toEqual([
      "test/api.test.mjs",
      "test/auth.test.mjs"
    ]);
    expect(parseAcTestFileProbe('{"files":["../outside.test.mjs"]}')).toEqual([]);
    expect(parseAcTestFileProbe('{"files":["/etc/passwd"]}')).toEqual([]);
    expect(parseAcTestFileProbe('{"files":["test/a b.test.mjs"]}')).toEqual([]);
    expect(parseAcTestFileProbe('{"files":["test/a.test.mjs; rm -rf /"]}')).toEqual([]);
    // 不可解析 → null（调用方视为「未探测」，退回名称筛选）。
    expect(parseAcTestFileProbe("")).toBeNull();
    expect(parseAcTestFileProbe("not json")).toBeNull();
    expect(parseAcTestFileProbe('{"files":"nope"}')).toBeNull();
  });
});

/**
 * N-55（`docs/232` §9.27）：第十一次回归 oracle 29/29 全过、自报失败，唯一阻塞是 slice-3 `T7`
 * 连败 3 次——证据是 `uncoveredAcKeys=[AC-24,AC-25,AC-26,AC-29]`，而同一条检查 `exitCode 0`、
 * `# tests 258 / # pass 258`。两个机制：
 *
 * - N-55a：沙箱只保留 stdout 的最后 96KB，排在前面的用例整段消失 ⇒ AC 被判「未覆盖」；
 * - N-55b：`--test-name-pattern` 被追加在脚本命令之后，Node 把它当脚本参数忽略 ⇒ 从未真正筛选。
 */
describe("N-55b 作用域命令：标志必须排在位置参数之前", () => {
  it("脚本是 `node --test \"test/**/*.test.js\"` 时改写调用，标志在前", () => {
    const command = buildAcScopedTestCommand(
      "pnpm test",
      ["AC-24"],
      'node --test "test/**/*.test.js"',
      120_000
    );
    expect(command).toBe(
      "node --test --test-name-pattern '\\[AC-24\\]' --test-timeout=20000 \"test/**/*.test.js\""
    );
    // 旧形态（`pnpm test -- --test-name-pattern …`）里标志排在 glob 之后，Node 会忽略它。
    expect(command).not.toContain("pnpm test --");
  });

  it("脚本带多个位置参数时原样保留，标志仍在前", () => {
    const command = buildAcScopedTestCommand(
      "pnpm test",
      ["AC-24"],
      "node --test test/a.test.js test/b.test.js",
      120_000
    );
    expect(command).toBe(
      "node --test --test-name-pattern '\\[AC-24\\]' --test-timeout=20000 test/a.test.js test/b.test.js"
    );
  });

  it("裸 `node --test` 维持既有追加形态（没有位置参数，追加的标志仍被解析）", () => {
    expect(buildAcScopedTestCommand("npm run test", ["AC-01"], "node --test", 120_000)).toBe(
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000"
    );
  });

  it("标志值（`--test-timeout 20000`）不被当成位置参数", () => {
    expect(
      buildAcScopedTestCommand("pnpm test", ["AC-24"], "node --test --test-timeout 20000", 120_000)
    ).toBe("pnpm test -- --test-name-pattern '\\[AC-24\\]' --test-timeout=20000");
  });

  it("不受支持的 runner 不作用域（返回 null；vitest 走 command-filter）", () => {
    expect(buildAcScopedTestCommand("pnpm test", ["AC-24"], "jest", 120_000)).toBeNull();
    expect(isVitestScript("vitest run")).toBe(true);
    expect(
      buildAcScopedTestCommand("npm run test", ["AC-01"], "vitest run", 120_000)
    ).toBe(
      "npm run test -- --testNamePattern '\\[AC-01\\]|\\[AC-1\\]' --testTimeout=20000"
    );
  });
});

describe("N-55a 输出截断检测", () => {
  it("TAP 汇总的用例数多于实际结果行 ⇒ 被截断", () => {
    const truncated = ["ok 250 - [AC-12] a", "ok 251 - [AC-13] b", "# tests 258", "# pass 258"].join(
      "\n"
    );
    expect(detectTestOutputTruncation(truncated)).toBe(true);
  });

  it("结果行数与汇总一致 ⇒ 未截断", () => {
    const complete = ["ok 1 - [AC-01] a", "not ok 2 - [AC-02] b", "# tests 2", "# fail 1"].join(
      "\n"
    );
    expect(detectTestOutputTruncation(complete)).toBe(false);
  });

  it("零匹配（`# tests 0`）不算截断——N-27 的空转判定保持不变", () => {
    expect(detectTestOutputTruncation(["1..0", "# tests 0"].join("\n"))).toBe(false);
  });

  it("没有 TAP 汇总行时不猜（非 TAP 输出）", () => {
    expect(detectTestOutputTruncation("PASS src/a.test.ts")).toBe(false);
    expect(detectTestOutputTruncation("")).toBe(false);
  });
});

/**
 * `docs/235` §6 第 1 步：检查候选由能力 profile 提供（本文件不再持有第二份表）。
 * 默认 profile 必须与迁移前一致；换 profile 时立即生效。
 */
describe("docs/235：检查候选来自能力 profile", () => {
  const scripts = { build: "node scripts/build.mjs", test: "node --test", lint: "eslint ." };

  it("默认 profile 为 frontend-vue（FRONTEND = build + lint + test）", () => {
    expect(resolveVerificationChecks("FRONTEND", scripts).plans.map((plan) => plan.name)).toEqual([
      "build",
      "lint",
      "test"
    ]);
    expect(
      resolveVerificationChecks("FRONTEND", scripts, "FRONTEND", BACKEND_NODE_PROFILE).plans.map(
        (plan) => plan.name
      )
    ).toEqual(["build", "lint"]);
  });

  it("自定义 profile 立即生效（FRONTEND 改成 test）", () => {
    const profile: CapabilityProfile = {
      ...BACKEND_NODE_PROFILE,
      checks: { FRONTEND: ["test"] }
    };
    expect(
      resolveVerificationChecks("FRONTEND", scripts, "FRONTEND", profile).plans.map(
        (plan) => plan.name
      )
    ).toEqual(["test"]);
  });

  /**
   * `docs/235` §5.1：`backend-node` 的 `FRONTEND = [build, lint]` 让前端任务的逐任务门只看
   * 「能编译、能过 lint」。`frontend-vue` 把 `test` 加回来——**这条断言就是那次转向在验证器上的
   * 落点**，否则前端任务的行为要等到 oracle 才被验一次。
   */
  it("frontend-vue profile：前端任务跑 build + lint + test", () => {
    expect(
      resolveVerificationChecks("FRONTEND", scripts, "FRONTEND", FRONTEND_VUE_PROFILE).plans.map(
        (plan) => plan.name
      )
    ).toEqual(["build", "lint", "test"]);
    // 期望为 pass（不是 TEST 任务的红灯检查）——前端任务是「测试应当通过」。
    expect(
      resolveVerificationChecks("FRONTEND", scripts, "FRONTEND", FRONTEND_VUE_PROFILE).plans.find(
        (plan) => plan.name === "test"
      )?.expectation
    ).toBe("pass");
  });

  it("frontend-vue profile：工作区缺 test script 时如实报缺，不静默通过", () => {
    // 这正是 §5.1 要防的形状：候选里有 test、只是跑不起来 ⇒ 记进 `missing`（证据面缺失），
    // 而不是像「该类型没有客观检查」那样走 unavailable。
    const resolution = resolveVerificationChecks(
      "FRONTEND",
      { build: "vite build", lint: "eslint ." },
      "FRONTEND",
      FRONTEND_VUE_PROFILE
    );
    expect(resolution.plans.map((plan) => plan.name)).toEqual(["build", "lint"]);
    expect(resolution.missing).toEqual(["test"]);
  });
});

/**
 * `docs/235` §6.8：**非 TAP runner 要有逐条结果**。
 *
 * 实测来源（F1 run 2 的 `T-07`）：vitest 默认 reporter 不打印通过的用例名 ⇒ 作用域 AC 一条都
 * 解析不到 ⇒ 「作用域全过即通过」失效 ⇒ 别的任务的测试红一次，每个任务都被判死。
 */
describe("docs/235 §6.8：给 vitest 追加逐条结果 reporter", () => {
  const VITEST = "vitest run";

  it("vitest 项目 + vitest parser → 追加 --reporter=verbose", () => {
    expect(withTestReporter("npm run test", VITEST, "vitest")).toBe(
      "npm run test -- --reporter=verbose"
    );
  });

  it("node-tap parser 不动（别的 runner 传这个参数会报错，那是新的假失败）", () => {
    expect(withTestReporter("npm run test", VITEST, "node-tap")).toBe("npm run test");
  });

  it("脚本本身不是 vitest 时不动", () => {
    expect(withTestReporter("npm run test", "node --test", "vitest")).toBe("npm run test");
    expect(withTestReporter("npm run test", "jest", "vitest")).toBe("npm run test");
  });

  it("用户已经指定过 --reporter 时不动", () => {
    expect(withTestReporter("npm run test -- --reporter=json", VITEST, "vitest")).toBe(
      "npm run test -- --reporter=json"
    );
  });

  it("作用域命令已含 -- 时只追加 --reporter，不再插第二个 --", () => {
    const scoped =
      "npm run test -- --testNamePattern '\\[AC-01\\]|\\[AC-1\\]' --testTimeout=20000";
    expect(withTestReporter(scoped, VITEST, "vitest")).toBe(`${scoped} --reporter=verbose`);
  });

  it("vitest 项目按 AC 拼 command-filter（可带文件列表）", () => {
    expect(buildAcScopedTestCommand("npm run test", ["AC-01"], "vitest run", 120_000)).toBe(
      "npm run test -- --testNamePattern '\\[AC-01\\]|\\[AC-1\\]' --testTimeout=20000"
    );
    expect(
      buildAcScopedTestCommand(
        "npm run test",
        ["AC-03"],
        "vitest run",
        120_000,
        ["tests/list.spec.ts"]
      )
    ).toBe(
      "npm run test -- 'tests/list.spec.ts' --testNamePattern '\\[AC-03\\]|\\[AC-3\\]' --testTimeout=60000"
    );
  });

  it("ANSI 颜色码不挡住逐条解析（真实 verbose 输出里 ✓ 前面压着转义序列）", () => {
    const output =
      "\u001b[32m✓\u001b[39m tests/list.spec.ts\u001b[2m > \u001b[22m[AC-03] 三条任务按 mock 顺序渲染\u001b[32m 12\u001b[2mms\u001b[39m";
    expect(parseAcResults(output)).toEqual({ "AC-03": "passed" });
  });

  it("verbatim：verbose 输出的逐条结果确实能被解析（✓ / × 两种标记）", () => {
    const output = [
      " ✓ tests/list.spec.ts > [AC-03] 三条任务按 mock 顺序渲染 12ms",
      " ✓ tests/list.spec.ts > [AC-04] 标题等于 mock 的 title 3ms",
      " × tests/search.spec.ts > [AC-15] 搜索与筛选叠加 1253ms",
      "   → expected [ …(1) ] to have a length of +0 but got 1"
    ].join("\n");
    expect(parseAcResults(output)).toEqual({
      "AC-03": "passed",
      "AC-04": "passed",
      "AC-15": "failed"
    });
  });
});

/**
 * N-64（`docs/232` §10）：**testid 命名契约**——源码里不得出现需求没声明过的 testid。
 *
 * 实测（2026-10-29 F1 第四轮）：PRD 第四节的定值表写了 `task-title-input`，但没有任何一条 AC 点名它，
 * 于是 `ui-smoke` 看不见，agent 写成 `new-task-title`，四条 Must 全失败。
 */
describe("N-64：testid 命名契约", () => {
  /** 在临时目录里铺一个工作区，跑**真实命令**（不是模拟字符串）。 */
  function scan(tree: Record<string, string>): ReturnType<typeof parseTestIdUsageScan> {
    const root = mkdtempSync(join(tmpdir(), "n64-scan-"));
    for (const [path, content] of Object.entries(tree)) {
      const full = join(root, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    const stdout = execFileSync("bash", ["-c", buildTestIdUsageScanCommand()], {
      cwd: root,
      encoding: "utf8"
    });
    return parseTestIdUsageScan(stdout);
  }

  it("收静态 testid；绑定属性与动态值跳过；测试文件不计入", () => {
    const used = scan({
      "src/App.vue": [
        '<h1 data-testid="app-title">x</h1>',
        '<li data-testid="task-item" :data-testid="bound">y</li>',
        '<span data-testid="task-${id}">z</span>',
        "<div data-testid='single-quoted'>w</div>"
      ].join("\n"),
      "src/App.spec.ts": '<div data-testid="new-task-title">should be ignored</div>',
      "node_modules/pkg/index.js": 'data-testid="also-ignored"'
    });
    expect(used).toEqual([
      { id: "app-title", file: "src/App.vue" },
      { id: "task-item", file: "src/App.vue" },
      { id: "single-quoted", file: "src/App.vue" }
    ]);
  });

  it("只收需求声明过的名字：`new-task-title` 会被判为自创", () => {
    const used = scan({
      "src/NewTaskDialog.vue": [
        '<input data-testid="new-task-title" />',
        '<button data-testid="save-task-button">保存</button>'
      ].join("\n")
    });
    expect(testIdContractViolations(used ?? [], ["save-task-button"])).toEqual([
      { id: "new-task-title", file: "src/NewTaskDialog.vue" }
    ]);
  });

  it("全部命中契约 ⇒ 无违规", () => {
    const used = scan({ "src/App.vue": '<h1 data-testid="app-title">x</h1>' });
    expect(testIdContractViolations(used ?? [], ["app-title"])).toEqual([]);
  });

  it("不可解析的输出按「未探测」处理（null，而不是「零违规」）", () => {
    expect(parseTestIdUsageScan("")).toBeNull();
    expect(parseTestIdUsageScan("not json")).toBeNull();
    expect(parseTestIdUsageScan('{"used":"nope"}')).toBeNull();
  });
});

/**
 * N-67（`docs/232` §10）：依赖探针——检查前判断工作区有没有 `node_modules`。
 *
 * 探针只回答「缺不缺」；`"unknown"` 是**保守答案**，调用方据此不动手（不因为探针抖动去装依赖）。
 */
describe("N-67：依赖探针", () => {
  it("解析布尔答案", () => {
    expect(parseDependencyProbe('{"hasNodeModules":true}')).toBe(true);
    expect(parseDependencyProbe('{"hasNodeModules":false}')).toBe(false);
    expect(
      parseDependencyProbe(
        '{"hasNodeModules":true,"nativeOk":false,"missingNative":["@rollup/rollup-linux-arm64-gnu"]}'
      )
    ).toBe(false);
    expect(
      parseDependencyProbe('{"hasNodeModules":true,"nativeOk":true,"missingNative":[]}')
    ).toBe(true);
    // AFC-M7 / M4：显式 binOk=false → 缺依赖（空 .bin）。
    expect(
      parseDependencyProbe(
        '{"hasNodeModules":true,"nativeOk":true,"binOk":false,"missingNative":[]}'
      )
    ).toBe(false);
  });

  it("不可解析 → unknown（调用方不得据此安装）", () => {
    expect(parseDependencyProbe("")).toBe("unknown");
    expect(parseDependencyProbe("not json")).toBe("unknown");
    expect(parseDependencyProbe('{"hasNodeModules":"yes"}')).toBe("unknown");
    expect(parseDependencyProbe('{"other":1}')).toBe("unknown");
  });

  it("命令在真实目录里跑出对应答案", () => {
    const root = mkdtempSync(join(tmpdir(), "n67-probe-"));
    const run = () =>
      parseDependencyProbe(
        execFileSync("bash", ["-c", buildDependencyProbeCommand()], {
          cwd: root,
          encoding: "utf8"
        })
      );
    expect(run()).toBe(false);
    mkdirSync(join(root, "node_modules"));
    // AFC-M4：仅有空 node_modules（无 .bin）视为缺依赖，不得跳过安装。
    expect(run()).toBe(false);
    mkdirSync(join(root, "node_modules", ".bin"));
    // 空 .bin 仍缺。
    expect(run()).toBe(false);
    // 放入占位 bin 后才算就绪（本夹具不装真实原生包）。
    writeFileSync(join(root, "node_modules", ".bin", "vite"), "#!/bin/sh\n");
    expect(run()).toBe(true);
  });
});


describe("docs/262：官方探测只走正规测试根", () => {
  it("isSafeTestFilePath / isCanonicalTestFilePath 拒绝宿主前缀与 workspace 副本", () => {
    expect(isCanonicalTestFilePath("tests/quality/t13.spec.ts")).toBe(true);
    expect(isCanonicalTestFilePath("test/api.test.mjs")).toBe(true);
    expect(isCanonicalTestFilePath("e2e/task-crud.spec.ts")).toBe(true);
    expect(isSafeTestFilePath("Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts")).toBe(
      false
    );
    expect(
      isCanonicalTestFilePath("Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts")
    ).toBe(false);
    expect(isCanonicalTestFilePath("workspace/tests/quality/t13.spec.ts")).toBe(false);
    expect(isCanonicalTestFilePath("dist/tests/foo.spec.ts")).toBe(false);
    expect(isCanonicalTestFilePath("coverage/tests/foo.spec.ts")).toBe(false);
  });

  it("parseAcTestFileProbe 丢掉嵌套残留，只保留正规根", () => {
    expect(
      parseAcTestFileProbe(
        JSON.stringify({
          files: [
            "Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts",
            "workspace/tests/quality/t13.spec.ts",
            "tests/quality/t13.spec.ts",
            "tests/quality/t10-quality-slice-gate.ac-17-ac-18-ac-19.spec.ts"
          ]
        })
      )
    ).toEqual([
      "tests/quality/t13.spec.ts",
      "tests/quality/t10-quality-slice-gate.ac-17-ac-18-ac-19.spec.ts"
    ]);
    expect(
      parseAcTestFileProbe(
        JSON.stringify({
          files: ["Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts"]
        })
      )
    ).toEqual([]);
  });

  it("过滤器先丢垃圾路径再截断；过滤后为空则命令为 null", () => {
    const junk = "Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts";
    const real = Array.from({ length: 3 }, (_, i) => `tests/quality/t${i}.spec.ts`);
    expect(selectCanonicalTestFiles([junk, ...real])).toEqual(real);
    expect(
      buildAcScopedTestCommand("npm run test", ["AC-17"], "vitest run", 120_000, [junk, ...real])
    ).toContain("'tests/quality/t0.spec.ts'");
    expect(
      buildAcScopedTestCommand("npm run test", ["AC-17"], "vitest run", 120_000, [junk, ...real])
    ).not.toContain("Users/shixianbao");
    expect(buildAcScopedTestCommand("npm run test", ["AC-17"], "vitest run", 120_000, [junk])).toBeNull();
    expect(
      scopedCommandUsesNonCanonicalTestFiles(
        "npm run test -- 'Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13.spec.ts'"
      )
    ).toBe(true);
    expect(
      scopedCommandUsesNonCanonicalTestFiles("npm run test -- 'tests/quality/t13.spec.ts'")
    ).toBe(false);
  });

  it("探测命令只 walk 正规根，并跳过 Users/workspace/dist/coverage", () => {
    const command = buildAcTestFileProbeCommand(["AC-01"]);
    expect(command).toContain("const roots=['tests','test','__tests__','e2e']");
    expect(command).toContain("'Users'");
    expect(command).toContain("'workspace'");
    expect(command).toContain("'dist'");
    expect(command).toContain("'coverage'");
    expect(command).toContain("for(const r of roots) walk(r)");
    expect(command).not.toContain("walk('.')");
    expect(command).not.toContain("$");
    expect(command).not.toContain("`");
  });
});
