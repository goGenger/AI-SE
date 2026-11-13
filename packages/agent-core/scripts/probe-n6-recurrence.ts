/**
 * N-6 RECURRENCE (docs/181, PL-M17) stage-1 probe: where does the gateway's
 * "reasoning_content must be passed back" 400 actually come from, now that PL-M13's two
 * rebuild points are fixed?
 *
 * L1-M4h (three E1x3 runs) produced SIX occurrences: five agent runs died on
 * `agent_runs.error` containing `reasoning_content`, and one `llm_retry` fired in a run
 * that still succeeded. Every one of them died INSIDE the inner deep agent loop (no
 * `agent_action` / `agent_final` event for those runs), which is the path PL-M16 does not
 * touch. PL-M13's own Known Issue 6 predicted exactly this: "if it still recurs after the
 * fix, there is either a second platform-side cause or it is gateway-side".
 *
 * WHAT THIS PROBE ADDS OVER PL-M13's PROBE (docs/173):
 *   PL-M13's fake gateway answered EVERY request with 200 and a canned body. It could
 *   therefore measure "does the platform emit reasoning_content when the message carries
 *   it" (INV-1) but it could NOT measure "under what condition does the gateway refuse".
 *   This probe's gateway ENFORCES the gateway's rule:
 *
 *     a request is rejected with the same 400 if it contains an assistant message that
 *     carries tool_calls but no non-empty reasoning_content
 *
 *   and the scripted responses deliberately STOP carrying `reasoning_content` partway
 *   through a conversation, which is how the real gateway behaves intermittently
 *   (docs/173 Known Issue 6: "when the gateway demands it back is still uncontrollable").
 *
 * HYPOTHESIS UNDER TEST (docs/181 sec.2.5, H-A -- a hypothesis, not a conclusion):
 *   the 400 fires when the outbound request holds an assistant message with tool_calls and
 *   no reasoning_content, because the gateway never returned reasoning_content for the
 *   turn that produced that message -- and the platform cannot manufacture a field it
 *   never received.
 *
 * SCENARIOS (all drive the REAL stack: real ChatOpenAI, real deepagents inner agent, real
 * ToolRuntimeBackend, real DeepAgentLLMProvider, real AgentRunner/AgentGraph; only the
 * endpoint is faked -- offline, deterministic, zero gateway quota):
 *   A_all_reasoning      every scripted response carries reasoning_content. Control: the
 *                        rule predicate should never be met and the run should complete.
 *   B_reasoning_stops    the scripted responses carry reasoning_content on turn 1 and then
 *                        STOP. If H-A holds, the request that follows the reasoning-less
 *                        tool-call turn is rejected by the rule.
 *   C_no_reasoning_at_all  no scripted response ever carries reasoning_content. The
 *                        sharpest form of the same condition.
 *
 * PER-REQUEST FINDING (independent of whether the gateway rejected):
 *   RULE-PREDICATE  the request holds an assistant message with tool_calls and no
 *                   reasoning_content -- i.e. the request WOULD be rejected by a gateway
 *                   in thinking mode. Printed for every recorded body, with the message's
 *                   tool names, so the offending turn can be traced to its source.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-n6-recurrence.ts
 * Optional: --out <dir>   default packages/eval/results/n6-recurrence-probe
 * NOTE: keep this file ASCII-only.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { createPhase1Tools, ToolRuntime } from "@ai-se/tool-runtime";
import { AgentContext } from "../src/agent/AgentContext.js";
import { AgentLifecycleHooks } from "../src/agent/AgentLifecycle.js";
import { AgentRunner } from "../src/agent/AgentRunner.js";
import { createOpenAIChatModel } from "../src/llm/LangChainLLMProvider.js";
import { PROFESSIONAL_AGENT_DEFINITIONS } from "../src/professional/AgentRegistry.js";
import { DeepAgentLLMProvider } from "../src/professional/DeepAgentLLMProvider.js";
import { createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "../src/professional/submitResult.js";
import { ToolRuntimeBackend } from "../src/professional/ToolRuntimeBackend.js";
import { withUntrustedInputClause } from "../src/professional/untrustedInput.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const REASONING = "PROBE_REASONING_SENTINEL";
const MAX_ITERATIONS = 12;

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old; use Node >= 22.`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}
// Resolved against the repo root: `pnpm --filter <pkg> exec` runs with the PACKAGE as its
// working directory, so a bare relative --out would land inside the package.
const OUT_DIR = resolve(
  REPO_ROOT,
  argValue("--out") ?? "packages/eval/results/n6-recurrence-probe"
);

/* ------------------------------------------------------------------ the gateway rule */

/**
 * The gateway's rule, transcribed -- and MEASURED, not guessed.
 *
 * `probe-n6-gateway-rule.ts` asked the real endpoint directly and got:
 *   R1 assistant(tool_calls, no reasoning_content)          -> 400 (this very error)
 *   R2 assistant(tool_calls, reasoning_content: "")         -> 200
 *   R3 assistant(tool_calls, reasoning_content: " ")        -> 200
 *   R4 assistant(tool_calls, reasoning_content: "<text>")   -> 200
 *   R5 tool_calls dropped, tool result kept                 -> 400 (a DIFFERENT error:
 *      "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'")
 *   R6 assistant + tool result both dropped                 -> 200
 *
 * So the rule is about PRESENCE, not about being non-empty: an empty string satisfies it.
 * That is what makes the fix possible at all -- the platform can send "" for a turn the
 * gateway never gave reasoning for, without inventing content and without changing the
 * conversation's meaning (tool_calls and tool results both stay).
 */
function ruleViolation(messages: Record<string, unknown>[]): number | null {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const calls = message.tool_calls;
    const hasCalls = Array.isArray(calls) && calls.length > 0;
    if (message.role !== "assistant" || !hasCalls) continue;
    if (typeof message.reasoning_content !== "string") return index;
  }
  return null;
}

const GATEWAY_400 =
  "400 Upstream request failed: [invalid_request_error] The `reasoning_content` in the " +
  "thinking mode must be passed back to the API. (request_id: probe-recurrence)";

/* ------------------------------------------------------------------ recording gateway */

interface ScriptedTurn {
  /** Does this response carry `reasoning_content`? This is the intermittency knob. */
  reasoning: boolean;
  /** Tool calls to return. Empty => a final answer. */
  tools?: { name: string; args: Record<string, unknown> }[];
  content?: string;
}

interface Recorded {
  seq: number;
  scenario: string;
  turnIndex: number;
  rejected: boolean;
  violationIndex: number | null;
  messages: {
    role: string;
    hasToolCalls: boolean;
    /** absent = the field never went out; empty = present but ""; text = real content. */
    reasoning: "absent" | "empty" | "text";
    preview: string;
  }[];
}

const recorded: Recorded[] = [];
let scenario = "unset";
let script: ScriptedTurn[] = [];
let turnIndex = 0;
let seq = 0;
let rejectionCount = 0;

function openAiMessage(turn: ScriptedTurn): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: turn.content ?? ""
  };
  if (turn.reasoning) message.reasoning_content = REASONING;
  if (turn.tools && turn.tools.length > 0) {
    message.tool_calls = turn.tools.map((tool, index) => ({
      id: `call_${index}_${turnIndex}`,
      type: "function",
      function: { name: tool.name, arguments: JSON.stringify(tool.args) }
    }));
  }
  return message;
}

function completion(message: Record<string, unknown>, finish: string): string {
  return JSON.stringify({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
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
      seq += 1;
      const rawMessages = body.messages;
      const messages = Array.isArray(rawMessages)
        ? (rawMessages as Record<string, unknown>[])
        : [];
      const violationIndex = ruleViolation(messages);
      const rejected = violationIndex !== null;
      if (rejected) rejectionCount += 1;

      recorded.push({
        seq,
        scenario,
        turnIndex,
        rejected,
        violationIndex,
        messages: messages.map((message) => ({
          role: String(message.role ?? "?"),
          hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
          reasoning:
            typeof message.reasoning_content !== "string"
              ? ("absent" as const)
              : message.reasoning_content.length > 0
                ? ("text" as const)
                : ("empty" as const),
          preview:
            typeof message.content === "string"
              ? message.content.replace(/\s+/g, " ").slice(0, 32)
              : JSON.stringify(message.content ?? null).slice(0, 32)
        }))
      });

      if (rejected) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: GATEWAY_400, type: "invalid_request_error" } }));
        return;
      }

      const turn = script[turnIndex] ?? { reasoning: true, content: "probe final answer" };
      turnIndex += 1;
      const message = openAiMessage(turn);
      const finish = message.tool_calls ? "tool_calls" : "stop";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion(message, finish));
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

class ProbeSandbox implements Sandbox {
  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    if (command.command.startsWith("cat -- ")) {
      return {
        command: command.command,
        exitCode: 0,
        stdout: "PROBE_FILE_LINE_ONE\nPROBE_FILE_LINE_TWO\n",
        stderr: "",
        duration: 1,
        timedOut: false
      };
    }
    throw new Error(`probe sandbox is not scripted (command: ${command.command})`);
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

function probeContext(): AgentContext {
  return {
    requestId: "n6-recurrence-probe",
    taskId: "n6-recurrence-probe-task",
    agentRunId: "n6-recurrence-probe-run",
    actor: "probe",
    workspacePath: REPO_ROOT,
    sandbox: new ProbeSandbox()
  };
}

interface ScenarioResult {
  name: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  iterations?: number;
  runError?: string;
  gatewayCalls: number;
  rejections: number;
  predicateRequests: number;
}

async function runScenario(
  name: string,
  port: number,
  turns: ScriptedTurn[]
): Promise<ScenarioResult> {
  scenario = name;
  script = turns;
  turnIndex = 0;
  const seqBefore = seq;
  const rejectionsBefore = rejectionCount;

  const definition = backendAgentDefinition();
  const model = createOpenAIChatModel({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "probe-key",
    model: "probe-model"
  });
  const backend = new ToolRuntimeBackend({
    runtime: new ToolRuntime({ tools: probeTools() }),
    context: probeContext(),
    permissions: definition.permissions
  });
  const provider = new DeepAgentLLMProvider(model, definition, backend, SUBMIT_RESULT_TOOL_NAME);
  const lifecycle: AgentLifecycleHooks = {};
  const runner = new AgentRunner({
    llmProvider: provider,
    toolRuntime: new ToolRuntime({ tools: probeTools() }),
    systemPrompt: withUntrustedInputClause(definition.systemInstructions),
    defaultMaxIterations: MAX_ITERATIONS,
    defaultTimeoutMs: 600_000,
    defaultMaxRetries: 1,
    lifecycle
  });

  let status = "unknown";
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let iterations: number | undefined;
  let runError: string | undefined;
  try {
    const result = await runner.run("probe task", probeContext(), {
      maxIterations: MAX_ITERATIONS
    });
    status = result.status;
    errorCode = result.error?.code;
    errorMessage = result.error?.message;
    iterations = result.iterations;
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
  }

  const mine = recorded.filter((entry) => entry.seq > seqBefore);
  return {
    name,
    status,
    errorCode,
    errorMessage,
    iterations,
    runError,
    gatewayCalls: seq - seqBefore,
    rejections: rejectionCount - rejectionsBefore,
    predicateRequests: mine.filter((entry) => entry.violationIndex !== null).length
  };
}

/* ------------------------------------------------------------------ scripts */

/** Turn 1 has reasoning, turn 2 does not -- the intermittency the real gateway shows. */
function turnsReasoningStops(): ScriptedTurn[] {
  return [
    { reasoning: true, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: false, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: true, content: "probe final answer" }
  ];
}

function turnsNoReasoningAtAll(): ScriptedTurn[] {
  return [
    { reasoning: false, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: false, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: false, content: "probe final answer" }
  ];
}

function turnsAllReasoning(): ScriptedTurn[] {
  return [
    { reasoning: true, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: true, tools: [{ name: "read_file", args: { file_path: "src/probe.txt" } }] },
    { reasoning: true, content: "probe final answer" }
  ];
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const gateway = await startGateway();
  const results: ScenarioResult[] = [];

  results.push(await runScenario("A_all_reasoning", gateway.port, turnsAllReasoning()));
  results.push(await runScenario("B_reasoning_stops", gateway.port, turnsReasoningStops()));
  results.push(await runScenario("C_no_reasoning_at_all", gateway.port, turnsNoReasoningAtAll()));

  await gateway.close();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "captured-bodies.json"), JSON.stringify(recorded, null, 2), "utf8");

  const lines: string[] = [];
  const say = (line = "") => {
    lines.push(line);
    console.log(line);
  };

  say("=== N-6 RECURRENCE PROBE (docs/181, PL-M17) ===");
  say(`node ${process.versions.node}   bodies written to ${join(OUT_DIR, "captured-bodies.json")}`);
  say("gateway rule: reject when an assistant message has tool_calls but no reasoning_content");
  say();

  for (const entry of recorded) {
    say(
      `--- request #${entry.seq}  scenario=${entry.scenario}  turn=${entry.turnIndex}  ` +
        `${entry.rejected ? "REJECTED (400)" : "accepted"} ---`
    );
    say(`  messages=${entry.messages.length}`);
    entry.messages.forEach((message, index) => {
      const flag = index === entry.violationIndex ? "  <== RULE PREDICATE" : "";
      say(
        `    [${index}] role=${message.role.padEnd(9)} tool_calls=${message.hasToolCalls ? "Y" : "n"} ` +
          `reasoning=${message.reasoning.padEnd(6)} ${message.preview}${flag}`
      );
    });
    say();
  }

  say("=== SCENARIO RESULTS ===");
  for (const result of results) {
    say(`  ${result.name}`);
    say(`    status=${result.status}${result.errorCode ? ` code=${result.errorCode}` : ""}`);
    say(
      `    gatewayCalls=${result.gatewayCalls} rejections=${result.rejections} ` +
        `requestsHittingRule=${result.predicateRequests}`
    );
    if (result.errorMessage) say(`    error=${result.errorMessage.replace(/\s+/g, " ").slice(0, 110)}`);
    if (result.runError) say(`    runError=${result.runError.replace(/\s+/g, " ").slice(0, 110)}`);
    say();
  }

  const control = results.find((result) => result.name === "A_all_reasoning");
  const stop = results.find((result) => result.name === "B_reasoning_stops");
  const none = results.find((result) => result.name === "C_no_reasoning_at_all");

  say("=== VERDICT ===");
  say(
    `  A control (every response carries reasoning): rule predicate met in ` +
      `${control?.predicateRequests ?? 0} request(s), gateway rejections ${control?.rejections ?? 0}`
  );
  say(
    `  B reasoning stops mid-conversation: rule predicate met in ` +
      `${stop?.predicateRequests ?? 0} request(s), gateway rejections ${stop?.rejections ?? 0}`
  );
  say(
    `  C no reasoning at all: rule predicate met in ` +
      `${none?.predicateRequests ?? 0} request(s), gateway rejections ${none?.rejections ?? 0}`
  );
  say();
  say("  H-A holds if A meets the predicate 0 times while B/C meet it and are rejected.");
  say("  If H-A holds, the platform cannot fix it by rebuilding a message: the field was");
  say("  never returned by the gateway for that turn, so no rebuild can restore it.");
  say("===============================================");

  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${lines.join("\n")}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
