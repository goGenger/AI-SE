import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, Task, WorkflowRun } from "@ai-se/shared";
import { ToolCallFinishedRecord, ToolCallStartedRecord } from "@ai-se/tool-runtime";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENV_GAP_INSTALL_TIMEOUT_MS } from "@ai-se/sandbox";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  FULL_SUITE_TEST_TIMEOUT_MS,
  isFullSuiteTestCommand,
  officialTestCheckTimeoutMs,
  readProtectedContentsFromWorkspace,
  resolveTaskWorkspace,
  summarizeRedLightFailures,
  TaskVerifier,
  waiveFullSuiteTimeoutIfScopedAcsGreen,
  type VerificationCheckEvidence
} from "../services/taskVerifier";
import { parseProtectedSnapshot } from "../services/taskVerifierRules";
import { VerifyingWorkflowTaskExecutor } from "../services/verifyingTaskExecutor";

/** C-3（T1）：验证门 + 包装层单测（假沙箱，无 Docker；真实命令通道另见 verificationGate.e2e）。 */

type SandboxScript = (command: string) => Partial<SandboxResult> | undefined;

class FakeSandbox implements Sandbox {
  readonly calls: string[] = [];
  readonly timeoutByCommand: Array<{ command: string; timeoutMs?: number }> = [];
  constructor(private readonly script: SandboxScript) {}

  timeoutMsFor(command: string): number | undefined {
    const matches = this.timeoutByCommand.filter((entry) => entry.command === command);
    return matches[matches.length - 1]?.timeoutMs;
  }

  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command.command);
    this.timeoutByCommand.push({ command: command.command, timeoutMs: command.timeoutMs });
    const partial = this.script(command.command);
    if (!partial) throw new Error(`unscripted sandbox command: ${command.command}`);
    return {
      command: command.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1,
      timedOut: false,
      ...partial
    };
  }
}

function makeWorkflow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: "wf-1",
    projectId: "project-1",
    requirementId: "req-1",
    planningVersion: 1,
    status: "RUNNING",
    policy: {
      maxConcurrency: 2,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: { workspacePath: "/tmp/verify-workspace" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "T1",
    title: "Backend task",
    description: "Implement endpoint",
    type: "BACKEND",
    status: "RUNNING",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function succeededResult(): TaskExecutionResult {
  return { status: "succeeded", output: { summary: "done" }, agentRunId: "run-1" };
}

const PROBE_SCRIPTS = '{"build":"node scripts/build.mjs","test":"node --test"}';

/** G1 夹具：证据任务完成时刻（远早于检查时刻）与被时间过滤排除的未来时刻。 */
const EVIDENCE_TS = "2026-01-01T00:00:00.000Z";
const FUTURE_TS = "2099-01-01T00:00:00.000Z";

function makeRecorder() {
  const started: ToolCallStartedRecord[] = [];
  const finished: ToolCallFinishedRecord[] = [];
  return {
    recorder: {
      recordToolCallStarted: async (record: ToolCallStartedRecord) => {
        started.push(record);
      },
      recordToolCallFinished: async (record: ToolCallFinishedRecord) => {
        finished.push(record);
      }
    },
    started,
    finished
  };
}

function makeEvents() {
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  return {
    sink: {
      create: async (input: {
        workflowRunId: string;
        taskId?: string;
        agentRunId?: string;
        eventType: string;
        payload: Record<string, unknown>;
      }) => {
        events.push({ eventType: input.eventType, payload: input.payload });
      }
    },
    events
  };
}

function probeMatcher(scriptsJson: string): SandboxScript {
  return (command) => {
    if (command.includes("package.json")) return { stdout: scriptsJson };
    return undefined;
  };
}

describe("TaskVerifier", () => {
  it("fails a self-reported success when the test check fails twice (attempts recorded)", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test")
        return { exitCode: 1, stdout: "not ok 1 - [AC-02] validates email format" };
      return undefined;
    });
    const recorder = makeRecorder();
    const events = makeEvents();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      toolCalls: recorder.recorder,
      events: events.sink
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("checks failed: test");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.attempts).toHaveLength(2);
    expect(testCheck?.flaked).toBe(false);
    expect(testCheck?.exitCode).toBe(1);
    expect(record.acResults).toEqual({ "AC-02": "failed" });
    expect(record.acSummary).toEqual({ total: 1, passed: 0, failed: 1 });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.eventType).toBe("TASK_VERIFICATION");
    expect(events.events[0]?.payload.verdict).toBe("failed");
    // 审计通道：检查命令经 Tool Runtime 录制（finished 收据按 toolCallId 关联，无 toolName 字段）。
    expect(recorder.started.map((entry) => entry.toolName)).toEqual(
      expect.arrayContaining(["run_command", "run_build", "run_unit_test"])
    );
    expect(recorder.finished).toHaveLength(recorder.started.length);
    expect(recorder.finished.some((entry) => entry.status === "failed")).toBe(true);
  });

  it("retries once and marks flaky when the second attempt passes", async () => {
    let testCalls = 0;
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") {
        testCalls += 1;
        return testCalls === 1
          ? { exitCode: 1, stdout: "not ok 1 - [AC-01] accepts valid input" }
          : { stdout: "ok 1 - [AC-01] accepts valid input" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "observe" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.flaked).toBe(true);
    expect(testCheck?.attempts).toHaveLength(2);
    // 逐条 AC 取末次尝试输出（flaky 后为通过）。
    expect(record.acResults).toEqual({ "AC-01": "passed" });
  });

  it("returns unavailable when no checks are available, without running any check", async () => {
    const sandbox = new FakeSandbox(probeMatcher("{}"));
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "ANALYSIS" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("unavailable");
    expect(record.verified).toBe(false);
    expect(record.reason).toContain("no available checks");
    expect(sandbox.calls.some((command) => command.startsWith("npm run"))).toBe(false);
  });

  // N-15′：DEBUG 任务派发到**目标类型**的 agent（`AgentRegistry.ts:318-319`）⇒ 该受目标类型的检查。
  // 修前 `CHECK_CANDIDATES` 没有 DEBUG 项 ⇒ 计划恒为空 ⇒ verdict 恒为 `unavailable`
  // （实测 33 条 DEBUG 记录的原因串逐字为 `no available checks for task type DEBUG`），
  // 而 DEBUG 同时在 `DEV_TASK_TYPES` 里、会改生产文件 ⇒ **一个会写代码的任务类型没有验证门**。
  it("N-15′：DEBUG 任务按其 `targetTaskType` 跑检查，不再恒为 unavailable", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "DEBUG", input: { targetTaskType: "BACKEND" } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    // 记录仍以**任务自身**类型记账（`verificationUnavailableByType` 的维度不变）。
    expect(record.taskType).toBe("DEBUG");
    expect(record.checks.map((check) => check.name)).toEqual(["build", "test"]);
  });

  it("N-15′：DEBUG 的检查真的会失败——门是有效的，不是换个名字继续放行", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-01] broken" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "DEBUG", input: { targetTaskType: "BACKEND" } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("checks failed: test");
  });

  it("N-15′：目标缺失的 DEBUG 仍是 unavailable（与修前逐字一致）", async () => {
    const sandbox = new FakeSandbox(probeMatcher(PROBE_SCRIPTS));
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "DEBUG", input: {} }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("unavailable");
    expect(record.reason).toContain("no available checks");
    expect(sandbox.calls.some((command) => command.startsWith("npm run"))).toBe(false);
  });

  it("N-15′：DEBUG→DATABASE 走迁移对（成对声明才算可用）", async () => {
    const scripts = '{"db:migrate:up":"node m/up.mjs","db:migrate:down":"node m/down.mjs"}';
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: scripts };
      if (command === "npm run db:migrate:up") return { stdout: "up ok" };
      if (command === "npm run db:migrate:down") return { stdout: "down ok" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "DEBUG", input: { targetTaskType: "DATABASE" } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.checks.map((check) => check.name)).toEqual(["migrate-up", "migrate-down"]);
  });

  it("fails on anti-tamper when a dev task weakens a protected test file (N-14)", async () => {
    const before = parseProtectedSnapshot(`${"a".repeat(64)}  ./test/api.test.mjs`);
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      if (command.includes("sha256sum"))
        return { stdout: `${"b".repeat(64)}  ./test/api.test.mjs` };
      if (command.includes("readFileSync(0,'utf8')"))
        return { stdout: JSON.stringify({ "./test/api.test.mjs": "assert.ok(2)" }) };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      before: { files: before, contents: new Map([["test/api.test.mjs", "assert.ok(1)"]]) }
    });

    expect(record.verdict).toBe("failed");
    expect(record.antiTamper).toEqual({
      verdict: "failed",
      changed: ["test/api.test.mjs"],
      weakened: ["test/api.test.mjs"]
    });
    expect(record.reason).toContain("protected test files weakened");
  });

  it("N-14：纯增量的改动不再判死，但仍留 `changed` 作证据", async () => {
    // L1-M4l 里 `T3-DEBUG-1` 的那一类：既有断言一条没少，只补了 import / 加了用例。
    const before = parseProtectedSnapshot(`${"a".repeat(64)}  ./test/api.test.mjs`);
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      if (command.includes("sha256sum"))
        return { stdout: `${"b".repeat(64)}  ./test/api.test.mjs` };
      if (command.includes("readFileSync(0,'utf8')"))
        return { stdout: JSON.stringify({ "./test/api.test.mjs": "assert.ok(1)\nassert.ok(2)" }) };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: BACKEND_NODE_PROFILE
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      before: { files: before, contents: new Map([["test/api.test.mjs", "assert.ok(1)"]]) }
    });

    expect(record.verdict).toBe("verified");
    expect(record.antiTamper).toEqual({ verdict: "passed", changed: ["test/api.test.mjs"] });
  });

  it("docs/259：内容快照采不到时跳过改弱判定，不再写成削弱", async () => {
    const before = parseProtectedSnapshot(`${"a".repeat(64)}  ./test/api.test.mjs`);
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      if (command.includes("sha256sum"))
        return { stdout: `${"b".repeat(64)}  ./test/api.test.mjs` };
      // 内容命令不脚本化 ⇒ 沙箱抛错 ⇒ 采不到内容。
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: BACKEND_NODE_PROFILE
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      before: { files: before }
    });

    expect(record.verdict).toBe("verified");
    expect(record.antiTamper?.verdict).toBe("skipped");
    expect(record.antiTamper?.unread).toEqual(["test/api.test.mjs"]);
    expect(record.antiTamper?.weakened).toBeUndefined();
    expect(record.reason).toBeUndefined();
  });

  it("docs/259：宿主机可直接读变更文件内容；交付报告不在受保护集", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-se-protected-"));
    try {
      mkdirSync(join(root, "tests", "reports"), { recursive: true });
      mkdirSync(join(root, "tests", "views"), { recursive: true });
      writeFileSync(join(root, "tests", "views", "row.spec.ts"), "assert.equal(1, 1);\n");
      writeFileSync(
        join(root, "tests", "reports", "test-execution-report.md"),
        "# report\nassert was mentioned in prose\n"
      );
      const contents = readProtectedContentsFromWorkspace(root, [
        "tests/views/row.spec.ts",
        "tests/reports/test-execution-report.md"
      ]);
      expect(contents?.get("tests/views/row.spec.ts")).toContain("assert.equal");
      expect(contents?.has("tests/reports/test-execution-report.md")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on anti-tamper even when no checks are available", async () => {
    const before = parseProtectedSnapshot(`${"a".repeat(64)}  ./test/api.test.mjs`);
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: "{}" };
      if (command.includes("sha256sum")) return { stdout: "" };
      if (command.includes("readFileSync(0,'utf8')")) return { stdout: "{}" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      before: { files: before }
    });

    expect(record.verdict).toBe("failed");
    expect(record.antiTamper?.verdict).toBe("failed");
  });

  it("runs the declared migration pair for database tasks", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json"))
        return { stdout: '{"db:migrate:up":"node up.mjs","db:migrate:down":"node down.mjs"}' };
      if (command === "npm run db:migrate:up") return { stdout: "up ok" };
      if (command === "npm run db:migrate:down") return { stdout: "down ok" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "DATABASE" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.checks.map((check) => check.name)).toEqual(["migrate-up", "migrate-down"]);
  });

  it("red-light: a TEST task whose suite passes is vacuous and fails verification", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      // F1-6（FX-20）+ G1：证据面可读（空证据列表）→ 空转诊断 VACUOUS_TEST（而非证据缺失）。
      requirementTasks: async () => []
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("red-light");
    expect(record.reason).toContain("VACUOUS_TEST");
    expect(record.failureCode).toBe("VACUOUS_TEST");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("fail");
    expect(check?.passed).toBe(false);
    expect(check?.attempts).toHaveLength(2);
    expect(check?.failureCode).toBe("VACUOUS_TEST");
  });

  it("red-light: a failing suite satisfies the check on the first attempt", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        return { exitCode: 1, stdout: "not ok 1 - [AC-01] not implemented" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.passed).toBe(true);
    expect(check?.flaked).toBe(false);
    expect(check?.attempts).toHaveLength(1);
    expect(record.acResults).toEqual({ "AC-01": "failed" });
  });

  it("red-light: green-then-red marks the check flaked", async () => {
    let calls = 0;
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        calls += 1;
        return calls === 1
          ? { stdout: "ok 1 - [AC-01] fine" }
          : { exitCode: 1, stdout: "not ok 1 - [AC-01] not implemented" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.flaked).toBe(true);
    expect(check?.attempts).toHaveLength(2);
  });

  it("E-0: flips red-light to regression when covered ACs already have implementation evidence", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        return { stdout: "ok 1 - [AC-01] boots\nok 2 - [AC-21] testids" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => [
        // 证据源 1：acKeys 计划覆盖。
        makeTask({
          id: "task-dev-1",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          input: { acKeys: ["AC-01"] }
        }),
        // 证据源 2：已验证任务自身的 acResults 覆盖（acKeys 为空的历史任务）。
        makeTask({
          id: "task-dev-2",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          input: {},
          output: { verification: { checks: [{ acResults: { "AC-21": "passed" } }] } }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-test-1", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("pass");
    expect(check?.passed).toBe(true);
    expect(check?.attempts).toHaveLength(1);
    expect(record.acResults).toEqual({ "AC-01": "passed", "AC-21": "passed" });
  });

  it("E-0: flips red-light for FR-named markers covered by sibling plan keys", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        return { stdout: "ok 1 - [FR-001] slug basics\nok 2 - [FR-008] unicode letters" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => [
        makeTask({
          id: "task-dev-1",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          input: { acKeys: ["FR-001", "FR-008"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-test-1", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("pass");
    expect(check?.passed).toBe(true);
    expect(record.acResults).toEqual({ "FR-001": "passed", "FR-008": "passed" });
  });

  it("E-0: keeps vacuous red-light when evidence is partial or self-referential", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        return { stdout: "ok 1 - [AC-01] boots\nok 2 - [AC-21] testids" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => [
        // 同 id 自引用（即便类型/状态齐备）不构成证据；他任务仅覆盖 AC-01 → AC-21 缺证据。
        makeTask({
          id: "task-test-1",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          input: { acKeys: ["AC-01", "AC-21"] }
        }),
        makeTask({
          id: "task-dev-1",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          input: { acKeys: ["AC-01"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-test-1", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("red-light");
    expect(record.reason).toContain("VACUOUS_TEST");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("fail");
    expect(check?.passed).toBe(false);
    expect(check?.failureCode).toBe("VACUOUS_TEST");
    expect(check?.attempts).toHaveLength(2);
  });

  it("F1-6（FX-20）：绿灯但解析不出任何 AC 证据 → EVIDENCE_MISSING（fail-closed）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") return { stdout: "all good, no markers" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("red-light");
    expect(record.reason).toContain("EVIDENCE_MISSING");
    expect(record.failureCode).toBe("EVIDENCE_MISSING");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.failureCode).toBe("EVIDENCE_MISSING");
  });

  it("F1-6（FX-20）+ G1：证据通道缺失（无 requirementTasks）→ EVIDENCE_MISSING", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("EVIDENCE_MISSING");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.failureCode).toBe("EVIDENCE_MISSING");
  });

  it("F1-6（FX-20）：证据通道读取失败 → EVIDENCE_MISSING", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => {
        throw new Error("db down");
      }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("EVIDENCE_MISSING");
    expect(record.reason).not.toContain("VACUOUS_TEST");
  });

  it("F1-2/FX-07：E-2b 回放——acKeys 回填后 TEST 绿灯检查翻转为回归验证（证据缺失类拦截为 0）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      if (command === "npm run test") {
        return { stdout: "ok 1 - [AC-01] basics\nok 2 - [AC-02] unicode letters" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => [
        makeTask({
          id: "task-dev-1",
          status: "SUCCESS",
          type: "BACKEND",
          finishedAt: EVIDENCE_TS,
          input: { acKeys: ["AC-01", "AC-02"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-test-1", type: "TEST" }),
      result: succeededResult()
    });

    // 回填前（acKeys 空）该形状以 "red-light check passed without implementation" fail-closed；
    // 回填后：全部 AC 均有实现证据 → 期望翻转为绿灯回归验证，拦截为 0。
    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("pass");
    expect(check?.passed).toBe(true);
    expect(record.reason ?? "").not.toContain("red-light");
    expect(record.acResults).toEqual({ "AC-01": "passed", "AC-02": "passed" });
  });
});

describe("G1（GX-01..05）：红灯判定精化——跨切片/跨 run 证据面 + 时间过滤 + 作用域", () => {
  const suiteLines = (keys: string[]) =>
    keys.map((key, index) => `ok ${index + 1} - [${key}] case`).join("\n");
  const greenTestSandbox = (keys: string[]) =>
    new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      // docs/255：TEST 有 AC 时官方命令带 --test-name-pattern；全绿输出仍可供红灯翻转。
      if (command === "npm run test" || command.startsWith("npm run test --")) {
        return { stdout: suiteLines(keys) };
      }
      return undefined;
    });
  const evidenceTask = (id: string, acKeys: string[], finishedAt = EVIDENCE_TS): Task =>
    makeTask({
      id,
      type: "BACKEND",
      status: "SUCCESS",
      finishedAt,
      input: { acKeys }
    });

  // FG1（案例 a `9626ef98` 形状）：20 键全量套件、任务无 acKeys；同切片证据仅 6 键。
  const CASE_A_KEYS = [
    "AC-01",
    "AC-02",
    "AC-03",
    "AC-04",
    "AC-05",
    "AC-06",
    "AC-07",
    "AC-08",
    "AC-09",
    "AC-10",
    "AC-11",
    "AC-12",
    "AC-13",
    "AC-14",
    "AC-15",
    "AC-16",
    "AC-17",
    "AC-18",
    "AC-23",
    "AC-30"
  ];
  const CASE_A_SLICE_KEYS = ["AC-14", "AC-15", "AC-16", "AC-17", "AC-18", "AC-23"];
  const CASE_A_CROSS_KEYS = [
    "AC-01",
    "AC-02",
    "AC-03",
    "AC-04",
    "AC-05",
    "AC-06",
    "AC-07",
    "AC-08",
    "AC-09",
    "AC-10",
    "AC-11",
    "AC-12",
    "AC-13",
    "AC-30"
  ];

  it("FG1（案例 a 形状）：证据仅覆盖本切片（14 键跨切片缺失）→ VACUOUS（复现修复前假阳）", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(CASE_A_KEYS),
      mode: "enforce",
      requirementTasks: async () => [evidenceTask("task-slice3", CASE_A_SLICE_KEYS)]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-integration", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
  });

  it("FG1（案例 a 形状）：跨切片证据补齐 → 翻转（修复后）", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(CASE_A_KEYS),
      mode: "enforce",
      requirementTasks: async () => [
        evidenceTask("task-slice3", CASE_A_SLICE_KEYS),
        evidenceTask("task-slice12", CASE_A_CROSS_KEYS)
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-integration", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("pass");
    expect(check?.passed).toBe(true);
  });

  // FG2（案例 b `51e20dc2` 形状）：17 键全量套件（含并发切片污染）、任务自身 6 键；检查时刻同工作流证据为空。
  const CASE_B_KEYS = [
    "AC-01",
    "AC-02",
    "AC-03",
    "AC-04",
    "AC-05",
    "AC-06",
    "AC-07",
    "AC-08",
    "AC-09",
    "AC-10",
    "AC-11",
    "AC-12",
    "AC-13",
    "AC-19",
    "AC-20",
    "AC-27",
    "AC-28"
  ];
  const CASE_B_SCOPE = ["AC-01", "AC-09", "AC-10", "AC-11", "AC-12", "AC-13"];

  it("FG2（案例 b 形状）：作用域键（6）齐备即翻转——全量套件跨切片解析不阻塞", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(CASE_B_KEYS),
      mode: "enforce",
      requirementTasks: async () => [evidenceTask("task-auth-impl", CASE_B_SCOPE)]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-auth-test", type: "TEST", input: { acKeys: CASE_B_SCOPE } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
  });

  it("FG2 对照：同形状无 acKeys → 全量 17 键缺 11 → VACUOUS", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(CASE_B_KEYS),
      mode: "enforce",
      requirementTasks: async () => [evidenceTask("task-auth-impl", CASE_B_SCOPE)]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-auth-test", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
  });

  // FG3（案例 c `47d7c85d` 形状）：11 键全量套件、任务自身 1 键。
  const CASE_C_KEYS = [
    "AC-01",
    "AC-02",
    "AC-03",
    "AC-05",
    "AC-06",
    "AC-07",
    "AC-08",
    "AC-19",
    "AC-20",
    "AC-27",
    "AC-28"
  ];

  it("FG3（案例 c 形状）：单键作用域（AC-19）齐备 → 翻转", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(CASE_C_KEYS),
      mode: "enforce",
      requirementTasks: async () => [evidenceTask("task-patch-impl", ["AC-19"])]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-patch-test", type: "TEST", input: { acKeys: ["AC-19"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
  });

  it("FG4（真阳保持）：全绿 + 无任何实现证据 → VACUOUS", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(["AC-01", "AC-02"]),
      mode: "enforce",
      requirementTasks: async () => []
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-empty", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
  });

  it("G1（时间过滤）：完成于检查时刻之后的证据不参与 → 保持 VACUOUS", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(["AC-01", "AC-02"]),
      mode: "enforce",
      requirementTasks: async () => [
        evidenceTask("task-old", ["AC-01"]),
        evidenceTask("task-future", ["AC-02"], FUTURE_TS)
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-filter", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
  });

  it("G1（跨 run 证据）：证据任务来自其他工作流（同需求）→ 翻转", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(["AC-01"]),
      mode: "enforce",
      requirementTasks: async () => [
        makeTask({
          id: "task-other-run",
          type: "BACKEND",
          status: "SUCCESS",
          finishedAt: EVIDENCE_TS,
          workflowRunId: "wf-old-run",
          input: { acKeys: ["AC-01"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-cross-run", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
  });
});

describe("VerifyingWorkflowTaskExecutor", () => {
  function fakeInner(result: TaskExecutionResult): WorkflowTaskExecutor {
    return {
      execute: vi.fn(async () => result),
      cancel: vi.fn(async () => undefined)
    } as unknown as WorkflowTaskExecutor;
  }

  it("enforce: overrides a self-reported success when the objective check fails", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.includes("sha256sum")) return { stdout: "" };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-02] x" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "enforce"
    );

    const result = await executor.execute(makeWorkflow(), makeTask());

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const output = result.output as Record<string, unknown>;
    expect(output.errorType).toBe("VERIFICATION_FAILED");
    const verification = output.verification as Record<string, unknown>;
    expect(verification.verdict).toBe("failed");
    // 失败重跑一次，两次都失败才判失败。
    const checks = verification.checks as { name: string; attempts: unknown[] }[];
    expect(checks.find((check) => check.name === "test")?.attempts).toHaveLength(2);
    expect(output.summary).toBe("done");
  });

  it("observe: records the failed verdict without overriding the task result", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.includes("sha256sum")) return { stdout: "" };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-02] x" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "observe" });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "observe"
    );

    const result = await executor.execute(makeWorkflow(), makeTask());

    expect(result.status).toBe("succeeded");
    const output = result.output as Record<string, unknown>;
    expect((output.verification as Record<string, unknown>).verdict).toBe("failed");
    expect((output.verification as Record<string, unknown>).mode).toBe("observe");
    expect(output.errorType).toBeUndefined();
  });

  it("passes through inner failures untouched and takes no after snapshot", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("sha256sum")) return { stdout: "" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });
    const innerResult: TaskExecutionResult = {
      status: "failed",
      error: { code: "AGENT_ERROR", message: "boom" },
      output: { summary: "failed attempt" }
    };
    const executor = new VerifyingWorkflowTaskExecutor(verifier, fakeInner(innerResult), "enforce");

    const result = await executor.execute(makeWorkflow(), makeTask());

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AGENT_ERROR");
    expect((result.output as Record<string, unknown>).verification).toBeUndefined();
    // 仅 before 快照一次；未执行探针/检查。
    expect(sandbox.calls.filter((command) => command.includes("sha256sum"))).toHaveLength(1);
    expect(sandbox.calls.some((command) => command.includes("package.json"))).toBe(false);
  });

  it("degrades to an explicit unavailable record when the verifier throws", async () => {
    const sandbox = new FakeSandbox(probeMatcher(PROBE_SCRIPTS));
    const verifier = new TaskVerifier({
      sandbox,
      mode: "observe",
      events: {
        create: async () => {
          throw new Error("event sink down");
        }
      }
    });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "observe"
    );

    const result = await executor.execute(makeWorkflow(), makeTask({ type: "TEST" }));

    expect(result.status).toBe("succeeded");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("unavailable");
    expect(verification.reason).toContain("event sink down");
  });

  it("DEBUG: records failed product checks but does not override diagnosis SUCCESS (even under L1 enforce)", async () => {
    // taskflow-vue v8：T-03-DEBUG-1 诊断完成、未改产品文件，但 npm test 因尚未实现的
    // TaskForm.vue 红灯 → 旧逻辑 VERIFICATION_FAILED，卡住依赖边的 -REPLAN-N。
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.includes("sha256sum")) return { stdout: "" };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") {
        return {
          exitCode: 1,
          stdout:
            "FAIL src/components/task/TaskForm.spec.ts\nCannot find module '@/components/task/TaskForm.vue'"
        };
      }
      return undefined;
    });
    // 显式 backend-node：避免默认 frontend-vue 的 registry 依赖探针打乱假沙箱。
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: BACKEND_NODE_PROFILE
    });
    const diagnosis: TaskExecutionResult = {
      status: "succeeded",
      output: {
        summary:
          "Diagnosis complete: TaskForm.spec.ts imports TaskForm.vue which is not implemented yet (pending FRONTEND tasks). No product/test files modified."
      },
      agentRunId: "debug-run-1"
    };
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(diagnosis),
      "enforce",
      BACKEND_NODE_PROFILE
    );
    const l1Workflow = makeWorkflow({
      policy: {
        maxConcurrency: 1,
        maxRetries: 2,
        failureStrategy: "REPLAN",
        allowRetry: true,
        allowReplan: true,
        approvalRequired: false,
        autonomyLevel: "L1"
      }
    });

    const result = await executor.execute(
      l1Workflow,
      makeTask({ type: "DEBUG", input: { targetTaskType: "BACKEND" } })
    );

    expect(result.status).toBe("succeeded");
    const output = result.output as Record<string, unknown>;
    expect(output.errorType).toBeUndefined();
    const verification = output.verification as Record<string, unknown>;
    expect(verification.mode).toBe("observe");
    expect(verification.verdict).toBe("failed");
    expect(String(output.summary)).toContain("Diagnosis complete");
  });

  it("BACKEND under L1 enforce: still overrides SUCCESS when product tests fail", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.includes("sha256sum")) return { stdout: "" };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-02] x" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "observe",
      profile: BACKEND_NODE_PROFILE
    });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "observe",
      BACKEND_NODE_PROFILE
    );
    const l1Workflow = makeWorkflow({
      policy: {
        maxConcurrency: 1,
        maxRetries: 2,
        failureStrategy: "REPLAN",
        allowRetry: true,
        allowReplan: true,
        approvalRequired: false,
        autonomyLevel: "L1"
      }
    });

    const result = await executor.execute(l1Workflow, makeTask({ type: "BACKEND" }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
  });
});

describe("resolveTaskWorkspace", () => {
  it("prefers the task workspace then the workflow workspace", () => {
    expect(resolveTaskWorkspace(makeWorkflow(), makeTask({ input: { workspacePath: "/a" } }))).toBe(
      "/a"
    );
    expect(resolveTaskWorkspace(makeWorkflow(), makeTask())).toBe("/tmp/verify-workspace");
  });
});

describe("TaskVerifier（F1-5 三层检查：任务级作用域 / 切片边界 / commit 归属）", () => {
  function fakeInner(result: TaskExecutionResult): WorkflowTaskExecutor {
    return {
      execute: vi.fn(async () => result),
      cancel: vi.fn(async () => undefined)
    } as unknown as WorkflowTaskExecutor;
  }

  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;

  it("FX-16：任务 A 已实现、任务 B 的测试已写但未实现——A 的任务级检查通过（修复前为红）", async () => {
    const scopedCommand = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === scopedCommand) return { stdout: "ok 1 - [AC-01] implemented" };
      // 全量命令（含任务 B 未实现的测试）必红——作用域修复后不应被调用。
      if (command === "npm run test")
        return { exitCode: 1, stdout: "not ok 2 - [AC-02] pending implementation" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.command).toBe(scopedCommand);
    expect(testCheck?.scopingMode).toBe("command-filter");
    expect(testCheck?.scopedAcKeys).toEqual(["AC-01"]);
    expect(record.acResults).toEqual({ "AC-01": "passed" });
    // 不退化为全量套件：作用域命令之外的全量 `npm run test` 从未执行。
    expect(sandbox.calls).not.toContain("npm run test");
  });

  it("FX-16：vitest 项目走 command-filter——作用域 AC 全过且不跑全量套件", async () => {
    const scoped =
      "npm run test -- --testNamePattern '\\[AC-01\\]|\\[AC-1\\]' --testTimeout=20000 --reporter=verbose";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json"))
        return { stdout: '{"build":"node scripts/build.mjs","test":"vitest run","lint":"eslint ."}' };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("hasNodeModules"))
        return { stdout: '{"hasNodeModules":true,"nativeOk":true,"binOk":true,"missingNative":[]}' };
      if (command.startsWith("node -e") && command.includes("suffixes"))
        return { stdout: '{"files":[]}' };
      if (command === "npm run build" || command === "npm run lint") return { stdout: "build ok" };
      if (command === scoped) return { stdout: "✓ tests/a.spec.ts > [AC-01] implemented" };
      if (command === "npm run test" || command === "npm run test -- --reporter=verbose")
        return { exitCode: 1, stdout: "should not run full suite" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", profile: FRONTEND_VUE_PROFILE });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "FRONTEND", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.scopingMode).toBe("command-filter");
    expect(testCheck?.command).toBe(scoped);
    expect(sandbox.calls).not.toContain("npm run test");
    expect(sandbox.calls).not.toContain("npm run test -- --reporter=verbose");
  });

  it("FX-16：vitest 作用域内的测试失败仍然判失败（command-filter 不放水）", async () => {
    const scoped =
      "npm run test -- --testNamePattern '\\[AC-01\\]|\\[AC-1\\]' --testTimeout=20000 --reporter=verbose";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json"))
        return { stdout: '{"build":"node scripts/build.mjs","test":"vitest run","lint":"eslint ."}' };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("hasNodeModules"))
        return { stdout: '{"hasNodeModules":true,"nativeOk":true,"binOk":true,"missingNative":[]}' };
      if (command.startsWith("node -e") && command.includes("suffixes"))
        return { stdout: '{"files":[]}' };
      if (command === "npm run build" || command === "npm run lint") return { stdout: "build ok" };
      if (command === scoped)
        return { exitCode: 1, stdout: "× tests/a.spec.ts > [AC-01] broken" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", profile: FRONTEND_VUE_PROFILE });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "FRONTEND", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("checks failed: test");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.scopingMode).toBe("command-filter");
    expect(testCheck?.attempts).toHaveLength(2);
    expect(record.acResults).toEqual({ "AC-01": "failed" });
  });

  it("有 AC 但 runner 不受支持 → fail-closed（AC_SCOPE_UNSUPPORTED），绝不跑全量套件", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json"))
        return { stdout: '{"build":"node scripts/build.mjs","test":"jest"}' };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("hasNodeModules"))
        return { stdout: '{"hasNodeModules":true,"nativeOk":true,"binOk":true,"missingNative":[]}' };
      if (command.startsWith("node -e") && command.includes("suffixes"))
        return { stdout: '{"files":[]}' };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test"))
        return { exitCode: 1, stdout: "full suite must not run" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", profile: BACKEND_NODE_PROFILE });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.failureCode).toBe("AC_SCOPE_UNSUPPORTED");
    expect(testCheck?.scopingMode).toBeUndefined();
    expect(sandbox.calls.filter((command) => command.startsWith("npm run test"))).toEqual([]);
  });

  it("FX-18：验证记录与每条检查携带工作区 HEAD；事件含 commitSha", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { stdout: `${commit}\n` };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test --")) return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", events: events.sink });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.commitSha).toBe(commit);
    expect(record.checks.length).toBeGreaterThan(0);
    expect(record.checks.every((check) => check.commitSha === commit)).toBe(true);
    expect(events.events[0]?.payload.commitSha).toBe(commit);
  });

  it("FX-25：验证门按项目 runner 解析命令（锁文件判定 pnpm → `pnpm test`/`pnpm build`，作用域命令同基）", async () => {
    const scopedCommand = "pnpm test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json"))
        return {
          stdout: JSON.stringify({
            hasPackageJson: true,
            lockfiles: ["yarn.lock", "pnpm-lock.yaml"],
            scripts: { build: "node scripts/build.mjs", test: "node --test" }
          })
        };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "pnpm build") return { stdout: "build ok" };
      if (command === scopedCommand) return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const build = record.checks.find((check) => check.name === "build");
    expect(build?.command).toBe("pnpm build");
    // 多锁文件：固定顺序选择 + 告警随证据返回（packageManager 字段优先路径即短路，不产生该告警）。
    expect(build?.warnings?.[0]).toContain("fixed order");
    const test = record.checks.find((check) => check.name === "test");
    expect(test?.command).toBe(scopedCommand);
    expect(test?.scopingMode).toBe("command-filter");
    expect(test?.scopedAcKeys).toEqual(["AC-01"]);
  });

  it("FX-17：切片最后一个实现任务运行边界检查（切片 AC 并集），全部通过", async () => {
    const ownScoped = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === ownScoped) return { stdout: "ok 1 - [AC-01] one" };
      if (command === boundaryScoped) return { stdout: "ok 1 - [AC-01] one\nok 2 - [AC-02] two" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T01",
          sliceKey: "S1",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(true);
    expect(boundary?.command).toBe(boundaryScoped);
    expect(boundary?.scopedAcKeys).toEqual(["AC-01", "AC-02"]);
    const boundaryEvent = events.events.find(
      (event) => event.eventType === "SLICE_BOUNDARY_CHECKED"
    );
    expect(boundaryEvent?.payload).toMatchObject({
      sliceKey: "S1",
      verdict: "passed",
      acKeys: ["AC-01", "AC-02"]
    });
  });

  it("FX-17：边界检查失败 → 判定失败并由包装层送入失败策略（VERIFICATION_FAILED）", async () => {
    const ownScoped = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === ownScoped) return { stdout: "ok 1 - [AC-01] one" };
      if (command === boundaryScoped)
        return { exitCode: 1, stdout: "ok 1 - [AC-01] one\nnot ok 2 - [AC-02] broken" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T01",
          sliceKey: "S1",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } })
      ]
    });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "enforce"
    );

    const result = await executor.execute(
      makeWorkflow(),
      makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } })
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("failed");
    const checks = verification.checks as { name: string; passed: boolean }[];
    expect(checks.find((check) => check.name === "test")?.passed).toBe(true);
    expect(checks.find((check) => check.name === "slice-boundary")?.passed).toBe(false);
    const boundaryEvent = events.events.find(
      (event) => event.eventType === "SLICE_BOUNDARY_CHECKED"
    );
    expect(boundaryEvent?.payload.verdict).toBe("failed");
  });

  it("N-49：进程活着但切片 AC 点名的业务路由全部 404 → 边界任务判失败（SURFACE_UNMOUNTED）", async () => {
    // 第六次回归的实测形状：健康端点 200，`/api/register` 404，项目自己的测试全绿。
    const probeScripts = '{"build":"node scripts/build.mjs","test":"node --test","start":"node src/server.js"}';
    const smokeVerdict = JSON.stringify({
      booted: true,
      exited: false,
      exitCode: null,
      signal: null,
      control: { method: "GET", path: "/__ai_se_smoke__abc", status: 404 },
      probes: [{ method: "POST", path: "/api/register", status: 404 }],
      stderrTail: ""
    });
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: probeScripts };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith('node -e "const{spawn}')) return { stdout: smokeVerdict };
      if (command.startsWith("npm run test")) return { stdout: "ok 1 - [AC-02] one" };
      return undefined;
    });
    const events = makeEvents();
    const sliceTasks = [
      makeTask({
        id: "task-first",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "SUCCESS",
        input: { acKeys: ["AC-02"], acceptanceCriteria: ["POST /api/register 新用户名 → 201"] }
      }),
      makeTask({
        taskKey: "S1-T02",
        sliceKey: "S1",
        input: { acKeys: ["AC-02"], acceptanceCriteria: ["POST /api/register 重复用户名 → 409"] }
      })
    ];
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => sliceTasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: sliceTasks[1] as Task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("server-smoke");
    expect(record.failureCode).toBe("SURFACE_UNMOUNTED");
    const smoke = record.checks.find((check) => check.name === "server-smoke");
    expect(smoke?.passed).toBe(false);
    expect(smoke?.failureCode).toBe("SURFACE_UNMOUNTED");
    expect(smoke?.smoke?.probes).toEqual([
      { route: "POST /api/register", status: 404 }
    ]);
    // 边界那条「再跑一遍测试」仍然是绿的——这正是 N-49：它看不见路由有没有挂上。
    expect(record.checks.find((check) => check.name === "slice-boundary")?.passed).toBe(true);
  });

  it("N-49：缺依赖/无网导致的启动失败只留痕（smokeSkipped），不判交付缺陷", async () => {
    const probeScripts = '{"build":"node scripts/build.mjs","test":"node --test","start":"node src/server.js"}';
    const smokeVerdict = JSON.stringify({
      booted: false,
      exited: true,
      exitCode: 1,
      signal: null,
      control: null,
      probes: [],
      stderrTail: "Error: Cannot find module 'express'"
    });
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: probeScripts };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith('node -e "const{spawn}')) return { stdout: smokeVerdict };
      if (command.startsWith("npm run test")) return { stdout: "ok 1 - [AC-02] one" };
      return undefined;
    });
    const sliceTasks = [
      makeTask({
        id: "task-first",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "SUCCESS",
        input: { acKeys: ["AC-02"], acceptanceCriteria: ["POST /api/register 新用户名 → 201"] }
      }),
      makeTask({
        taskKey: "S1-T02",
        sliceKey: "S1",
        input: { acKeys: ["AC-02"], acceptanceCriteria: ["POST /api/register 重复用户名 → 409"] }
      })
    ];
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: makeEvents().sink,
      workflowTasks: async () => sliceTasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: sliceTasks[1] as Task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.smokeSkipped).toBe("BOOT_ENV_UNRESOLVED");
    expect(record.checks.find((check) => check.name === "server-smoke")).toBeUndefined();
  });

  it("N-50：切片最后一项是失败任务的解决者 → 边界检查照常触发（不再判「源任务未解决」）", async () => {
    // 第七次回归 S1 的形状：T5(REVIEW) 失败 → T5-REPLAN-1 成功；验证后者时它自己还是 RUNNING。
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test")) return { stdout: "ok 1 - [AC-01] one" };
      return undefined;
    });
    const events = makeEvents();
    const sliceTasks = [
      makeTask({
        id: "task-src",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "FAILED",
        resolvedByTaskId: "task-replan",
        input: { acKeys: ["AC-01"] }
      }),
      makeTask({
        id: "task-replan",
        taskKey: "S1-T01-REPLAN-1",
        sliceKey: "S1",
        status: "RUNNING",
        input: { acKeys: ["AC-01"] }
      })
    ];
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => sliceTasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: sliceTasks[1] as Task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.boundarySkipped).toBeUndefined();
    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(true);
    expect(events.events.some((event) => event.eventType === "SLICE_BOUNDARY_CHECKED")).toBe(true);
  });

  it("N-50 反向：失败源任务指向的解决者不是当前任务（仍 PENDING）→ 边界检查照旧跳过", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test")) return { stdout: "ok 1 - [AC-01] one" };
      return undefined;
    });
    const sliceTasks = [
      makeTask({
        id: "task-src",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "FAILED",
        resolvedByTaskId: "task-pending",
        input: { acKeys: ["AC-01"] }
      }),
      makeTask({
        id: "task-pending",
        taskKey: "S1-T01-REPLAN-1",
        sliceKey: "S1",
        status: "PENDING",
        input: { acKeys: ["AC-01"] }
      }),
      makeTask({
        id: "task-last",
        taskKey: "S1-T02",
        sliceKey: "S1",
        status: "RUNNING",
        input: { acKeys: ["AC-01"] }
      })
    ];
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: makeEvents().sink,
      workflowTasks: async () => sliceTasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: sliceTasks[2] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "slice-boundary")).toBeUndefined();
    expect(record.boundarySkipped).toContain("siblings-unfinished");
  });

  it("FX-17：切片内尚有未完成实现任务时不运行边界检查", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test --")) return { stdout: "ok 1 - [AC-01] one" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T01",
          sliceKey: "S1",
          status: "RUNNING",
          input: { acKeys: ["AC-02"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.checks.map((check) => check.name)).toEqual(["build", "test"]);
    expect(events.events.some((event) => event.eventType === "SLICE_BOUNDARY_CHECKED")).toBe(false);
  });

  it("PL-M2：只有 TEST 任务的切片也触发边界检查——红灯未转绿 → 判失败", async () => {
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const red = { exitCode: 1, stdout: "not ok 1 - [AC-01] broken\nnot ok 2 - [AC-02] broken" };
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run test" || command.startsWith("npm run test --")) return { ...red };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: events.sink,
      workflowTasks: async () => [
        makeTask({
          id: "test-first",
          taskKey: "S9-T01",
          type: "TEST",
          sliceKey: "S9",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({
          taskKey: "S9-T02",
          type: "TEST",
          sliceKey: "S9",
          input: { acKeys: ["AC-01"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({
        taskKey: "S9-T02",
        type: "TEST",
        sliceKey: "S9",
        input: { acKeys: ["AC-01"] }
      }),
      result: succeededResult()
    });

    // 红灯检查通过（测试确实红了），但切片边界要求「本切片的测试已转绿」→ 边界检查判失败。
    expect(record.checks.find((check) => check.name === "test")?.passed).toBe(true);
    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.expected).toBe("pass");
    expect(boundary?.passed).toBe(false);
    expect(boundary?.command).toBe(boundaryScoped);
    expect(boundary?.scopedAcKeys).toEqual(["AC-01", "AC-02"]);
    expect(record.verdict).toBe("failed");
    const boundaryEvent = events.events.find(
      (event) => event.eventType === "SLICE_BOUNDARY_CHECKED"
    );
    expect(boundaryEvent?.payload).toMatchObject({ sliceKey: "S9", verdict: "failed" });
  });

  it("PL-M2：只被 TEST 任务引用的 AC 进入边界检查范围（run 3 slice-5 的缺口）", async () => {
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000")
        return { stdout: "ok 1 - [AC-01] one" };
      // 边界命令把 AC-02 也纳入：AC-02 只被 TEST 任务引用，此前根本不进范围。
      if (command === boundaryScoped)
        return { exitCode: 1, stdout: "ok 1 - [AC-01] one\nnot ok 2 - [AC-02] broken" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "test-sibling",
          taskKey: "S9-T01",
          type: "TEST",
          sliceKey: "S9",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({ taskKey: "S9-T02", sliceKey: "S9", input: { acKeys: ["AC-01"] } })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S9-T02", sliceKey: "S9", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.scopedAcKeys).toEqual(["AC-01", "AC-02"]);
    expect(boundary?.passed).toBe(false);
    expect(record.verdict).toBe("failed");
  });

  it("PL-M2：切片内未完成的交付链任务不阻断边界检查锚点", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command.startsWith("npm run test --"))
        return { stdout: "ok 1 - [AC-01] one\nok 2 - [AC-02] two" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "impl-first",
          taskKey: "S9-T01",
          sliceKey: "S9",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({
          id: "deploy-later",
          taskKey: "S9-T03",
          type: "DEPLOY",
          sliceKey: "S9",
          status: "PENDING",
          input: { acKeys: ["AC-03"], delivery: { action: "DEPLOY", environment: "staging" } }
        }),
        makeTask({ taskKey: "S9-T02", sliceKey: "S9", input: { acKeys: ["AC-01"] } })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S9-T02", sliceKey: "S9", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(true);
    // 交付链任务的 AC 仍计入范围（AC-03 只被 DEPLOY 任务引用）。
    expect(boundary?.scopedAcKeys).toEqual(["AC-01", "AC-02", "AC-03"]);
    expect(record.verdict).toBe("verified");
  });
});

describe("TaskVerifier（N-47：无 acKeys 的 dev 任务不跑逐任务绿灯 test 检查）", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;

  /**
   * N-47（`docs/232` §9.11）：实测形状——`s3-03-task-repository` 没有 acKeys，旧口径按本切片
   * AC 并集兜底，于是被 `s3-04-create-api` 才交付的建任务测试判死；DEBUG/REPLAN 五次继承同一份
   * 空 acKeys、反复跑同一条命令。现在这类任务不跑绿灯 test，绿灯交给 build 与切片边界。
   */
  it("N-47：无 acKeys 的 dev 任务跳过 test 检查（留痕 NO_AC_SCOPE），不被切片内其它任务的测试拖垮", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      // 切片内其它任务的测试此刻还是红的——不该再被调用到。
      if (command.startsWith("npm run test"))
        return { exitCode: 1, stdout: "not ok 2 - [AC-25] restart persistence" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "task-test",
          taskKey: "S1-T11",
          type: "TEST",
          sliceKey: "S1",
          status: "PENDING",
          input: { acKeys: ["AC-04"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      // PL-M4 run 1 的 T-10 形状：BACKEND、无 acKeys。
      task: makeTask({ taskKey: "S1-T10", sliceKey: "S1", input: {} }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.checks.find((check) => check.name === "test")).toBeUndefined();
    expect(record.skippedChecks).toEqual([{ name: "test", reason: "NO_AC_SCOPE" }]);
    expect(sandbox.calls.filter((command) => command.startsWith("npm run test"))).toEqual([]);
  });

  it("N-47：切片内根本没有 AC 记录 → 不存在 AC 作用域，维持旧口径（无作用域的全量套件）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-25] x" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({ id: "task-test", taskKey: "S1-T11", type: "TEST", sliceKey: "S1", input: {} })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T10", sliceKey: "S1", input: {} }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.skippedChecks).toBeUndefined();
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.command).toBe("npm run test");
  });

  it("PL-M8：已声明 acKeys 的任务作用域逐字不变（只取自身，不并入切片并集）", async () => {
    const ownScoped = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === ownScoped) return { stdout: "ok 1 - [AC-01] x" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "task-b",
          taskKey: "S1-T02",
          sliceKey: "S1",
          input: { acKeys: ["AC-04"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T01", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.scopedAcKeys).toEqual(["AC-01"]);
    expect(testCheck?.command).toBe(ownScoped);
  });
});

describe("TaskVerifier（PL-M9：检查可判定性——可见化 9a + TEST fail-closed 9c）", () => {
  function fakeInner(result: TaskExecutionResult): WorkflowTaskExecutor {
    return {
      execute: vi.fn(async () => result),
      cancel: vi.fn(async () => undefined)
    } as unknown as WorkflowTaskExecutor;
  }

  it("9c：TEST 任务缺 test script 时判 failed + EVIDENCE_MISSING，且一条检查都没跑", async () => {
    const sandbox = new FakeSandbox(probeMatcher("{}"));
    const events = makeEvents();
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", events: events.sink });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.verified).toBe(false);
    expect(record.failureCode).toBe("EVIDENCE_MISSING");
    expect(record.missingChecks).toEqual(["test"]);
    expect(record.reason).toContain("not adjudicable");
    expect(record.checks).toEqual([]);
    // 红灯检查是 TEST 任务存在的全部理由——跑不起来即等于什么都没验证。
    expect(sandbox.calls.some((command) => command.startsWith("npm run"))).toBe(false);
    // 9c 的失败由 TASK_VERIFICATION 的失败码承载，不另发观察事件。
    expect(events.events.map((entry) => entry.eventType)).toEqual(["TASK_VERIFICATION"]);
  });

  it("9c：enforce 下经包装层覆盖自报成功（errorType=VERIFICATION_FAILED）", async () => {
    const sandbox = new FakeSandbox(probeMatcher("{}"));
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      fakeInner(succeededResult()),
      "enforce"
    );

    const result = await executor.execute(makeWorkflow(), makeTask({ type: "TEST" }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("failed");
    expect(verification.failureCode).toBe("EVIDENCE_MISSING");
  });

  it("9a：非 TEST 类型缺 script 时维持 unavailable，但发 TASK_CHECK_UNAVAILABLE 事件并记账", async () => {
    const sandbox = new FakeSandbox(probeMatcher("{}"));
    const events = makeEvents();
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", events: events.sink });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "BACKEND" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("unavailable");
    expect(record.verified).toBe(false);
    expect(record.missingChecks).toEqual(["build", "test"]);
    expect(record.reason).toContain("no available checks");
    const observation = events.events.find(
      (entry) => entry.eventType === "TASK_CHECK_UNAVAILABLE"
    );
    expect(observation?.payload).toMatchObject({
      stage: "task_verification",
      taskKey: "T1",
      taskType: "BACKEND",
      missing: ["build", "test"]
    });
    // 纯观察：payload 不含 errorCode，因此不会被 collectFailureLayers 误计入失败层。
    expect(observation?.payload.errorCode).toBeUndefined();
  });

  it("9a：本类型没有客观检查时维持 unavailable，且不发事件、不记 missingChecks", async () => {
    const sandbox = new FakeSandbox(probeMatcher("{}"));
    const events = makeEvents();
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", events: events.sink });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "ANALYSIS" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("unavailable");
    expect(record.missingChecks).toBeUndefined();
    expect(events.events.map((entry) => entry.eventType)).toEqual(["TASK_VERIFICATION"]);
  });

  it("9a/9c：script 存在时判定逐字不变（TEST 仍走红灯检查）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run test") return { exitCode: 1, stdout: "not ok 1 - [AC-01] x" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({ sandbox, mode: "enforce", events: events.sink });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.missingChecks).toBeUndefined();
    expect(record.checks.map((check) => check.name)).toEqual(["test"]);
    expect(events.events.map((entry) => entry.eventType)).toEqual(["TASK_VERIFICATION"]);
  });
});

/**
 * PL-M18（N-10）：无锚点 TEST 任务的红灯作用域回退。
 * 生产形状 = L1-M4i run 1 的 `T10`：任务无 `acKeys`、带 `sliceKey`；套件解析出 5 键，
 * 其中 `AC-29`/`AC-30` 属别的切片，`FR-06` 是从测试标题的 FR 编号解析出来的
 * （本需求没有任何任务声明过它）⇒ 改动前 `acKeys.every(...)` 恒假、`VACUOUS_TEST` 恒成立。
 */
describe("PL-M18（N-10）：红灯作用域回退——无锚点时收回本切片", () => {
  const suiteLines = (keys: string[]) =>
    keys.map((key, index) => `ok ${index + 1} - [${key}] case`).join("\n");
  const greenTestSandbox = (keys: string[]) =>
    new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: '{"test":"node --test"}' };
      // docs/255：TEST 有 AC 时官方命令带 --test-name-pattern；全绿输出仍可供红灯翻转。
      if (command === "npm run test" || command.startsWith("npm run test --")) {
        return { stdout: suiteLines(keys) };
      }
      return undefined;
    });
  const devTask = (
    id: string,
    acKeys: string[],
    sliceKey: string,
    type: Task["type"] = "BACKEND"
  ): Task =>
    makeTask({
      id,
      type,
      status: "SUCCESS",
      finishedAt: EVIDENCE_TS,
      sliceKey,
      input: { acKeys }
    });

  const PRODUCTION_KEYS = ["AC-04", "AC-29", "AC-30", "FR-06"];

  it("无 acKeys + 有 sliceKey：作用域收回本切片 → 翻转", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(PRODUCTION_KEYS),
      mode: "enforce",
      requirementTasks: async () => [
        devTask("task-slice2-impl", ["AC-04"], "slice-2"),
        devTask("task-slice4-impl", ["AC-29", "AC-30"], "slice-4")
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-qa", type: "TEST", sliceKey: "slice-2" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.expected).toBe("pass");
    expect(check?.passed).toBe(true);
  });

  it("无 acKeys + 无 sliceKey：行为与改动前逐字相同（全量作用域仍判 VACUOUS），且 reason 点名缺证据的 AC", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(PRODUCTION_KEYS),
      mode: "enforce",
      requirementTasks: async () => [devTask("task-slice2-impl", ["AC-04"], "slice-2")]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-qa", type: "TEST" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.uncoveredAcKeys).toEqual(["AC-29", "AC-30", "FR-06"]);
    expect(record.reason).toContain("uncovered: AC-29,AC-30,FR-06");
  });

  it("反向对照：本切片的 AC 没有实现证据 → 仍判 VACUOUS（红灯门未被放松）", async () => {
    const verifier = new TaskVerifier({
      sandbox: greenTestSandbox(PRODUCTION_KEYS),
      mode: "enforce",
      requirementTasks: async () => [
        // 同切片、声明了 AC-04，但是 TEST 任务——不是开发类，不构成实现证据。
        devTask("task-slice2-test", ["AC-04"], "slice-2", "TEST")
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ id: "task-qa", type: "TEST", sliceKey: "slice-2" }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
    const check = record.checks.find((entry) => entry.name === "test");
    expect(check?.uncoveredAcKeys).toEqual(["AC-04"]);
  });
});

describe("TaskVerifier（N-26：作用域判定不被兄弟切片的钩子失败污染）", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const SCOPED =
    "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";

  /**
   * L1-M4p run 1 的 `T-008` 原文形状：`--test-name-pattern` 只筛**测试名**，
   * `node --test` 仍加载 `test/` 下的**每个**文件并执行其顶层钩子；兄弟切片的测试文件
   * 钩子失败（`ERR_SERVER_NOT_RUNNING`）⇒ 整条命令 exit 1，而本切片 AC-01 **自己全过**。
   */
  const SIBLING_HOOK_FAILURE = [
    "ok 1 - [AC-01] health endpoints need no Authorization header and are not protected",
    "not ok 2 - /workspace/test/login.ac09-10.test.js",
    "  ---",
    "  failureType: 'hookFailed'",
    "  error: 'Server is not running.'",
    "  code: 'ERR_SERVER_NOT_RUNNING'",
    "  ..."
  ].join("\n");

  it("command-filter：兄弟切片的钩子失败不再把本切片判失败（主判据）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED) return { exitCode: 1, stdout: SIBLING_HOOK_FAILURE };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.scopingMode).toBe("command-filter");
    // 关键：命令**确实**以非零退出码失败——放行靠的是作用域内 AC 的结果，不是命令成功。
    expect(testCheck?.exitCode).toBe(1);
    expect(testCheck?.attempts).toHaveLength(1);
    expect(testCheck?.failureCode).toBeUndefined();
    expect(record.acResults).toEqual({ "AC-01": "passed" });
  });

  it("负控：作用域内 AC 失败仍然判失败（规则没有放水）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED)
        return {
          exitCode: 1,
          stdout: [
            "not ok 1 - [AC-01] health endpoints need no Authorization header",
            "ok 2 - [AC-09] an unrelated sibling test"
          ].join("\n")
        };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.attempts).toHaveLength(2);
  });

  it("负控：一条 AC 结果都没解析出来时仍然判失败（N-10 的空转防线不放松）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      // 只有兄弟文件的钩子失败、**没有任何** AC 结果——放宽不得把这种情形放行。
      if (command === SCOPED)
        return {
          exitCode: 1,
          stdout: [
            "not ok 2 - /workspace/test/login.ac09-10.test.js",
            "  ---",
            "  failureType: 'hookFailed'",
            "  ..."
          ].join("\n")
        };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
  });

  it("N-27：command-filter 零匹配（exit 0 / `# tests 0`）不再空转通过", async () => {
    // 缺陷原文形状：`--test-name-pattern` 一条都没匹配上时，`node --test` **退出码是 0**
    // （TAP `1..0`），而 `resolveCheckOutcome` 在 `expectation !== "fail"` 时只看 `result.success`
    // ⇒ 空转通过。L1-M4q 三个 run 各复现 1 次，全部来自同一个任务 T1（`docs/209` §4）。
    const EMPTY_TAP = ["TAP version 13", "1..0", "# tests 0", "# pass 0", "# fail 0"].join("\n");
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED) return { exitCode: 0, stdout: EMPTY_TAP };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
    // 关键：命令**成功**了（exit 0）——判失败靠的是「没有本切片 AC 的证据」，不是命令失败。
    expect(testCheck?.exitCode).toBe(0);
    expect(testCheck?.timedOut).toBe(false);
    expect(testCheck?.uncoveredAcKeys).toEqual(["AC-01"]);
  });

  it("N-55：输出被截断时「没看到 AC」不再判未覆盖（按退出码裁决并留痕）", async () => {
    // 第十一次回归 slice-3 `T7` 的形状：258 条用例、输出 137KB，而沙箱只保留最后 96KB
    // （`packages/sandbox/src/index.ts:69-76`）⇒ 排在前面的 `[AC-24]` 整段消失，
    // 于是「exit 0 + 258/258 全绿」被读成「这些 AC 没有覆盖」。
    const TRUNCATED = [
      "ok 250 - [AC-12] a later test",
      "ok 251 - [AC-13] another later test",
      "# tests 258",
      "# pass 258",
      "# fail 0"
    ].join("\n");
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED) return { exitCode: 0, stdout: TRUNCATED };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.coverageTruncated).toBe(true);
    expect(testCheck?.uncoveredAcKeys).toBeUndefined();
  });

  it("N-27：作用域内 AC 未全过时把失败编号落进 uncoveredAcKeys", async () => {
    const TWO_ACS =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === TWO_ACS)
        return {
          exitCode: 0,
          stdout: ["ok 1 - [AC-01] one", "not ok 2 - [AC-02] two"].join("\n")
        };
      return undefined;
    });
    const verifier = new TaskVerifier({ sandbox, mode: "enforce" });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      // 任务声明 AC-01 + AC-02，命令却只跑到 AC-01 与 AC-02；AC-02 失败。
      task: makeTask({ input: { acKeys: ["AC-01", "AC-02"] } }),
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.uncoveredAcKeys).toEqual(["AC-02"]);
  });

  it("切片边界检查同形：兄弟切片的钩子失败不再把边界判失败", async () => {
    const ownScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === ownScoped) return { stdout: "ok 1 - [AC-01] one" };
      // 边界命令：切片并集，兄弟文件的钩子失败 ⇒ exit 1，但两条切片 AC 都过了。
      if (command === boundaryScoped)
        return {
          exitCode: 1,
          stdout: [
            "ok 1 - [AC-01] one",
            "ok 2 - [AC-02] two",
            "not ok 3 - /workspace/test/register.ac02-03.test.js",
            "  ---",
            "  failureType: 'hookFailed'",
            "  ..."
          ].join("\n")
        };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T01",
          sliceKey: "S1",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({
          id: "task-1",
          taskKey: "S1-T02",
          sliceKey: "S1",
          status: "RUNNING",
          input: { acKeys: ["AC-01"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(true);
    expect(boundary?.exitCode).toBe(1);
    expect(boundary?.scopingMode).toBe("command-filter");
  });
});

describe("TaskVerifier（N-35：已被 replan 解决的失败不再吞掉切片边界检查）", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const OWN = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
  const BOUNDARY =
    "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";

  /**
   * 缺陷原文：`maybeSliceBoundaryCheck` 原先要求同切片**全部**非交付任务 `status === "SUCCESS"`。
   * 而 replan 之后**源任务行永远是 FAILED**（重试是另一行任务、`source_task_id` 指回），
   * ⇒ 凡是发生过 replan 的切片一律拿不到边界检查。
   * 全库普查：含 FAILED 的 169 个工作流里 **145 个（86%）没有任何边界检查**。
   */
  function sandboxWithBoundary(): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === OWN) return { stdout: "ok 1 - [AC-01] one" };
      if (command === BOUNDARY) return { stdout: "ok 1 - [AC-01] one\nok 2 - [AC-02] two" };
      return undefined;
    });
  }

  const ANCHOR = makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } });

  it("兄弟任务 FAILED 但已被 replan 救回 ⇒ 边界检查照跑", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithBoundary(),
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "t-orig",
          taskKey: "S1-T00",
          sliceKey: "S1",
          status: "FAILED",
          resolvedByTaskId: "t-replan",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({
          id: "t-replan",
          taskKey: "S1-T00-REPLAN-1",
          sliceKey: "S1",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });

    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary).toBeDefined();
    expect(boundary?.passed).toBe(true);
    expect(boundary?.scopedAcKeys).toEqual(["AC-01", "AC-02"]);
  });

  it("负控：replan 自己也失败（链走到头仍未解决）⇒ 边界检查不跑", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithBoundary(),
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "t-orig",
          taskKey: "S1-T00",
          sliceKey: "S1",
          status: "FAILED",
          resolvedByTaskId: "t-replan",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({
          id: "t-replan",
          taskKey: "S1-T00-REPLAN-1",
          sliceKey: "S1",
          status: "FAILED",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "slice-boundary")).toBeUndefined();
  });

  it("负控：兄弟任务仍在跑 / 未解决失败 ⇒ 边界检查不跑（切片未收尾）", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithBoundary(),
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({ id: "t-run", taskKey: "S1-T01", sliceKey: "S1", status: "RUNNING" }),
        makeTask({
          id: "t-bad",
          taskKey: "S1-T03",
          sliceKey: "S1",
          status: "FAILED",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "slice-boundary")).toBeUndefined();
    // PL-M40 后续观测：把「谁没收尾」写进跳过原因，批次后可直接查库定位。
    expect(record.boundarySkipped).toBe("siblings-unfinished:S1-T01:RUNNING,S1-T03:FAILED");
  });
});

describe("TaskVerifier（PL-M20 / N-13：检查未返回的诊断码）", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const SCOPED =
    "npm run test -- --test-name-pattern '\\[AC-04\\]|\\[AC-4\\]' --test-timeout=20000";

  /** N-13 的生产形态：测试跑过了、作用域内 AC 也过了，命令却没有返回。 */
  function timedOutSandbox(): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED)
        return { exitCode: null, timedOut: true, stdout: "ok 1 - [AC-04] password not plaintext" };
      return undefined;
    });
  }

  it("检查超时 → 检查级 CHECK_TIMEOUT，与「测试确实失败」区分开", async () => {
    const verifier = new TaskVerifier({
      sandbox: timedOutSandbox(),
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "task-test",
          taskKey: "S1-T11",
          type: "TEST",
          sliceKey: "S1",
          status: "PENDING",
          input: { acKeys: ["AC-04"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      // N-47：本任务声明自己的 acKeys —— 检查按任务作用域跑（超时语义与作用域来源无关）。
      task: makeTask({ taskKey: "S1-T10", sliceKey: "S1", input: { acKeys: ["AC-04"] } }),
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.timedOut).toBe(true);
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.failureCode).toBe("CHECK_TIMEOUT");
    // 反向对照：AC 确实通过了——所以失败**不是**测试挂了，是命令没返回。
    expect(testCheck?.acResults).toEqual({ "AC-04": "passed" });
    // 两次尝试都记录在案（超时不重试成功，attempts 保留）。
    expect(testCheck?.attempts).toHaveLength(2);
  });

  it("未超时的普通失败不写 CHECK_TIMEOUT", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === SCOPED) return { exitCode: 1, stdout: "not ok 1 - [AC-04] nope" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => [
        makeTask({
          id: "task-test",
          taskKey: "S1-T11",
          type: "TEST",
          sliceKey: "S1",
          status: "PENDING",
          input: { acKeys: ["AC-04"] }
        })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      // N-47：本任务声明自己的 acKeys（作用域来源不影响「普通失败 vs 超时」的区分）。
      task: makeTask({ taskKey: "S1-T10", sliceKey: "S1", input: { acKeys: ["AC-04"] } }),
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.timedOut).toBe(false);
    expect(testCheck?.failureCode).toBeUndefined();
  });

  it("切片边界检查超时同样记 CHECK_TIMEOUT（与 test 检查同口径）", async () => {
    const ownScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
    const boundaryScoped =
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === ownScoped) return { stdout: "ok 1 - [AC-01] one" };
      // 边界检查跑的是**同一条**作用域命令，同样会没返回。
      if (command === boundaryScoped) return { exitCode: null, timedOut: true, stdout: "" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      events: makeEvents().sink,
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T01",
          sliceKey: "S1",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } })
      ]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });

    const boundary = record.checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(false);
    expect(boundary?.timedOut).toBe(true);
    expect(boundary?.failureCode).toBe("CHECK_TIMEOUT");
  });
});

/**
 * `docs/235` §6 第 3 步：**切片边界门由能力 profile 的 `boundaryCheck` 选**。
 *
 * `backend-node` 是 `server`（HTTP 路由），`frontend-vue` 是 `ui`（页面 + testid）。
 * 缺省仍是 `server` ⇒ 既有批次行为不变（这也是本步的回滚开关）。
 */
describe("docs/235 §6 第 3 步：边界门按 profile 选择", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const FRONTEND_SCRIPTS =
    '{"build":"vite build","test":"vitest run","start":"vite preview","lint":"eslint ."}';

  const uiProfile = { ...BACKEND_NODE_PROFILE, boundaryCheck: "ui" as const };

  function uiOutput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      booted: true,
      exited: false,
      exitCode: null,
      signal: null,
      pageStatus: 200,
      browser: "playwright",
      browserError: null,
      present: [],
      consoleErrors: [],
      stderrTail: "",
      ...overrides
    });
  }

  function makeUiSandbox(uiVerdict: string): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("loadBrowser")) return { stdout: uiVerdict };
      if (command === "npm run build" || command === "pnpm build") return { stdout: "build ok" };
      if (command.startsWith("npm run test") || command.startsWith("pnpm test")) {
        return { stdout: "ok 1 - [AC-02] one" };
      }
      return undefined;
    });
  }

  function uiSliceTasks(): Task[] {
    return [
      makeTask({
        id: "task-first",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "SUCCESS",
        input: {
          acKeys: ["AC-02"],
          acceptanceCriteria: ['列表项携带 data-testid="todo-item"，空态提示 data-testid="todo-empty"']
        }
      }),
      makeTask({
        taskKey: "S1-T02",
        sliceKey: "S1",
        input: {
          acKeys: ["AC-02"],
          acceptanceCriteria: ["点击 data-testid=todo-add 后列表新增一项"]
        }
      })
    ];
  }

  it("boundaryCheck=ui：跑 ui-smoke 而不跑 server-smoke；元素全缺席 → SURFACE_MISSING", async () => {
    // `docs/233` §6.2 的 mutant 反向（`empty-shell`）：页面起得来、但 AC 点名的元素一个都不在。
    const tasks = uiSliceTasks();
    const verifier = new TaskVerifier({
      sandbox: makeUiSandbox(uiOutput()),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "server-smoke")).toBeUndefined();
    const ui = record.checks.find((check) => check.name === "ui-smoke");
    expect(ui?.passed).toBe(false);
    expect(ui?.failureCode).toBe("SURFACE_MISSING");
    expect(ui?.ui?.testIds).toEqual(["todo-item", "todo-empty", "todo-add"]);
    expect(ui?.ui?.pageStatus).toBe(200);
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("SURFACE_MISSING");
  });

  it("boundaryCheck=ui：点名的元素真的挂上了 → ui-smoke 通过", async () => {
    const tasks = uiSliceTasks();
    const verifier = new TaskVerifier({
      sandbox: makeUiSandbox(uiOutput({ present: ["todo-item", "todo-empty", "todo-add"] })),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    const ui = record.checks.find((check) => check.name === "ui-smoke");
    expect(ui?.passed).toBe(true);
    expect(ui?.ui?.present).toEqual(["todo-item", "todo-empty", "todo-add"]);
    expect(record.verdict).toBe("verified");
  });

  it("boundaryCheck=ui：工作区没有浏览器 → 留痕跳过，不判交付缺陷", async () => {
    // 没有浏览器时「元素不在」与「没看过」必须分开：否则镜像缺浏览器会把整片判死。
    const tasks = uiSliceTasks();
    const verifier = new TaskVerifier({
      sandbox: makeUiSandbox(uiOutput({ browser: "unavailable", present: [] })),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "ui-smoke")).toBeUndefined();
    expect(record.smokeSkipped).toBe("BROWSER_UNAVAILABLE");
    expect(record.verdict).toBe("verified");
  });

  it("boundaryCheck=ui：AC 没点名任何 testid → NO_TESTIDS 留痕，不起进程", async () => {
    const tasks = [
      makeTask({
        id: "task-first",
        taskKey: "S1-T01",
        sliceKey: "S1",
        status: "SUCCESS",
        input: { acKeys: ["AC-02"] }
      }),
      makeTask({ taskKey: "S1-T02", sliceKey: "S1", input: { acKeys: ["AC-02"] } })
    ];
    const sandbox = makeUiSandbox(uiOutput());
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "ui-smoke")).toBeUndefined();
    expect(record.smokeSkipped).toBe("NO_TESTIDS");
    // 不花成本：那条命令根本没发出去。
    expect(sandbox.calls.some((command) => command.includes("loadBrowser"))).toBe(false);
  });

  it("boundaryCheck=none：两种边界门都不跑，留痕可查", async () => {
    const tasks = uiSliceTasks();
    const sandbox = makeUiSandbox(uiOutput());
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: { ...BACKEND_NODE_PROFILE, boundaryCheck: "none" as const },
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "ui-smoke")).toBeUndefined();
    expect(record.checks.find((check) => check.name === "server-smoke")).toBeUndefined();
    expect(record.smokeSkipped).toBe("boundary-check-disabled");
    expect(record.verdict).toBe("verified");
  });

  it("缺省 profile（backend-node）仍然走 server-smoke——第 3 步不改变既有行为", async () => {
    const tasks = uiSliceTasks();
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("loadBrowser")) return { stdout: uiOutput() };
      if (command.startsWith('node -e "const{spawn}')) {
        return {
          stdout: JSON.stringify({
            booted: true,
            exited: false,
            exitCode: null,
            signal: null,
            control: null,
            probes: [],
            stderrTail: ""
          })
        };
      }
      if (command === "npm run build" || command === "pnpm build") return { stdout: "build ok" };
      if (command.startsWith("npm run test") || command.startsWith("pnpm test")) {
        return { stdout: "ok 1 - [AC-02] one" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "ui-smoke")).toBeUndefined();
    expect(sandbox.calls.some((command) => command.includes("loadBrowser"))).toBe(false);
  });

  /**
   * N-64（`docs/232` §10）：**testid 命名契约**。
   *
   * 与冒烟解耦：冒烟要起进程、要 `start` 脚本；「名字是不是自创的」只读源码，起不来进程时也要判。
   */
  const CONTRACT_PRD = [
    "## 四、UI 契约：testid 命名（硬性）",
    "",
    "| testid | 用途 |",
    "| --- | --- |",
    "| `todo-item` | 列表项 |",
    "| `todo-empty` | 空态 |",
    "| `todo-add` | 新增 |"
  ].join("\n");

  /** 真实任务输入带 `requirementId`（库里实测），测试夹具默认不带，这里补上。 */
  function contractTasks(): Task[] {
    return uiSliceTasks().map((entry) => ({
      ...entry,
      input: { ...entry.input, requirementId: "requirement-1" }
    }));
  }

  function contractSandbox(used: Array<{ id: string; file: string }>): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("data-testid")) return { stdout: JSON.stringify({ used }) };
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("loadBrowser")) {
        return { stdout: uiOutput({ present: ["todo-item", "todo-empty", "todo-add"] }) };
      }
      if (command === "npm run build" || command === "pnpm build") return { stdout: "build ok" };
      if (command.startsWith("npm run test") || command.startsWith("pnpm test")) {
        return { stdout: "ok 1 - [AC-02] one" };
      }
      return undefined;
    });
  }

  it("源码里出现需求没声明过的 testid → 检查失败并判死任务", async () => {
    const tasks = contractTasks();
    const verifier = new TaskVerifier({
      sandbox: contractSandbox([
        { id: "todo-item", file: "src/App.vue" },
        { id: "todo-new-item", file: "src/App.vue" }
      ]),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks,
      requirementText: async () => CONTRACT_PRD
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    const contract = record.checks.find((check) => check.name === "testid-contract");
    expect(contract?.passed).toBe(false);
    expect(contract?.failureCode).toBe("TESTID_CONTRACT_VIOLATION");
    expect(contract?.stdoutTail).toContain("todo-new-item");
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("TESTID_CONTRACT_VIOLATION");
  });

  it("全部命中契约 → 检查通过", async () => {
    const tasks = contractTasks();
    const verifier = new TaskVerifier({
      sandbox: contractSandbox([
        { id: "todo-item", file: "src/App.vue" },
        { id: "todo-add", file: "src/App.vue" }
      ]),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks,
      requirementText: async () => CONTRACT_PRD
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "testid-contract")?.passed).toBe(true);
    expect(record.verdict).toBe("verified");
  });

  it("没有需求原文 → 跳过并留痕，不判交付缺陷", async () => {
    const tasks = contractTasks();
    const verifier = new TaskVerifier({
      sandbox: contractSandbox([{ id: "todo-item", file: "src/App.vue" }]),
      mode: "enforce",
      profile: uiProfile,
      workflowTasks: async () => tasks
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: tasks[1] as Task,
      result: succeededResult()
    });

    expect(record.checks.find((check) => check.name === "testid-contract")).toBeUndefined();
    expect(record.testIdContractSkipped).toBe("no-requirement-text");
    expect(record.verdict).toBe("verified");
  });
});

/**
 * `docs/235` §6.8：**非 TAP runner 的作用域判定**（F1 run 2 的 `T-07` 形状）。
 *
 * 实测：vitest 默认 reporter 不打印通过的用例名 ⇒ 作用域 AC 一条都解析不到 ⇒ 命令退出码一非零
 * （别的任务的测试红了），本任务就被判死，连 REPLAN 两次都救不回来。
 *
 * 修法两条一起生效：给 vitest 追加 `--reporter=verbose`；解析前剥掉 ANSI 颜色。
 */
describe("docs/235 §6.8：vitest 项目按作用域 AC 判定", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const SCRIPTS =
    '{"build":"vite build","test":"vitest run","lint":"vue-tsc --noEmit","start":"vite preview"}';

  const VERBOSE_OUTPUT = [
    "\u001b[32m✓\u001b[39m tests/list.spec.ts\u001b[2m > \u001b[22m[AC-03] 三条任务按 mock 顺序渲染\u001b[32m 12\u001b[2mms\u001b[39m",
    "\u001b[31m×\u001b[39m tests/search.spec.ts\u001b[2m > \u001b[22m[AC-15] 搜索与筛选叠加\u001b[31m 1253\u001b[2mms\u001b[39m",
    "",
    " Test Files  1 failed | 1 passed (2)",
    "      Tests  1 failed | 1 passed (2)"
  ].join("\n");

  it("本任务作用域 AC 全过 → command-filter（带 testNamePattern + verbose），不跑全量套件", async () => {
    const scoped =
      "npm run test -- 'tests/list.spec.ts' --testNamePattern '\\[AC-03\\]|\\[AC-3\\]' --testTimeout=60000 --reporter=verbose";
    const commands: string[] = [];
    const sandbox = new FakeSandbox((command) => {
      commands.push(command);
      if (command.includes("package.json")) return { stdout: SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command.includes("hasNodeModules"))
        return { stdout: '{"hasNodeModules":true,"nativeOk":true,"binOk":true,"missingNative":[]}' };
      if (command.startsWith("node -e") && command.includes("suffixes")) {
        return { stdout: '{"files":["tests/list.spec.ts"]}' };
      }
      if (command === scoped) {
        return {
          stdout:
            "\u001b[32m✓\u001b[39m tests/list.spec.ts\u001b[2m > \u001b[22m[AC-03] 三条任务按 mock 顺序渲染\u001b[32m 12\u001b[2mms\u001b[39m"
        };
      }
      if (command === "npm run test" || command === "npm run test -- --reporter=verbose") {
        return { exitCode: 1, stdout: VERBOSE_OUTPUT };
      }
      if (/^(npm|pnpm)( run)? (build|lint)( |$)/.test(command)) return { stdout: "ok" };
      return undefined;
    });

    const task = makeTask({
      type: "FRONTEND",
      status: "RUNNING",
      input: {
        acKeys: ["AC-03"],
        acceptanceCriteria: ["列表按 mock 顺序渲染 data-testid=\"task-item\""]
      }
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.scopingMode).toBe("command-filter");
    expect(testCheck?.command).toBe(scoped);
    expect(testCheck?.acResults).toMatchObject({ "AC-03": "passed" });
    expect(commands.some((command) => command.includes("--testNamePattern"))).toBe(true);
    expect(commands.some((command) => command.includes("--reporter=verbose"))).toBe(true);
    expect(commands).not.toContain("npm run test");
    expect(commands).not.toContain("npm run test -- --reporter=verbose");
    expect(
      record.verdict,
      JSON.stringify({
        reason: record.reason,
        checks: record.checks.map((check) => [check.name, check.passed, check.failureCode]),
        commands
      })
    ).toBe("verified");
  });
});

/**
 * N-67（`docs/232` §10）：**跑检查之前先确保依赖就位**（修法 A），装不上就按
 * `DEPENDENCIES_MISSING` 记账（修法 B）。
 *
 * 第七轮三次逐字相同的 `sh: 1: vite: not found` 被记成 `VERIFICATION_FAILED`，REPLAN 于是派
 * DEBUG 去"修代码"，三次撞同一堵墙——而同一份源码在 oracle 里装完依赖后 **24/24**。
 * 这两个断言各守一条：A 守「先装再检查」的顺序，B 守「装不上不等于代码错」的归因。
 */
describe("N-67：检查前确保依赖就位", () => {
  const FACTS =
    '{"hasPackageJson":true,"lockfiles":["pnpm-lock.yaml"],"scripts":{"build":"vite build"}}';
  const DEPENDENCY_PROBE = "hasNodeModules";

  function buildTask(): Task {
    return makeTask({ type: "BUILD", status: "RUNNING", taskKey: "T1" });
  }

  it("缺 node_modules → 先装依赖再跑检查（顺序可证）", async () => {
    const commands: string[] = [];
    const sandbox = new FakeSandbox((command) => {
      commands.push(command);
      if (command.includes(DEPENDENCY_PROBE)) return { stdout: '{"hasNodeModules":false}' };
      if (command.includes("package.json")) return { stdout: FACTS };
      if (command === "pnpm install --frozen-lockfile") return { stdout: "dependencies installed" };
      if (command === "pnpm build") return { stdout: "build ok" };
      return undefined;
    });
    const task = buildTask();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.dependencyInstall).toEqual({
      attempted: true,
      ok: true,
      command: "pnpm install --frozen-lockfile"
    });
    expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      commands.indexOf("pnpm build")
    );
  });

  it("依赖已在位 → 不装（探针说 true 就停手）", async () => {
    const commands: string[] = [];
    const sandbox = new FakeSandbox((command) => {
      commands.push(command);
      if (command.includes(DEPENDENCY_PROBE)) return { stdout: '{"hasNodeModules":true}' };
      if (command.includes("package.json")) return { stdout: FACTS };
      if (command === "pnpm build") return { stdout: "build ok" };
      return undefined;
    });
    const task = buildTask();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.dependencyInstall).toBeUndefined();
    expect(commands.some((command) => command.includes("install"))).toBe(false);
  });

  it("装依赖失败 + 检查失败 → DEPENDENCIES_MISSING，不是代码缺陷", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes(DEPENDENCY_PROBE)) return { stdout: '{"hasNodeModules":false}' };
      if (command.includes("package.json")) return { stdout: FACTS };
      if (command === "pnpm install --frozen-lockfile")
        return { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" };
      if (command === "pnpm install") return { exitCode: 1, stderr: "ERR_PNPM_NO_NETWORK" };
      if (command === "pnpm build") return { exitCode: 1, stderr: "sh: 1: vite: not found" };
      return undefined;
    });
    const task = buildTask();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("DEPENDENCIES_MISSING");
    expect(record.reason).toContain("dependencies are not installed");
    expect(record.reason).toContain("ERR_PNPM_NO_NETWORK");
    expect(record.dependencyInstall).toMatchObject({ attempted: true, ok: false });
    // 装不上不能抹掉检查自己的失败证据——两条都要在记录里。
    expect(record.checks.find((check) => check.name === "build")?.passed).toBe(false);
  });

  it("非 registry profile（backend-node）→ 不探测、不安装，行为不变", async () => {
    const commands: string[] = [];
    const sandbox = new FakeSandbox((command) => {
      commands.push(command);
      if (command.includes("package.json")) return { stdout: FACTS };
      if (command === "pnpm build") return { stdout: "build ok" };
      return undefined;
    });
    const task = buildTask();
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: BACKEND_NODE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    expect(record.verdict).toBe("verified");
    expect(record.dependencyInstall).toBeUndefined();
    expect(commands.some((command) => command.includes(DEPENDENCY_PROBE))).toBe(false);
  });
});


describe("docs/255：TEST 门禁按 AC 作用域分段，全量超时不误判 EVIDENCE_MISSING", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const OWN_SCOPED =
    "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";

  it("ENV_GAP install timeout is much longer than the generic 120s check timeout", () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(120_000);
    expect(ENV_GAP_INSTALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CHECK_TIMEOUT_MS);
    expect(ENV_GAP_INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
  });

  it("TEST task with AC keys uses a scoped official command, not full npm run test", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum") || command.includes("find ")) return { ...SNAPSHOT };
      if (command === "npm run test" || command === "npm run test -- --reporter=verbose") {
        throw new Error("full-suite official test must not run when AC keys exist");
      }
      if (command.includes("--test-name-pattern") || command.includes("--testNamePattern")) {
        return { stdout: "ok 1 - [AC-01] login works", exitCode: 1 };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => []
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({
        type: "TEST",
        input: { acKeys: ["AC-01"] }
      }),
      result: succeededResult()
    });
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.command).toMatch(/--test-name-pattern|--testNamePattern/);
    expect(testCheck?.command).not.toBe("npm run test");
    expect(testCheck?.command).not.toBe("npm run test -- --reporter=verbose");
    expect(sandbox.calls).not.toContain("npm run test");
    expect(sandbox.calls).not.toContain("npm run test -- --reporter=verbose");
    expect(isFullSuiteTestCommand(testCheck?.command)).toBe(false);
  });

  it("TEST red-light timeout is CHECK_TIMEOUT, not EVIDENCE_MISSING", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum") || command.includes("find ")) return { ...SNAPSHOT };
      if (command.includes("--test-name-pattern") || command.includes("--testNamePattern")) {
        return { exitCode: null, timedOut: true, stdout: "ok 1 - [AC-01] login works" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      requirementTasks: async () => []
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST", input: { acKeys: ["AC-01"] } }),
      result: succeededResult()
    });
    const testCheck = record.checks.find((check) => check.name === "test");
    expect(record.verdict).toBe("failed");
    expect(testCheck?.timedOut).toBe(true);
    expect(testCheck?.failureCode).toBe("CHECK_TIMEOUT");
    expect(record.failureCode).toBe("CHECK_TIMEOUT");
    expect(record.failureCode).not.toBe("EVIDENCE_MISSING");
    expect(record.failureCode).not.toBe("VACUOUS_TEST");
    expect(record.reason).toContain("CHECK_TIMEOUT");
    expect(record.reason ?? "").not.toContain("VACUOUS_TEST");
    expect(record.reason ?? "").not.toContain("passed without implementation");
  });

  it("120s full-suite timeout is not EVIDENCE_MISSING when scoped ACs are already green", () => {
    const checks: VerificationCheckEvidence[] = [
      {
        name: "test",
        command: "npm run test -- --reporter=verbose",
        expected: "fail",
        passed: false,
        exitCode: null,
        timedOut: true,
        attempts: [{ exitCode: null, durationMs: 120_000, timedOut: true }],
        flaked: false,
        outputDigest: "x",
        stdoutTail: "",
        stderrTail: "TIMEOUT",
        durationMs: 120_000,
        failureCode: "EVIDENCE_MISSING"
      }
    ];
    waiveFullSuiteTimeoutIfScopedAcsGreen({
      checks,
      acKeys: ["AC-01", "AC-02"],
      acResults: { "AC-01": "passed", "AC-02": "passed" }
    });
    expect(checks[0]?.passed).toBe(true);
    expect(checks[0]?.failureCode).toBeUndefined();
    expect(checks[0]?.warnings).toEqual(
      expect.arrayContaining([
        "full-suite timeout ignored because scoped/segmented AC evidence is green"
      ])
    );
  });

  it("full-suite timeout without green AC evidence becomes CHECK_TIMEOUT, not a silent pass", () => {
    const checks: VerificationCheckEvidence[] = [
      {
        name: "test",
        command: "npm run test -- --reporter=verbose",
        expected: "fail",
        passed: false,
        exitCode: null,
        timedOut: true,
        attempts: [{ exitCode: null, durationMs: 120_000, timedOut: true }],
        flaked: false,
        outputDigest: "x",
        stdoutTail: "",
        stderrTail: "TIMEOUT",
        durationMs: 120_000,
        failureCode: "EVIDENCE_MISSING"
      }
    ];
    waiveFullSuiteTimeoutIfScopedAcsGreen({
      checks,
      acKeys: ["AC-01"],
      acResults: {}
    });
    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.failureCode).toBe("CHECK_TIMEOUT");
  });
});


describe("docs/260：官方全量 test 加长超时，超时不得写成 VACUOUS_TEST", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const FRONTEND_SCRIPTS =
    '{"build":"vite build","test":"vitest run","lint":"eslint .","typecheck":"vue-tsc --noEmit"}';
  const FULL_SUITE = "npm run test -- --reporter=verbose";
  // runTool 给沙箱超时加 5s 余量，让沙箱先于运行时超时返回。
  const OFFICIAL_FULL_SUITE_SANDBOX_TIMEOUT_MS = FULL_SUITE_TEST_TIMEOUT_MS + 5_000;

  it("exports an 8-minute official full-suite timeout without raising the generic 120s default", () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(120_000);
    expect(FULL_SUITE_TEST_TIMEOUT_MS).toBe(480_000);
    expect(FULL_SUITE_TEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CHECK_TIMEOUT_MS);
    expect(officialTestCheckTimeoutMs(FULL_SUITE)).toBe(FULL_SUITE_TEST_TIMEOUT_MS);
    expect(
      officialTestCheckTimeoutMs(
        "npm run test -- --test-name-pattern '\\[AC-01\\]' --test-timeout=20000"
      )
    ).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });

  it("unfiltered official test check uses the longer timeout; lint and typecheck stay at 120s", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("hasNodeModules")) return { stdout: '{"hasNodeModules":true}' };
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum") || command.includes("find ")) return { ...SNAPSHOT };
      if (command === "npm run lint" || command === "npm run typecheck" || command === "npm run build") {
        return { stdout: "ok" };
      }
      if (command === FULL_SUITE || command === "npm run test") {
        return { stdout: "✓ tests/app.spec.ts > [AC-01] renders", exitCode: 0 };
      }
      return undefined;
    });
    const task = makeTask({
      type: "FRONTEND",
      status: "RUNNING",
      input: {}
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      workflowTasks: async () => [task]
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task,
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.command).toBe(FULL_SUITE);
    expect(isFullSuiteTestCommand(testCheck?.command)).toBe(true);
    expect(sandbox.timeoutMsFor(FULL_SUITE)).toBe(OFFICIAL_FULL_SUITE_SANDBOX_TIMEOUT_MS);
    expect(sandbox.timeoutMsFor("npm run lint")).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(sandbox.timeoutMsFor("npm run typecheck")).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(sandbox.timeoutMsFor("npm run build")).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(record.verdict).toBe("verified");
  });

  it("TEST red-light official full-suite timeout is CHECK_TIMEOUT, not VACUOUS_TEST", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("hasNodeModules")) return { stdout: '{"hasNodeModules":true}' };
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum") || command.includes("find ")) return { ...SNAPSHOT };
      if (command === FULL_SUITE || command === "npm run test") {
        return { exitCode: null, timedOut: true, stdout: "✓ tests/app.spec.ts > [AC-01] renders" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      requirementTasks: async () => []
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.command).toBe(FULL_SUITE);
    expect(testCheck?.expected).toBe("fail");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.timedOut).toBe(true);
    expect(testCheck?.exitCode).toBeNull();
    expect(testCheck?.failureCode).toBe("CHECK_TIMEOUT");
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("CHECK_TIMEOUT");
    expect(record.reason).toContain("CHECK_TIMEOUT");
    expect(record.reason ?? "").not.toContain("VACUOUS_TEST");
    expect(record.reason ?? "").not.toContain("passed without implementation");
    expect(sandbox.timeoutMsFor(FULL_SUITE)).toBe(OFFICIAL_FULL_SUITE_SANDBOX_TIMEOUT_MS);
  });

  it("a genuine vacuous red-light pass (exit 0, no implementation) is still VACUOUS_TEST", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.includes("hasNodeModules")) return { stdout: '{"hasNodeModules":true}' };
      if (command.includes("package.json")) return { stdout: FRONTEND_SCRIPTS };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum") || command.includes("find ")) return { ...SNAPSHOT };
      if (command === FULL_SUITE || command === "npm run test") {
        return { exitCode: 0, stdout: "✓ tests/app.spec.ts > [AC-01] renders" };
      }
      return undefined;
    });
    const verifier = new TaskVerifier({
      sandbox,
      mode: "enforce",
      profile: FRONTEND_VUE_PROFILE,
      requirementTasks: async () => []
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ type: "TEST" }),
      result: succeededResult()
    });

    const testCheck = record.checks.find((check) => check.name === "test");
    expect(testCheck?.expected).toBe("fail");
    expect(testCheck?.passed).toBe(false);
    expect(testCheck?.timedOut).toBe(false);
    expect(testCheck?.exitCode).toBe(0);
    expect(testCheck?.failureCode).toBe("VACUOUS_TEST");
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VACUOUS_TEST");
    expect(record.reason).toContain("VACUOUS_TEST");
    expect(record.reason).toContain("passed without implementation");
    expect(record.reason ?? "").not.toContain("CHECK_TIMEOUT");
  });

  it("summarizeRedLightFailures keeps a timeout out of the VACUOUS_TEST reason", () => {
    const timedOut: VerificationCheckEvidence = {
      name: "test",
      command: FULL_SUITE,
      expected: "fail",
      passed: false,
      exitCode: null,
      timedOut: true,
      attempts: [{ exitCode: null, durationMs: 120_000, timedOut: true }],
      flaked: false,
      outputDigest: "x",
      stdoutTail: "",
      stderrTail: "TIMEOUT",
      durationMs: 120_000,
      failureCode: "CHECK_TIMEOUT"
    };
    const summary = summarizeRedLightFailures([timedOut]);
    expect(summary.failureCode).toBe("CHECK_TIMEOUT");
    expect(summary.reason).toContain("CHECK_TIMEOUT");
    expect(summary.reason).not.toContain("VACUOUS_TEST");
    expect(summary.reason).not.toContain("passed without implementation");
  });
});


describe("docs/256：官方 E2E 只在切片末运行", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const PROBE_WITH_E2E =
    '{"build":"node scripts/build.mjs","test":"node --test","test:e2e":"playwright test"}';
  const OWN = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
  const BOUNDARY =
    "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
  const E2E = "npm run test:e2e -- --workers=2";

  function sandboxWithE2e(onE2e?: (command: string) => Partial<import("@ai-se/sandbox").SandboxResult> | undefined): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE_WITH_E2E };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === OWN) return { stdout: "ok 1 - [AC-01] one" };
      if (command === BOUNDARY) return { stdout: "ok 1 - [AC-01] one\nok 2 - [AC-02] two" };
      if (command === E2E) return onE2e?.(command) ?? { stdout: "e2e ok", exitCode: 0 };
      return undefined;
    });
  }

  const ANCHOR = makeTask({
    id: "task-1",
    taskKey: "S1-T13",
    sliceKey: "S1",
    type: "TEST",
    input: { acKeys: ["AC-01"] }
  });

  it("runs official test:e2e --workers=2 on the last verifiable slice task", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithE2e(),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T02",
          sliceKey: "S1",
          type: "FRONTEND",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    const e2e = record.checks.find((check) => check.name === "e2e");
    expect(e2e?.command).toBe(E2E);
    expect(e2e?.passed).toBe(true);
    expect(e2e?.expected).toBe("pass");
  });

  it("does not run official e2e while slice siblings are still unfinished", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithE2e(),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [
        makeTask({
          id: "task-mid",
          taskKey: "S1-T07",
          sliceKey: "S1",
          type: "FRONTEND",
          status: "RUNNING",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    expect(record.checks.find((check) => check.name === "e2e")).toBeUndefined();
    expect(record.checks.find((check) => check.name === "slice-boundary")).toBeUndefined();
  });

  it("marks slice-end e2e as ENV_GAP when the browser is resource-killed", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxWithE2e(() => ({
        exitCode: 1,
        stderr: "Target crashed; pthread_create: Resource temporarily unavailable (11)"
      })),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T02",
          sliceKey: "S1",
          type: "FRONTEND",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ]
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    const e2e = record.checks.find((check) => check.name === "e2e");
    expect(e2e?.passed).toBe(false);
    expect(e2e?.failureCode).toBe("ENV_GAP");
  });
});


describe("docs/265：官方视觉审查只在切片末运行，且不以智能体自报为准", () => {
  const NO_GIT = { exitCode: 128, stderr: "fatal: not a git repository" } as const;
  const SNAPSHOT = { stdout: "" } as const;
  const PROBE =
    '{"build":"node scripts/build.mjs","test":"node --test","test:e2e":"playwright test","start":"vite preview"}';
  const OWN = "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]' --test-timeout=20000";
  const BOUNDARY =
    "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]|\\[AC-02\\]|\\[AC-2\\]' --test-timeout=20000";
  const E2E = "npm run test:e2e -- --workers=2";

  const PAGE_BASELINE = {
    fileName: "task-list.png",
    mimeType: "image/png",
    note: "任务列表主页面"
  };
  const DIALOG_DATE_BASELINE = {
    fileName: "edit-dialog-datepicker.png",
    mimeType: "image/png",
    note: "编辑任务对话框与日期面板"
  };

  const ANCHOR = makeTask({
    id: "task-1",
    taskKey: "S1-T13",
    sliceKey: "S1",
    type: "FRONTEND",
    input: { acKeys: ["AC-01"] }
  });
  const SIBLING = makeTask({
    id: "task-first",
    taskKey: "S1-T02",
    sliceKey: "S1",
    type: "FRONTEND",
    status: "SUCCESS",
    input: { acKeys: ["AC-02"] }
  });

  function defaultSkinCapture(): string {
    return JSON.stringify({
      booted: true,
      usedFileProtocol: false,
      pageStatus: 200,
      browser: "playwright",
      protocol: "http:",
      appUrl: "http://127.0.0.1:48001/",
      states: [
        { kind: "page", opened: true, screenshotRef: "page.png" },
        { kind: "dialog", opened: true, screenshotRef: "dialog.png" },
        {
          kind: "date-panel",
          opened: true,
          screenshotRef: "date-panel.png",
          features: {
            defaultPickerPanel: true,
            pickerIllustration: true,
            oversizedPickerArrows: true,
            unwrappedElDateEditor: true,
            wrapperContractPresent: false
          }
        }
      ]
    });
  }

  function passingCapture(): string {
    return JSON.stringify({
      booted: true,
      usedFileProtocol: false,
      pageStatus: 200,
      browser: "playwright",
      protocol: "http:",
      appUrl: "http://127.0.0.1:48001/",
      states: [
        { kind: "page", opened: true, screenshotRef: "page.png" },
        { kind: "dialog", opened: true, screenshotRef: "dialog.png" },
        {
          kind: "date-panel",
          opened: true,
          screenshotRef: "date-panel.png",
          features: { wrapperContractPresent: true, minorSpacingDrift: true, pixelDiffRatio: 0.03 }
        }
      ]
    });
  }

  function sandboxForVisual(
    onVisual?: (command: string) => Partial<import("@ai-se/sandbox").SandboxResult> | undefined
  ): FakeSandbox {
    return new FakeSandbox((command) => {
      if (command.includes("package.json")) return { stdout: PROBE };
      if (command.startsWith("git rev-parse")) return { ...NO_GIT };
      if (command.includes("sha256sum")) return { ...SNAPSHOT };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === OWN) return { stdout: "ok 1 - [AC-01] one" };
      if (command === BOUNDARY) return { stdout: "ok 1 - [AC-01] one\nok 2 - [AC-02] two" };
      if (command === E2E) return { stdout: "e2e ok", exitCode: 0 };
      if (command.includes("OFFICIAL_VISUAL_GATE")) {
        return onVisual?.(command) ?? { stdout: passingCapture(), exitCode: 0 };
      }
      return undefined;
    });
  }

  it("fails a UI-facing slice with no visual baselines as VISUAL_BASELINE_MISSING (does not skip)", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [SIBLING, ANCHOR],
      visualBaselines: async () => [],
      requirementText: async () => "列表、编辑对话框和日期面板"
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    const visual = record.checks.find((check) => check.name === "visual");
    expect(visual?.passed).toBe(false);
    expect(visual?.failureCode).toBe("VISUAL_BASELINE_MISSING");
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VISUAL_BASELINE_MISSING");
    expect(record.visualSkipped).toBeUndefined();
  });

  it("does not run official visual while slice siblings are still unfinished", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [
        makeTask({
          id: "task-mid",
          taskKey: "S1-T07",
          sliceKey: "S1",
          type: "FRONTEND",
          status: "RUNNING",
          input: { acKeys: ["AC-02"] }
        }),
        ANCHOR
      ],
      visualBaselines: async () => [PAGE_BASELINE]
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    expect(record.checks.find((check) => check.name === "visual")).toBeUndefined();
    expect(record.checks.find((check) => check.name === "e2e")).toBeUndefined();
  });

  it("allows a non-UI backend slice to have no baselines", async () => {
    const backendAnchor = makeTask({
      id: "task-1",
      taskKey: "S1-T13",
      sliceKey: "S1",
      type: "BACKEND",
      input: { acKeys: ["AC-01"] }
    });
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(),
      mode: "enforce",
      profile: BACKEND_NODE_PROFILE,
      workflowTasks: async () => [
        makeTask({
          id: "task-first",
          taskKey: "S1-T02",
          sliceKey: "S1",
          type: "BACKEND",
          status: "SUCCESS",
          input: { acKeys: ["AC-02"] }
        }),
        backendAnchor
      ],
      visualBaselines: async () => []
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: backendAnchor,
      result: succeededResult()
    });
    expect(record.checks.find((check) => check.name === "visual")).toBeUndefined();
    expect(record.visualSkipped).toBe("not-ui-facing");
  });

  it("fails official visual when the running app shows the default date-picker skin", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(() => ({ stdout: defaultSkinCapture(), exitCode: 0 })),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [SIBLING, ANCHOR],
      visualBaselines: async () => [PAGE_BASELINE, DIALOG_DATE_BASELINE],
      requirementText: async () => "列表、编辑对话框和日期面板"
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    const visual = record.checks.find((check) => check.name === "visual");
    expect(visual?.passed).toBe(false);
    expect(visual?.failureCode).toBe("VISUAL_DEFAULT_SKIN");
    expect(visual?.command).toContain("OFFICIAL_VISUAL_GATE");
    expect(visual?.command).not.toContain("file://");
    expect(record.verdict).toBe("failed");
    expect(record.failureCode).toBe("VISUAL_DEFAULT_SKIN");
    expect(record.failureCode).not.toBe("ENV_GAP");
  });

  it("does not fail official visual for slight spacing or pixel-diff alone", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(() => ({ stdout: passingCapture(), exitCode: 0 })),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [SIBLING, ANCHOR],
      visualBaselines: async () => [PAGE_BASELINE, DIALOG_DATE_BASELINE],
      requirementText: async () => "列表、编辑对话框和日期面板"
    });
    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: ANCHOR,
      result: succeededResult()
    });
    const visual = record.checks.find((check) => check.name === "visual");
    expect(visual?.passed).toBe(true);
    expect(visual?.failureCode).toBeUndefined();
    expect(record.verdict).toBe("verified");
  });

  it("overrides a self-reported success when official visual fails", async () => {
    const verifier = new TaskVerifier({
      sandbox: sandboxForVisual(() => ({ stdout: defaultSkinCapture(), exitCode: 0 })),
      mode: "enforce",
      profile: { ...FRONTEND_VUE_PROFILE, boundaryCheck: "none" },
      workflowTasks: async () => [SIBLING, ANCHOR],
      visualBaselines: async () => [PAGE_BASELINE, DIALOG_DATE_BASELINE],
      requirementText: async () => "列表、编辑对话框和日期面板"
    });
    const executor = new VerifyingWorkflowTaskExecutor(
      verifier,
      {
        execute: async () => ({
          status: "succeeded" as const,
          output: { summary: "已按 UI 图实现日期面板" },
          agentRunId: "run-1"
        }),
        cancel: async () => undefined
      },
      "enforce",
      FRONTEND_VUE_PROFILE
    );
    const result = await executor.execute(makeWorkflow(), ANCHOR);
    expect(result.status).toBe("failed");
    const output = result.output as Record<string, unknown>;
    expect(output.errorType).toBe("VISUAL_DEFAULT_SKIN");
    expect(output.failureClass).toBe("VISUAL");
    expect(output.fixTaskType).toBe("FRONTEND");
    const verification = output.verification as { verdict?: string; failureCode?: string };
    expect(verification.verdict).toBe("failed");
    expect(verification.failureCode).toBe("VISUAL_DEFAULT_SKIN");
  });
});
