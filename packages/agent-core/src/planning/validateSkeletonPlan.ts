/**
 * N-43（`docs/232` §T4-9）：**骨架先行契约**。
 *
 * 实测缺陷（L1-M4v 回归，2026-10-23）：第一个切片的骨架任务 S1-T01（type=BUILD）把五个脚本名写进
 * `package.json`，但它自己的 7 条验收标准**全部只描述清单字段**；agent 就只写了 `package.json` 一个
 * 文件。验证门按 BUILD 类型跑 `pnpm build`，而 `scripts/build.js` 由**五个任务之后**的 S1-T06 创建
 * ——首个任务必然 `MODULE_NOT_FOUND`，两轮 DEBUG 也救不回来，整条工作流 FAILED、oracle 0/29。
 *
 * 机制：**验收标准才是 agent 真正照着做的清单**（`TaskContext` 原文进提示词）。计划把「声明脚本」
 * 与「实现脚本」拆开，而 AC 又没要求脚本可执行，于是任务在计划层面就**不可能**通过它自己的验证检查。
 *
 * 契约（只作用于第一个切片——工作区从空开始的那一片）：
 * - **可执行条款自动补齐**：骨架任务声明/负责的每个脚本，若 AC 里没有「该脚本真实可执行、退出码 0」
 *   的条款，确定性追加一条。不改任务图、不改 AC 编号映射。
 * - **单一提供者**：同一脚本不得由切片内两个任务同时声明——那正是「声明在前、实现在后」的拆分形态。
 *
 * 骨架任务 = 声明了 `build` 的任务（构建契约的锚点）；无人声明时取计划顺序里的第一个根任务。
 * 非 Node/pnpm 工程（无任何脚本声明、AC 也不提 `package.json`）时本契约无输入，保持既有行为。
 */

/** 骨架契约要求的脚本集（E1 硬性约束与工程惯例的并集；缺哪个补哪个）。 */
export const SKELETON_REQUIRED_SCRIPTS = ["start", "test", "lint", "typecheck", "build"] as const;

export interface SkeletonTaskLike {
  id: string;
  type: string;
  dependencies: string[];
  providesScripts?: string[];
  acceptanceCriteria: string[];
}

export interface SkeletonRepair {
  taskId: string;
  script: string;
}

export interface SkeletonPlanInput<T extends SkeletonTaskLike> {
  tasks: T[];
  /** 显式 true 才生效；缺省 = 单级 full 模式或无切片信息，保持既有行为。 */
  isFirstSlice?: boolean;
}

/** Node/pnpm 工程判定：有脚本声明，或任一 AC 点名 `package.json`。 */
export function isNodeProject(tasks: SkeletonTaskLike[]): boolean {
  return tasks.some(
    (task) =>
      (task.providesScripts ?? []).length > 0 ||
      task.acceptanceCriteria.some((criterion) => criterion.includes("package.json"))
  );
}

/** 骨架任务：声明 `build` 的任务；缺省取计划顺序里的第一个根任务。 */
export function findSkeletonTask<T extends SkeletonTaskLike>(tasks: T[]): T | null {
  const provider = tasks.find((task) => (task.providesScripts ?? []).includes("build"));
  if (provider) return provider;
  return tasks.find((task) => task.dependencies.length === 0) ?? null;
}

/** 退出码/可执行性标记；与脚本名同时出现才算该脚本已被覆盖。 */
const EXECUTABILITY_MARKER = /(退出码|exit code|exit(?:s)?\s+(?:with\s+)?(?:code\s+)?0)/i;

function mentionsScript(text: string, script: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${script}([^A-Za-z0-9_-]|$)`).test(text);
}

function coversScript(task: SkeletonTaskLike, script: string): boolean {
  return task.acceptanceCriteria.some(
    (criterion) => mentionsScript(criterion, script) && EXECUTABILITY_MARKER.test(criterion)
  );
}

function skeletonCriterion(script: string): string {
  return (
    `Project skeleton is executable (${script}): after this task, \`pnpm run ${script}\` must have a real ` +
    `implementation in the repository and exit 0 — declaring the script name in package.json without the ` +
    `code it runs does not satisfy this criterion.`
  );
}

/**
 * 补齐骨架任务的可执行条款。返回**新数组**（不改入参）：上层把结果作为最终计划继续使用。
 */
export function repairSkeletonAcceptanceCriteria<T extends SkeletonTaskLike>(
  input: SkeletonPlanInput<T>
): { tasks: T[]; repairs: SkeletonRepair[] } {
  if (input.isFirstSlice !== true) return { tasks: input.tasks, repairs: [] };
  if (!isNodeProject(input.tasks)) return { tasks: input.tasks, repairs: [] };
  const skeleton = findSkeletonTask(input.tasks);
  if (!skeleton) return { tasks: input.tasks, repairs: [] };

  const missing = SKELETON_REQUIRED_SCRIPTS.filter((script) => !coversScript(skeleton, script));
  if (missing.length === 0) return { tasks: input.tasks, repairs: [] };

  const tasks = input.tasks.map((task) =>
    task.id === skeleton.id
      ? { ...task, acceptanceCriteria: [...task.acceptanceCriteria, ...missing.map(skeletonCriterion)] }
      : task
  );
  return { tasks, repairs: missing.map((script) => ({ taskId: skeleton.id, script })) };
}

/**
 * 骨架契约的硬错误（可确定性判定的部分）。补 AC 是自动修复，这里只拦「同一脚本两个提供者」——
 * 那正是把清单与实现拆成两个任务、让前者永远无法通过自身验证检查的形态。
 */
export function validateSkeletonPlan(input: SkeletonPlanInput<SkeletonTaskLike>): string[] {
  if (input.isFirstSlice !== true) return [];
  if (!isNodeProject(input.tasks)) return [];

  const providers = new Map<string, string[]>();
  for (const task of input.tasks) {
    for (const script of task.providesScripts ?? []) {
      providers.set(script, [...(providers.get(script) ?? []), task.id]);
    }
  }

  const errors: string[] = [];
  for (const [script, ids] of providers) {
    if (ids.length < 2) continue;
    errors.push(
      `Script ${script} is declared by more than one task (${ids.join(", ")}) ` +
        `(SKELETON_SCRIPT_MULTIPLE_PROVIDERS); exactly one task must create a script and the code it runs — ` +
        `merge the declaration into the task that implements it, and remove it from the other`
    );
  }
  return errors;
}
