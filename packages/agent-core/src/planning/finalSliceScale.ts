import { TaskPlan } from "@ai-se/shared";
import { isDeliveryChainTask } from "./validateTaskGraph";

/**
 * F1-4（发现⑤）：最终切片规模度量与「超限再拆」判定（observe 先行、校准后 enforce）。
 * - observe（默认）：只记录规模并发 `FINAL_SLICE_SCALE_OBSERVED` 事件，不判失败；
 * - enforce（开关 `PLANNING_FINAL_SLICE_MAX_TASKS` 开启且携带阈值）：任务数超限 →
 *   `FINAL_SLICE_OVERLOAD` 进入 LLM 压缩修复；仍超限 → 一级重做拆分 → 人工关口。
 * 阈值口径：E1 观测的 slice-2 三轮计划任务数 17/15/17 → enforce 初始值不低于 18（L2 校准后写入 docs/129）。
 */

export interface FinalSliceScale {
  /** 最终切片计划的任务数（超限判定的主指标）。 */
  taskCount: number;
  /** 交付链任务数（DEPLOY 或携带 delivery 块）。 */
  deliveryTaskCount: number;
  /** 最终切片的 FR 数（切片范围）。 */
  frCount: number;
  /** 归入最终切片的全局性 AC 数。 */
  globalAcCount: number;
}

export function measureFinalSliceScale(input: {
  tasks: TaskPlan["tasks"];
  globalAcKeys: string[];
  frCount: number;
}): FinalSliceScale {
  return {
    taskCount: input.tasks.length,
    deliveryTaskCount: input.tasks.filter(isDeliveryChainTask).length,
    frCount: input.frCount,
    globalAcCount: input.globalAcKeys.length
  };
}

/**
 * enforce 超限错误（返回 null = 未超限）。消息内嵌压缩指令：修复轮将本错误回灌提示词，
 * LLM 压缩时**不得增删 AC 映射**（任务集收敛，映射关系保持）。
 */
export function finalSliceOverloadError(
  scale: FinalSliceScale,
  maxTasks: number | undefined
): string | null {
  if (maxTasks === undefined || scale.taskCount <= maxTasks) {
    return null;
  }
  return (
    `Final slice plan is overloaded: ${scale.taskCount} tasks exceed the limit of ${maxTasks} ` +
    `(FINAL_SLICE_OVERLOAD). Compress the plan: merge or reduce tasks while keeping every ` +
    `acceptance-criteria mapping unchanged — do NOT add or drop AC mappings, and keep the DAG valid.`
  );
}
