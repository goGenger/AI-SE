import { ToolMessage } from "@langchain/core/messages";
import type { createDeepAgent } from "deepagents";

type DeepAgentMiddleware = NonNullable<
  NonNullable<Parameters<typeof createDeepAgent>[0]>["middleware"]
>[number];

/**
 * E-0（docs/125）：run 超时/取消的终止传播（C-6 幽灵调用修复点）。
 * signal 中止后：
 *  - beforeModel 跳转结束——深代理循环在下一个模型边界终止，不再发起模型调用；
 *  - wrapToolCall 拦截工具派发——中止后的工具调用不执行，直接返回取消结果。
 * 中止瞬间已在执行的模型/工具调用属「中止前已启动」，自然收尾；本中间件保证此后零新增调用。
 */
export function createAbortTerminationMiddleware(
  signal: AbortSignal | undefined
): DeepAgentMiddleware {
  return {
    name: "run-abort-termination",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async () => (signal?.aborted ? { jumpTo: "end" as const } : undefined)
    },
    wrapToolCall: async (request, handler) => {
      if (signal?.aborted) {
        return new ToolMessage({
          content: "Tool call cancelled: agent run aborted",
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name
        });
      }
      return handler(request);
    }
  };
}
