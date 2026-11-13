/**
 * N-9 (docs/179, PL-M16) stage-1 probe: why does the outer loop keep going after the
 * inner agent has already submitted?
 *
 * L1-M4g run 1 showed the shape (docs/179 sec.2.3): the agent called `submit_result` at
 * round 6 and succeeded, and then EVERY later round requested the SAME `submit_result`
 * again -- 44 rounds inside 1.2 seconds, with no model call in any of them -- until
 * `state.iteration` reached 50 and the platform guard returned TOOL_ERROR. The task
 * reported `outcome: SUCCESS` and was still marked FAILED.
 *
 * This probe runs the REAL stack -- real ChatOpenAI, real `deepagents` inner agent, real
 * ToolRuntimeBackend, real DeepAgentLLMProvider, real AgentRunner/AgentGraph -- against a
 * local recording gateway. Offline, deterministic, zero gateway quota.
 *
 * Scenarios
 *   A_baseline      the stack as it is today, driven to the platform guard.
 *   B_counterfactual  same run, but the provider's returned message is rebuilt WITHOUT
 *                   tool_calls (additional_kwargs minus the `tool_calls` key). This is the
 *                   candidate fix from docs/179 sec.4 item 3, exercised as a
 *                   counterfactual -- it is NOT applied to production code here.
 *   C_framework_default  same as A but the graph is invoked WITHOUT `recursionLimit`
 *                   (the pre-PL-M14 condition). If this dies at ~12 rounds with
 *                   "Recursion limit of 25", then N-7 was this same spin cut short by the
 *                   framework -- the hypothesis recorded as judgement 16i.
 *   D_message_shape dumps, per outer round, what the outer loop actually receives:
 *                   tool_calls, additional_kwargs keys, content.
 *
 * Deliberate simplifications (kept explicit -- a probe must match production): the sandbox
 * answers every command with the same canned stdout, and the gateway's script is fixed.
 * The inner agent, the backend, the provider, the graph and the guard are all the
 * production ones. `submit_result` is registered explicitly because `createPhase1Tools()`
 * does not include it (see `DeepAgentLLMProvider.test.ts`).
 *
 * KNOWN FIDELITY GAP (registered, not hidden): in this probe the INNER agent never
 * dispatches the `submit_result` tool -- `backend.toolResults` only ever holds `read_file`,
 * so `captureSubmittedOutcome` returns undefined and the provider's content stays empty.
 * Production does dispatch it (`agent_runs.output->>'outcomeMode' = "tool"` on every
 * L1-M4g run). The OUTER mechanism under test -- the returned message carrying
 * `additional_kwargs.tool_calls`, and the loop re-executing them -- is reproduced exactly,
 * and scenario B shows the fix removes the spin. Whether the fix should be conditioned on
 * `captureSubmittedOutcome` is therefore answered by robustness, not by this probe.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-outer-loop-spin.ts
 * Optional: --out <dir>   default packages/eval/results/n9-spin-probe
 * NOTE: keep this file ASCII-only.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { createPhase1Tools, ToolRuntime } from "@ai-se/tool-runtime";
import { createDeepAgent } from "deepagents";
import { AgentContext } from "../src/agent/AgentContext.js";
import { AgentLifecycleHooks } from "../src/agent/AgentLifecycle.js";
import { AgentRunner } from "../src/agent/AgentRunner.js";
import { createInitialAgentState } from "../src/agent/AgentState.js";
import { createAgentGraph, createHumanTaskMessage } from "../src/graph/AgentGraph.js";
import { createOpenAIChatModel, messageContentToText } from "../src/llm/LangChainLLMProvider.js";
import { LLMInvokeOptions, LLMProvider } from "../src/llm/LLMProvider.js";
import { PROFESSIONAL_AGENT_DEFINITIONS } from "../src/professional/AgentRegistry.js";
import { createAbortTerminationMiddleware } from "../src/professional/abortTermination.js";
import { DeepAgentLLMProvider } from "../src/professional/DeepAgentLLMProvider.js";
import { createSubmitResultTerminationMiddleware, createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "../src/professional/submitResult.js";
import { ToolRuntimeBackend } from "../src/professional/ToolRuntimeBackend.js";
import { withUntrustedInputClause } from "../src/professional/untrustedInput.js";

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
  : join(REPO_ROOT, "packages/eval/results/n9-spin-probe");
const MAX_ITERATIONS = Number(argValue("--max-iterations") ?? "50");

const INPUT_PER_CALL = 1000;
const OUTPUT_PER_CALL = 200;

/* ------------------------------------------------------------------ recording gateway */

interface GatewayCallRecord {
  seq: number;
  scenario: string;
  round: number;
}

let scenario = "unset";
let currentRound = 0;
let callSeq = 0;
const gatewayCalls: GatewayCallRecord[] = [];

function assistantMessage(
  content: string,
  toolCall?: { id: string; name: string; args: Record<string, unknown> }
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCall) {
    message.tool_calls = [
      {
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) }
      }
    ];
  }
  return message;
}

function completion(message: Record<string, unknown>): string {
  const finish = message.tool_calls ? "tool_calls" : "stop";
  return JSON.stringify({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: INPUT_PER_CALL,
      completion_tokens: OUTPUT_PER_CALL,
      total_tokens: INPUT_PER_CALL + OUTPUT_PER_CALL
    }
  });
}

function sse(message: Record<string, unknown>): string {
  const finish = message.tool_calls ? "tool_calls" : "stop";
  const base = {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model"
  };
  const delta: Record<string, unknown> = { role: "assistant" };
  if (typeof message.content === "string" && message.content !== "") delta.content = message.content;
  if (message.tool_calls) delta.tool_calls = message.tool_calls;
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

/**
 * Fixed script per round, mirroring the production shape of L1-M4g run 1: some real work,
 * then a `submit_result` that the termination middleware accepts. After that the inner
 * agent must not be asked to do anything again -- if it is, the outer loop is spinning.
 */
function scriptedMessage(callInRound: number): Record<string, unknown> {
  if (callInRound === 1) {
    return assistantMessage("", {
      id: "call_probe_read",
      name: "read_file",
      args: { file_path: "package.json" }
    });
  }
  return assistantMessage("", {
    id: "call_probe_submit",
    name: SUBMIT_RESULT_TOOL_NAME,
    args: {
      status: "SUCCESS",
      summary: `probe submission (round ${currentRound})`,
      artifacts: [],
      issues: [],
      recommendations: [],
      metadata: {}
    }
  });
}

function startGateway(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = { __unparsable: true };
      }
      callSeq += 1;
      const callInRound =
        gatewayCalls.filter((entry) => entry.scenario === scenario && entry.round === currentRound)
          .length + 1;
      gatewayCalls.push({ seq: callSeq, scenario, round: currentRound });
      const message = scriptedMessage(callInRound);
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(message));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(completion(message));
      }
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ port, close: () => new Promise<void>((closed) => server.close(() => closed())) });
    });
  });
}

/* ------------------------------------------------------------------ stack under test */

class ProbeSandbox implements Sandbox {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    return {
      command: command.command,
      exitCode: 0,
      stdout: "PROBE_FILE_LINE_ONE\nPROBE_FILE_LINE_TWO\n",
      stderr: "",
      duration: 1,
      timedOut: false
    };
  }
}

function backendAgentDefinition() {
  const definition = PROFESSIONAL_AGENT_DEFINITIONS.find((entry) => entry.type === "BACKEND");
  if (!definition) throw new Error("no BACKEND agent definition found");
  return definition;
}

/** `submit_result` is a control tool, not part of createPhase1Tools() -- register it. */
function probeTools() {
  return [...createPhase1Tools(), createSubmitResultTool()];
}

interface Stack {
  provider: DeepAgentLLMProvider;
  backend: ToolRuntimeBackend;
  systemPrompt: string;
}

/** Everything the backend was actually asked to execute, in order. */
const backendEvents: string[] = [];

function buildStack(port: number): Stack {
  const definition = backendAgentDefinition();
  const model = createOpenAIChatModel({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "probe-key",
    model: "probe-model"
  });
  const context = probeContext();
  const backend = new ToolRuntimeBackend({
    runtime: new ToolRuntime({ tools: probeTools() }),
    context,
    permissions: definition.permissions,
    onToolEvent: async (eventType, payload) => {
      if (eventType === "tool_call_started") {
        backendEvents.push(`round${currentRound}:${String(payload.toolName ?? "?")}`);
      }
    }
  });
  const systemPrompt = withUntrustedInputClause(definition.systemInstructions);
  return {
    provider: new DeepAgentLLMProvider(model, definition, backend, SUBMIT_RESULT_TOOL_NAME),
    backend,
    systemPrompt
  };
}

function probeContext(): AgentContext {
  return {
    requestId: "n9-spin-probe",
    taskId: "n9-spin-probe-task",
    agentRunId: "n9-spin-probe-run",
    actor: "probe",
    workspacePath: REPO_ROOT,
    sandbox: new ProbeSandbox()
  };
}

/* ------------------------------------------------------------------ recording wrapper */

interface RoundRecord {
  round: number;
  inputMessages: number;
  gatewayCallsInRound: number;
  returnedToolCalls: string[];
  additionalKwargKeys: string[];
  contentPreview: string;
  contentEmpty: boolean;
  error?: string;
}

function scenarioCalls(): number {
  return gatewayCalls.filter((entry) => entry.scenario === scenario).length;
}

/**
 * `stripToolCalls` is the counterfactual from docs/179 sec.4 item 3: rebuild the returned
 * message without `tool_calls` while keeping the rest of `additional_kwargs` (that is where
 * N-6's `reasoning_content` lives). Off by default -- scenario B turns it on.
 */
class RecordingProvider implements LLMProvider {
  readonly rounds: RoundRecord[] = [];

  constructor(
    private readonly inner: LLMProvider,
    private readonly stripToolCalls = false
  ) {}

  async invoke(messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    currentRound += 1;
    const round = currentRound;
    const callsBefore = scenarioCalls();
    try {
      const raw = await this.inner.invoke(messages, options);
      const response = this.stripToolCalls ? withoutToolCalls(raw) : raw;
      const additionalKwargs = (response.additional_kwargs ?? {}) as Record<string, unknown>;
      this.rounds.push({
        round,
        inputMessages: messages.length,
        gatewayCallsInRound: scenarioCalls() - callsBefore,
        returnedToolCalls: (response.tool_calls ?? []).map((call) => call.name),
        additionalKwargKeys: Object.keys(additionalKwargs).sort(),
        contentPreview: messageContentToText(response.content).replace(/\s+/g, " ").slice(0, 40),
        contentEmpty: messageContentToText(response.content).trim() === ""
      });
      return response;
    } catch (error: unknown) {
      this.rounds.push({
        round,
        inputMessages: messages.length,
        gatewayCallsInRound: scenarioCalls() - callsBefore,
        returnedToolCalls: [],
        additionalKwargKeys: [],
        contentPreview: "",
        contentEmpty: true,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async *stream(messages: BaseMessage[], options?: LLMInvokeOptions): AsyncIterable<AIMessage> {
    yield await this.invoke(messages, options);
  }

  bindTools(tools: StructuredToolInterface[]): LLMProvider {
    this.inner.bindTools(tools);
    return this;
  }
}

/** Rebuild the message with `additional_kwargs` minus its `tool_calls` key. */
function withoutToolCalls(message: AIMessage): AIMessage {
  const { tool_calls: _dropped, ...rest } = (message.additional_kwargs ?? {}) as Record<
    string,
    unknown
  >;
  return new AIMessage({
    content: message.content,
    additional_kwargs: rest,
    usage_metadata: message.usage_metadata,
    response_metadata: message.response_metadata
  });
}

/* ------------------------------------------------------------------ scenarios */

interface ScenarioResult {
  name: string;
  rounds: RoundRecord[];
  gatewayCalls: number;
  status: string;
  errorCode: string | undefined;
  iterations: number | undefined;
  finalAnswerPreview: string;
  iterationTrail: number[];
  runError?: string;
  /** Why `captureSubmittedOutcome` did or did not find the submission. */
  backendResults: { toolName: string; success: boolean; dataPreview: string }[];
  customToolNames: string[];
}

async function runThroughRunner(
  name: string,
  port: number,
  stripToolCalls: boolean
): Promise<ScenarioResult> {
  scenario = name;
  currentRound = 0;
  backendEvents.length = 0;
  const callsBefore = gatewayCalls.length;
  const iterationTrail: number[] = [];
  const lifecycle: AgentLifecycleHooks = {
    onIteration: async (record) => {
      iterationTrail.push(record.iteration);
    }
  };
  const { provider, backend, systemPrompt } = buildStack(port);
  const recording = new RecordingProvider(provider, stripToolCalls);
  const runner = new AgentRunner({
    llmProvider: recording,
    toolRuntime: new ToolRuntime({ tools: probeTools() }),
    systemPrompt,
    defaultMaxIterations: MAX_ITERATIONS,
    defaultTimeoutMs: 600_000,
    defaultMaxRetries: 1,
    lifecycle
  });
  let status = "unknown";
  let errorCode: string | undefined;
  let iterations: number | undefined;
  let finalAnswerPreview = "";
  let runError: string | undefined;
  try {
    const result = await runner.run("probe task", probeContext(), {
      maxIterations: MAX_ITERATIONS
    });
    status = result.status;
    errorCode = result.error?.code;
    iterations = result.iterations;
    finalAnswerPreview = result.finalAnswer.replace(/\s+/g, " ").slice(0, 60);
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
  }
  return {
    name,
    rounds: recording.rounds,
    gatewayCalls: gatewayCalls.length - callsBefore,
    status,
    errorCode,
    iterations,
    finalAnswerPreview,
    iterationTrail,
    runError,
    backendResults: backend.toolResults.map((result) => ({
      toolName: result.toolName,
      success: result.success,
      dataPreview: JSON.stringify(result.data ?? null).slice(0, 60)
    })),
    customToolNames: backend.createCustomTools().map((entry) => entry.name)
  };
}

/**
 * Pre-PL-M14 condition: drive the graph directly and pass NO `recursionLimit`, so LangGraph
 * uses its default of 25 supersteps. Everything else is identical to scenario A.
 */
async function runWithoutRecursionLimit(port: number): Promise<ScenarioResult> {
  const name = "C_framework_default";
  scenario = name;
  currentRound = 0;
  backendEvents.length = 0;
  const callsBefore = gatewayCalls.length;
  const { provider, backend, systemPrompt } = buildStack(port);
  const recording = new RecordingProvider(provider, false);
  const context = probeContext();
  const graph = createAgentGraph({
    llmProvider: recording,
    toolRuntime: new ToolRuntime({ tools: probeTools() }),
    systemPrompt,
    maxIterations: MAX_ITERATIONS,
    maxRetries: 1,
    context
  });
  const state = createInitialAgentState({
    messages: [createHumanTaskMessage("probe task")],
    projectId: context.projectId,
    taskId: context.taskId,
    agentRunId: context.agentRunId,
    metadata: context.metadata
  });
  let status = "unknown";
  let errorCode: string | undefined;
  let iterations: number | undefined;
  let runError: string | undefined;
  try {
    const finalState = await graph.invoke(state, {
      configurable: { thread_id: context.agentRunId }
    });
    status = finalState.status;
    errorCode = finalState.error?.code;
    iterations = finalState.iteration;
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
  }
  return {
    name,
    rounds: recording.rounds,
    gatewayCalls: gatewayCalls.length - callsBefore,
    status,
    errorCode,
    iterations,
    finalAnswerPreview: "",
    iterationTrail: [],
    runError,
    backendResults: backend.toolResults.map((result) => ({
      toolName: result.toolName,
      success: result.success,
      dataPreview: JSON.stringify(result.data ?? null).slice(0, 60)
    })),
    customToolNames: backend.createCustomTools().map((entry) => entry.name)
  };
}

/* ------------------------------------------------------------------ report */

function roundLine(round: RoundRecord): string {
  return [
    String(round.round).padStart(4),
    String(round.inputMessages).padStart(6),
    String(round.gatewayCallsInRound).padStart(6),
    (round.returnedToolCalls.length > 0 ? round.returnedToolCalls.join("+") : "-").padEnd(16),
    (round.additionalKwargKeys.join(",") || "-").padEnd(22),
    round.contentEmpty ? "EMPTY" : "text",
    round.contentPreview,
    round.error ? `ERROR ${round.error.slice(0, 30)}` : ""
  ].join("  ");
}

const HEADER =
  " rnd  inMsgs  calls  returnedToolCalls  additionalKwargKeys     content  preview";

function summarise(result: ScenarioResult): string[] {
  const lines: string[] = [];
  lines.push(
    `  rounds=${result.rounds.length}  gatewayCalls=${result.gatewayCalls}  ` +
      `status=${result.status} code=${result.errorCode ?? "-"} iterations=${result.iterations ?? "-"}`
  );
  const spinRounds = result.rounds.filter(
    (round) => round.returnedToolCalls.includes(SUBMIT_RESULT_TOOL_NAME)
  ).length;
  const zeroCallRounds = result.rounds.filter((round) => round.gatewayCallsInRound === 0).length;
  lines.push(
    `  rounds requesting submit_result: ${spinRounds}/${result.rounds.length}  ` +
      `rounds with ZERO model calls: ${zeroCallRounds}/${result.rounds.length}`
  );
  if (result.iterationTrail.length > 0) {
    lines.push(
      `  state.iteration trail: [${result.iterationTrail.slice(0, 6).join(",")}` +
        `${result.iterationTrail.length > 6 ? ",..." + String(result.iterationTrail.at(-1)) : ""}]`
    );
  }
  if (result.finalAnswerPreview) lines.push(`  finalAnswer: ${result.finalAnswerPreview}`);
  if (result.runError) lines.push(`  runError: ${result.runError.slice(0, 120)}`);
  lines.push(`  backend.toolResults (${result.backendResults.length}):`);
  for (const entry of result.backendResults) {
    lines.push(
      `    toolName=${entry.toolName} success=${entry.success} data=${entry.dataPreview}`
    );
  }
  lines.push(`  custom tools exposed to the inner agent: ${result.customToolNames.join(", ") || "(none)"}`);
  lines.push(`  backend tool_call_started events: ${backendEvents.join(" | ") || "(none)"}`);
  return lines;
}

async function main(): Promise<void> {
  const gateway = await startGateway();
  const lines: string[] = [];
  const say = (line = ""): void => {
    lines.push(line);
    console.log(line);
  };

  say("=== N-9 PROBE: outer loop after an accepted submit_result (docs/179, PL-M16) ===");
  say(`node ${process.versions.node}   maxIterations=${MAX_ITERATIONS}`);
  say();

  const a = await runThroughRunner("A_baseline", gateway.port, false);
  say("--- scenario A: baseline (current code) ---");
  say(HEADER);
  for (const round of a.rounds) say(roundLine(round));
  for (const line of summarise(a)) say(line);

  say();
  const b = await runThroughRunner("B_counterfactual", gateway.port, true);
  say("--- scenario B: counterfactual -- returned message rebuilt WITHOUT tool_calls ---");
  say(HEADER);
  for (const round of b.rounds) say(roundLine(round));
  for (const line of summarise(b)) say(line);

  say();
  const c = await runWithoutRecursionLimit(gateway.port);
  say("--- scenario C: graph invoked WITHOUT recursionLimit (pre-PL-M14 condition) ---");
  say(HEADER);
  for (const round of c.rounds) say(roundLine(round));
  for (const line of summarise(c)) say(line);

  say();
  say("--- VERDICT ---");
  const aSpins = a.rounds.length > 3 && a.rounds.every((r) => r.gatewayCallsInRound === 0) === false;
  const aZeroCallTail = a.rounds.slice(1).every((r) => r.gatewayCallsInRound === 0);
  say(
    `  A: ${a.rounds.length} rounds, status=${a.status}, code=${a.errorCode ?? "-"}; ` +
      `all rounds after the first made 0 model calls = ${aZeroCallTail}`
  );
  say(`  A spins to the guard: ${aSpins}`);
  say(
    `  B: ${b.rounds.length} rounds, status=${b.status}, code=${b.errorCode ?? "-"} ` +
      `(fix removes the spin: ${b.rounds.length < a.rounds.length})`
  );
  say(
    `  C: ${c.rounds.length} rounds, status=${c.status}, code=${c.errorCode ?? "-"}` +
      (c.runError ? `, error=${c.runError.slice(0, 80)}` : "")
  );
  const cIsRecursion = /recursion/i.test(`${c.runError ?? ""}${c.errorCode ?? ""}`);
  say(
    `  C died on the framework recursion limit: ${cIsRecursion} ` +
      `(=> N-7 was this same spin cut short: ${cIsRecursion && c.rounds.length < a.rounds.length})`
  );

  const report = lines.join("\n");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${report}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, "probe-measurements.json"),
    `${JSON.stringify(
      {
        maxIterations: MAX_ITERATIONS,
        scenarioA: a,
        scenarioB: b,
        scenarioC: c,
        verdict: {
          aSpins: aSpins,
          aAllRoundsAfterFirstMadeZeroModelCalls: aZeroCallTail,
          bRemovesSpin: b.rounds.length < a.rounds.length,
          cIsFrameworkRecursionLimit: cIsRecursion
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`\nreport written to ${OUT_DIR}`);

  await gateway.close();
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
