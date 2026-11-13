import {
  AgentCapability,
  AgentDefinitionView,
  AgentType,
  DEFAULT_CAPABILITY_PROFILE,
  isUsableTargetTaskType,
  SpecificationType,
  Task,
  TaskType,
  type CapabilityProfile
} from "@ai-se/shared";
import { SUBMIT_RESULT_TOOL_NAME } from "./submitResult";
import { readFailureClassFromTask, withInjectedSkills } from "./skillResolver";

export interface AgentPermissions {
  tools: string[];
  readPaths: string[];
  writePaths: string[];
  /**
   * PL-M5（`docs/158` §3）：额外放行**任意位置的测试文件**（按 `@ai-se/shared` 的
   * `isTestFilePath` 判定）。仅对以写测试为职责的 agent 置真——缺省即现状。
   * 只增加这一条语义化条件，**不放宽 `writePaths` 数组本身**。
   */
  writeTestFiles?: boolean;
  /**
   * PL-M10（`docs/168`）：额外放行**仓库根的工程清单/配置文件**（按 `@ai-se/shared` 的
   * `isProjectManifestPath` 判定）。`writePaths` 是相对仓库根的前缀白名单，而仓库根是所有
   * 前缀的父目录——任何前缀都表达不了「根本身」，故工程骨架任务写不出 `package.json`。
   * 仅对以产出工程骨架为职责的 agent 置真；缺省即现状，且**不放宽 `writePaths` 数组本身**。
   */
  writeProjectManifests?: boolean;
  /**
   * PL-M11（`docs/170`）：额外放行**仓库根的交付物**（按 `@ai-se/shared` 的
   * `isRootDeliveryArtifactPath` 判定：`Dockerfile` / `docker-compose*.yml` / `.dockerignore` /
   * `README.md`）。与 `writeProjectManifests` 同形且同因——前缀白名单表达不了「根本身」——
   * 但集合与语义不同（工程清单/配置 vs 交付物），故并列而非合并。
   *
   * 缺省即现状，且**不放宽 `writePaths` 数组本身**。
   */
  writeRootDeliveryArtifacts?: boolean;
  /**
   * docs/255：允许 list/read 仓库根路径本身（`"."` / `""`），但不把 `"."` 写入
   * `readPaths`——`isPathUnderPrefixes` 会把 `"."` 当成「一切路径」的前缀。
   * 用于 ENV_GAP BUILD 查看根目录（package.json、playwright.config.*）而不打开 src/。
   */
  readWorkspaceRoot?: boolean;
}

export interface AgentDefinition {
  name: string;
  type: AgentType;
  description: string;
  capabilities: AgentCapability[];
  tools: string[];
  systemInstructions: string;
  permissions: AgentPermissions;
  specificationTypes: SpecificationType[];
}

const READ_TOOLS = ["read_file", "list_directory", "search_code", "git_status", "git_diff"];
const CHECK_TOOLS = ["run_unit_test", "run_lint", "run_build"];
const WRITE_TOOLS = ["write_file", "edit_file"];

/** T2：控制类工具（submit_result）对全部职业 Agent 开放——无外部副作用，执行经 Tool Runtime 校验/审计。 */
const CONTROL_TOOLS = [SUBMIT_RESULT_TOOL_NAME];

/**
 * N-14（C）（`docs/189` §4.2）：dev 类任务的测试文件约束必须**写进指令**，不能只靠门。
 *
 * 门是事后判死——agent 事先不知道这条约束，就会在重试里重做同一件事（L1-M4l 那 7 次死亡里，
 * 每次重试都在不知道「我上次因为改了测试文件被判死」的情况下重做）。与 N-17（把失败理由回灌）
 * 配套：一个让它事先知道，一个让它事后看得见。
 *
 * 措辞与门的判据同口径：**加**测试随意，**改弱既有断言**才拦（`weakenedProtectedFiles`）。
 */
const TEST_FILE_CONSTRAINT =
  " You may add new test cases or new test files. You may also edit existing test assembly/setup/" +
  "fixture harness code (createPinia(), router plugins, mount wrappers, provide/inject stubs) when " +
  "failure evidence shows fixture/setup errors (e.g. getActivePinia, No active Pinia, missing " +
  "plugin). Never weaken, relax, or delete an existing assertion to make a test pass — anti-tamper " +
  "still blocks assertion weakening. If an assertion contradicts the AC, report SPEC_CONFLICT and " +
  "do not silently weaken it." +
  // N-40（l1-m4v run 1 第二次失败）：验证门按任务自己的 acKeys 跑
  // `node --test --test-name-pattern '\[AC-04\]|…'`，零匹配**不算通过证据**（N-27）。
  // agent 写了 6 个测试但都没带编号 ⇒ 过滤后 `1..0` ⇒ 任务判失败。测试名因此不是文风问题，
  // 是验证契约的一部分。
  " Name every test you add with the acceptance-criterion number it covers, exactly as the task " +
  "lists it (e.g. `test('[AC-04] ...', ...)`): verification selects tests by that marker, and a " +
  "test without one is not counted as evidence.";

/**
 * N-19（`docs/191` §3）：被拒的交付物写入必须**如实报告**，不能靠改道蒙混过去。
 *
 * 平台侧分不出「任务声明的交付物」与「agent 顺手写的东西」——`TaskPlanItemSchema` 是 `.strict()`，
 * 交付物路径只存在于自由文本 `description` 里，没有结构化字段；而写范围审计是 **diff 式**的，
 * 被拒的写入不产生 diff。⇒ 唯一能阻止「交付物没写成、任务却判成功」的杠杆在 agent 侧。
 * 实测（L1-M4m run 2）：`slice-1-task-8-REPLAN-1` 写 `scripts/verify-contract.mjs` 被拒后，
 * 把产物改道写进 `infrastructure/`，**结果里一个字没提**。
 *
 * 措辞刻意**只要求如实说明、不要求判失败**：强制失败会把「改道后确实完成了工作」的任务一并
 * 打成 FAILED，而 replan 目前并不收敛（`docs/189` §9.3）——那只会让链更早断。
 */
const WRITE_DENIAL_CONSTRAINT =
  " If the write policy rejects a path that your task description names as a deliverable, say so " +
  "explicitly in your result (which path, and what you did instead). Never silently write the " +
  "deliverable somewhere else and report success without mentioning it.";

/**
 * N-22（`docs/199`）：`REPLAN` 要带上「应当创建哪一类任务」。
 *
 * 此前**只有 qa-agent** 被要求填 `fixTaskType`（那句话原本只写在 qa 的指令里），
 * 于是其余 agent 报 `REPLAN` 时该字段为空 ⇒ `WorkflowEngine.debugTargetType` 的第 1 步读不到值，
 * 只能落到第 3 步按源任务类型重试。实测 L1-M4n run 2：`T7-REPLAN-1`（backend-agent）报 `REPLAN`
 * 并在 `recommendations` 里**用自由文本**要求「Route a TEST-type task …」，平台给了它**又一个 BACKEND**
 * ——同一堵墙撞到预算耗尽。全库 36 次 `REPLAN` 里 **19 次来自 backend-agent**（从未被要求填该字段）。
 *
 * 这不是「多加一句提示」，是**让第 1 步可达**；判据 25g 守住「没给值时行为不变」。
 */
const REPLAN_CONSTRAINT =
  " When you report REPLAN, also set fixTaskType to the kind of task that should be created instead " +
  "(for example TEST when the change belongs in test files, BACKEND when it belongs in backend " +
  "code). Report REPLAN only when you can name that type; otherwise report FAILED.";

/**
 * docs/264：Playwright / Chromium 是平台契约。产品必须钉死 1.64.1（镜像已预置 chromium-1248），
 * 不得当普通依赖升级，也不得在无网沙箱里执行 playwright install。
 */
const PLAYWRIGHT_CONTRACT_CONSTRAINT =
  " Playwright and @playwright/test are a platform contract (docs/264): pin both exactly to 1.64.1, " +
  "which matches Chromium revision 1248 baked in the sandbox image ai-se-sandbox:22-pnpm9. Never bump " +
  "Playwright as an ordinary dependency upgrade, never write a newer range, and never run " +
  "`playwright install` or `npm run test:e2e:install` in the sandbox (no network). If the product is " +
  "off-pin, realign to 1.64.1 or report ENV_GAP as a contract mismatch — do not open a BUILD install loop.";

/**
 * `docs/235` §6.9：**测试必须按 AC 断言，不得把缺陷固化成"预期失败"。**
 *
 * 实测（F1 run 1 的 slice-4，两条独立的死锁，最终整片 FAILED）：
 * - `T-03` 写了 `tests/ac18-delete.test.ts`，其中一条断言把**列表顺序写错**（AC 要求保持
 *   mock 顺序）。后面的修复任务要让它绿，只能去改这个测试 —— 而改既有断言行被防篡改门拦下
 *   （`weakened: ["tests/ac18-delete.test.ts"]`），REPLAN 耗尽。
 * - `T-05-REPLAN-1` 更直接：测试里用 `test.fails(...)` 把当前缺陷钉成"预期失败"，注释还写着
 *   "修好后把 test.fails 改回 test"。修复任务落地实现后，那条 `test.fails` 反而变红，
 *   而改它同样撞门。
 *
 * 两个案例的共同点：**测试先行**变成了**把错误的契约写进受保护文件**。所以这条约束落在写测试的
 * agent 身上，而不是靠门去纠正——门只能拒绝，不能告诉你怎么写才是对的。
 */
const TEST_CONTRACT_CONSTRAINT =
  " Write every assertion against the acceptance criterion's own words: if the AC fixes an order, " +
  "a count or a selector, assert exactly that. Never use test.fails, test.skip, describe.skip or an " +
  "empty test body to record a defect as expected, and never mark your own placeholder as pending - " +
  "a later task cannot repair it without editing this file, which the anti-tamper rule forbids. " +
  "A test that must change for the implementation to pass is a wrong test, not a strict one.";

/**
 * N-72（`docs/232` §10）：**红灯是本阶段的期望结果，不是任务失败。**
 *
 * 第十三轮里两个 TEST 任务（slice-4 `T4`、slice-5 `T1`）写完红灯用例、报出它们失败，然后把自己
 * 提交成 `FAILED`——平台照单全收，验证门根本没跑（记录里连 `verification` 都没有），每触发一次
 * 就多一轮 REPLAN。qa-agent 的职责原本就写着「show them failing first」，但没有一句告诉它
 * 「这算完成」。这条把 submit 语义补齐：跑红 → 提交 `SUCCESS` + 红灯证据。
 */
const RED_TEST_OUTCOME_CONSTRAINT =
  " A red run is the expected outcome of this task, not a failure of it: once the AC-numbered tests " +
  "exist and you have shown them failing for the right reason, submit status SUCCESS and attach that " +
  "failing run as TEST_RESULT evidence. Submit FAILED only when the acceptance criteria cannot be met " +
  "at all - never submit FAILED merely because the tests you were asked to write are red.";

function definition(value: Omit<AgentDefinition, "tools"> & { tools?: string[] }): AgentDefinition {
  const tools = value.tools ?? value.permissions.tools;
  return {
    ...value,
    tools: [...tools, ...CONTROL_TOOLS],
    permissions: { ...value.permissions, tools: [...value.permissions.tools, ...CONTROL_TOOLS] }
  };
}

export const PROFESSIONAL_AGENT_DEFINITIONS: AgentDefinition[] = [
  definition({
    name: "planner-agent",
    type: "PLANNER",
    description: "Plans one engineering task without scheduling other tasks or agents.",
    capabilities: ["PLAN"],
    permissions: { tools: READ_TOOLS, readPaths: ["."], writePaths: [] },
    specificationTypes: ["REQUIREMENT_ANALYSIS", "FUNCTIONAL", "TECHNICAL", "ARCHITECTURE"],
    systemInstructions: "Plan the assigned task only. Do not modify files or schedule agents."
  }),
  definition({
    name: "frontend-agent",
    type: "FRONTEND",
    description: "Implements frontend code and tests from UI and API specifications.",
    capabilities: ["FRONTEND_CODE", "TEST"],
    permissions: {
      tools: [...READ_TOOLS, ...WRITE_TOOLS, ...CHECK_TOOLS],
      readPaths: [
        "apps/web",
        "web",
        "frontend",
        "packages/shared",
        "src",
        "test",
        "tests",
        "__tests__",
        "package.json"
      ],
      writePaths: ["apps/web", "web", "frontend", "src"],
      writeProjectManifests: true,
      writeRootDeliveryArtifacts: true,
      // N-38 / AFC fixture：`writeTestFiles` 放行任意测试文件写入；readPaths 含
      // test/tests/__tests__，否则装配测（如 tests/assembly/*.spec.ts）读不到、夹具修不了。
      // 断言改弱仍由 anti-tamper（weakenedProtectedFiles）硬拦。
      writeTestFiles: true
    },
    specificationTypes: ["FUNCTIONAL", "API", "UI"],
    systemInstructions:
      "Change only frontend files. Verify loading, error, empty, and success states." +
      TEST_FILE_CONSTRAINT +
      WRITE_DENIAL_CONSTRAINT +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  }),
  definition({
    name: "backend-agent",
    type: "BACKEND",
    description: "Implements validated backend APIs and integration tests.",
    capabilities: ["BACKEND_CODE", "TEST"],
    permissions: {
      tools: [...READ_TOOLS, ...WRITE_TOOLS, ...CHECK_TOOLS],
      readPaths: [
        "apps/server",
        "server",
        "backend",
        "packages/shared",
        "src",
        "test",
        "tests",
        "__tests__",
        "package.json"
      ],
      writePaths: ["apps/server", "server", "backend", "src"],
      writeProjectManifests: true,
      writeRootDeliveryArtifacts: true,
      // 同上：读范围含 `test`、写范围不含，而验证对 BACKEND 任务要求 test 检查通过。
      writeTestFiles: true
    },
    specificationTypes: ["FUNCTIONAL", "TECHNICAL", "ARCHITECTURE", "API", "DATABASE"],
    systemInstructions:
      "Change only backend files. Validate trust-boundary input and preserve API contracts." +
      TEST_FILE_CONSTRAINT +
      WRITE_DENIAL_CONSTRAINT +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  }),
  definition({
    name: "database-agent",
    type: "DATABASE",
    description: "Implements schema, migrations, and database tests.",
    capabilities: ["DATABASE_SCHEMA", "TEST"],
    permissions: {
      tools: [...READ_TOOLS, ...WRITE_TOOLS, ...CHECK_TOOLS],
      readPaths: [
        "packages/database",
        "database",
        "migrations",
        "src",
        "test",
        "tests",
        "__tests__",
        "package.json"
      ],
      writePaths: ["packages/database", "database", "migrations", "src"],
      writeProjectManifests: true,
      writeRootDeliveryArtifacts: true,
      // 同上：DATABASE 任务的候选检查回退到 build + test（taskVerifierRules N-1b）。
      writeTestFiles: true
    },
    specificationTypes: ["TECHNICAL", "ARCHITECTURE", "DATABASE"],
    systemInstructions:
      "Change only schema and migration files for this project; you may add database tests." +
      TEST_FILE_CONSTRAINT +
      WRITE_DENIAL_CONSTRAINT +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  }),
  definition({
    name: "qa-agent",
    type: "QA",
    description:
      "Writes AC-numbered tests first, runs them to show the red light, and reports failures.",
    capabilities: ["TEST"],
    permissions: {
      tools: [...READ_TOOLS, ...CHECK_TOOLS, ...WRITE_TOOLS],
      readPaths: ["."],
      writePaths: ["test", "tests", "__tests__", ".prettierignore"],
      // PL-M5：测试可能落在项目自己的测试目录里（本仓库规范 = `src/__tests__/`），
      // 而白名单是相对仓库根的前缀匹配，覆盖不到。故按「是不是测试文件」放行。
      writeTestFiles: true
    },
    specificationTypes: ["FUNCTIONAL", "TECHNICAL", "API", "DATABASE", "UI"],
    systemInstructions:
      "Write tests named with their AC numbers (e.g. [AC-01]) before the implementation exists and show them failing first; never modify product code. Run tests and report exact failures." +
      RED_TEST_OUTCOME_CONSTRAINT +
      TEST_CONTRACT_CONSTRAINT +
      WRITE_DENIAL_CONSTRAINT +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  }),
  definition({
    name: "reviewer-agent",
    type: "REVIEWER",
    description: "Performs a read-only requirement, architecture, security, type, and test review.",
    capabilities: ["REVIEW", "TEST"],
    permissions: { tools: [...READ_TOOLS, ...CHECK_TOOLS], readPaths: ["."], writePaths: [] },
    specificationTypes: [
      "REQUIREMENT_ANALYSIS",
      "FUNCTIONAL",
      "TECHNICAL",
      "ARCHITECTURE",
      "API",
      "DATABASE",
      "UI"
    ],
    systemInstructions:
      "Never modify files. Review requirement, specification, git diff, security, type safety, and tests (check that every Must acceptance criterion has an AC-numbered test)." +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  }),
  definition({
    name: "devops-agent",
    type: "DEVOPS",
    description: "Inspects and updates build or local Docker configuration without deployment.",
    capabilities: ["BUILD"],
    permissions: {
      tools: [...READ_TOOLS, ...WRITE_TOOLS, "run_command", "run_lint", "run_build"],
      // N-18（`docs/190`）：`scripts/` / `bin/` / `.github/` 是构建与 CI 的属地，原先只在
      // `apps/server` 的审计表（`DEVOPS_PATH`）里被当作 devops 的范围，强制侧**一格都没有**
      // ——审计说合法、写层说非法，同一族漂移的第五例（前四例见 PL-M5 / PL-M10 / PL-M11 / PL-M12）。
      // 实测代价：计划点名的 `scripts/verify-contract.mjs` 无人可写，两次复现。
      // docs/255：可读仓库根（readWorkspaceRoot）与测试/Playwright 配置，便于 ENV_GAP
      // 安装；不把 "." 放进 readPaths（那会打开 src/）。测试文件仍不可写（E2E 非阻断由平台标记）。
      readPaths: [
        "infrastructure",
        "scripts",
        "bin",
        ".github",
        "docs",
        "compose.yaml",
        "Dockerfile",
        "Makefile",
        "package.json",
        "README.md",
        "tests",
        "test",
        "__tests__",
        "e2e",
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mjs",
        "playwright.config.cjs"
      ],
      readWorkspaceRoot: true,
      writePaths: [
        "infrastructure",
        "scripts",
        "bin",
        ".github",
        "docs",
        "compose.yaml",
        "Dockerfile",
        "Makefile",
        // docs/261：BUILD 可更新测试报告，但不可写 tests/** 规格（writeTestFiles 仍关）。
        "tests/reports"
      ],
      writeProjectManifests: true,
      writeRootDeliveryArtifacts: true
    },
    specificationTypes: ["TECHNICAL", "ARCHITECTURE"],
    systemInstructions:
      "Work on local build/Docker files and documentation deliverables (README.md, docs/** such as " +
      "docs/delivery-report.md). Satisfy README/docs assertion literals without weakening tests. " +
      "On ENV_GAP (Playwright/Chromium missing or off-pin): do not run `npx playwright install` or " +
      "`npm run test:e2e:install` in the sandbox. Realign the product to the platform Playwright pin " +
      "1.64.1 (Chromium 1248 baked in the image) or report a contract mismatch with ENV_GAP evidence. " +
      "Do not rewrite product FRONTEND code, weaken tests, or open another BUILD install loop. " +
      "Do not deploy or access production." +
      WRITE_DENIAL_CONSTRAINT +
      REPLAN_CONSTRAINT +
      PLAYWRIGHT_CONTRACT_CONSTRAINT
  })
];

const TASK_AGENT_TYPES: Partial<Record<TaskType, AgentType>> = {
  ANALYSIS: "PLANNER",
  DESIGN: "PLANNER",
  DATABASE: "DATABASE",
  BACKEND: "BACKEND",
  FRONTEND: "FRONTEND",
  TEST: "QA",
  REVIEW: "REVIEWER",
  BUILD: "DEVOPS"
};

/**
 * PL-C3（`docs/161` Known Issue 4）：消费侧同样要做成员判定。PL-M3 只让**生产者**不再写入不可用值
 * （`WorkflowEngine.debugTargetType`），这里原先仍把 `input.targetTaskType` 直接 `as TaskType`——
 * 宽松断言会让 `TASK_AGENT_TYPES` 查空，最终抛出一条**误报 `task type DEBUG`** 的错误。
 */
function debugTarget(task: Task): TaskType | undefined {
  const value = task.input.targetTaskType;
  return isUsableTargetTaskType(value) ? value : undefined;
}

/**
 * PL-M12（`docs/170` §4 裁定 7）：**某任务类型可写的路径前缀**——强制侧的**唯一**来源。
 *
 * `apps/server` 的写范围审计原先手抄了一张正则表（`SOURCE_PATH`）表达同一件事，两张表已经漂移：
 * `SOURCE_PATH` 描述的是 `app/`（单数）、`pages/`、`lib/`、`components/` 这类本仓库并不存在的
 * 布局，于是对真实的 `apps/`、`packages/` 一律误报越界（L1-M4c run 2 实测 `violations:["apps/"]`）。
 * 现在审计侧从本函数取前缀，不再有第二份定义。
 *
 * 返回 `undefined` 表示该任务类型**没有承接的 agent**（如 `DEPLOY` 走交付链、`DEBUG`/`MONITOR`/
 * `INCIDENT` 是运行期类型），调用方需自行决定退路。
 */
export function writePathsForTaskType(taskType: TaskType): string[] | undefined {
  const agentType = TASK_AGENT_TYPES[taskType];
  if (!agentType) return undefined;
  const agent = PROFESSIONAL_AGENT_DEFINITIONS.find((entry) => entry.type === agentType);
  return agent ? [...agent.permissions.writePaths] : undefined;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  /**
   * `docs/235` §6.5：profile 由**构造**决定（组合根注入一次），而不是每次调用再传一遍——
   * 这样"注册表属于哪个能力面"在装配处就看得见，也不会漏传。
   * 缺省 `backend-node`（启用全部七个 agent）⇒ 既有调用方零改动、零行为变化。
   */
  constructor(
    definitions: AgentDefinition[] = PROFESSIONAL_AGENT_DEFINITIONS,
    private readonly profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
  ) {
    for (const agent of definitions) this.register(agent);
  }

  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.name)) throw new Error(`Agent already registered: ${agent.name}`);
    this.agents.set(agent.name, agent);
  }

  /**
   * 全量目录：含当前 profile 未启用的 agent。派发仍走 `resolveTask` 的 fail-closed。
   * 注册表页面 / `GET /agents` 使用 `listEnabled()`。
   */
  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /**
   * `docs/266`：按当前（或指定）capability profile 过滤后的展示列表。
   * 与派发同一份 `profile.agents`；未启用的定义与实现仍保留在目录里，只是不出现在注册表 UI。
   */
  listEnabled(profile: CapabilityProfile = this.profile): AgentDefinition[] {
    return this.list().filter((agent) => profile.agents.includes(agent.type));
  }

  get(name: string): AgentDefinition {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`No registered agent named ${name}`);
    return agent;
  }

  resolveByCapability(capability: AgentCapability): AgentDefinition {
    const matches = this.list().filter((agent) => agent.capabilities.includes(capability));
    if (matches.length !== 1) {
      throw new Error(`Capability ${capability} resolves to ${matches.length} agents`);
    }
    return matches[0];
  }

  /**
   * `docs/235` §5.2 层 2：**注册表保留全部定义，但只把 profile 启用的 agent 派出去**。
   * 不属于任何启用 profile 的类型一律 fail-closed——否则「保留但不可达」会退化成「保留且随时可达」。
   * 缺省 profile 启用全部七个 agent，因此对既有调用方**零行为变化**。
   */
  resolveTask(task: Task, profile: CapabilityProfile = this.profile): AgentDefinition {
    if (task.assignedAgent) return this.assertEnabled(this.get(task.assignedAgent), profile);
    const taskType = task.type === "DEBUG" ? debugTarget(task) : task.type;
    const agentType = taskType ? TASK_AGENT_TYPES[taskType] : undefined;
    const agent = this.list().find((entry) => entry.type === agentType);
    if (!agent) {
      // PL-C3：DEBUG 任务派不出去时，真实原因通常是**目标类型缺失/不可用，或没有承接的 agent**
      // （例如目标指向 `DEPLOY` 这类交付链类型）——不要把它误报成「task type DEBUG 没有 agent」。
      // 目标值来自任务输入 / agent 输出，**不回显**（`AGENTS.md` §10；与 PL-M3 的回退事件同一口径）。
      throw new Error(
        task.type === "DEBUG"
          ? "No professional agent for DEBUG task: its target task type is missing or unusable"
          : `No professional agent for task type ${task.type}`
      );
    }
    const enabled = this.assertEnabled(agent, profile);
    // docs/252：按任务类型 / 失败类 / 能力面声明式注入 skills（模型不自选）。
    return withInjectedSkills(enabled, {
      taskType: task.type,
      failureClass: readFailureClassFromTask(task),
      capabilityProfile: profile.id
    });
  }

  private assertEnabled(agent: AgentDefinition, profile: CapabilityProfile): AgentDefinition {
    if (!profile.agents.includes(agent.type)) {
      throw new Error(`Agent ${agent.type} is not enabled by capability profile ${profile.id}`);
    }
    return agent;
  }

  toView(agent: AgentDefinition): AgentDefinitionView {
    return {
      name: agent.name,
      type: agent.type,
      description: agent.description,
      capabilities: agent.capabilities,
      tools: agent.tools,
      permissions: {
        tools: agent.permissions.tools,
        pathPrefixes: [
          ...new Set([...agent.permissions.readPaths, ...agent.permissions.writePaths])
        ],
        readOnly: agent.permissions.writePaths.length === 0
      },
      status: "available"
    };
  }
}
