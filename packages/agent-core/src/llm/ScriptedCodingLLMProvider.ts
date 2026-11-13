import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { LLMInvokeOptions, LLMProvider } from "./LLMProvider";

type ToolCallArgs = Record<string, unknown>;

interface ScriptedToolCall {
  name: string;
  args: ToolCallArgs;
}

const BUGGY_DISCOUNT_LINE = "const discountRate = isPremiumUser ? 0.05 : 0.1;";
const FIRST_FIX_LINE = "const discountRate = isPremiumUser ? 0.15 : 0.1;";
const FINAL_FIX_LINE = "const discountRate = isPremiumUser ? 0.2 : 0.1;";

export class ScriptedCodingLLMProvider implements LLMProvider {
  private index = 0;
  private readonly toolNames = new Set<string>();

  private readonly script: ScriptedToolCall[] = [
    { name: "list_directory", args: { path: "." } },
    { name: "search_code", args: { query: "calculateDiscount", path: "src" } },
    { name: "read_file", args: { path: "src/calculator.ts" } },
    {
      name: "edit_file",
      args: {
        path: "src/calculator.ts",
        search: BUGGY_DISCOUNT_LINE,
        replace: FIRST_FIX_LINE
      }
    },
    { name: "git_diff", args: {} },
    {
      name: "run_unit_test",
      args: { command: "node --test --experimental-strip-types tests/*.test.ts", timeoutMs: 30_000 }
    },
    { name: "read_file", args: { path: "src/calculator.ts" } },
    {
      name: "edit_file",
      args: {
        path: "src/calculator.ts",
        search: FIRST_FIX_LINE,
        replace: FINAL_FIX_LINE
      }
    },
    { name: "git_diff", args: {} },
    {
      name: "run_unit_test",
      args: { command: "node --test --experimental-strip-types tests/*.test.ts", timeoutMs: 30_000 }
    }
  ];

  async invoke(messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
    const lastToolMessage = [...messages]
      .reverse()
      .find((message) => ToolMessage.isInstance(message));
    const lastToolFailed =
      lastToolMessage && ToolMessage.isInstance(lastToolMessage)
        ? lastToolMessage.status === "error"
        : false;

    if (this.index >= this.script.length) {
      return new AIMessage({
        content: [
          "status: SUCCESS",
          "summary: Fixed calculateDiscount so premium users receive the expected 20% discount.",
          "tests: node --test --experimental-strip-types tests/*.test.ts"
        ].join("\n")
      });
    }

    const next = this.script[this.index];
    this.index += 1;

    if (this.toolNames.size > 0 && !this.toolNames.has(next.name)) {
      throw new Error(`Script requested an unbound tool: ${next.name}`);
    }

    return new AIMessage({
      content: lastToolFailed
        ? `Previous tool result failed. Continuing with the next corrective action: ${next.name}.`
        : `Action: ${next.name}`,
      tool_calls: [
        {
          name: next.name,
          args: next.args,
          id: `scripted-call-${this.index}`,
          type: "tool_call"
        }
      ]
    });
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(tools: StructuredToolInterface[]): LLMProvider {
    const next = new ScriptedCodingLLMProvider();
    next.index = this.index;
    for (const tool of tools) {
      next.toolNames.add(tool.name);
    }
    return next;
  }
}
