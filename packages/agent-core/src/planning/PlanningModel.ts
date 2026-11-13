import { JsonObject } from "@ai-se/shared";
import { z } from "zod";
import { PlanningStage } from "./PlanningState";

export interface PlanningModelRequest<TOutput extends JsonObject> {
  stage: PlanningStage;
  prompt: string;
  schema: z.ZodType<TOutput>;
  input: JsonObject;
  validationErrors: string[];
  signal?: AbortSignal;
  /**
   * N-25（`docs/206`）：**每一次模型调用**的用量回调，形状与 `agent_runs.token_usage` 一致
   * （LangChain `usage_metadata`）。
   *
   * 为什么用回调而不是返回值：一次逻辑调用可能因解析失败被重采样多次
   * （`STRUCTURED_OUTPUT_ATTEMPTS`），而解析失败会抛出 `OutputParserException`——
   * 它只带 `llmOutput: string`，**不含用量**。走返回值的方案拿不到失败那几次的消耗，
   * 累计值必然偏低。回调在**模型调用结束**时触发，与后续解析成败无关。
   */
  onUsage?: (usage: JsonObject) => void;
}

export interface PlanningModel {
  generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown>;
}

/**
 * N-25：把一次模型调用的用量并入累计值。数值字段相加，嵌套对象（如 `input_token_details`）递归相加。
 * 唯一实现——守卫读的是同一个 `token_usage` 字段，不另立第二套记账。
 */
export function addTokenUsage(acc: JsonObject, next: JsonObject): JsonObject {
  const merged: JsonObject = { ...acc };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number") {
      const previous = typeof merged[key] === "number" ? (merged[key] as number) : 0;
      merged[key] = previous + value;
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const current = merged[key];
      const base =
        typeof current === "object" && current !== null && !Array.isArray(current)
          ? (current as JsonObject)
          : {};
      merged[key] = addTokenUsage(base, value as JsonObject);
    }
  }
  return merged;
}
