/**
 * N-8 (docs/176) stage-1 probe: does the token accounting stay LINEAR in the iteration count?
 *
 * Why this exists: every agent run that reaches the platform's `maxIterations` guard
 * (`TOOL_ERROR: Agent reached max iterations`) records an absurd `token_usage`:
 *
 *   263,816,819,968,573,440   (run 1 attempt 1)
 *   684,582,327,732,404,200   (run 2 attempt 1)
 *   737,833,874,888,851,500   (run 2 attempt 2)
 *   4,139,511,744,995,262,500 (run 2 attempt 3)
 *
 * Those are the ONLY four rows in history with `input_tokens > 10M`, and they are exactly
 * the four rows that hit the guard (4/4). Runs that SUCCEEDED with 81 / 61 / 60 / 57 / 51 /
 * 50 iterations all recorded normal values (404,844 / 347,699 / 2,716,139 / ...). So the
 * corruption is tied to the guard path, not to the iteration count -- and the guard was
 * unreachable before PL-M14 (N-7 masked N-8).
 *
 * This probe answers the one question that separates the candidate mechanisms:
 * if a run with a CONSTANT per-call usage reports a total that grows faster than
 * linearly with the iteration count, the accumulation itself is doubling; if it grows
 * linearly, the blow-up needs another explanation.
 *
 *   provider returns the SAME usage_metadata on every call (input=1000, output=200)
 *   run to the guard at several maxIterations values
 *   expected (correct)  total.input_tokens == 1000 * maxIterations
 *   doubling            total.input_tokens ~ 1000 * 2^(maxIterations-1)
 *
 * Offline, deterministic, zero gateway quota. Note it deliberately drives the run INTO
 * the platform guard, which is the path under investigation.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-usage-accounting.ts
 * Optional: --out <dir>   default packages/eval/results/n8-probe
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

const outArg = argValue("--out");
const OUT_DIR = outArg
  ? resolve(REPO_ROOT, outArg)
  : join(REPO_ROOT, "packages/eval/results/n8-probe");

/** Constant per-call usage, so any growth beyond linearity is the accumulator's doing. */
const INPUT_PER_CALL = 1000;
const OUTPUT_PER_CALL = 200;

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

/** Never converges: always asks for another tool call, so the run ends at the step ceiling. */
class MeteredProvider implements LLMProvider {
  calls = 0;
  private tools: StructuredToolInterface[] = [];

  async invoke(_messages: BaseMessage[], _options?: LLMInvokeOptions): Promise<AIMessage> {
    this.calls += 1;
    return new AIMessage({
      content: `probe iteration ${this.calls}`,
      usage_metadata: {
        input_tokens: INPUT_PER_CALL,
        output_tokens: OUTPUT_PER_CALL,
        total_tokens: INPUT_PER_CALL + OUTPUT_PER_CALL
      },
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
    requestId: "n8-probe",
    taskId: "n8-probe-task",
    agentRunId: "n8-probe-run",
    actor: "probe",
    workspacePath: process.cwd(),
    sandbox: new ProbeSandbox()
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function runAt(maxIterations: number): Promise<{
  maxIterations: number;
  calls: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  expectedInput: number;
  ratio: number | undefined;
  status: string;
  errorCode: string | undefined;
}> {
  const provider = new MeteredProvider();
  const runner = new AgentRunner({
    llmProvider: provider,
    toolRuntime: new ToolRuntime({ tools: createPhase1Tools() }),
    systemPrompt: "N-8 probe: always request a tool call.",
    defaultTimeoutMs: 120_000
  });

  const result = await runner.run("probe task", context(), { maxIterations, maxRetries: 0 });

  const usage = (result.tokenUsage ?? {}) as Record<string, unknown>;
  const inputTokens = numeric(usage.input_tokens);
  const expectedInput = INPUT_PER_CALL * maxIterations;

  return {
    maxIterations,
    calls: provider.calls,
    inputTokens,
    outputTokens: numeric(usage.output_tokens),
    expectedInput,
    ratio: inputTokens === undefined ? undefined : inputTokens / expectedInput,
    status: result.status,
    errorCode: result.error?.code
  };
}

async function main(): Promise<void> {
  const cases = [2, 4, 8, 16, 50];
  const rows: Awaited<ReturnType<typeof runAt>>[] = [];
  for (const maxIterations of cases) {
    rows.push(await runAt(maxIterations));
  }

  const lines: string[] = [];
  lines.push("=== N-8 probe: is the token accounting linear in the iteration count? ===");
  lines.push(`constant per-call usage: input=${INPUT_PER_CALL} output=${OUTPUT_PER_CALL}`);
  lines.push("");
  lines.push("maxIter  calls  input_tokens        expected    ratio    status   code");
  for (const row of rows) {
    lines.push(
      [
        String(row.maxIterations).padStart(7),
        String(row.calls).padStart(5),
        String(row.inputTokens ?? "(none)").padStart(19),
        String(row.expectedInput).padStart(11),
        (row.ratio === undefined ? "(none)" : row.ratio.toExponential(3)).padStart(9),
        row.status.padStart(8),
        row.errorCode ?? "-"
      ].join("  ")
    );
  }
  lines.push("");

  const linear = rows.every((row) => row.ratio !== undefined && Math.abs(row.ratio - 1) < 1e-9);
  const growing = rows.some((row) => row.ratio !== undefined && row.ratio > 1.5);

  lines.push("--- VERDICT ---");
  if (linear) {
    lines.push("N8-LINEAR     every run reported exactly per_call * iterations.");
    lines.push("              The accumulator is NOT doubling; the blow-up seen in production");
    lines.push("              needs another explanation (the guard path itself, or the values");
    lines.push("              handed to it).");
  } else if (growing) {
    lines.push("N8-SUPERLINEAR  the reported total exceeds per_call * iterations.");
    lines.push("              The accumulation itself inflates. Reproduced offline.");
  } else {
    lines.push("N8-INCONCLUSIVE  neither a clean linear nor a growing pattern was observed.");
  }

  const report = lines.join("\n");
  console.log(report);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${report}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, "probe-measurements.json"),
    `${JSON.stringify(
      {
        inputPerCall: INPUT_PER_CALL,
        outputPerCall: OUTPUT_PER_CALL,
        rows,
        verdict: linear ? "N8-LINEAR" : growing ? "N8-SUPERLINEAR" : "N8-INCONCLUSIVE"
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
