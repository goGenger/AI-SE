import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import {
  BACKEND_NODE_PROFILE,
  isPathUnderPrefixes,
  isProjectManifestPath,
  isRootDeliveryArtifactPath,
  Task,
  WorkflowRun
} from "@ai-se/shared";
import { writePathsForTaskType } from "@ai-se/agent-core";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { describe, expect, it } from "vitest";
import {
  auditWriteScope,
  diffPorcelain,
  isPathInWriteScope,
  parsePorcelainPath
} from "../services/writeScopeAudit";
import { TaskVerifier } from "../services/taskVerifier";
import { VerifyingWorkflowTaskExecutor } from "../services/verifyingTaskExecutor";

/**
 * F2-1（FX-29/30）/ F2-2（FX-33）：写范围审计单测。
 * - FX-29：QA(TEST) 写源码、BACKEND 写 Dockerfile 被检出；DEVOPS 写 Dockerfile 通过；
 * - FX-30：回放 E-1 run-1 的 T-08 写入集（任务 be4d037a，经工具调用记录重建）——
 *   observe 模式检出超范围写入（test/scripts/README 片段），src/配置写入不误伤，事件留痕；
 * - FX-33：被策略拦截后改走其他通道 → POLICY_EVASION_SUSPECTED 事件。
 */

class FakeSandbox implements Sandbox {
  readonly calls: string[] = [];
  constructor(private readonly script: (command: string) => Partial<SandboxResult> | undefined) {}

  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command.command);
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
      maxConcurrency: 1,
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

/** E-1 run-1 的 T-08（任务 be4d037a，BACKEND）写入集重建（存储截断，为可恢复子集）。 */
const T08_WRITE_SET = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/build.js",
  "scripts/lint.js",
  "scripts/typecheck.js",
  "src/errors.js",
  "src/http/respond.js",
  "src/router.js",
  "src/routes/account.js",
  "src/routes/health.js",
  "src/routes/home.js",
  "test/__p5.js",
  "test/__p7.js",
  "test/__p8.js",
  "test/__probe.test.js",
  "test/acceptance-coverage.test.js",
  ".readme.tmpl",
  ".dbg.cjs"
];

function porcelainOf(paths: string[]): string {
  return paths.map((path) => `?? ${path}`).join("\n");
}

function scopeAwareSandbox(afterPorcelain: string): FakeSandbox {
  return new FakeSandbox((command) => {
    if (command === "git status --porcelain") return { stdout: afterPorcelain };
    if (command === "git rev-parse HEAD") return { stdout: "deadbeef" };
    // package.json 探测须优先于通用 node -e（否则 scripts 读不到 → unavailable）。
    if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
    // TaskVerifier 依赖探针（AFC-M4）。
    if (command.startsWith("node -e")) {
      return {
        stdout: JSON.stringify({
          hasNodeModules: true,
          nativeOk: true,
          binOk: true,
          missingNative: []
        })
      };
    }
    // anti-tamper 快照：无受保护文件变更即可。
    if (command.includes("sha256sum") || command.trimStart().startsWith("find ")) {
      return { stdout: "" };
    }
    if (command === "npm run build") return { stdout: "build ok" };
    if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
    return undefined;
  });
}

describe("F2-1（FX-29）写范围白名单", () => {
  it("QA(TEST) 只可写测试目录：写源码被检出", () => {
    const audit = auditWriteScope({
      taskType: "TEST",
      changedPaths: ["tests/ac-02.test.mjs", "src/index.ts"]
    });
    expect(audit.violations).toEqual(["src/index.ts"]);
    expect(isPathInWriteScope("TEST", "tests/ac-02.test.mjs")).toBe(true);
    expect(isPathInWriteScope("TEST", "src/index.ts")).toBe(false);
  });

  it("PL-M11：实现类写仓库根交付物不再算越界；越界的仍是越界", () => {
    // 修前这里断言 `["Dockerfile"]`——审计把 BACKEND 写根 `Dockerfile` 判为越界。而计划正是把
    // 这件事派成了 BACKEND 任务（L1-M4c run 2 的 S4-10「编写 Dockerfile … 保证
    // `docker build -t taskboard .` 成功」），oracle 的容器段在仓库根跑不出构建上下文，
    // AC-24/25/26/29 四条 Must 全灭。强制侧同样写不出（PL-M11 修的就是这个）。
    for (const path of ["Dockerfile", "README.md", "docker-compose.yml", ".dockerignore"]) {
      expect(isRootDeliveryArtifactPath(path), path).toBe(true);
      expect(isPathInWriteScope("BACKEND", path), path).toBe(true);
    }
    // 交付物之外的越界照旧：CI 配置属 DEVOPS 组，不在 BACKEND 的实现范围内。
    expect(
      auditWriteScope({
        taskType: "BACKEND",
        changedPaths: [".github/workflows/ci.yml", "src/server.ts"]
      }).violations
    ).toEqual([".github/workflows/ci.yml"]);
    // DEVOPS(DEPLOY) 写 Dockerfile/脚本/README/CI 通过（既有行为，逐字保留）。
    const devops = auditWriteScope({
      taskType: "DEPLOY",
      changedPaths: ["Dockerfile", "scripts/build.js", "README.md", ".github/workflows/ci.yml"]
    });
    expect(devops.violations).toEqual([]);
  });

  it("PL-M12：BUILD 类型不再落默认组，devops 的构建产物路径不再误报", () => {
    // 修前 `SCOPE_RULES` **没有 `BUILD` 条目**，于是落进默认组（源码 + 配置 + 测试），
    // devops-agent 的 `infrastructure/` 与 `Dockerfile` 一律被判越界——而 `BUILD` 任务的
    // 承接 agent 正是 devops。
    const build = auditWriteScope({
      taskType: "BUILD",
      changedPaths: ["Dockerfile", "compose.yaml", "infrastructure/main.tf", "package.json"]
    });
    expect(build.violations).toEqual([]);
  });

  it("DOCS_GAP：BUILD 可写 README.md 与 docs/**；FRONTEND 仍不可写 docs/", () => {
    for (const path of ["README.md", "docs/delivery-report.md", "docs/notes.md"]) {
      expect(isPathInWriteScope("BUILD", path), path).toBe(true);
    }
    expect(
      auditWriteScope({
        taskType: "BUILD",
        changedPaths: ["README.md", "docs/delivery-report.md", "Dockerfile"]
      }).violations
    ).toEqual([]);
    // FRONTEND 仍可写根 README（PL-M11 writeRootDeliveryArtifacts），但 docs/ 仍越界。
    expect(isPathInWriteScope("FRONTEND", "README.md")).toBe(true);
    expect(isPathInWriteScope("FRONTEND", "docs/delivery-report.md")).toBe(false);
    expect(
      auditWriteScope({
        taskType: "FRONTEND",
        changedPaths: ["docs/delivery-report.md", "src/App.vue"]
      }).violations
    ).toEqual(["docs/delivery-report.md"]);
  });

  it("PL-M12：审计的路径表取自对应 agent 的 writePaths，不再手抄一份本仓库不存在的布局", () => {
    // 修前的 `SOURCE_PATH` 列的是 `app/`（单数）、`pages/`、`lib/`、`components/`，而本仓库的
    // 顶层是 `apps/` 与 `packages/`（`AGENTS.md` §2）——真实路径一律误报。L1-M4c run 2 实测
    // `violations:["apps/"]`。
    for (const path of [
      "apps/server/routes/tasks.ts",
      "backend/index.ts",
      "server/index.ts",
      "src/index.ts"
    ]) {
      expect(isPathInWriteScope("BACKEND", path), path).toBe(true);
    }
    expect(isPathInWriteScope("FRONTEND", "apps/web/src/App.vue")).toBe(true);
    expect(isPathInWriteScope("FRONTEND", "tests/assembly/app-assembly.spec.ts")).toBe(true);
    expect(isPathInWriteScope("BACKEND", "tests/unit/foo.test.ts")).toBe(true);
    for (const path of ["packages/database/migrations/001.sql", "database/schema.sql"]) {
      expect(isPathInWriteScope("DATABASE", path), path).toBe(true);
    }
    // 仍然越界：别的实现类的目录不是本类型的写范围（各 agent 的 `writePaths` 不重叠）。
    expect(isPathInWriteScope("BACKEND", "apps/web/src/App.vue")).toBe(false);
    expect(isPathInWriteScope("FRONTEND", "apps/server/index.ts")).toBe(false);
    expect(isPathInWriteScope("BACKEND", "docs/guide.md")).toBe(false);
  });

  it("N-18：BUILD/DEPLOY 的范围取自 devops 的 writePaths，不再手抄正则", () => {
    // 修前 `DEVOPS_PATH` 是一张手抄正则表，把 `scripts/` / `bin/` / `.github/` / 根级 `*.ya?ml` /
    // `Makefile` 都算作 devops 的范围，而强制侧（`devops-agent.permissions.writePaths`）**一格都
    // 没有**——审计说合法、写层说非法。实测代价：计划点名的 `scripts/verify-contract.mjs` 无人可写，
    // L1-M4m 的 run 1 / run 2 各有一条完整的 slice-1 TEST 链死在这里。
    const devopsPaths = writePathsForTaskType("BUILD") ?? [];
    for (const path of [
      "scripts/verify-contract.mjs",
      "scripts/build.mjs",
      "bin/run.sh",
      ".github/workflows/ci.yml",
      "Makefile",
      "infrastructure/main.tf"
    ]) {
      // 两侧同源：审计判在范围内 ⇔ 强制侧确实放行（前缀来自同一个函数）。
      expect(isPathUnderPrefixes(path, devopsPaths), path).toBe(true);
      expect(isPathInWriteScope("BUILD", path), path).toBe(true);
      expect(isPathInWriteScope("DEPLOY", path), path).toBe(true);
    }
    // 反向对照：实现类与测试类仍不得写构建属地（越界在 observe 下如实记录）。
    for (const type of ["BACKEND", "FRONTEND", "DATABASE", "TEST"] as const) {
      for (const path of ["scripts/verify-contract.mjs", ".github/workflows/ci.yml"]) {
        expect(isPathInWriteScope(type, path), `${type}:${path}`).toBe(false);
      }
    }
  });

  it("PL-M12：porcelain 的目录摘要行（`?? apps/`）不算越界", () => {
    // git 把整片未跟踪的目录折叠成一行；该行对「里面写了什么」零信息（里面的文件 git 根本没
    // 列出来），把它算作越界是纯粹的假阳性。
    const audit = auditWriteScope({
      taskType: "BACKEND",
      changedPaths: ["apps/", "test/", "docs/", "src/server.ts"]
    });
    expect(audit.violations).toEqual([]);
    // 但同一批里的**文件**行照常判定。
    const mixed = auditWriteScope({
      taskType: "BACKEND",
      changedPaths: ["apps/", "docs/guide.md"]
    });
    expect(mixed.violations).toEqual(["docs/guide.md"]);
  });

  it("PL-M10：根级工程清单的判据与强制侧共用 @ai-se/shared 的同一份实现", () => {
    // 修前这里是一份独立的 `CONFIG_PATH` 正则表：审计早已把根级 `package.json` 判为 BACKEND
    // 的合法写入，而强制侧（`AgentRegistry` 的前缀白名单）把它全部拒绝——同一仓库、同一时刻
    // 一边说合法一边说不合法。工程骨架任务因此写不出 `package.json`（L1-M4b run 1 首任务致败）。
    for (const path of ["package.json", "pnpm-lock.yaml", "tsconfig.json", ".gitignore"]) {
      expect(isProjectManifestPath(path), path).toBe(true);
      expect(isPathInWriteScope("BACKEND", path), path).toBe(true);
    }
    // 谓词只判**仓库根级**：子目录里的同名文件不是「仓库根清单」。
    expect(isProjectManifestPath("src/package.json")).toBe(false);
    // 但审计的**总体**作用域另有前缀规则（`src` 在 backend-agent 的 `writePaths` 里），该路径
    // 仍属 BACKEND 范围内——两条规则不同源，此处如实钉住，避免把「根清单谓词」误读成「审计
    // 作用域的全部」。
    expect(isPathInWriteScope("BACKEND", "src/package.json")).toBe(true);
    // `README.md` 原属「两侧一致判越界」的文档类（`docs/168` §4 裁定 7）；PL-M11 据 AC-24 的
    // 契约测试与 AC-30 的 oracle 把它改判为**根交付物**（`docs/170` §4 裁定 5）。
    expect(isProjectManifestPath("README.md")).toBe(false);
    expect(isRootDeliveryArtifactPath("README.md")).toBe(true);
    expect(isPathInWriteScope("BACKEND", "README.md")).toBe(true);
  });

  it("porcelain 解析与差集（renames、状态变化、行级基线）", () => {
    expect(parsePorcelainPath('R  old.js -> "new name.js"')).toEqual(["old.js", "new name.js"]);
    expect(parsePorcelainPath("?? .dbg.cjs")).toEqual([".dbg.cjs"]);
    expect(diffPorcelain(" M a.js", " M a.js\n?? b.js")).toEqual(["b.js"]);
    // 状态变化（已脏 → 再改）按行级差异计为任务写入。
    expect(diffPorcelain(" M a.js", "MM a.js")).toEqual(["a.js"]);
    // 既有脏文件行未变 → 不计入。
    expect(diffPorcelain("?? keep.js", "?? keep.js\n?? added.js")).toEqual(["added.js"]);
  });
});

describe("F2-1（FX-30）E-1 run-1 T-08 回放（observe）", () => {
  it("检出超范围写入（test/scripts/README 片段），src/配置不误伤，事件留痕", async () => {
    const sandbox = scopeAwareSandbox(porcelainOf(T08_WRITE_SET));
    const events = makeEvents();
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      events: events.sink,
      writeScope: { mode: "observe" }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "T-08", title: "工程脚本、锁文件与 README 命令文档" }),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    expect(record.writeScope?.mode).toBe("observe");
    expect(record.writeScope?.outcome).toBe("violation");
    expect(record.writeScope?.checked).toBe(T08_WRITE_SET.length);
    // AFC fixture：test/ 已与 writeTestFiles 对齐，不再算 BACKEND 越界；
    // 仍检出 scripts/ 与非清单根文件（.readme.tmpl / .dbg.cjs）。
    expect(record.writeScope?.violations).toEqual(
      expect.arrayContaining([
        "scripts/build.js",
        "scripts/lint.js",
        ".readme.tmpl",
        ".dbg.cjs"
      ])
    );
    for (const allowed of [
      "src/errors.js",
      "src/routes/health.js",
      "package.json",
      "test/acceptance-coverage.test.js",
      "test/__probe.test.js"
    ]) {
      expect(record.writeScope?.violations).not.toContain(allowed);
    }
    // observe 不覆盖结果。
    expect(record.verdict).toBe("verified");
    const scopeEvent = events.events.find((event) => event.eventType === "SCOPE_VIOLATION");
    expect(scopeEvent?.payload.taskKey).toBe("T-08");
    expect(scopeEvent?.payload.mode).toBe("observe");
    expect(events.events.filter((event) => event.eventType === "TASK_VERIFICATION")).toHaveLength(
      1
    );
  });

  it("enforce：越界判失败并走既有失败判定（reason 可读）", async () => {
    const sandbox = scopeAwareSandbox(porcelainOf(T08_WRITE_SET));
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "enforce",
      writeScope: { mode: "enforce" }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "T-08" }),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    expect(record.verdict).toBe("failed");
    expect(record.reason).toContain("write scope violation (enforce)");
    expect(record.reason).toContain("scripts/build.js");
  });

  it("FX-33：被拦截后改走其他通道 → POLICY_EVASION_SUSPECTED（写范围审计兜底）", async () => {
    // docs/ 仍越界；test/ 已对 BACKEND 合法，不能再当越界探针。
    const sandbox = scopeAwareSandbox(porcelainOf(["src/overshoot.js", "docs/ghost.md"]));
    const events = makeEvents();
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      events: events.sink,
      writeScope: {
        mode: "observe",
        blockedCommandAttempts: async () => 2
      }
    });

    await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "T-99" }),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    const types = events.events.map((event) => event.eventType);
    expect(types).toContain("SCOPE_VIOLATION");
    expect(types).toContain("POLICY_EVASION_SUSPECTED");
    const evasion = events.events.find((event) => event.eventType === "POLICY_EVASION_SUSPECTED");
    expect(evasion?.payload.blockedAttempts).toBe(2);
    expect(evasion?.payload.violations).toEqual(["docs/ghost.md"]);
  });

  it("N-19：被写权限拒绝的写入进记录，但不改变 outcome", async () => {
    // 审计是 **diff 式**的（`git status --porcelain` 前后比对），被拒的写入**不产生 diff**
    // ——它只能从 `tool_calls` 的 `input.denied = 'write'` 读到。实测（L1-M4m run 2）：
    // `slice-1-task-8-REPLAN-1` 写 `scripts/verify-contract.mjs` 被拒，`changedPaths` 是 `[]`。
    const sandbox = scopeAwareSandbox(porcelainOf(["src/app.js"]));
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      writeScope: {
        mode: "observe",
        deniedWriteAttempts: async () => ({
          attempts: 2,
          paths: ["scripts/selfcheck.mjs", "scripts/verify-contract.mjs"]
        })
      }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask({ taskKey: "T-98" }),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    expect(record.writeScope?.deniedAttempts).toBe(2);
    expect(record.writeScope?.deniedPaths).toEqual([
      "scripts/selfcheck.mjs",
      "scripts/verify-contract.mjs"
    ]);
    // **只记录、不改判**：被拒写入不是越界（越界只看 `changedPaths`）。
    expect(record.writeScope?.violations).toEqual([]);
    expect(record.writeScope?.outcome).toBe("passed");
    expect(record.verdict).toBe("verified");
  });

  it("N-19：非 git 工作区（审计 skipped）仍读得到被拒写入", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command === "git status --porcelain") return { exitCode: 128, stderr: "not a git repo" };
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      writeScope: {
        mode: "observe",
        deniedWriteAttempts: async () => ({ attempts: 1, paths: ["scripts/verify-contract.mjs"] })
      }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    // 这正是修复的价值：diff 面整个不可用时，被拒写入仍然可读。
    expect(record.writeScope?.outcome).toBe("skipped");
    expect(record.writeScope?.deniedAttempts).toBe(1);
    expect(record.writeScope?.deniedPaths).toEqual(["scripts/verify-contract.mjs"]);
  });

  it("N-19：deniedWriteAttempts 抛错时按 0 计，不作废整次验证", async () => {
    const sandbox = scopeAwareSandbox(porcelainOf(["src/app.js"]));
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      writeScope: {
        mode: "observe",
        deniedWriteAttempts: async () => {
          throw new Error("tool_calls unavailable");
        }
      }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    expect(record.writeScope?.deniedAttempts).toBe(0);
    expect(record.writeScope?.deniedPaths).toEqual([]);
    expect(record.verdict).toBe("verified");
  });

  it("非 git 工作区：审计转 skipped（不阻断、不产生事件）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command === "git status --porcelain") return { exitCode: 128, stderr: "not a git repo" };
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1" };
      return undefined;
    });
    const events = makeEvents();
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      events: events.sink,
      writeScope: { mode: "observe" }
    });

    const record = await verifier.verify({
      workflow: makeWorkflow(),
      task: makeTask(),
      result: succeededResult(),
      scopeBefore: { porcelain: "" }
    });

    expect(record.writeScope?.outcome).toBe("skipped");
    expect(events.events.every((event) => event.eventType !== "SCOPE_VIOLATION")).toBe(true);
  });
});

describe("F2-1 包装层：基线快照捕获", () => {
  it("observe 模式下执行前后各取一次 git 状态，越界随记录返回", async () => {
    let gitStatusCalls = 0;
    const sandbox = new FakeSandbox((command) => {
      if (command === "git status --porcelain") {
        gitStatusCalls += 1;
        return { stdout: gitStatusCalls === 1 ? "" : porcelainOf(["docs/new.md"]) };
      }
      if (command === "git rev-parse HEAD") return { stdout: "deadbeef" };
      if (command.includes("package.json")) return { stdout: PROBE_SCRIPTS };
      if (command.startsWith("node -e")) {
        return {
          stdout: JSON.stringify({
            hasNodeModules: true,
            nativeOk: true,
            binOk: true,
            missingNative: []
          })
        };
      }
      if (command.includes("sha256sum") || command.trimStart().startsWith("find ")) {
        return { stdout: "" };
      }
      if (command === "npm run build") return { stdout: "build ok" };
      if (command === "npm run test") return { stdout: "ok 1 - [AC-01] fine" };
      return undefined;
    });
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      writeScope: { mode: "observe" }
    });
    const inner: WorkflowTaskExecutor = {
      execute: async () => succeededResult(),
      cancel: async () => undefined
    };
    const executor = new VerifyingWorkflowTaskExecutor(verifier, inner, "observe");

    const result = await executor.execute(makeWorkflow(), makeTask());

    expect(sandbox.calls.filter((command) => command === "git status --porcelain")).toHaveLength(2);
    const verification = (result.output as { verification?: { writeScope?: { outcome: string } } })
      .verification;
    expect(verification?.writeScope?.outcome).toBe("violation");
  });

  it("off 模式：不取基线快照，不出现审计字段", async () => {
    const sandbox = scopeAwareSandbox(porcelainOf([]));
    const verifier = new TaskVerifier({
      profile: BACKEND_NODE_PROFILE,
      sandbox,
      mode: "observe",
      writeScope: { mode: "off" }
    });
    const inner: WorkflowTaskExecutor = {
      execute: async () => succeededResult(),
      cancel: async () => undefined
    };
    const executor = new VerifyingWorkflowTaskExecutor(verifier, inner, "observe");

    const result = await executor.execute(makeWorkflow(), makeTask());

    expect(sandbox.calls.filter((command) => command === "git status --porcelain")).toHaveLength(0);
    const verification = (result.output as { verification?: { writeScope?: unknown } })
      .verification;
    expect(verification?.writeScope).toBeUndefined();
  });
});


describe("docs/255：BUILD 可读测试但写范围仍不含 tests/", () => {
  it("does not treat test files as writable for BUILD (E2E skip is a platform mark)", () => {
    expect(isPathInWriteScope("BUILD", "tests/e2e/login.spec.ts")).toBe(false);
    // playwright.config.ts 命中根级 `*.config.*` 工程清单（CONFIG_PATH），本来就可写。
    expect(isPathInWriteScope("TEST", "tests/e2e/login.spec.ts")).toBe(true);
  });
});

describe("docs/261：BUILD / TEST 对 .prettierignore 与 tests/reports 的写范围", () => {
  it("allows BUILD and TEST to write .prettierignore, and BUILD to write reports but not specs", () => {
    expect(isPathInWriteScope("BUILD", ".prettierignore")).toBe(true);
    expect(isPathInWriteScope("TEST", ".prettierignore")).toBe(true);
    expect(isPathInWriteScope("BUILD", "tests/reports/test-execution-report.md")).toBe(true);
    expect(isPathInWriteScope("TEST", "tests/reports/t21-full-regression-report.md")).toBe(true);
    expect(isPathInWriteScope("BUILD", "tests/quality/t13-run-report-accuracy.spec.ts")).toBe(false);
    expect(isPathInWriteScope("TEST", "tests/quality/t13-run-report-accuracy.spec.ts")).toBe(true);
  });
});
