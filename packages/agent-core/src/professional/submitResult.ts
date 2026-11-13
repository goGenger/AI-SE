import { ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolDefinition, ToolResult } from "@ai-se/tool-runtime";
import type { createDeepAgent } from "deepagents";
import { OutcomeSchema, SubmitResultSchema } from "./outcomeSchema";
import { ProfessionalOutcome } from "./types";

/**
 * T2：结构化提交工具名。
 * 控制类工具——无外部副作用（不执行命令、不触文件系统），仅经 Tool Runtime 的
 * schema 校验 / 审计 / 结果通道；执行由 Tool Runtime 统一负责（唯一执行路径）。
 */
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

const DESCRIPTION = [
  "Submit the final structured result for this task and end the run.",
  "Call it once the task's acceptance criteria are met, or when the task cannot proceed.",
  'Arguments: {"status":"SUCCESS|FAILED|RETRY|REPLAN","summary":"...","artifacts":[],"issues":[],"recommendations":[],"metadata":{}}.',
  "The arguments are validated against the result schema; on validation errors, fix them and call it again."
].join(" ");

/** T2 控制类工具：入参 = ProfessionalOutcome（SubmitResultSchema，JSON-Schema 可表示），输出 = 校验后的结果本身。 */
export function createSubmitResultTool(): ToolDefinition<ProfessionalOutcome, ProfessionalOutcome> {
  return {
    name: SUBMIT_RESULT_TOOL_NAME,
    description: DESCRIPTION,
    riskLevel: "LOW",
    inputSchema: SubmitResultSchema,
    execute: async (input) => input
  };
}

/**
 * 从工具执行记录里取最后一次「被接受」的结构化提交（对 data 再做一次 schema 复核，
 * 保证调用方拿到的永远是通过校验的 ProfessionalOutcome）。
 */
export function captureSubmittedOutcome(
  toolResults: ToolResult[],
  toolName?: string
): ProfessionalOutcome | undefined {
  if (!toolName) {
    return undefined;
  }
  for (const result of [...toolResults].reverse()) {
    if (result.toolName !== toolName || !result.success) {
      continue;
    }
    const parsed = OutcomeSchema.safeParse(result.data);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

/** deepagents 的中间件类型从 createDeepAgent 的参数签名派生（agent-core 不直接依赖 langchain）。 */
type DeepAgentMiddleware = NonNullable<
  NonNullable<Parameters<typeof createDeepAgent>[0]>["middleware"]
>[number];

function isAcceptedSubmitResult(content: unknown, toolName: string): boolean {
  if (typeof content !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(content) as { success?: unknown; toolName?: unknown };
    return parsed.success === true && parsed.toolName === toolName;
  } catch {
    return false;
  }
}

/**
 * T2 终止条件（deepagents 路径）：submit_result 成功执行后，在下一次模型调用之前
 * 直接结束循环（beforeModel + jumpTo:"end"）——不再多烧一次模型调用。
 * 校验失败则正常回到模型自修（错误作为工具结果已回传，计入迭代）。
 */
export function createSubmitResultTerminationMiddleware(toolName: string): DeepAgentMiddleware {
  return {
    name: "submit-result-termination",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state: unknown) => {
        const messages = (state as { messages?: BaseMessage[] }).messages;
        const last = messages?.at(-1);
        if (
          last &&
          ToolMessage.isInstance(last) &&
          isAcceptedSubmitResult(last.content, toolName)
        ) {
          return { jumpTo: "end" as const };
        }
        return undefined;
      }
    }
  };
}
