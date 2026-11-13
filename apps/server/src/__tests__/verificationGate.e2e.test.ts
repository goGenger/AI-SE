import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DockerSandbox } from "@ai-se/sandbox";
import { Task, WorkflowRun } from "@ai-se/shared";
import { ToolCallStartedRecord } from "@ai-se/tool-runtime";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskVerifier } from "../services/taskVerifier";
import { VerifyingWorkflowTaskExecutor } from "../services/verifyingTaskExecutor";

/**
 * C-3（T1）验证门真实链路 e2e：真实 DockerSandbox + Tool Runtime。
 * 覆盖：客观检查经沙箱真实执行、自报成功但测试失败 → VERIFICATION_FAILED、
 * 防篡改（dev 任务改写受保护测试文件）→ 失败。
 */

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

const packageJson = JSON.stringify(
  {
    name: "verify-sample",
    private: true,
    type: "module",
    scripts: { build: "node scripts/build.mjs", test: "node --test" }
  },
  null,
  2
);

const buildScript = 'console.log("build ok");\n';

function testFile(failing: boolean): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("[AC-01] health endpoint responds", () => { assert.equal(1 + 1, 2); });',
    failing
      ? 'test("[AC-02] rejects invalid credentials", () => { assert.equal(1, 2); });'
      : 'test("[AC-02] rejects invalid credentials", () => { assert.throws(() => { throw new Error("bad"); }); });',
    ""
  ].join("\n");
}

async function createWorkspace(root: string, name: string, failing: boolean): Promise<string> {
  const workspace = path.join(root, name);
  await mkdir(path.join(workspace, "scripts"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), packageJson);
  await writeFile(path.join(workspace, "scripts/build.mjs"), buildScript);
  await writeFile(path.join(workspace, "test/api.test.mjs"), testFile(failing));
  return workspace;
}

function makeWorkflow(workspacePath: string): WorkflowRun {
  const now = new Date().toISOString();
  return {
    id: "wf-verify",
    projectId: "project-verify",
    requirementId: "req-verify",
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
    input: { workspacePath },
    createdAt: now,
    updatedAt: now
  };
}

function makeTask(workspacePath: string): Task {
  const now = new Date().toISOString();
  return {
    id: "task-verify",
    projectId: "project-verify",
    taskKey: "S1-T99",
    title: "Backend task",
    description: "Implement endpoints",
    type: "BACKEND",
    status: "RUNNING",
    priority: "MEDIUM",
    input: { workspacePath },
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function succeededResult(): TaskExecutionResult {
  return {
    status: "succeeded",
    output: { summary: "self-reported success" },
    agentRunId: "run-verify"
  };
}

describe.skipIf(!runDockerTests)("verification gate e2e (C-3/T1)", () => {
  let workspaceRoot: string;
  let okWorkspace: string;
  let failWorkspace: string;
  let tamperWorkspace: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-verification-"));
    okWorkspace = await createWorkspace(workspaceRoot, "verify-ok", false);
    failWorkspace = await createWorkspace(workspaceRoot, "verify-fail", true);
    tamperWorkspace = await createWorkspace(workspaceRoot, "verify-tamper", false);
    sandbox = new DockerSandbox({ allowedWorkspaceRoot: workspaceRoot });
  }, 120_000);

  afterAll(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  function makeExecutor(
    workspace: string,
    inner: WorkflowTaskExecutor,
    mode: "observe" | "enforce",
    options: {
      events?: { eventType: string; payload: Record<string, unknown> }[];
      workflowTasks?: (workflowRunId: string) => Promise<Task[]>;
      requirementTasks?: (requirementId: string) => Promise<Task[]>;
    } = {}
  ) {
    const started: ToolCallStartedRecord[] = [];
    const verifier = new TaskVerifier({
      sandbox,
      mode,
      toolCalls: {
        recordToolCallStarted: async (record) => {
          started.push(record);
        },
        recordToolCallFinished: async () => undefined
      },
      ...(options.events
        ? {
            events: {
              create: async (input: {
                workflowRunId: string;
                taskId?: string;
                agentRunId?: string;
                eventType: string;
                payload: Record<string, unknown>;
              }) => {
                options.events?.push({ eventType: input.eventType, payload: input.payload });
              }
            }
          }
        : {}),
      ...(options.workflowTasks ? { workflowTasks: options.workflowTasks } : {}),
      ...(options.requirementTasks ? { requirementTasks: options.requirementTasks } : {})
    });
    return {
      executor: new VerifyingWorkflowTaskExecutor(verifier, inner, mode),
      started,
      workspace
    };
  }

  function fakeInner(result: TaskExecutionResult, onExecute?: () => Promise<void>) {
    return {
      execute: vi.fn(async () => {
        if (onExecute) await onExecute();
        return result;
      }),
      cancel: vi.fn(async () => undefined)
    } as unknown as WorkflowTaskExecutor;
  }

  it("runs the objective checks in the real sandbox and records per-AC results", async () => {
    const { executor } = makeExecutor(okWorkspace, fakeInner(succeededResult()), "enforce");

    const result = await executor.execute(makeWorkflow(okWorkspace), makeTask(okWorkspace));

    expect(result.status).toBe("succeeded");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("verified");
    expect(verification.verified).toBe(true);
    const checks = verification.checks as { name: string; passed: boolean }[];
    expect(checks.map((check) => check.name)).toEqual(["build", "test"]);
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(verification.acResults).toEqual({ "AC-01": "passed", "AC-02": "passed" });
    expect(verification.acSummary).toEqual({ total: 2, passed: 2, failed: 0 });
    expect((verification.antiTamper as Record<string, unknown>).verdict).toBe("passed");
  }, 180_000);

  it("overrides a self-reported success when the real test run fails (VERIFICATION_FAILED)", async () => {
    const { executor, started } = makeExecutor(
      failWorkspace,
      fakeInner(succeededResult()),
      "enforce"
    );

    const result = await executor.execute(makeWorkflow(failWorkspace), makeTask(failWorkspace));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const output = result.output as Record<string, unknown>;
    expect(output.errorType).toBe("VERIFICATION_FAILED");
    const verification = output.verification as Record<string, unknown>;
    expect(verification.verdict).toBe("failed");
    const checks = verification.checks as { name: string; attempts: unknown[]; flaked: boolean }[];
    const testCheck = checks.find((check) => check.name === "test");
    expect(testCheck?.attempts).toHaveLength(2);
    expect(testCheck?.flaked).toBe(false);
    expect(verification.acResults).toEqual({ "AC-01": "passed", "AC-02": "failed" });
    // 检查命令真实经过 Tool Runtime 的检查工具（审计通道收据）。
    expect(started.map((entry) => entry.toolName)).toEqual(
      expect.arrayContaining(["run_command", "run_build", "run_unit_test"])
    );
  }, 180_000);

  it("L1-4: an L1 workflow enforces the gate even when the executor is built in observe mode", async () => {
    const { executor } = makeExecutor(failWorkspace, fakeInner(succeededResult()), "observe");
    const workflow = {
      ...makeWorkflow(failWorkspace),
      policy: { ...makeWorkflow(failWorkspace).policy, autonomyLevel: "L1" as const }
    };

    const result = await executor.execute(workflow, makeTask(failWorkspace));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    // 记录里的 mode 也必须是生效的那一个，否则审计面会说「observe 却判了失败」。
    expect(verification.mode).toBe("enforce");
    expect(verification.verdict).toBe("failed");
  }, 180_000);

  it("L1-4/L1-7: a workflow without an autonomy level keeps the configured observe mode", async () => {
    const { executor } = makeExecutor(failWorkspace, fakeInner(succeededResult()), "observe");

    const result = await executor.execute(makeWorkflow(failWorkspace), makeTask(failWorkspace));

    expect(result.status).toBe("succeeded"); // observe 不覆盖自报（现状）
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.mode).toBe("observe");
    expect(verification.verdict).toBe("failed"); // 记录在案，但不改结果
  }, 180_000);

  it("fails the anti-tamper rule when a dev task weakens a protected test file (N-14)", async () => {
    const tamperedFile = path.join(tamperWorkspace, "test/api.test.mjs");
    // 两个用例共用同一个工作区，各自先复位，避免互相污染。
    await writeFile(tamperedFile, testFile(false));
    const inner = fakeInner(succeededResult(), async () => {
      // 把「必须抛出」的断言换成 `assert.ok(true)`——既有断言行消失。
      await writeFile(
        tamperedFile,
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("[AC-01] health endpoint responds", () => { assert.equal(1 + 1, 2); });',
          'test("[AC-02] rejects invalid credentials", () => { assert.ok(true); });',
          ""
        ].join("\n")
      );
    });
    const { executor } = makeExecutor(tamperWorkspace, inner, "enforce");

    const result = await executor.execute(makeWorkflow(tamperWorkspace), makeTask(tamperWorkspace));

    expect(result.status).toBe("failed");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("failed");
    expect(verification.antiTamper).toMatchObject({
      verdict: "failed",
      changed: ["test/api.test.mjs"],
      weakened: ["test/api.test.mjs"]
    });
  }, 180_000);

  it("N-14：只追加内容的改动不再触发反篡改（L1-M4l 里门拦错了的那一类）", async () => {
    const tamperedFile = path.join(tamperWorkspace, "test/api.test.mjs");
    await writeFile(tamperedFile, testFile(false));
    const inner = fakeInner(succeededResult(), async () => {
      const existing = await readFile(tamperedFile, "utf8");
      await writeFile(tamperedFile, `${existing}\n// touched by dev task\n`);
    });
    const { executor } = makeExecutor(tamperWorkspace, inner, "enforce");

    const result = await executor.execute(makeWorkflow(tamperWorkspace), makeTask(tamperWorkspace));

    expect(result.status).toBe("succeeded");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("verified");
    // 纯增量：不判死，但把「动过」留作证据——批次里据此分得出门拦对了还是拦错了。
    expect(verification.antiTamper).toMatchObject({
      verdict: "passed",
      changed: ["test/api.test.mjs"]
    });
  }, 180_000);

  it("red-light over the real sandbox: a passing suite is vacuous for a TEST task", async () => {
    // F1-6（FX-20）+ G1：证据面可读（空证据列表）→ 空转诊断 VACUOUS_TEST。
    const { executor } = makeExecutor(okWorkspace, fakeInner(succeededResult()), "enforce", {
      requirementTasks: async () => []
    });
    const task = { ...makeTask(okWorkspace), type: "TEST" as const };

    const result = await executor.execute(makeWorkflow(okWorkspace), task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("failed");
    expect(String(verification.reason)).toContain("red-light");
    expect(String(verification.reason)).toContain("VACUOUS_TEST");
    expect(verification.failureCode).toBe("VACUOUS_TEST");
  }, 180_000);

  it("red-light over the real sandbox: a failing suite satisfies a TEST task", async () => {
    const { executor } = makeExecutor(failWorkspace, fakeInner(succeededResult()), "enforce");
    const task = { ...makeTask(failWorkspace), type: "TEST" as const };

    const result = await executor.execute(makeWorkflow(failWorkspace), task);

    expect(result.status).toBe("succeeded");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("verified");
    expect(verification.acResults).toEqual({ "AC-01": "passed", "AC-02": "failed" });
  }, 180_000);

  it("FX-17：切片边界——最后一个实现任务运行切片 AC 并集，失败进入失败策略", async () => {
    const events: { eventType: string; payload: Record<string, unknown> }[] = [];
    const sibling: Task = {
      ...makeTask(failWorkspace),
      id: "task-sibling",
      taskKey: "S1-T01",
      sliceKey: "S1",
      status: "SUCCESS",
      input: { workspacePath: failWorkspace, acKeys: ["AC-02"] }
    };
    const task: Task = {
      ...makeTask(failWorkspace),
      taskKey: "S1-T02",
      sliceKey: "S1",
      input: { workspacePath: failWorkspace, acKeys: ["AC-01"] }
    };
    const { executor } = makeExecutor(failWorkspace, fakeInner(succeededResult()), "enforce", {
      events,
      workflowTasks: async () => [sibling, task]
    });

    const result = await executor.execute(makeWorkflow(failWorkspace), task);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("failed");
    const checks = verification.checks as { name: string; passed: boolean; scopingMode?: string }[];
    // A 已实现：任务级作用域检查通过（修复前全量套件因 B 未实现为红）。
    const testCheck = checks.find((check) => check.name === "test");
    expect(testCheck?.passed).toBe(true);
    expect(testCheck?.scopingMode).toBe("command-filter");
    // B 未实现：切片边界（切片 AC 并集）失败 → 进入失败策略。
    const boundary = checks.find((check) => check.name === "slice-boundary");
    expect(boundary?.passed).toBe(false);
    expect(
      events.some(
        (event) =>
          event.eventType === "SLICE_BOUNDARY_CHECKED" && event.payload.verdict === "failed"
      )
    ).toBe(true);
  }, 180_000);

  it("FX-17：切片边界全部通过时正常验证（最后一个实现任务）", async () => {
    const sibling: Task = {
      ...makeTask(okWorkspace),
      id: "task-sibling",
      taskKey: "S1-T01",
      sliceKey: "S1",
      status: "SUCCESS",
      input: { workspacePath: okWorkspace, acKeys: ["AC-02"] }
    };
    const task: Task = {
      ...makeTask(okWorkspace),
      taskKey: "S1-T02",
      sliceKey: "S1",
      input: { workspacePath: okWorkspace, acKeys: ["AC-01"] }
    };
    const { executor } = makeExecutor(okWorkspace, fakeInner(succeededResult()), "enforce", {
      workflowTasks: async () => [sibling, task]
    });

    const result = await executor.execute(makeWorkflow(okWorkspace), task);

    expect(result.status).toBe("succeeded");
    const verification = (result.output as Record<string, unknown>).verification as Record<
      string,
      unknown
    >;
    expect(verification.verdict).toBe("verified");
    const checks = verification.checks as { name: string; passed: boolean }[];
    expect(checks.find((check) => check.name === "slice-boundary")?.passed).toBe(true);
  }, 180_000);
});
