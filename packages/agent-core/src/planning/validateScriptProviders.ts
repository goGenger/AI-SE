import { TaskType } from "@ai-se/shared";
import { canonicalAcKey } from "./acceptanceCriteria";
import { IMPLEMENTATION_TYPES, dependencyClosure } from "./validateTestFirstPlan";

/**
 * PL-M9 9b（`docs/166` §3）：计划期**脚本提供者守卫**。
 *
 * 缺陷（`docs/166` §2.1 ①，PL-M4 run 1 实测）：计划可以把「创建 `package.json` 与其 scripts 的
 * 任务」排在「需要该 script 的 TEST 任务」**之后**——run 1 的 `T-04 → T-05` 正是此形状：T-04 的
 * 标题是「编写工程脚手架契约测试」，断言 `package.json` 的 scripts 并执行 `pnpm lint/typecheck/build`；
 * T-05 是「搭建 pnpm 工程脚手架」，创建那个 `package.json`。**T-04 测的正是 T-05 造的东西，
 * 而 T-05 被排在它之后。** DAG 无环、既有校验器全过。
 *
 * 后果：`apps/server` 的检查可用性判定读的是**运行期工作区**的 `package.json`（`probePackageFacts`），
 * 而计划期对它一无所知——三个 TEST 任务在脚手架之前运行 → 检查计划为空 → `unavailable`
 * → 静默通过，**红灯检查一次都没跑**。
 *
 * 判定：切片内存在声明了 `test` script 的提供者时，**每个 TEST 任务必须（传递）依赖某个提供者**。
 * 只覆盖 TEST（`docs/166` §4 裁定 3，同 PL-M7 裁定 2 的思路：TEST 是唯一「检查即任务本质」的类型）。
 * 提供者缺省（无声明）时本守卫**无输入**——与 PL-M7 7a 同一退路口径，兜底由 PL-M9 9a 的观察事件承担。
 */

/** 需要 `test` script 才能判定的检查（`apps/server` 的 `CHECK_CANDIDATES.TEST`）。 */
export const TEST_SCRIPT = "test";

export interface ScriptProviderTask {
  id: string;
  type: TaskType;
  dependencies: string[];
  acKeys?: string[];
  providesScripts?: string[];
}

export interface ScriptProviderInput {
  tasks: ScriptProviderTask[];
}

/** 声明了 `test` script 的任务（提供者）。 */
export function listScriptProviders(tasks: ScriptProviderTask[]): ScriptProviderTask[] {
  return tasks.filter((task) => (task.providesScripts ?? []).includes(TEST_SCRIPT));
}

/** 需要 `test` script 才能判定的任务（消费者）。 */
export function listScriptConsumers(tasks: ScriptProviderTask[]): ScriptProviderTask[] {
  return tasks.filter((task) => task.type === "TEST");
}

/**
 * N4 与 9b 的冲突判定：该边是否是 N4 强制的「实现任务 → 测试任务」边（共享 AC）。
 * 若是，9b 不得删除它——两个要求同时成立时计划无解，交 LLM 修复轮（`docs/166` §4 裁定 4）。
 */
export function isTestFirstMandatedEdge(
  source: ScriptProviderTask,
  target: ScriptProviderTask
): boolean {
  if (!IMPLEMENTATION_TYPES.includes(source.type)) return false;
  if (target.type !== "TEST") return false;
  const targetKeys = new Set((target.acKeys ?? []).map((key) => canonicalAcKey(key)));
  return (source.acKeys ?? []).some((key) => targetKeys.has(canonicalAcKey(key)));
}

export function validateScriptProviders(input: ScriptProviderInput): string[] {
  const providers = listScriptProviders(input.tasks);
  if (providers.length === 0) return [];
  const consumers = listScriptConsumers(input.tasks);
  if (consumers.length === 0) return [];

  const closures = dependencyClosure(input.tasks);
  const providerIds = providers.map((provider) => provider.id);
  const errors: string[] = [];
  for (const consumer of consumers) {
    const reachable = closures.get(consumer.id) ?? new Set<string>();
    if (providerIds.some((id) => reachable.has(id))) continue;
    errors.push(
      `Task ${consumer.id} is a TEST task but does not (transitively) depend on the task that creates the ` +
        `${TEST_SCRIPT} script (${providerIds.join(", ")}) — its red-light check cannot run before that script ` +
        `exists (PLAN_TEST_BEFORE_SCRIPT_PROVIDER); make it depend on ${providerIds[0]}`
    );
  }
  return errors;
}
