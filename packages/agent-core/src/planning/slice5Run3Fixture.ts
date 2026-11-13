import { AcceptanceCriterion } from "@ai-se/shared";
import { PlanningSliceScope } from "./PlanningState";
import { TestFirstTask } from "./validateTestFirstPlan";

/**
 * PL-M1（`docs/158` §3）回归夹具：E1 自治 L1 批次 run 3 的 **slice-5 真实计划快照**。
 *
 * 来源：2026-10-16 平台库实查（workflow run `e6c513e1-debe-416f-bc43-cce7a3bb48cd`，
 * `tasks` + `task_dependencies` + `requirement_acceptance_criteria`，
 * requirement `a30f30cc-64f5-4b31-9bbb-9b3d5bbaba53`）。任务编号/类型/acKeys/依赖边**均为库中实值**，
 * 未作示意填充——本夹具的价值正在于它是「计划器真的产出过、且三个既有校验器全部放行」的那份计划。
 *
 * 缺口（`docs/158` §1.4）：AC-24/25/26/29 只被 TEST（TASK-15）与 DEPLOY（TASK-17/18）引用，
 * AC-30 只被 TEST（TASK-16）与 BUILD（TASK-12）引用——**没有任何实现类任务**（BACKEND/FRONTEND/
 * DATABASE）覆盖这五条。而三条既有校验器对它零报错：
 * - `validateAcceptanceCoverage`：五条 AC 都被「某个」任务引用（不分类型）→ 通过；
 * - `validateMustAcTestCoverage`：五条 Must AC 都有 TEST 任务 → 通过；
 * - `validateTestFirstOrder`：四个实现任务都已传递依赖 TASK-14 → 无未满足的测试先行边。
 * 计划首轮通过率 100%、修复轮 0 轮（`packages/eval/results/l1-m4/run-3.json` 的 `planningMetrics`），
 * 与缺口完全吻合。后果链见 `docs/158` §1.4 末段。
 *
 * 任务标题未入库于本夹具——消费方只用 type / acKeys / dependencies。
 */

/** E1 全量 AC（30 条；acKey / text / priority / verification / smoke / frKeys 均为库中实值）。 */
export const slice5Run3Criteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-01",
    text: "健康端点 `/healthz`、`/health`、`/ready` 均 200 且 `status=ok`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-02",
    text: "新用户名注册 → 201，返回 `user.id`（UUID）与 `user.username`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-03",
    text: "重复用户名（完全相同）→ 409 `USERNAME_TAKEN`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-04",
    text: "注册后扫描 `DATA_DIR` 数据文件，不含测试用明文密码",
    priority: "Must",
    verification: "文件扫描",
    smoke: false,
    frKeys: ["FR-7"]
  },
  {
    acKey: "AC-05",
    text: "大小写冲突（已存在 `Alice`，再注册 `alice`）→ 409 `USERNAME_TAKEN`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-06",
    text: "并发注册同一用户名（≥5 并发）恰好一次成功、其余 409，不得出现 500",
    priority: "Must",
    verification: "并发 HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-07",
    text: "用户名非法（过短 / 含空格 / 非 ASCII / 超 32 位）→ 400 `VALIDATION_ERROR`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-08",
    text: "密码过短（<8 位）→ 400 `VALIDATION_ERROR`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-09",
    text: "正确凭证登录 → 200 且返回非空 token",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-2"]
  },
  {
    acKey: "AC-10",
    text: "密码错误 → 401 `INVALID_CREDENTIALS`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-2"]
  },
  {
    acKey: "AC-11",
    text: "无令牌访问任务接口 → 401 `UNAUTHORIZED`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-2"]
  },
  {
    acKey: "AC-12",
    text: "令牌被篡改（改一位）→ 401",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-2"]
  },
  {
    acKey: "AC-13",
    text: "令牌被截断 → 401",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-2"]
  },
  {
    acKey: "AC-14",
    text: "正常创建 → 201，`done=false`、`dueDate` 按提交回显",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-3"]
  },
  {
    acKey: "AC-15",
    text: "标题恰好 100 码点通过；101 码点 → 400 `TITLE_INVALID`",
    priority: "Must",
    verification: "边界断言",
    smoke: false,
    frKeys: ["FR-3"]
  },
  {
    acKey: "AC-16",
    text: "首尾空格被去除后保存；全空白标题 → 400 `TITLE_INVALID`",
    priority: "Must",
    verification: "边界断言",
    smoke: false,
    frKeys: ["FR-3"]
  },
  {
    acKey: "AC-17",
    text: "含中文与 emoji 的标题原样返回",
    priority: "Must",
    verification: "边界断言",
    smoke: false,
    frKeys: ["FR-3"]
  },
  {
    acKey: "AC-18",
    text: "非法 `dueDate`（`2026-02-30`、`2026-13-01`、格式错误）→ 400 `DATE_INVALID`",
    priority: "Must",
    verification: "边界断言",
    smoke: false,
    frKeys: ["FR-3"]
  },
  {
    acKey: "AC-19",
    text: "PATCH 含未知字段 → 400 `UNKNOWN_FIELD`（不得静默忽略）",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-5"]
  },
  {
    acKey: "AC-20",
    text: "PATCH `title`/`done` 生效并 200 回显；再次 GET 已更新",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-5"]
  },
  {
    acKey: "AC-21",
    text: "首页返回 200 HTML 且包含 4 个约定 `data-testid`",
    priority: "Must",
    verification: "HTML 断言",
    smoke: true,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-22",
    text: "（可选增强）无头浏览器渲染检查",
    priority: "Should",
    verification: "浏览器（可选）",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-23",
    text: "列表仅返回本人任务；`q` 过滤正确；恶意字符 `q` 不产生 5xx",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: true,
    frKeys: ["FR-4"]
  },
  {
    acKey: "AC-24",
    text: "`docker build` 成功；`docker run` 后健康端点可达",
    priority: "Must",
    verification: "容器运行",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-25",
    text: "容器重启后数据保留（重启前后同一用户可登录、任务仍在）",
    priority: "Must",
    verification: "容器运行",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-26",
    text: "容器以非 root 用户运行",
    priority: "Must",
    verification: "容器检查",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-27",
    text: "用户 B 对用户 A 的任务 GET/PATCH/DELETE → 404 `NOT_FOUND`，且任务未被改动",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-6"]
  },
  {
    acKey: "AC-28",
    text: "DELETE 本人任务 → 204 且列表消失；重复删除 → 404 `NOT_FOUND`",
    priority: "Must",
    verification: "HTTP 断言",
    smoke: false,
    frKeys: ["FR-5"]
  },
  {
    acKey: "AC-29",
    text: "容器日志不含明文密码/密钥",
    priority: "Must",
    verification: "日志扫描",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-30",
    text: "README 命令可执行；`pnpm test` 全绿；除 Should（AC-22）与 AC-30 自身外，每条 Must AC 至少一个名称含对应编号的测试（部署类 AC-24–26、29 以静态契约测试覆盖）",
    priority: "Must",
    verification: "命令执行 + 测试名解析",
    smoke: false,
    frKeys: ["FR-9"]
  }
];

/** slice-5 = 最终切片（`slice_order` 5，E1 五个切片的最后一个）→ `isFinalSlice: true`。 */
export const slice5Run3SliceScope: PlanningSliceScope = {
  key: "slice-5-mutate-isolation",
  title: "Mutate and isolation",
  goal: "任务变更与数据隔离：PATCH/DELETE 语义、未知字段拒绝、跨用户越权一律 404。",
  frKeys: ["FR-5", "FR-6"]
};

/** 库中实值：`tasks` 的 task_key / type / input.acKeys，与 `task_dependencies` 的 23 条边。 */
export const slice5Run3Tasks: TestFirstTask[] = [
  { id: "TASK-01", type: "ANALYSIS", dependencies: [] },
  { id: "TASK-02", type: "DESIGN", dependencies: ["TASK-01"] },
  { id: "TASK-03", type: "TEST", dependencies: ["TASK-02"] },
  {
    id: "TASK-07",
    type: "BACKEND",
    acKeys: ["AC-20", "AC-27", "AC-28"],
    dependencies: ["TASK-08", "TASK-14"]
  },
  { id: "TASK-08", type: "BACKEND", acKeys: ["AC-27"], dependencies: ["TASK-02", "TASK-14"] },
  {
    id: "TASK-09",
    type: "BACKEND",
    acKeys: ["AC-19", "AC-20", "AC-27"],
    dependencies: ["TASK-08", "TASK-14"]
  },
  { id: "TASK-10", type: "BACKEND", acKeys: ["AC-27", "AC-28"], dependencies: ["TASK-08", "TASK-14"] },
  {
    id: "TASK-11",
    type: "REVIEW",
    dependencies: ["TASK-07", "TASK-08", "TASK-09", "TASK-10"]
  },
  { id: "TASK-12", type: "BUILD", acKeys: ["AC-30"], dependencies: ["TASK-11", "TASK-15", "TASK-16"] },
  {
    id: "TASK-14",
    type: "TEST",
    acKeys: ["AC-19", "AC-20", "AC-27", "AC-28"],
    dependencies: ["TASK-03"]
  },
  {
    id: "TASK-15",
    type: "TEST",
    acKeys: ["AC-24", "AC-25", "AC-26", "AC-29"],
    dependencies: ["TASK-03"]
  },
  { id: "TASK-16", type: "TEST", acKeys: ["AC-30"], dependencies: ["TASK-03"] },
  { id: "TASK-17", type: "DEPLOY", acKeys: ["AC-24"], dependencies: ["TASK-12"] },
  { id: "TASK-18", type: "DEPLOY", acKeys: ["AC-25", "AC-26", "AC-29"], dependencies: ["TASK-17"] },
  { id: "TASK-19", type: "DEPLOY", dependencies: ["TASK-18"] }
];

/** 修后新校验器对该计划应报出的错误（逐条、保序；`selectAcceptanceCriteriaForSlice` 的序）。 */
export const slice5Run3ImplementationCoverageErrors: string[] = [
  "Must acceptance criterion AC-24 has no implementation task coverage.",
  "Must acceptance criterion AC-25 has no implementation task coverage.",
  "Must acceptance criterion AC-26 has no implementation task coverage.",
  "Must acceptance criterion AC-29 has no implementation task coverage.",
  "Must acceptance criterion AC-30 has no implementation task coverage."
];
