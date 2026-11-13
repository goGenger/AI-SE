import {
  ToolCallStartedRecord,
  ToolRuntime,
  createPhase1Tools
} from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./AgentRegistry";
import { ToolRuntimeBackend } from "./ToolRuntimeBackend";

/**
 * PL-M5（`docs/158` §3）：写范围必须覆盖「项目实际放测试的地方」。
 * 这里钉住三件事：① QA 能写任意位置的测试文件；② 非测试文件仍被拒；
 * ③ 没有 `writeTestFiles` 的 agent 行为逐项不变。
 *
 * PL-C1（`docs/159` Known Issue 3）：**读侧**与写侧对称——`read` / `ls` / `grep` 的拒绝
 * 同样留痕、同样说清生效范围。
 *
 * PL-M10（`docs/168`）：写范围还必须覆盖「**仓库根**的工程清单/配置文件」。前缀白名单表达不了
 * 「仓库根本身」，故工程骨架任务写不出 `package.json`（L1-M4b run 1 在第一个任务上即致败）。
 * 同时修正范围列表的渲染——单文件条目不再被画成目录。
 *
 * 判定手法：沙箱桩一旦被调用就抛错。**权限门放行 → 调用到达沙箱**（返回的是沙箱错误）；
 * **权限门拒绝 → 根本不碰沙箱**（返回 `Path is not writable/readable: …`）。用计数器区分两条路径。
 */

interface Hooks {
  counter?: { n: number };
  recorded?: string[];
  events?: string[];
}

function buildBackend(agentName: string, hooks: Hooks = {}): ToolRuntimeBackend {
  const definition = new AgentRegistry().get(agentName);
  return new ToolRuntimeBackend({
    runtime: new ToolRuntime({ tools: createPhase1Tools() }),
    permissions: definition.permissions,
    context: {
      requestId: "request",
      taskId: "task",
      agentRunId: "run",
      actor: definition.name,
      workspacePath: process.cwd(),
      sandbox: {
        async runCommand() {
          if (hooks.counter) hooks.counter.n += 1;
          throw new Error("Sandbox write reached");
        }
      }
    },
    ...(hooks.recorded
      ? {
          toolCallRecorder: {
            async recordToolCallStarted(record: { toolName: string; input: { path?: string } }) {
              hooks.recorded?.push(`started:${record.toolName}:${record.input.path ?? ""}`);
            },
            async recordToolCallFinished(record: { status: string }) {
              hooks.recorded?.push(`finished:${record.status}`);
            }
          }
        }
      : {}),
    ...(hooks.events
      ? {
          onToolEvent: async (eventType: string, payload: { status?: unknown }) => {
            hooks.events?.push(`${eventType}:${String(payload.status ?? "")}`);
          }
        }
      : {})
  });
}

describe("professional Agent permissions", () => {
  it("prevents the Reviewer from writing files", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("reviewer-agent", { counter });

    await expect(backend.write("/apps/server/index.ts", "unsafe")).resolves.toEqual({
      error: "Path is not writable: apps/server/index.ts (allowed: none)"
    });
    expect(counter.n).toBe(0);
  });

  it("lets the backend agent write flat-layout src files and keeps out-of-scope paths blocked", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });

    // src/slugify.mjs falls under the flat-layout source prefix: the permission
    // gate must pass and the call must reach the sandbox (aborted here on purpose).
    await backend.write("src/slugify.mjs", "export const slugify = (text) => text;");
    expect(counter.n).toBe(1);

    const blocked = await backend.write("docs/guide.md", "# out of scope");
    expect(blocked).toEqual({
      error:
        "Path is not writable: docs/guide.md (allowed: apps/server/, server/, backend/, src/, " +
        "and test files anywhere (test/spec by name, or under test/, tests/, __tests__/), " +
        "and project manifests/configs at the repository root " +
        "(package.json, pnpm-lock.yaml, tsconfig*.json, .gitignore, ...), " +
        "and delivery artifacts at the repository root " +
        "(Dockerfile, docker-compose*.yml, .dockerignore, README.md))"
    });
    expect(counter.n).toBe(1);
  });

  it("lets the QA agent write test files wherever the project keeps them (PL-M5)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("qa-agent", { counter });

    // 关键用例：白名单前缀相对仓库根，覆盖不到 `src/__tests__/`——
    // 而它正是本仓库自己的测试规范（AGENTS.md §5/§6），也正是 run 2 写不进去的那一类路径。
    for (const path of [
      "src/__tests__/todo.test.ts",
      "apps/web/src/__tests__/view.test.ts",
      "test/z.test.js",
      "tests/helpers/util.mjs"
    ]) {
      await backend.write(path, "content");
    }
    expect(counter.n).toBe(4);
  });

  it("lets dev agents write new test files so their test check can pass (N-38)", async () => {
    // l1-m4v run 1：BACKEND 任务的验证含 `test` 检查（期望通过），计划把测试放在 `test/`，
    // 而 backend-agent 的 writePaths 只到 `src/` —— 零测试 ⇒ 零证据 ⇒ 任务失败，整条链在
    // 第一个任务上终止。`TEST_FILE_CONSTRAINT` 一直告诉 agent「新增测试文件是允许的」。
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });
    for (const path of ["test/scaffold.test.js", "src/config.test.js"]) {
      await backend.write(path, "content");
    }
    expect(counter.n).toBe(2);
  });

  it("still blocks the QA agent from writing non-test files", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("qa-agent", { counter });

    const allowedScope =
      "test/, tests/, __tests__/, .prettierignore, and test files anywhere " +
      "(test/spec by name, or under test/, tests/, __tests__/)";
    for (const path of ["src/server.ts", "probe.txt", "src/helpers/util.ts"]) {
      await expect(backend.write(path, "content"), path).resolves.toEqual({
        error: `Path is not writable: ${path} (allowed: ${allowedScope})`
      });
    }
    expect(counter.n).toBe(0);
  });

  /**
   * PL-M10（`docs/168`）：工程骨架任务必须能写**仓库根**的清单/配置文件。写范围是相对仓库根的
   * 前缀白名单，而仓库根是所有前缀的**父目录**——任何前缀都表达不了「根本身」。L1-M4b run 1 的
   * S1-T1（BACKEND，"Scaffold pnpm / Node.js 22 project manifest and required scripts"）因此
   * 在**第一个任务**上就写不出 `package.json`，整条链 13 分钟即终止。
   */
  it("lets implementation agents write root-level project manifests (PL-M10)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });

    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      ".gitignore",
      "vitest.config.ts"
    ]) {
      await backend.write(path, "content");
    }
    expect(counter.n).toBe(5);
  });

  it("keeps non-manifest root files blocked for implementation agents (PL-M10)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });

    // `index.js` 属根级源码：两个谓词都不覆盖它，强制侧仍拒——与审计侧现在**一致**
    // （PL-M12 把审计的实现类作用域改为取自 agent 的 `writePaths`，原先那条「根级源码合法」
    // 的正则随之消失）。若计划把服务入口点放在仓库根，N-2 同形的致败会复发（`docs/169` KI 1）。
    const denied = await backend.write("index.js", "content");
    expect(denied.error).toContain("Path is not writable");
    expect(counter.n).toBe(0);
  });

  /**
   * PL-M11（`docs/170`）：交付物（`Dockerfile` / compose / `.dockerignore` / `README.md`）与
   * 工程清单是两类东西，同形但并列。L1-M4c run 2 的 S4-10（「编写 Dockerfile … 保证
   * `docker build -t taskboard .` 成功」，BACKEND，acKeys AC-24/AC-26）三次尝试全被拒，把同一份
   * Dockerfile 写到 `backend/` / `server/` / `apps/server/`；而 oracle 的容器段在**仓库根**执行
   * `docker build`（`oracle.mjs:626`，`cwd = workspace`）——AC-24/25/26/29 四条 Must 全灭。
   */
  it("lets implementation agents write root-level delivery artifacts (PL-M11)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });

    for (const path of [
      "Dockerfile",
      "Dockerfile.dev",
      ".dockerignore",
      "compose.yaml",
      "docker-compose.prod.yml",
      "README.md"
    ]) {
      await backend.write(path, "content");
    }
    expect(counter.n).toBe(6);
  });

  it("keeps sub-directory namesakes and non-artifacts blocked (PL-M11 反向对照)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("backend-agent", { counter });

    // 谓词只判**仓库根级**：`docker/Dockerfile` 不是根交付物（oracle 只读仓库根那一份）；
    // `docs/guide.md` 属文档类；`compose.yaml.bak` 不是 compose 文件。
    for (const path of ["docker/Dockerfile", "docs/guide.md", "compose.yaml.bak", "notes.txt"]) {
      const denied = await backend.write(path, "content");
      expect(denied.error, path).toContain("Path is not writable");
    }
    expect(counter.n).toBe(0);
  });

  /**
   * N-18（`docs/190`）：计划点名的交付物是 `scripts/verify-contract.mjs`（E1 的 PRD 只要求「六步
   * 构建契约」，从不点名这个路径——它是规划器发明的），而审计侧的 `DEVOPS_PATH` 一直把
   * `scripts/` / `bin/` / `.github/` 当作 devops 的范围，强制侧**一格都没有**。
   * 实测代价：L1-M4m 的 run 1 / run 2 **各有一条完整的 slice-1 TEST 链**死在这里。
   */
  it("lets the devops agent write build scripts and CI config (N-18)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("devops-agent", { counter });

    for (const path of [
      "scripts/verify-contract.mjs",
      "scripts/build.mjs",
      "bin/run.sh",
      ".github/workflows/ci.yml",
      "Makefile",
      "infrastructure/main.tf"
    ]) {
      await backend.write(path, "content");
    }
    expect(counter.n).toBe(6);
  });

  it("keeps implementation and test agents out of build scripts and CI config (N-18 反向对照)", async () => {
    for (const name of ["backend-agent", "frontend-agent", "database-agent", "qa-agent"]) {
      const counter = { n: 0 };
      const backend = buildBackend(name, { counter });

      // `Makefile` 不在此列——它本就是「仓库根工程清单/配置」（`isProjectManifestPath`），
      // 实现类一直可写。
      for (const path of ["scripts/verify-contract.mjs", ".github/workflows/ci.yml"]) {
        const denied = await backend.write(path, "content");
        expect(denied.error, `${name}:${path}`).toContain("Path is not writable");
      }
      expect(counter.n).toBe(0);
    }
  });

  /**
   * N-19（`docs/191`）：被拒调用必须在 `tool_calls` 里**可结构化检索**，不靠 `error.message`
   * 的子串匹配。修前生产里唯一的「被拦尝试」计数器（`blockedCommandAttempts`）匹配的是
   * `"blocked"`，而写权限拒绝的消息是 `Path is not writable:` —— 这一类一次都没被计过。
   */
  it("marks denied calls with a structured flag, not just a message (N-19)", async () => {
    const captured: Array<ToolCallStartedRecord["input"]> = [];
    const definition = new AgentRegistry().get("backend-agent");
    const backend = new ToolRuntimeBackend({
      runtime: new ToolRuntime({ tools: createPhase1Tools() }),
      permissions: definition.permissions,
      context: {
        requestId: "request",
        taskId: "task",
        agentRunId: "run",
        actor: definition.name,
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("Sandbox write reached");
          }
        }
      },
      toolCallRecorder: {
        async recordToolCallStarted(record: ToolCallStartedRecord) {
          captured.push({ ...record.input });
        },
        async recordToolCallFinished() {}
      }
    });

    await backend.write("scripts/verify-contract.mjs", "content");
    await backend.read("scripts/verify-contract.mjs");

    expect(captured).toEqual([
      { path: "scripts/verify-contract.mjs", denied: "write" },
      { path: "scripts/verify-contract.mjs", denied: "read" }
    ]);
  });

  it("does not widen read-only or test-only agents to delivery artifacts (PL-M11)", async () => {
    for (const name of ["reviewer-agent", "qa-agent"]) {
      const counter = { n: 0 };
      const backend = buildBackend(name, { counter });

      const denied = await backend.write("Dockerfile", "FROM node:22-alpine");

      expect(denied.error, name).toContain("Path is not writable");
      expect(counter.n).toBe(0);
    }
  });

  it("does not widen read-only or test-only agents to project manifests (PL-M10)", async () => {
    for (const name of ["reviewer-agent", "qa-agent"]) {
      const counter = { n: 0 };
      const backend = buildBackend(name, { counter });

      const denied = await backend.write("package.json", "{}");

      expect(denied.error, name).toContain("Path is not writable");
      expect(counter.n).toBe(0);
    }
  });

  it("renders single-file scope entries as files, not directories (PL-M10 M-1)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("devops-agent", { counter });

    const denied = await backend.write("src/index.ts", "content");

    // 原实现一律 `join("/, ") + "/"`，把 `compose.yaml` / `Dockerfile` / `package.json` 全画成
    // 目录（实测读侧消息里出现过 `package.json/`）——与 PL-M5 的「拒绝必须可被发现」相悖。
    expect(denied).toEqual({
      error:
        "Path is not writable: src/index.ts (allowed: infrastructure/, scripts/, bin/, .github, " +
        "docs/, compose.yaml, Dockerfile, Makefile, tests/reports/, " +
        "and project manifests/configs at the repository root " +
        "(package.json, pnpm-lock.yaml, tsconfig*.json, .gitignore, ...), " +
        "and delivery artifacts at the repository root " +
        "(Dockerfile, docker-compose*.yml, .dockerignore, README.md))"
    });
    expect(counter.n).toBe(0);
  });

  it("does not widen the scope of agents that do not declare writeTestFiles", async () => {
    // 同一路径：reviewer 没有 writeTestFiles → 仍被拒。这是「只增加一条语义化条件」的反向对照。
    const counter = { n: 0 };
    const backend = buildBackend("reviewer-agent", { counter });

    await expect(backend.write("src/__tests__/todo.test.ts", "content")).resolves.toEqual({
      error: "Path is not writable: src/__tests__/todo.test.ts (allowed: none)"
    });
    expect(counter.n).toBe(0);
  });

  it("records a denied write as a failed tool call (PL-M5)", async () => {
    const recorded: string[] = [];
    const events: string[] = [];
    const backend = buildBackend("qa-agent", { recorded, events });

    await backend.write("probe.txt", "content");

    // 拒绝发生在调用 Tool Runtime 之前，若不补记则 tool_calls 表完全没有这次尝试
    // （run 2 的 QA agent 就是这样消失的，见 docs/158 §1.5）。
    expect(recorded).toEqual(["started:write_file:probe.txt", "finished:failed"]);
    expect(events).toEqual(["tool_call_started:running", "tool_call_finished:failed"]);
    expect(backend.toolResults).toHaveLength(1);
    expect(backend.toolResults[0]).toMatchObject({
      success: false,
      toolName: "write_file",
      error: { code: "TOOL_ERROR" }
    });
  });

  /**
   * PL-C1（`docs/159` Known Issue 3）：读侧与写侧对称——拒绝同样必须留痕、必须说清生效范围。
   * `devops-agent` 是唯一读范围受限的 agent（`readPaths` 不含 `src`），用它触发真实拒绝。
   */
  it("records a denied read as a failed tool call (PL-C1)", async () => {
    const counter = { n: 0 };
    const recorded: string[] = [];
    const events: string[] = [];
    const backend = buildBackend("devops-agent", { counter, recorded, events });

    const denied = await backend.read("src/index.ts");

    expect(denied.error).toContain("Path is not readable: src/index.ts");
    expect(denied.error).toContain("allowed:");
    expect(denied.error).toContain("repository root listing (.)");
    // 与写侧同一条记录通道：拒绝发生在 Tool Runtime 之前，不补记则 tool_calls 完全没有这次尝试。
    expect(recorded).toEqual(["started:read_file:src/index.ts", "finished:failed"]);
    expect(events).toEqual(["tool_call_started:running", "tool_call_finished:failed"]);
    expect(counter.n).toBe(0);
    expect(backend.toolResults).toHaveLength(1);
    expect(backend.toolResults[0]).toMatchObject({
      success: false,
      toolName: "read_file",
      error: { code: "TOOL_ERROR" }
    });
  });

  it("covers the ls and grep denial paths too (PL-C1)", async () => {
    const counter = { n: 0 };
    const recorded: string[] = [];
    const backend = buildBackend("devops-agent", { counter, recorded });

    await backend.ls("src");
    await backend.grep("TODO", "src");

    expect(recorded).toEqual([
      "started:list_directory:src",
      "finished:failed",
      "started:search_code:src",
      "finished:failed"
    ]);
    expect(counter.n).toBe(0);
    expect(backend.toolResults.map((entry) => entry.toolName)).toEqual([
      "list_directory",
      "search_code"
    ]);
  });

  it("keeps permitted reads reaching the sandbox (PL-C1)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("devops-agent", { counter });

    await backend.read("Dockerfile");

    // 放行 → 调用到达沙箱（桩抛错，被 executeTool 收成失败结果）。失败来自**沙箱**而非权限门：
    // 这正是与上一条（`src/index.ts` 被权限门拦下、沙箱零调用）的对照。
    expect(counter.n).toBe(1);
    expect(backend.toolResults[0]?.error?.message ?? "").not.toContain("is not readable");
  });

  it("lets frontend-agent read/write assembly tests outside writePaths (AFC fixture / AC-15)", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("frontend-agent", { counter });

    // Write still goes through writeTestFiles → sandbox (permission gate must pass).
    await backend.write("tests/assembly/app-assembly.spec.ts", "content");
    expect(counter.n).toBe(1);

    // Read must not be rejected as out-of-scope (AC-15 root cause: tests/ not readable).
    const readResult = await backend.read("tests/assembly/app-assembly.spec.ts");
    expect(JSON.stringify(readResult)).not.toContain("Path is not readable");

    const lsResult = await backend.ls("tests");
    expect(JSON.stringify(lsResult)).not.toContain("Path is not readable");

    // docs/255：devops 可读 tests/（ENV_GAP 预检）但仍不可写测试，也不可读 src/。
    const devopsCounter = { n: 0 };
    const devops = buildBackend("devops-agent", { counter: devopsCounter });
    const readable = await devops.read("tests/assembly/app-assembly.spec.ts");
    expect(JSON.stringify(readable)).not.toContain("Path is not readable");
    expect(devopsCounter.n).toBe(1);
    const rootList = await devops.ls(".");
    expect(JSON.stringify(rootList)).not.toContain("Path is not readable");
    const srcDenied = await devops.read("src/index.ts");
    expect(srcDenied.error).toContain("Path is not readable");
  });

});

describe("docs/261：.prettierignore 与 tests/reports 写权限", () => {
  it("lets QA write .prettierignore and tests/reports, but still blocks package.json", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("qa-agent", { counter });
    await backend.write(".prettierignore", "node_modules\n");
    await backend.write("tests/reports/test-execution-report.md", "# report\n");
    expect(counter.n).toBe(2);
    const denied = await backend.write("package.json", "{}");
    expect(denied.error).toContain("Path is not writable");
  });

  it("lets devops write .prettierignore and tests/reports, but not quality specs", async () => {
    const counter = { n: 0 };
    const backend = buildBackend("devops-agent", { counter });
    await backend.write(".prettierignore", "dist\n");
    await backend.write("tests/reports/t21-full-regression-report.md", "# t21\n");
    expect(counter.n).toBe(2);
    const denied = await backend.write("tests/quality/t13-run-report-accuracy.spec.ts", "export {}");
    expect(denied.error).toContain("Path is not writable");
    expect(counter.n).toBe(2);
  });
});
