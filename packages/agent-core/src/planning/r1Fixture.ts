import { AcceptanceCriterion, Requirement, TaskPlan, TaskPlanItem } from "@ai-se/shared";
import { PlanningSliceScope } from "./PlanningState";

/**
 * F1-3 回归夹具 R1：E1 slice-2 planningVersion 8 三次规划尝试（docs/128 §样本 R1）。
 *
 * 复刻依据（三轮计划原文未落库，按可得证据重建）：
 * - 错误原文：f0-inputs.md §②（三次 attempt 的完整错误列表，逐字）；
 * - 事件记录：E1 workflow_events（agent_run e2052ce0-…：taskCount 17→15→17、
 *   attempt 0/1 各 5 条测试先行错误、attempt 2 = T-022 DEPLOY + T-005/T-006 测试先行）；
 * - 任务编号/类型/AC 集：取自错误原文（T-008..T-012、T-005/T-006 的 shared ACs、
 *   T-016/T-019 测试任务、T-022 DEPLOY）；其余任务为示意填充（不含 acKeys，避免引入额外错误）。
 *
 * AC 范围：slice-2 frKeys=[FR-7, FR-1] → 涵盖 AC-01..AC-08（全 Must，DB 实查）；
 * AC-01..03/04 文本为 DB 实值，其余文本按 PRD 语义重建。
 */

export const r1Requirement: Requirement = {
  id: "a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53",
  projectId: "f72e8999-55a7-4cc5-bcde-0719a4d13c40",
  title: "E1",
  description: "任务板应用（分片重规划回放：slice-2 持久化存储与用户注册）",
  rawContent: "任务板应用：持久化存储与用户注册（slice-2 规划回放；AC 记录见库）。",
  status: "ANALYZED",
  version: 1,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T21:07:04.000Z"
};

export const r1SliceScope: PlanningSliceScope = {
  key: "slice-2",
  title: "持久化存储与用户注册",
  goal: "实现持久化存储与用户注册：users 表、注册端点、用户名唯一性、错误码与健康自检。",
  frKeys: ["FR-7", "FR-1"]
};

/** slice-2 范围内 AC（source=parsed，DB 实况：8 条全 Must）。 */
export const r1Criteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-01",
    text: "健康端点 /healthz、/health、/ready 均 200 且 status=ok",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-02",
    text: "新用户名注册 → 201，返回 user.id（UUID）与 user.username",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-03",
    text: "重复用户名（完全相同）→ 409 USERNAME_TAKEN",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-04",
    text: "配置文件与镜像内不出现明文密码/凭据（文件扫描）",
    priority: "Must",
    verification: "文件扫描",
    smoke: false,
    frKeys: ["FR-7"]
  },
  {
    acKey: "AC-05",
    text: "重复用户名（仅大小写不同）→ 409 USERNAME_TAKEN",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-06",
    text: "并发注册同名用户仅一个成功（201），其余 409",
    priority: "Must",
    verification: "并发 HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-07",
    text: "缺少 username 或非法字符 → 400 INVALID_USERNAME",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-08",
    text: "重启容器后已注册用户仍可查得（持久化）",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  }
];

interface TaskSeed {
  id: string;
  title: string;
  type: TaskPlanItem["type"];
  deps: string[];
  ac?: string[];
}

function taskOf(seed: TaskSeed, complexity = 2): TaskPlanItem {
  return {
    id: seed.id,
    title: seed.title,
    description: `${seed.title}：按切片范围实现并保持既有行为不变。`,
    type: seed.type,
    priority: "MEDIUM",
    dependencies: seed.deps,
    estimatedComplexity: complexity,
    acceptanceCriteria: [`${seed.title}：完成且可验证。`],
    ...(seed.ac ? { acKeys: seed.ac } : {}),
    sourceSpecTypes: ["FUNCTIONAL"]
  };
}

const ALL_AC = ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06", "AC-07", "AC-08"];

/** 公共骨架：T-001..T-007 + T-013..T-015（两个 attempt 共用的示意填充，均不带 acKeys）。 */
const SKELETON_HEAD: TaskSeed[] = [
  { id: "T-001", title: "确认存储与注册契约（数据形态、路由、错误码）", type: "DESIGN", deps: [] },
  { id: "T-002", title: "建 users 表迁移与唯一索引", type: "DATABASE", deps: ["T-001"] },
  { id: "T-003", title: "实现持久化存储层与连接管理", type: "BACKEND", deps: ["T-002"] },
  { id: "T-004", title: "定义注册端点请求/响应与错误契约", type: "DESIGN", deps: ["T-001"] },
  { id: "T-005", title: "梳理用户名唯一性与并发注册时序", type: "ANALYSIS", deps: ["T-004"] },
  { id: "T-006", title: "评审存储与注册设计一致性", type: "REVIEW", deps: ["T-004"] },
  { id: "T-007", title: "实现错误响应统一封装", type: "BACKEND", deps: ["T-003"] }
];

const SKELETON_REVIEW: TaskSeed[] = [
  { id: "T-013", title: "评审注册与存储实现", type: "REVIEW", deps: ["T-008", "T-011"] },
  { id: "T-014", title: "评审错误处理与边界", type: "REVIEW", deps: ["T-010"] },
  { id: "T-015", title: "静态检查与风险复核", type: "ANALYSIS", deps: ["T-013", "T-014"] }
];

/** 5 个被测试先行校验命中的实现任务（两轮同构，仅测试任务号变化）。 */
const IMPL_TASKS: TaskSeed[] = [
  {
    id: "T-008",
    title: "实现用户注册端点",
    type: "BACKEND",
    deps: ["T-003", "T-004"],
    ac: ["AC-02", "AC-04"]
  },
  {
    id: "T-009",
    title: "实现用户名唯一索引与冲突处理",
    type: "DATABASE",
    deps: ["T-002"],
    ac: ["AC-04"]
  },
  {
    id: "T-010",
    title: "实现注册参数校验与错误码",
    type: "BACKEND",
    deps: ["T-004"],
    ac: ["AC-07", "AC-08"]
  },
  {
    id: "T-011",
    title: "实现密码哈希与存储脱敏",
    type: "BACKEND",
    deps: ["T-003"],
    ac: ["AC-02", "AC-03", "AC-05", "AC-06", "AC-07", "AC-08"]
  },
  { id: "T-012", title: "实现健康检查与启动自检", type: "BACKEND", deps: ["T-001"], ac: ["AC-01"] }
];

/** attempt 0（taskCount 17）：测试任务 T-016；5 个实现任务未依赖测试任务。 */
export const r1Attempt0Plan: TaskPlan = {
  summary: "Replay fixture: E1 slice-2 attempt 0 (17 tasks; T-008..T-012 not depending on T-016).",
  tasks: [
    ...SKELETON_HEAD.map((seed) => taskOf(seed)),
    ...IMPL_TASKS.map((seed) => taskOf(seed, 3)),
    ...SKELETON_REVIEW.map((seed) => taskOf(seed)),
    taskOf(
      {
        id: "T-016",
        title: "为 AC-01..AC-08 编写验收测试（先红）",
        type: "TEST",
        deps: ["T-001"],
        ac: ALL_AC
      },
      3
    ),
    taskOf({ id: "T-017", title: "计划内交付物清点", type: "REVIEW", deps: ["T-015"] })
  ]
};

/** attempt 1（taskCount 15）：与 attempt 0 同构，仅测试任务号 T-016 → T-019。 */
export const r1Attempt1Plan: TaskPlan = {
  summary: "Replay fixture: E1 slice-2 attempt 1 (15 tasks; T-008..T-012 not depending on T-019).",
  tasks: [
    ...SKELETON_HEAD.map((seed) => taskOf(seed)),
    ...IMPL_TASKS.map((seed) => taskOf(seed, 3)),
    taskOf({ id: "T-013", title: "评审注册与存储实现", type: "REVIEW", deps: ["T-008", "T-011"] }),
    taskOf({ id: "T-014", title: "评审错误处理与边界", type: "REVIEW", deps: ["T-010"] }),
    taskOf(
      {
        id: "T-019",
        title: "为 AC-01..AC-08 编写验收测试（先红）",
        type: "TEST",
        deps: ["T-001"],
        ac: ALL_AC
      },
      3
    )
  ]
};

/** attempt 2（taskCount 17）：HEAD 去掉示意版 T-005/T-006 → 改为实现任务（AC-04）；
 *  T-008..T-012 已依赖 T-019；新增 T-022 DEPLOY（非最终切片，无交付块）。 */
export const r1Attempt2Plan: TaskPlan = {
  summary: "Replay fixture: E1 slice-2 attempt 2 (17 tasks; T-022 DEPLOY in non-final slice).",
  tasks: [
    ...SKELETON_HEAD.filter((seed) => seed.id !== "T-005" && seed.id !== "T-006").map((seed) =>
      taskOf(seed)
    ),
    taskOf(
      { id: "T-005", title: "实现持久化写入路径", type: "BACKEND", deps: ["T-002"], ac: ["AC-04"] },
      3
    ),
    taskOf(
      {
        id: "T-006",
        title: "实现用户名唯一性检查",
        type: "BACKEND",
        deps: ["T-003"],
        ac: ["AC-04"]
      },
      3
    ),
    ...IMPL_TASKS.map((seed) => taskOf({ ...seed, deps: [...seed.deps, "T-019"] }, 3)),
    ...SKELETON_REVIEW.map((seed) => taskOf(seed)),
    taskOf(
      {
        id: "T-019",
        title: "为 AC-01..AC-08 编写验收测试（先红）",
        type: "TEST",
        deps: ["T-001"],
        ac: ALL_AC
      },
      3
    ),
    taskOf({ id: "T-022", title: "部署用户注册服务到预发环境", type: "DEPLOY", deps: ["T-015"] })
  ]
};

/** attempt 2 的 LLM 修复产物（进入修复路径后）：去掉非最终切片的 T-022，测试先行边已由 LLM 补齐。 */
export const r1Attempt2FixedPlan: TaskPlan = {
  summary: "Replay fixture: E1 slice-2 attempt 2 after LLM repair (T-022 removed, edges fixed).",
  tasks: [
    ...SKELETON_HEAD.filter((seed) => seed.id !== "T-005" && seed.id !== "T-006").map((seed) =>
      taskOf(seed)
    ),
    taskOf(
      {
        id: "T-005",
        title: "实现持久化写入路径",
        type: "BACKEND",
        deps: ["T-002", "T-019"],
        ac: ["AC-04"]
      },
      3
    ),
    taskOf(
      {
        id: "T-006",
        title: "实现用户名唯一性检查",
        type: "BACKEND",
        deps: ["T-003", "T-019"],
        ac: ["AC-04"]
      },
      3
    ),
    ...IMPL_TASKS.map((seed) => taskOf({ ...seed, deps: [...seed.deps, "T-019"] }, 3)),
    ...SKELETON_REVIEW.map((seed) => taskOf(seed)),
    taskOf(
      {
        id: "T-019",
        title: "为 AC-01..AC-08 编写验收测试（先红）",
        type: "TEST",
        deps: ["T-001"],
        ac: ALL_AC
      },
      3
    )
  ]
};

/** E 期录像的测试先行错误原文（f0-inputs.md §②，逐字；用于 toEqual 断言）。 */
export const r1Attempt0Errors: string[] = [
  "Implementation task T-008 must depend on test task T-016 (shared ACs: AC-02, AC-04) to keep tests first.",
  "Implementation task T-009 must depend on test task T-016 (shared ACs: AC-04) to keep tests first.",
  "Implementation task T-010 must depend on test task T-016 (shared ACs: AC-07, AC-08) to keep tests first.",
  "Implementation task T-011 must depend on test task T-016 (shared ACs: AC-02, AC-03, AC-05, AC-06, AC-07, AC-08) to keep tests first.",
  "Implementation task T-012 must depend on test task T-016 (shared ACs: AC-01) to keep tests first."
];

export const r1Attempt1Errors: string[] = [
  "Implementation task T-008 must depend on test task T-019 (shared ACs: AC-02, AC-04) to keep tests first.",
  "Implementation task T-009 must depend on test task T-019 (shared ACs: AC-04) to keep tests first.",
  "Implementation task T-010 must depend on test task T-019 (shared ACs: AC-07, AC-08) to keep tests first.",
  "Implementation task T-011 must depend on test task T-019 (shared ACs: AC-02, AC-03, AC-05, AC-06, AC-07, AC-08) to keep tests first.",
  "Implementation task T-012 must depend on test task T-019 (shared ACs: AC-01) to keep tests first."
];

export const r1Attempt2TestFirstErrors: string[] = [
  "Implementation task T-005 must depend on test task T-019 (shared ACs: AC-04) to keep tests first.",
  "Implementation task T-006 must depend on test task T-019 (shared ACs: AC-04) to keep tests first."
];
