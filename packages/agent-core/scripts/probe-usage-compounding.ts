/**
 * N-8 (docs/176, PL-M15) stage-1 probe, part 2: WHERE does the blow-up come from?
 *
 * Stage 1 (`scripts/probe-usage-accounting.ts`) proved the accumulator is linear: a
 * scripted provider returning a constant per-call usage produced exactly
 * per_call * iterations, at every maxIterations. That left exactly one unexcluded
 * link in the chain:
 *
 *     DeepAgentLLMProvider.invoke -> totalTokenUsage(agentUsages(result))   (:87)
 *
 * `agentUsages` walks the INNER deep agent's WHOLE message list. That list is seeded
 * with the messages the OUTER loop hands in -- and the outer loop feeds back the
 * provider's own previous AIMessage, which carries the PREVIOUS round's accumulated
 * total. If those echoed messages are counted a second time, the reported total is
 * not a sum but a recurrence:
 *
 *     compounding :  T(1) = U(1) ;  T(n) = U(n) + sum_{k<n} T(k)   ~ 2^(n-1) * U
 *     correct     :  T(n) = U(n)                                   (own inner usage only)
 *
 * This probe decides between the two by running the REAL stack -- real ChatOpenAI,
 * real `deepagents` inner agent, real ToolRuntimeBackend, real DeepAgentLLMProvider
 * -- against a local recording gateway that answers with canned OpenAI-compatible
 * payloads. Offline, deterministic, zero gateway quota.
 *
 * Scenarios
 *   A_outer_loop    the real AgentRunner / AgentGraph outer loop, wired exactly as
 *                   `ProfessionalAgent.run` wires it (outcomeTool = submit_result,
 *                   maxIterations 50, maxRetries 1). The gateway scripts one tool call
 *                   plus one accepted `submit_result` per round, which is the shape the
 *                   production runs show. Records whether the outer loop continues, how
 *                   state.iteration moves, and the final reported total.
 *   B_two_rounds    consecutive provider.invoke calls, each fed the previous response
 *                   exactly as `AgentGraph.agentNode` feeds `state.messages` back
 *                   (`[SystemMessage(systemPrompt), ...state.messages]`). Isolates the
 *                   recurrence from everything else.
 *   C_inner_messages  dumps the inner deep agent's result message list for one round:
 *                   which messages carry a `usage_metadata`, and whether the caller's
 *                   messages come back by reference. This is what the fix has to key on.
 *
 * Deliberate simplifications (kept explicit -- the repo note is that a probe must match
 * production): the sandbox answers every command with the same canned stdout, and the
 * gateway's script is fixed. The scripted `read_file` path (`/probe.txt`) is outside the
 * backend agent's readPaths, so that call is denied by the backend before it ever reaches
 * the sandbox; the denial still produces a message and does not touch the accounting path.
 * The inner agent, the backend, the provider and the outer graph are all the production ones.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-usage-compounding.ts
 * Optional: --out <dir>     default packages/eval/results/n8-compounding-probe
 *           --cases <list>  comma-separated maxIterations for scenario A, default "50"
 *           --rounds <n>    rounds for scenario B, default 8
 * NOTE: keep this file ASCII-only.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { createPhase1Tools, ToolRuntime } from "@ai-se/tool-runtime";
import { createDeepAgent } from "deepagents";
import { AgentContext } from "../src/agent/AgentContext.js";
import { AgentLifecycleHooks } from "../src/agent/AgentLifecycle.js";
import { AgentRunner } from "../src/agent/AgentRunner.js";
import { createOpenAIChatModel, messageContentToText } from "../src/llm/LangChainLLMProvider.js";
import { LLMInvokeOptions, LLMProvider } from "../src/llm/LLMProvider.js";
import { totalTokenUsage } from "../src/llm/usage.js";
import { createAbortTerminationMiddleware } from "../src/professional/abortTermination.js";
import { PROFESSIONAL_AGENT_DEFINITIONS } from "../src/professional/AgentRegistry.js";
import { DeepAgentLLMProvider } from "../src/professional/DeepAgentLLMProvider.js";
import { createSubmitResultTerminationMiddleware, SUBMIT_RESULT_TOOL_NAME } from "../src/professional/submitResult.js";
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
  : join(REPO_ROOT, "packages/eval/results/n8-compounding-probe");
const CASES = (argValue("--cases") ?? "50")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const B_ROUNDS = Number(argValue("--rounds") ?? "8");

/** Constant per-call usage, so the arithmetic is exact and the recurrence is readable. */
const INPUT_PER_CALL = 1000;
const OUTPUT_PER_CALL = 200;

/* ------------------------------------------------------------------ recording gateway */

interface GatewayCallRecord {
  seq: number;
  scenario: string;
  round: number;
  messageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
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
 * Fixed two-call script per round: one ordinary tool call, then an ACCEPTED
 * `submit_result`. The second is what production does -- the termination middleware ends
 * the inner loop right there, and the message it ends on still carries `tool_calls`, so
 * the OUTER loop sees work to do and comes back around. That is the shape that runs the
 * outer loop to the guard.
 */
function scriptedMessage(callInRound: number): Record<string, unknown> {
  if (callInRound === 1) {
    return assistantMessage("", {
      id: "call_probe_read",
      name: "read_file",
      args: { file_path: "/probe.txt" }
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
      const messages = Array.isArray(body.messages)
        ? (body.messages as Record<string, unknown>[])
        : [];
      callSeq += 1;
      const callInRound =
        gatewayCalls.filter((entry) => entry.scenario === scenario && entry.round === currentRound)
          .length + 1;
      gatewayCalls.push({
        seq: callSeq,
        scenario,
        round: currentRound,
        messageCount: messages.length,
        assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
        toolMessageCount: messages.filter((m) => m.role === "tool").length
      });
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
      done({
        port,
        close: () => new Promise<void>((closed) => server.close(() => closed()))
      });
    });
  });
}

/* ------------------------------------------------------------------ stack under test */

/**
 * Permissive stub: the accounting defect does not live in tool execution, so every
 * command succeeds with the same canned stdout. A tool failure here would only add
 * noise to the round counts.
 */
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

interface Stack {
  provider: DeepAgentLLMProvider;
  backend: ToolRuntimeBackend;
  model: ReturnType<typeof createOpenAIChatModel>;
  systemPrompt: string;
}

function buildStack(port: number): Stack {
  const definition = backendAgentDefinition();
  const model = createOpenAIChatModel({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "probe-key",
    model: "probe-model"
  });
  const backend = new ToolRuntimeBackend({
    runtime: new ToolRuntime({ tools: createPhase1Tools() }),
    context: {
      requestId: "probe-request",
      taskId: "probe-task",
      agentRunId: "probe-run",
      actor: definition.name,
      workspacePath: REPO_ROOT,
      sandbox: new ProbeSandbox()
    },
    permissions: definition.permissions
  });
  const systemPrompt = withUntrustedInputClause(definition.systemInstructions);
  return {
    provider: new DeepAgentLLMProvider(
      model,
      definition,
      backend,
      SUBMIT_RESULT_TOOL_NAME,
      undefined
    ),
    backend,
    model,
    systemPrompt
  };
}

/* ------------------------------------------------------------------ recording wrapper */

interface RoundRecord {
  round: number;
  inputMessages: number;
  inputAIMessages: number;
  inputUsagesCarried: number;
  inputUsageInputTokens: number;
  inputUsageValues: number[];
  gatewayCallsInRound: number;
  returnedInputTokens: number | undefined;
  returnedOutputTokens: number | undefined;
  returnedTotalTokens: number | undefined;
  agentIterations: number | undefined;
  returnedToolCalls: string[];
  contentEmpty: boolean;
  error?: string;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scenarioCalls(): number {
  return gatewayCalls.filter((entry) => entry.scenario === scenario).length;
}

/**
 * Thin delegating decorator: it changes nothing about what the provider does, it only
 * observes what goes in and what comes back. Everything the accounting touches stays
 * the production implementation.
 */
class RecordingProvider implements LLMProvider {
  readonly rounds: RoundRecord[] = [];

  constructor(private readonly inner: LLMProvider) {}

  async invoke(messages: BaseMessage[], options?: LLMInvokeOptions): Promise<AIMessage> {
    currentRound += 1;
    const round = currentRound;
    const aiMessages = messages.filter((message): message is AIMessage =>
      AIMessage.isInstance(message)
    );
    const values: number[] = [];
    for (const message of aiMessages) {
      const usage = message.usage_metadata;
      if (typeof usage === "object" && usage !== null) {
        const input = (usage as Record<string, unknown>).input_tokens;
        if (typeof input === "number" && Number.isFinite(input)) values.push(input);
      }
    }
    const sum = totalTokenUsage(
      aiMessages.map((message) => message.usage_metadata).filter((usage) => usage !== undefined)
    );
    const sumInput = typeof sum?.input_tokens === "number" ? sum.input_tokens : 0;
    const callsBefore = scenarioCalls();
    const base = {
      round,
      inputMessages: messages.length,
      inputAIMessages: aiMessages.length,
      inputUsagesCarried: values.length,
      inputUsageInputTokens: sumInput,
      inputUsageValues: values
    };
    try {
      const response = await this.inner.invoke(messages, options);
      const returned = response.usage_metadata as Record<string, unknown> | undefined;
      const agentIterations = response.response_metadata?.agentIterations;
      this.rounds.push({
        ...base,
        gatewayCallsInRound: scenarioCalls() - callsBefore,
        returnedInputTokens: numeric(returned?.input_tokens),
        returnedOutputTokens: numeric(returned?.output_tokens),
        returnedTotalTokens: numeric(returned?.total_tokens),
        agentIterations: typeof agentIterations === "number" ? agentIterations : undefined,
        returnedToolCalls: (response.tool_calls ?? []).map((toolCall) => toolCall.name),
        contentEmpty: messageContentToText(response.content).trim() === ""
      });
      return response;
    } catch (error: unknown) {
      this.rounds.push({
        ...base,
        gatewayCallsInRound: scenarioCalls() - callsBefore,
        returnedInputTokens: undefined,
        returnedOutputTokens: undefined,
        returnedTotalTokens: undefined,
        agentIterations: undefined,
        returnedToolCalls: [],
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

function context(): AgentContext {
  return {
    requestId: "n8-compounding-probe",
    taskId: "n8-compounding-probe-task",
    agentRunId: "n8-compounding-probe-run",
    actor: "probe",
    workspacePath: REPO_ROOT,
    sandbox: new ProbeSandbox()
  };
}

/* ------------------------------------------------------------------ scenario A */

interface ScenarioAResult {
  maxIterations: number;
  rounds: RoundRecord[];
  gatewayCalls: number;
  iterations: number | undefined;
  status: string;
  errorCode: string | undefined;
  reportedInputTokens: number | undefined;
  trueInputTokens: number;
  iterationTrail: number[];
  runError?: string;
}

async function scenarioOuterLoop(port: number, maxIterations: number): Promise<ScenarioAResult> {
  scenario = `A_outer_loop@${maxIterations}`;
  currentRound = 0;
  const callsBefore = gatewayCalls.length;
  const iterationTrail: number[] = [];
  const lifecycle: AgentLifecycleHooks = {
    onIteration: async (record) => {
      iterationTrail.push(record.iteration);
    }
  };
  const { provider, systemPrompt } = buildStack(port);
  const recording = new RecordingProvider(provider);
  const runner = new AgentRunner({
    llmProvider: recording,
    toolRuntime: new ToolRuntime({ tools: createPhase1Tools() }),
    systemPrompt,
    defaultMaxIterations: 50,
    defaultTimeoutMs: 600_000,
    defaultMaxRetries: 1,
    lifecycle
  });
  let iterations: number | undefined;
  let status = "unknown";
  let errorCode: string | undefined;
  let reportedInputTokens: number | undefined;
  let runError: string | undefined;
  try {
    const result = await runner.run("probe task", context(), { maxIterations });
    iterations = result.iterations;
    status = result.status;
    errorCode = result.error?.code;
    reportedInputTokens = numeric(
      (result.tokenUsage as Record<string, unknown> | undefined)?.input_tokens
    );
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
  }
  const gatewayCallsHere = gatewayCalls.slice(callsBefore);
  return {
    maxIterations,
    rounds: recording.rounds,
    gatewayCalls: gatewayCallsHere.length,
    iterations,
    status,
    errorCode,
    reportedInputTokens,
    trueInputTokens: gatewayCallsHere.length * INPUT_PER_CALL,
    iterationTrail,
    runError
  };
}

/* ------------------------------------------------------------------ scenario B */

interface ScenarioBRound extends RoundRecord {
  expectedCompounding: number;
  expectedLinear: number;
}

interface ScenarioBResult {
  rounds: ScenarioBRound[];
  gatewayCalls: number;
  trueInputTokens: number;
}

/**
 * Replays `AgentGraph.agentNode`'s provider call exactly: system prompt, then the state
 * messages, with the previous round's response appended each time. The graph itself is
 * left out on purpose -- this scenario is about the provider's arithmetic, and the graph
 * is already exercised by scenario A.
 */
async function scenarioTwoRounds(port: number, roundCount: number): Promise<ScenarioBResult> {
  scenario = `B_two_rounds@${roundCount}`;
  currentRound = 0;
  const callsBefore = gatewayCalls.length;
  const { provider, systemPrompt } = buildStack(port);
  const recording = new RecordingProvider(provider);
  recording.bindTools([]);

  const stateMessages: BaseMessage[] = [new HumanMessage("probe task")];
  for (let index = 0; index < roundCount; index += 1) {
    const response = await recording.invoke([new SystemMessage(systemPrompt), ...stateMessages]);
    stateMessages.push(response);
  }

  // The two competing predictions, both derived from the measured data rather than from an
  // assumed calls-to-tokens mapping: every round runs the same script, so a round's own
  // contribution is the first round's returned value.
  //   correct     -> every round reports its own contribution (flat)
  //   compounding -> T(n) = sum_{k<n} T(k) + own
  const own = recording.rounds[0]?.returnedInputTokens ?? 0;
  let runningCompounding = 0;
  const rounds: ScenarioBRound[] = recording.rounds.map((round) => {
    const expectedCompounding = runningCompounding + own;
    runningCompounding = expectedCompounding;
    return { ...round, expectedLinear: own, expectedCompounding };
  });

  return {
    rounds,
    gatewayCalls: gatewayCalls.length - callsBefore,
    trueInputTokens: (gatewayCalls.length - callsBefore) * INPUT_PER_CALL
  };
}

/* ------------------------------------------------------------------ scenario C */

interface InnerMessageDump {
  index: number;
  className: string;
  role: string;
  isAIMessage: boolean;
  inputIndex: number;
  usageInputTokens: number | undefined;
  toolCalls: string;
  preview: string;
}

interface ScenarioCResult {
  inputMessages: number;
  innerMessages: number;
  dumped: InnerMessageDump[];
  aiMessagesWithUsage: number;
  agentUsagesSum: number;
  echoCount: number;
  echoSum: number;
  ownSum: number;
  finalMessageIsEcho: boolean;
  gatewayCalls: number;
}

/**
 * One inner round, dumped. `createDeepAgent` is constructed here the same way
 * `DeepAgentLLMProvider.invoke` constructs it (same model, backend, tools, middleware),
 * so the message list observed is the one the provider's `agentUsages` walks. The point
 * is to see which entries carry usage and whether the caller's own messages come back.
 */
async function scenarioInnerMessages(port: number): Promise<ScenarioCResult> {
  scenario = "C_inner_messages";
  currentRound = 0;
  const callsBefore = gatewayCalls.length;
  const { backend, model, systemPrompt } = buildStack(port);
  const agent = createDeepAgent({
    name: backendAgentDefinition().name,
    model,
    backend,
    tools: backend.createCustomTools(),
    systemPrompt,
    checkpointer: false,
    subagents: [],
    middleware: [
      createAbortTerminationMiddleware(undefined),
      createSubmitResultTerminationMiddleware(SUBMIT_RESULT_TOOL_NAME)
    ]
  });
  const previous = new AIMessage({
    content: "previous round answer",
    usage_metadata: { input_tokens: 12345, output_tokens: 7, total_tokens: 12352 }
  });
  const input: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage("probe task"),
    previous
  ];
  const result = (await agent.invoke(
    { messages: input },
    { configurable: { thread_id: backend.id } }
  )) as { messages: BaseMessage[] };
  const messages = result.messages;

  let agentUsagesSum = 0;
  let echoCount = 0;
  let echoSum = 0;
  let ownSum = 0;
  const dumped: InnerMessageDump[] = messages.map((message, index) => {
    const usage = AIMessage.isInstance(message) ? message.usage_metadata : undefined;
    const inputTokens =
      typeof usage === "object" && usage !== null
        ? numeric((usage as Record<string, unknown>).input_tokens)
        : undefined;
    const isAI = AIMessage.isInstance(message);
    const inputIndex = input.indexOf(message);
    if (isAI && inputTokens !== undefined) {
      agentUsagesSum += inputTokens;
      if (inputIndex >= 0) {
        echoCount += 1;
        echoSum += inputTokens;
      } else {
        ownSum += inputTokens;
      }
    }
    return {
      index,
      className: message.constructor.name,
      role: message.getType(),
      isAIMessage: isAI,
      inputIndex,
      usageInputTokens: inputTokens,
      toolCalls: AIMessage.isInstance(message)
        ? (message.tool_calls ?? []).map((call) => call.name).join("+") || "-"
        : "-",
      preview: messageContentToText(message.content).replace(/\s+/g, " ").slice(0, 30)
    };
  });

  const lastAI = [...messages].reverse().find((message) => AIMessage.isInstance(message));

  return {
    inputMessages: input.length,
    innerMessages: messages.length,
    dumped,
    aiMessagesWithUsage: dumped.filter((entry) => entry.usageInputTokens !== undefined).length,
    agentUsagesSum,
    echoCount,
    echoSum,
    ownSum,
    finalMessageIsEcho: lastAI !== undefined && input.indexOf(lastAI) >= 0,
    gatewayCalls: gatewayCalls.length - callsBefore
  };
}

/* ------------------------------------------------------------------ report */

function roundLine(round: RoundRecord): string {
  return [
    String(round.round).padStart(4),
    String(round.inputMessages).padStart(6),
    String(round.inputUsagesCarried).padStart(6),
    String(round.inputUsageInputTokens).padStart(16),
    String(round.gatewayCallsInRound).padStart(6),
    String(round.returnedInputTokens ?? "(none)").padStart(20),
    String(round.agentIterations ?? "-").padStart(6),
    round.returnedToolCalls.length > 0 ? round.returnedToolCalls.join("+") : "-"
  ].join("  ");
}

const HEADER =
  " rnd  inMsgs  inUsg  inUsgInputTokens   calls       returnedInputTokens   agentIt  toolCalls";

async function main(): Promise<void> {
  const gateway = await startGateway();
  const lines: string[] = [];
  const say = (line = ""): void => {
    lines.push(line);
    console.log(line);
  };

  say("=== N-8 PROBE (part 2): where does the usage blow-up come from? ===");
  say(
    `node ${process.versions.node}   per-call usage: input=${INPUT_PER_CALL} output=${OUTPUT_PER_CALL}`
  );
  say();

  /* ---------------------------------------------------------------- scenario A */
  say("--- scenario A: the real AgentRunner / AgentGraph outer loop ---");
  const aResults: ScenarioAResult[] = [];
  for (const maxIterations of CASES) {
    const result = await scenarioOuterLoop(gateway.port, maxIterations);
    aResults.push(result);
    say();
    say(`A maxIterations=${maxIterations}`);
    say(HEADER);
    for (const round of result.rounds) say(roundLine(round));
    say(
      `  rounds=${result.rounds.length}  gatewayCalls=${result.gatewayCalls}  ` +
        `state.iteration trail=[${result.iterationTrail.join(",")}]`
    );
    say(
      `  run: status=${result.status} code=${result.errorCode ?? "-"} iterations=${result.iterations ?? "-"} ` +
        `reportedInputTokens=${result.reportedInputTokens ?? "(none)"} trueInputTokens=${result.trueInputTokens}` +
        (result.runError ? `  runError=${result.runError}` : "")
    );
    const ratio =
      result.reportedInputTokens !== undefined && result.trueInputTokens > 0
        ? result.reportedInputTokens / result.trueInputTokens
        : undefined;
    say(`  reported / true = ${ratio === undefined ? "(none)" : ratio.toExponential(3)}`);
  }

  /* ---------------------------------------------------------------- scenario B */
  say();
  say(`--- scenario B: consecutive provider.invoke rounds (n=${B_ROUNDS}) ---`);
  const bResult = await scenarioTwoRounds(gateway.port, B_ROUNDS);
  say();
  say(
    " rnd  inMsgs  inUsg  inUsgInputTokens   calls       returnedInputTokens   " +
      "linearPred  compoundPred"
  );
  for (const round of bResult.rounds) {
    say(
      [
        String(round.round).padStart(4),
        String(round.inputMessages).padStart(6),
        String(round.inputUsagesCarried).padStart(6),
        String(round.inputUsageInputTokens).padStart(16),
        String(round.gatewayCallsInRound).padStart(6),
        String(round.returnedInputTokens ?? "(none)").padStart(20),
        String(round.expectedLinear).padStart(11),
        String(round.expectedCompounding).padStart(13)
      ].join("  ")
    );
  }
  say(`  trueInputTokens (all gateway calls) = ${bResult.trueInputTokens}`);

  /* ---------------------------------------------------------------- scenario C */
  say();
  say("--- scenario C: the inner deep agent's result message list (one round) ---");
  const cResult = await scenarioInnerMessages(gateway.port);
  say(
    `  inputMessages=${cResult.inputMessages}  innerMessages=${cResult.innerMessages}  gatewayCalls=${cResult.gatewayCalls}`
  );
  say(" idx  class                 role        isAI  inputIndex  usageInputTokens  toolCalls       preview");
  for (const entry of cResult.dumped) {
    say(
      [
        String(entry.index).padStart(4),
        entry.className.padEnd(21),
        entry.role.padEnd(10),
        (entry.isAIMessage ? "yes" : "no").padStart(5),
        String(entry.inputIndex).padStart(11),
        String(entry.usageInputTokens ?? "-").padStart(17),
        entry.toolCalls.padEnd(15),
        entry.preview
      ].join("  ")
    );
  }
  say(
    `  AIMessages with usage=${cResult.aiMessagesWithUsage}  agentUsages sum=${cResult.agentUsagesSum}  ` +
      `echoed(count=${cResult.echoCount}, sum=${cResult.echoSum})  own(sum=${cResult.ownSum})`
  );
  say(`  finalMessage is one of the caller's messages: ${cResult.finalMessageIsEcho}`);
  if (cResult.aiMessagesWithUsage < cResult.gatewayCalls) {
    say(
      `  OBSERVATION (not investigated, out of scope): the gateway served ${cResult.gatewayCalls} ` +
        `model calls this round, but only ${cResult.aiMessagesWithUsage} AIMessage(s) carrying a`
    );
    say(
      "  usage_metadata appear in result.messages. Under THIS probe's script the reported per-round"
    );
    say(
      "  total is therefore below the calls actually made. Whether that holds for production round"
    );
    say("  shapes was NOT determined here. It is the opposite direction from N-8 (over-counting),");
    say("  it is not fixed in this batch, and it is registered as an open item.");
  }

  /* ---------------------------------------------------------------- verdict */
  say();
  say("--- VERDICT ---");
  const bMatches = bResult.rounds.map((round) => {
    const returned = round.returnedInputTokens;
    if (returned === undefined) return "none";
    const linear = returned === round.expectedLinear;
    const compound = returned === round.expectedCompounding;
    // Round 1 ties by construction (nothing has been fed back yet), so a tie is not evidence.
    if (linear && compound) return "tie";
    if (linear) return "linear";
    if (compound) return "compound";
    return "neither";
  });
  say(`  scenario B per-round match: ${bMatches.join(", ")}`);
  const anyCompound = bMatches.includes("compound");
  const anyLinear = bMatches.includes("linear");
  if (anyCompound && !anyLinear) {
    say("  N8-COMPOUNDING  the provider re-counts the AIMessages the outer loop fed back.");
    say("                  The blow-up is in DeepAgentLLMProvider.invoke, not the accumulator.");
  } else if (anyLinear && !anyCompound) {
    say("  N8-LINEAR      each round reports only its own inner usage; no compounding observed.");
  } else {
    say("  N8-MIXED/INCONCLUSIVE  rounds do not match either prediction cleanly; read the table.");
  }
  say(`  scenario C: caller's messages echoed back by reference = ${cResult.echoCount > 0}`);

  const report = lines.join("\n");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${report}\n`, "utf8");
  writeFileSync(
    join(OUT_DIR, "probe-measurements.json"),
    `${JSON.stringify(
      {
        inputPerCall: INPUT_PER_CALL,
        outputPerCall: OUTPUT_PER_CALL,
        scenarioA: aResults,
        scenarioB: bResult,
        scenarioC: cResult,
        bMatches,
        verdict:
          anyCompound && !anyLinear
            ? "N8-COMPOUNDING"
            : anyLinear && !anyCompound
              ? "N8-LINEAR"
              : "N8-MIXED"
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
