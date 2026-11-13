/**
 * N-7 (docs/174, PL-M14) stage-1 probe: measure the outer AgentGraph's step ceiling.
 *
 * Why this exists: on 2026-10-17 an agent run died with
 *
 *   UNKNOWN_ERROR: Recursion limit of 25 reached without hitting a stop condition.
 *
 * That is LangGraph's GraphRecursionError, and it is thrown by the Pregel loop itself,
 * not by any node -- which is why the error code is AgentRunner's outer UNKNOWN_ERROR
 * rather than agentNode's LLM_ERROR. `recursionLimit` appears nowhere in the platform's
 * source or dist, so LangGraph's DEFAULT_RECURSION_LIMIT (25) governs the outer graph.
 *
 * The outer graph is a TWO-NODE loop (agent <-> tools), so each iteration costs 2
 * supersteps and the graph stops at ~12 iterations -- while the platform's own guard
 * (`state.iteration >= maxIterations`, maxIterations = 50 on the production path)
 * never gets a chance to fire.
 *
 * Static reading alone cannot say how many iterations are actually reachable, so this
 * probe runs the REAL graph with a provider that never converges and reports the exact
 * numbers. It is offline, deterministic and uses zero gateway quota.
 *
 * Provider: always answers with a fresh tool_call, so the loop can only end at a step
 * ceiling. Each agentNode execution = 1 superstep, each toolsNode execution = 1.
 *
 * Expected
 *   BEFORE the fix   status=failed  code=UNKNOWN_ERROR  "Recursion limit of 25"   ~13 iterations
 *   AFTER  the fix   status=failed  code=TOOL_ERROR     "max iterations"          50 iterations
 *
 * Both outcomes are reported; the probe does not fail the shell, it prints a VERDICT.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-agent-recursion-limit.ts
 * Optional: --max-iterations <n>   default 50 (the production value)
 *           --out <dir>            default packages/eval/results/n7-probe
 * NOTE: keep this file ASCII-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { AgentContext } from "../src/agent/AgentContext.js";
import { AgentRunner } from "../src/agent/AgentRunner.js";
import { LLMInvokeOptions, LLMProvider } from "../src/llm/LLMProvider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old; use Node >= 22.`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

const MAX_ITERATIONS = Number(argValue("--max-iterations") ?? "50");
// Resolve a relative --out against the REPO ROOT, not process.cwd(): `pnpm --filter ... exec`
// runs with cwd set to the package directory, which silently sends a relative path to
// packages/agent-core/packages/eval/results/... instead of packages/eval/results/...
const outArg = argValue("--out");
const OUT_DIR = outArg
  ? resolve(REPO_ROOT, outArg)
  : join(REPO_ROOT, "packages/eval/results/n7-probe");

/* ------------------------------------------------------------------ scripted pieces */

class ProbeSandbox implements Sandbox {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    return {
      command: command.command,
      exitCode: 0,
      stdout: "PROBE_FILE_CONTENT\n",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
}

/** Never converges: every call asks for another tool call, so only a step ceiling can stop it. */
class NeverConvergingProvider implements LLMProvider {
  calls = 0;
  private tools: StructuredToolInterface[] = [];

  async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
    this.calls += 1;
    return new AIMessage({
      content: `probe iteration ${this.calls}`,
      tool_calls: [
        {
          name: "read_file",
          args: { path: "probe.txt" },
          id: `probe-call-${this.calls}`,
          type: "tool_call"
        }
      ]
    });
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(tools: StructuredToolInterface[]): LLMProvider {
    this.tools = tools;
    return this;
  }

  toolCount(): number {
    return this.tools.length;
  }
}

function context(): AgentContext {
  return {
    requestId: "n7-probe",
    taskId: "n7-probe-task",
    agentRunId: "n7-probe-run",
    actor: "probe",
    workspacePath: process.cwd(),
    sandbox: new ProbeSandbox()
  };
}

/* ------------------------------------------------------------------ run */

async function main(): Promise<void> {
  const provider = new NeverConvergingProvider();
  let toolsNodeRuns = 0;
  const events: string[] = [];

  const runner = new AgentRunner({
    llmProvider: provider,
    toolRuntime: new ToolRuntime({ tools: createPhase1Tools() }),
    systemPrompt: "N-7 probe: always request a tool call.",
    defaultTimeoutMs: 120_000,
    lifecycle: {
      onEvent: async (record) => {
        events.push(record.eventType);
        if (record.eventType === "tool_call_started") {
          toolsNodeRuns += 1;
        }
      }
    }
  });

  const result = await runner.run("probe task", context(), {
    maxIterations: MAX_ITERATIONS,
    maxRetries: 0
  });

  const agentNodeRuns = provider.calls;
  const supersteps = agentNodeRuns + toolsNodeRuns + 1; // +1 for START -> agent
  const code = result.error?.code ?? "(none)";
  const message = result.error?.message ?? "(none)";

  const hitFrameworkLimit = code === "UNKNOWN_ERROR" && message.includes("Recursion limit");
  const hitPlatformGuard = code === "TOOL_ERROR" && message.includes("max iterations");

  const lines: string[] = [];
  lines.push("=== N-7 probe: outer AgentGraph step ceiling ===");
  lines.push(`maxIterations requested : ${MAX_ITERATIONS}`);
  lines.push(`status                  : ${result.status}`);
  lines.push(`error code              : ${code}`);
  lines.push(`error message           : ${message.split("\n")[0]}`);
  lines.push(`agentNode executions    : ${agentNodeRuns}   (= provider invocations = loop iterations)`);
  lines.push(`toolsNode executions    : ${toolsNodeRuns}`);
  lines.push(`approx. supersteps      : ${supersteps}   (agentNode + toolsNode + START)`);
  lines.push(`iterations reported     : ${result.iterations}`);
  lines.push(`bound tools             : ${provider.toolCount()}`);
  lines.push(`events                  : ${events.length}`);
  lines.push("");
  lines.push("--- VERDICT ---");
  if (hitFrameworkLimit) {
    lines.push("N7-PRESENT  the graph stopped at LangGraph's default recursionLimit (25),");
    lines.push(`            not at the platform guard (${MAX_ITERATIONS}). UNKNOWN_ERROR is the`);
    lines.push("            framework's error, not the platform's TOOL_ERROR.");
  } else if (hitPlatformGuard) {
    lines.push("N7-FIXED    the graph ran to the platform's own guard and reported TOOL_ERROR");
    lines.push(`            at ${result.iterations} iterations. The framework limit no longer binds.`);
  } else {
    lines.push("N7-UNEXPECTED  neither the framework limit nor the platform guard was reached.");
  }

  const report = lines.join("\n");
  console.log(report);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${report}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, "probe-measurements.json"),
    `${JSON.stringify(
      {
        maxIterations: MAX_ITERATIONS,
        status: result.status,
        errorCode: code,
        errorMessage: message,
        agentNodeRuns,
        toolsNodeRuns,
        approxSupersteps: supersteps,
        reportedIterations: result.iterations,
        boundTools: provider.toolCount(),
        eventCount: events.length,
        verdict: hitFrameworkLimit ? "N7-PRESENT" : hitPlatformGuard ? "N7-FIXED" : "N7-UNEXPECTED"
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`\nreport written to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
