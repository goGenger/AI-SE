import {
  DEFAULT_CAPABILITY_PROFILE,
  profileConsumesApi,
  type CapabilityProfile
} from "@ai-se/shared";
import { withPlanningIntentContract } from "../../professional/skillResolver";

function baseLines(profile: CapabilityProfile): string[] {
  return [
    "Role: Software engineering planner.",
    "Input: validated requirement analysis and specifications.",
    "Output Schema: TaskPlan.",
    `Plannable task types: ${profile.taskTypes.plannable.join(", ")}. DEBUG, MONITOR and INCIDENT are runtime-only types created by the Workflow Engine — never plan them. DEPLOY tasks must carry a delivery block with action DEPLOY and an environment.`,
    "Constraints: produce a Task DAG with task IDs, dependencies, type, priority, complexity, acceptance criteria, and sourceSpecTypes.",
    'Script providers: when a task creates the project manifest and its npm scripts (package.json with start/test/lint/typecheck/build), declare them in that task\'s providesScripts (e.g. ["test","build"]). The test runner does not exist until that task has run, so the providing task must come FIRST: every TEST task must (transitively) depend on it, and no task may depend on a TEST task whose script it provides.',
    "Project skeleton: the task that declares the manifest scripts must also create, in that same task, the files those scripts run (scripts/*, the entry point, the test files) — never declare a script whose implementation a later task will add, because every task is verified on its own and a script pointing at a file that does not exist yet fails immediately. The skeleton task has no dependencies, and its acceptanceCriteria must state that each declared script really runs and exits 0. That task MUST be a work type (FRONTEND for a web UI, BACKEND for a service): BUILD, TEST, REVIEW and DEPLOY tasks carry delivery and check responsibilities and their write scope does not include the application tree, so a skeleton assigned to them cannot be completed."
  ];
}

/**
 * N-33（`docs/217`）：**交付块是平台契约，动作填错就等于做错事。**
 *
 * 旧文案只点名四个「任务名」（CI BUILD / staging DEPLOY / staging VERIFY / production DEPLOY），
 * **从未说过 `delivery.action` 该填什么**。实测批次 `l1-m4t`：规划器把「验证 staging 环境」写成
 * `type=DEPLOY, delivery={action:"DEPLOY", environment:"staging"}`——语义正确、契约错误。
 * 后果：`DeliveryOrchestrator` 照契约执行**又一次部署**，而 `harness.ts:150-160` 的
 * `collectStagingSegment` 找的是 `action === "VERIFY"` ⇒ 找不到 ⇒ **staging 段恒为 0**。
 * run 1 与 run 2 连续两次同样的形状（两次的真交付率都是 100%，只有这一段永远无法成立）。
 */
const DELIVERY_READY_LINE =
  'Create tasks only; do not execute them. End delivery-ready plans with exactly these four delivery tasks, each carrying the `delivery` block shown - the block is a platform contract, so a wrong action performs the wrong operation: (1) CI: type BUILD, delivery {"action":"CI"}. (2) Staging deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"staging"}. (3) Staging verify: type TEST, delivery {"action":"VERIFY","environment":"staging"} - the action MUST be "VERIFY", not "DEPLOY"; a DEPLOY action here deploys staging again instead of verifying it. (4) Production deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"production"} (human-approved by the Workflow Engine).';

/**
 * N-73：**交付链止于 staging 的 profile**（`FRONTEND_VUE_PROFILE.delivery.chain` 有 CI / staging
 * DEPLOY / staging VERIFY，没有 production）。此时仍要求规划生产部署，会排出一个没有环境可落的
 * 任务（`DELIVERY_ENVIRONMENT_MISSING`），所以单独给一份三条的契约文案。
 */
const DELIVERY_READY_STAGING_ONLY_LINE =
  'Create tasks only; do not execute them. End delivery-ready plans with exactly these three delivery tasks, each carrying the `delivery` block shown - the block is a platform contract, so a wrong action performs the wrong operation: (1) CI: type BUILD, delivery {"action":"CI"}. (2) Staging deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"staging"}. (3) Staging verify: type TEST, delivery {"action":"VERIFY","environment":"staging"} - the action MUST be "VERIFY", not "DEPLOY"; a DEPLOY action here deploys staging again instead of verifying it. This project has NO production environment: do NOT plan a production deploy.';

/**
 * 项目未绑定 Git 仓库时（deliveryConfigured === false）不得规划交付链：
 * 运行期 CI/部署由 DeploymentOrchestrator 执行，缺仓库会直接 REPOSITORY_NOT_CONFIGURED 失败
 * （真实案例 2026-09-29）。此时要求规划器以实现/测试/评审任务收尾。
 */
const NO_REPOSITORY_LINE =
  "Create tasks only; do not execute them. This project has NO Git repository bound, so CI and deployment cannot run: do NOT plan CI BUILD, staging DEPLOY, staging VERIFY or production DEPLOY tasks. End the plan with implementation, testing and review tasks.";

/**
 * F1-4：非最终切片的二级规划提示词变体——不得以交付链收尾（交付链只归最终切片）。
 * 与校验器（DELIVERY_TASK_OUTSIDE_FINAL_SLICE / GLOBAL_AC_OUTSIDE_FINAL_SLICE）配套为软硬双保险。
 */
const NON_FINAL_SLICE_LINE =
  "Create tasks only; do not execute them. This is NOT the final slice: do NOT plan CI BUILD, staging DEPLOY, staging VERIFY or production DEPLOY tasks, and do not include any delivery tasks — the final slice owns the delivery chain and verifies deployment/documentation acceptance. End the plan with implementation, testing and review tasks.";

export function taskPlanningPrompt(
  options: {
    deliveryConfigured?: boolean;
    isFinalSlice?: boolean;
    /** `docs/235`：能力 profile 决定可规划类型清单；缺省 = `backend-node`（与迁移前逐字相同）。 */
    profile?: CapabilityProfile;
  } = {}
): string {
  const profile = options.profile ?? DEFAULT_CAPABILITY_PROFILE;
  // N-73：交付链是否包含 production 由 profile 声明决定，决定提示词里那一段的条数。
  const hasProduction = profile.delivery?.chain.some(
    (step) => step.action === "DEPLOY" && step.environment === "production"
  );
  const consumeApiLine = profileConsumesApi(profile)
    ? "This profile consumes API contracts as input. Plan frontend interface encapsulation and page wiring as FRONTEND work that follows provided TRD / API contracts / encapsulation examples. Do not invent a server-side API, and never plan BACKEND or DATABASE tasks."
    : undefined;
  return withPlanningIntentContract(
    [
      ...baseLines(profile),
      ...(consumeApiLine ? [consumeApiLine] : []),
      "Each task must include acceptanceCriteria that name a check (an acceptance criterion or an official gate) that would prove the task is done. A task without a named check is not a complete plan item. Official full-suite E2E and official visual review belong at slice end or in CI, not on every intermediate implementation task.",
      options.deliveryConfigured === false
        ? NO_REPOSITORY_LINE
        : options.isFinalSlice === false
          ? NON_FINAL_SLICE_LINE
          : hasProduction
            ? DELIVERY_READY_LINE
            : DELIVERY_READY_STAGING_ONLY_LINE
    ].join("\n")
  );
}

/** 默认（项目具备交付能力）的提示词；未绑定仓库时用 taskPlanningPrompt({ deliveryConfigured: false })。 */
export const TASK_PLANNING_PROMPT = taskPlanningPrompt();
