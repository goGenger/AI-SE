import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  PROFESSIONAL_AGENT_DEFINITIONS,
  writePathsForTaskType
} from "./AgentRegistry";

function task(type: Task["type"], input = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "TASK-1",
    title: "Task",
    description: "Task",
    type,
    status: "READY",
    priority: "MEDIUM",
    input,
    retryCount: 0,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("AgentRegistry", () => {
  it("registers and resolves professional agents by task type and capability", () => {
    const registry = new AgentRegistry();
    expect(registry.list()).toHaveLength(7);
    expect(registry.resolveTask(task("BACKEND")).name).toBe("backend-agent");
    expect(registry.resolveByCapability("DATABASE_SCHEMA").name).toBe("database-agent");
  });

  it("resolves debug work to the failed task profession", () => {
    const registry = new AgentRegistry();
    expect(registry.resolveTask(task("DEBUG", { targetTaskType: "FRONTEND" })).name).toBe(
      "frontend-agent"
    );
  });

  /**
   * PL-C3（`docs/161` Known Issue 4）：消费侧同样要做成员判定。此前 `debugTarget` 把
   * `input.targetTaskType` 直接 `as TaskType`，非法值查空 `TASK_AGENT_TYPES`，最终抛出一条
   * **误报 `task type DEBUG`** 的错误——真实原因是目标类型不可用。
   */
  it("rejects an unusable DEBUG target type with an accurate reason (PL-C3)", () => {
    const registry = new AgentRegistry();
    const cases: Record<string, unknown>[] = [
      // agent 输出里的自由文本（真实案例：`fixTaskType: "IMPLEMENTATION"`，枚举里没有这个值）
      { targetTaskType: "IMPLEMENTATION" },
      // 运行期专属类型：没有职业 agent 承接
      { targetTaskType: "MONITOR" },
      { targetTaskType: "DEBUG" },
      // 交付编排器独占：TASK_AGENT_TYPES 无 DEPLOY（F1 round17 DEBUG×DEPLOY）
      { targetTaskType: "DEPLOY" },
      // 缺失 / 类型不对
      {},
      { targetTaskType: 42 }
    ];

    for (const input of cases) {
      let message = "";
      try {
        registry.resolveTask(task("DEBUG", input));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, JSON.stringify(input)).toContain("target task type is missing or unusable");
      // 关键：不再把真实原因误报成「DEBUG 没有 agent」。
      expect(message, JSON.stringify(input)).not.toContain("for task type DEBUG");
      // 也不回显目标值本身（它可能来自 agent 输出；`AGENTS.md` §10）。
      expect(message, JSON.stringify(input)).not.toContain("IMPLEMENTATION");
    }
  });

  it("still resolves every usable DEBUG target type (PL-C3)", () => {
    const registry = new AgentRegistry();
    for (const [target, expected] of [
      ["BACKEND", "backend-agent"],
      ["FRONTEND", "frontend-agent"],
      ["DATABASE", "database-agent"],
      ["TEST", "qa-agent"],
      ["REVIEW", "reviewer-agent"],
      ["BUILD", "devops-agent"]
    ] as const) {
      expect(registry.resolveTask(task("DEBUG", { targetTaskType: target })).name).toBe(expected);
    }
  });

  it("rejects unknown or duplicate agents", () => {
    const registry = new AgentRegistry();
    expect(() => registry.get("missing")).toThrow("No registered agent");
    expect(() => registry.resolveTask(task("DEPLOY"))).toThrow("No professional agent");
    expect(() => registry.register(PROFESSIONAL_AGENT_DEFINITIONS[0])).toThrow(
      "already registered"
    );
  });

  it("covers flat project layouts (src/test/tests) for code-writing professions", () => {
    const registry = new AgentRegistry();
    for (const name of ["backend-agent", "frontend-agent", "database-agent"]) {
      const permissions = registry.get(name).permissions;
      expect(permissions.writePaths).toContain("src");
      expect(permissions.readPaths).toEqual(
        expect.arrayContaining(["src", "test", "tests", "__tests__"])
      );
    }
    expect(registry.get("qa-agent").permissions.writePaths).toEqual(
      expect.arrayContaining(["test"])
    );
  });

  it("dev agents and the test author may write test files outside their write paths (PL-M5 / N-38)", () => {
    const registry = new AgentRegistry();
    // QA 写测试，而测试可能落在项目自己的测试目录里（本仓库规范 = `src/__tests__/`），
    // 白名单前缀覆盖不到 → 显式声明 writeTestFiles。
    expect(registry.get("qa-agent").permissions.writeTestFiles).toBe(true);
    // N-38：BACKEND/FRONTEND/DATABASE 任务的验证含 `test` 检查（期望通过），而它们的读范围
    // 含 `test`、写范围不含 —— 提示词说「新增测试文件是允许的」，权限层却拒绝，实测在
    // E1 第一个任务上即致败（l1-m4v run 1）。
    for (const name of ["backend-agent", "frontend-agent", "database-agent"]) {
      expect(registry.get(name).permissions.writeTestFiles, name).toBe(true);
    }
    // 反向对照：reviewer 只读，不因上面三条放宽而获得写测试的能力。
    expect(registry.get("reviewer-agent").permissions.writeTestFiles).toBeUndefined();
  });

  it("frontend instructions allow fixture harness edits without relaxing anti-tamper (AFC fixture)", () => {
    const registry = new AgentRegistry();
    const instructions = registry.get("frontend-agent").systemInstructions;
    expect(instructions).toMatch(/createPinia\(\)/);
    expect(instructions).toMatch(/getActivePinia/);
    expect(instructions).toMatch(/Never weaken, relax, or delete an existing assertion/);
    expect(instructions).not.toMatch(/Existing test files are read-only/);
  });

  /**
   * N-72（`docs/232` §10）：qa-agent 写完红灯用例后必须把「红」当成**期望结果**提交，
   * 而不是 `FAILED`——否则任务在验证门之前就被判死、白走一轮 REPLAN（第十三轮两片各一次）。
   */
  it("N-72：qa-agent 明确「红灯是期望结果、跑红后提交 SUCCESS」", () => {
    const registry = new AgentRegistry();
    const instructions = registry.get("qa-agent").systemInstructions;
    expect(instructions).toContain("A red run is the expected outcome");
    expect(instructions).toContain("submit status SUCCESS");
    // 作用域只给写测试的 agent：写实现的 agent 收到这条语义会被误读成「失败也算完成」。
    expect(registry.get("frontend-agent").systemInstructions).not.toContain(
      "A red run is the expected outcome"
    );
  });

  it("only the manifest-producing agents may write root project manifests (PL-M10)", () => {
    const registry = new AgentRegistry();
    // 写范围是相对仓库根的**前缀**白名单，覆盖不到「仓库根**本身**」——工程骨架任务因此写不出
    // `package.json`（L1-M4b run 1 在第一个任务上即致败，见 docs/168 §2）。
    for (const name of ["backend-agent", "frontend-agent", "database-agent", "devops-agent"]) {
      expect(registry.get(name).permissions.writeProjectManifests, name).toBe(true);
    }
    for (const name of ["planner-agent", "qa-agent", "reviewer-agent"]) {
      expect(registry.get(name).permissions.writeProjectManifests, name).toBeUndefined();
    }
  });

  it("only the implementing and build agents may write root delivery artifacts (PL-M11)", () => {
    const registry = new AgentRegistry();
    // 与 PL-M10 同因不同集：交付物（Dockerfile / compose / README）同样落在仓库根，而前缀白名单
    // 表达不了「根本身」。L1-M4c run 2 的 S4-10 因此写不出根 Dockerfile，oracle 的容器段
    // 在仓库根跑不出构建上下文（AC-24/25/26/29 全灭，见 docs/170 §2.1）。
    for (const name of ["backend-agent", "frontend-agent", "database-agent", "devops-agent"]) {
      expect(registry.get(name).permissions.writeRootDeliveryArtifacts, name).toBe(true);
    }
    for (const name of ["planner-agent", "qa-agent", "reviewer-agent"]) {
      expect(registry.get(name).permissions.writeRootDeliveryArtifacts, name).toBeUndefined();
    }
  });

  it("exposes the write paths of a task type as the single source of truth (PL-M12)", () => {
    const registry = new AgentRegistry();
    // `apps/server` 的写范围审计原先手抄了一张 `SOURCE_PATH` 正则表表达同一件事，且已经漂移
    // （它列的是 `app/`、`pages/`、`lib/`，而本仓库顶层是 `apps/`、`packages/`）。现在审计侧
    // 从这里取前缀，不再有第二份定义。
    expect(writePathsForTaskType("BACKEND")).toEqual(
      registry.get("backend-agent").permissions.writePaths
    );
    expect(writePathsForTaskType("TEST")).toEqual(registry.get("qa-agent").permissions.writePaths);
    expect(writePathsForTaskType("BUILD")).toEqual(
      registry.get("devops-agent").permissions.writePaths
    );
    // 没有承接 agent 的任务类型返回 undefined，由调用方决定退路（`DEPLOY` 走交付链；
    // `DEBUG` / `MONITOR` / `INCIDENT` 是运行期类型）。
    for (const type of ["DEPLOY", "DEBUG", "MONITOR", "INCIDENT"] as const) {
      expect(writePathsForTaskType(type), type).toBeUndefined();
    }
  });

  /**
   * N-18（`docs/190`）：devops 的构建属地**必须**在 `writePaths` 里，否则审计侧
   * （`apps/server/src/services/writeScopeAudit.ts` 的 `DEVOPS_SCOPE`）会从本函数派生出
   * 一份**比强制侧更宽**的表——那正是本缺陷的成因（审计说合法、写层说非法）。
   */
  it("keeps the devops build directories in its own write paths (N-18)", () => {
    const devops = new AgentRegistry().get("devops-agent");
    for (const entry of ["infrastructure", "scripts", "bin", ".github", "docs"]) {
      expect(devops.permissions.writePaths, entry).toContain(entry);
      expect(devops.permissions.readPaths, entry).toContain(entry);
    }
    expect(devops.permissions.writeRootDeliveryArtifacts).toBe(true);
    expect(devops.permissions.readPaths).toContain("README.md");
    expect(devops.systemInstructions).toMatch(/README\.md|docs\/\*\*/);
    // 反向对照：实现类与测试类 agent 的写范围**不含**这些构建属地。
    for (const name of ["backend-agent", "frontend-agent", "database-agent", "qa-agent"]) {
      const permissions = new AgentRegistry().get(name).permissions;
      for (const entry of ["scripts", "bin", ".github"]) {
        expect(permissions.writePaths, `${name}:${entry}`).not.toContain(entry);
      }
    }
  });

  /**
   * N-19（`docs/191` §3）：平台侧分不出「任务声明的交付物」与「agent 顺手写的东西」
   * （`TaskPlanItemSchema` 是 `.strict()`，路径只在自由文本 `description` 里），而写范围审计是
   * diff 式的、看不见被拒的写入。⇒「被拒的交付物写入必须如实报告」只能落在指令上。
   */
  it("tells every writing agent to report a denied deliverable write (N-19)", () => {
    const registry = new AgentRegistry();
    const marker = "rejects a path that your task description names as a deliverable";
    for (const name of [
      "frontend-agent",
      "backend-agent",
      "database-agent",
      "qa-agent",
      "devops-agent"
    ]) {
      expect(registry.get(name).systemInstructions, name).toContain(marker);
    }
    // 反向对照：只读 agent 不该背上这条（它们没有写权限，也没有可被拒的交付物）。
    for (const name of ["planner-agent", "reviewer-agent"]) {
      expect(registry.get(name).systemInstructions, name).not.toContain(marker);
    }
  });

  it("tells every dev agent to mark tests with the AC number verification selects by (N-40)", () => {
    // l1-m4v run 1（第二次）：验证门按任务 acKeys 跑
    // `node --test --test-name-pattern '\[AC-04\]|…'`，零匹配不算证据（N-27）。agent 写了 6 个
    // 测试但一个都没带编号 ⇒ 过滤后 `1..0` ⇒ BACKEND 任务判失败，链路在第一个任务上终止。
    const registry = new AgentRegistry();
    const marker = "with the acceptance-criterion number it covers";
    for (const name of ["frontend-agent", "backend-agent", "database-agent"]) {
      expect(registry.get(name).systemInstructions, name).toContain(marker);
    }
    // 反向对照：qa-agent 早已有自己的 AC 命名要求，不靠这条。
    expect(registry.get("qa-agent").systemInstructions).toContain("[AC-01]");
  });

  it("N-22：每个会报 REPLAN 的 agent 都被要求给出 fixTaskType", () => {
    // 起因（L1-M4n run 2）：该要求**原本只写在 qa-agent 的指令里**，于是 backend-agent 报
    // `REPLAN` 时字段为空 ⇒ 路由只能按源任务类型重试（全库 36 次 REPLAN 里 19 次来自 backend）。
    const carrying = PROFESSIONAL_AGENT_DEFINITIONS.filter((definition) =>
      definition.systemInstructions.includes("fixTaskType")
    )
      .map((definition) => definition.name)
      .sort();
    expect(carrying).toEqual(
      [
        "backend-agent",
        "database-agent",
        "devops-agent",
        "frontend-agent",
        "qa-agent",
        "reviewer-agent"
      ].sort()
    );
    // 反向对照：planner-agent 不做工作、不改文件，不背这条。
    expect(
      PROFESSIONAL_AGENT_DEFINITIONS.find((d) => d.name === "planner-agent")?.systemInstructions
    ).not.toContain("fixTaskType");
  });
});

/**
 * `docs/235` §5.2 层 2：**定义保留、按 profile 可达**。
 *
 * 只把 agent 从 profile 的 `agents` 里去掉，注册表仍然注册它（历史任务恢复需要），但派发必须
 * fail-closed——否则「保留但不可达」会退化成「保留且随时可达」。
 */
describe("docs/235：能力 profile 决定可达性", () => {
  it("默认 profile 启用全部七个 agent（零行为变化）", () => {
    const registry = new AgentRegistry();
    expect(registry.list()).toHaveLength(7);
    for (const type of ["BACKEND", "DATABASE", "FRONTEND"] as const) {
      expect(() => registry.resolveTask(task(type))).not.toThrow();
    }
  });

  it("profile 未启用的类型 → 按类型派发时 fail-closed", () => {
    const registry = new AgentRegistry();
    const narrow = { ...BACKEND_NODE_PROFILE, agents: ["PLANNER"] as const };
    expect(() => registry.resolveTask(task("BACKEND"), narrow)).toThrow(/not enabled/);
  });

  it("已指派 agent 的历史任务同样受 profile 约束", () => {
    const registry = new AgentRegistry();
    const narrow = { ...BACKEND_NODE_PROFILE, agents: ["PLANNER"] as const };
    const assigned = { ...task("BACKEND"), assignedAgent: "backend-agent" };
    expect(() => registry.resolveTask(assigned, narrow)).toThrow(/not enabled/);
  });

  it("profile 由**构造**决定（docs/235 §6.5 的选择机制：装配处注入一次）", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    expect(registry.resolveTask(task("FRONTEND")).name).toBe("frontend-agent");
    expect(() => registry.resolveTask(task("BACKEND"))).toThrow(/not enabled/);
    expect(() => registry.resolveTask(task("DATABASE"))).toThrow(/not enabled/);
  });
});

/**
 * `docs/235` §6.9：**测试必须按 AC 断言，不得把缺陷固化成"预期失败"**。
 *
 * 实测来源（F1 run 1 的 slice-4）：TEST 任务写出一条**顺序断言错误**的测试，与一条用
 * `test.fails(...)` 把缺陷钉成"预期失败"的测试；后续修复任务要落地实现，就必须改这两个受保护
 * 文件，而防篡改门拒绝改弱断言 ⇒ REPLAN 耗尽 ⇒ 整片 FAILED。
 *
 * 门只能拒绝，不能告诉 agent 怎么写才对——所以这条约束落在写测试的那个 agent 上。
 */
describe("docs/235 §6.9：写测试的 agent 不得把缺陷固化成预期失败", () => {
  const marker = "Never use test.fails";

  it("qa-agent 背这条约束", () => {
    const registry = new AgentRegistry();
    expect(registry.get("qa-agent").systemInstructions).toContain(marker);
    expect(registry.get("qa-agent").systemInstructions).toContain(
      "A test that must change for the implementation to pass is a wrong test"
    );
  });

  it("只读与实现类 agent 不背（它们不写 AC 测试）", () => {
    const registry = new AgentRegistry();
    for (const name of ["planner-agent", "reviewer-agent", "devops-agent"]) {
      expect(registry.get(name).systemInstructions, name).not.toContain(marker);
    }
  });

  it("与既有的 AC 命名要求并存，没有替换掉任何一条", () => {
    const instructions = new AgentRegistry().get("qa-agent").systemInstructions;
    expect(instructions).toContain("[AC-01]");
    expect(instructions).toContain("fixTaskType");
    expect(instructions).toContain(marker);
  });
});

describe("docs/255：devops ENV_GAP 读范围与安装工具", () => {
  it("can list the workspace root and read tests/ without opening src/ as a write path", () => {
    const devops = new AgentRegistry().get("devops-agent");
    expect(devops.permissions.readWorkspaceRoot).toBe(true);
    expect(devops.permissions.readPaths).toEqual(
      expect.arrayContaining(["tests", "test", "__tests__", "playwright.config.ts", "package.json"])
    );
    expect(devops.permissions.writePaths).not.toContain("tests");
    expect(devops.permissions.writeTestFiles).toBeUndefined();
    expect(devops.permissions.tools).toContain("run_command");
    expect(devops.permissions.readPaths).not.toContain(".");
  });
});

describe("docs/261：正确任务类型可写 .prettierignore 与 tests/reports/**", () => {
  it("lets BUILD write tests/reports but not test specs, and TEST write .prettierignore plus reports", () => {
    const devops = new AgentRegistry().get("devops-agent");
    const qa = new AgentRegistry().get("qa-agent");
    expect(devops.permissions.writePaths).toContain("tests/reports");
    expect(devops.permissions.writePaths).not.toContain("tests");
    expect(devops.permissions.writeTestFiles).toBeUndefined();
    expect(writePathsForTaskType("BUILD")).toEqual(expect.arrayContaining(["tests/reports"]));
    expect(qa.permissions.writePaths).toEqual(
      expect.arrayContaining(["test", "tests", "__tests__", ".prettierignore"])
    );
    expect(qa.permissions.writeProjectManifests).toBeUndefined();
  });
});

describe("docs/264：Playwright 平台契约写入指令", () => {
  it("tells coding and devops agents not to bump Playwright or install browsers in the sandbox", () => {
    const registry = new AgentRegistry();
    for (const name of ["frontend-agent", "qa-agent", "devops-agent", "backend-agent"]) {
      const instructions = registry.get(name).systemInstructions;
      expect(instructions, name).toMatch(/1\.64\.1/);
      expect(instructions, name).toMatch(/platform contract/i);
      expect(instructions, name).not.toMatch(/install browsers via shell/);
    }
  });
});

/**
 * `docs/266`：注册表展示列表跟随当前能力面；全量目录与实现保留。
 */
describe("docs/266：注册表展示跟随 capability profile", () => {
  it("list() 仍是含 BACKEND / DATABASE 的全量目录", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    expect(registry.list()).toHaveLength(7);
    expect(registry.list().map((agent) => agent.name)).toEqual(
      expect.arrayContaining(["backend-agent", "database-agent"])
    );
  });

  it("frontend-vue 下 listEnabled() 不含 BACKEND / DATABASE", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    expect(registry.listEnabled().map((agent) => agent.name)).toEqual([
      "planner-agent",
      "frontend-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
  });

  it("backend-node 下 listEnabled() 含全部七个 agent", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, BACKEND_NODE_PROFILE);
    expect(registry.listEnabled().map((agent) => agent.name)).toEqual([
      "planner-agent",
      "frontend-agent",
      "backend-agent",
      "database-agent",
      "qa-agent",
      "reviewer-agent",
      "devops-agent"
    ]);
  });

  it("frontend-vue 下派发仍拒绝未启用的 BACKEND / DATABASE", () => {
    const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, FRONTEND_VUE_PROFILE);
    expect(registry.resolveTask(task("FRONTEND")).name).toBe("frontend-agent");
    expect(() => registry.resolveTask(task("BACKEND"))).toThrow(/not enabled/);
    expect(() => registry.resolveTask(task("DATABASE"))).toThrow(/not enabled/);
  });
});
