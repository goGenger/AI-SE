import { DEFAULT_CAPABILITY_PROFILE, type CapabilityProfile, type TaskType } from "@ai-se/shared";

/**
 * docs/235 §5.2 / l1-rv1 事故：能力 profile 的 `taskTypes.plannable` 原先只进提示词，
 * 不进计划期硬校验。于是 `frontend-vue` 下仍可能落库 DATABASE/BACKEND 任务，
 * 运行期才被 AgentRegistry fail-closed 成秒级 `TASK_EXECUTION_ERROR`（工作区空、token=0）。
 *
 * 本校验把「不可规划类型」提前到计划期报错，交给既有修复轮；缺省 profile = backend-node
 * （与迁移前可规划清单一致，零行为变化）。
 */
export function validatePlannableTaskTypes(input: {
  tasks: ReadonlyArray<{ id: string; type: TaskType }>;
  profile?: CapabilityProfile;
}): string[] {
  const profile = input.profile ?? DEFAULT_CAPABILITY_PROFILE;
  const allowed = new Set<string>(profile.taskTypes.plannable);
  const errors: string[] = [];
  for (const task of input.tasks) {
    if (!allowed.has(task.type)) {
      errors.push(
        `Task ${task.id} has type ${task.type} which is not plannable under capability profile ${profile.id}.`
      );
    }
  }
  return errors;
}
