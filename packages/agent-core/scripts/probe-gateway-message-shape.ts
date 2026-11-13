/**
 * N-6 (docs/172, PL-M13) stage-1 probe: capture the REAL outbound message shape.
 *
 * Why this exists: the gateway rejects two message shapes with 400
 *   (1) "The `reasoning_content` in the thinking mode must be passed back to the API."
 *   (2) "tool message content must be a string on the gRPC path"
 * Static reading of the platform + the `deepagents` library could not pin down where
 * the offending bytes come from, so this probe records what the platform ACTUALLY
 * sends, using the real factories:
 *
 *   createOpenAIChatModel  ->  real ChatOpenAI  ->  real @langchain/openai converter
 *   ToolRuntimeBackend     ->  real backend (stub sandbox; no tool is called here)
 *   DeepAgentLLMProvider   ->  real inner deep agent (deepagents createDeepAgent)
 *
 * Only the ENDPOINT is faked: a local recording server that answers with canned
 * OpenAI-compatible payloads (including `reasoning_content`) and keeps every request
 * body. That makes the probe deterministic, offline and free of gateway quota, while
 * the bytes on the wire are still produced by the platform's own code path.
 *
 * Scenarios
 *   A_initial      provider.invoke([Human])                        -> record #1
 *   B_accumulate   provider.invoke([Human, <A's AIMessage>])       -> record #2
 *                  This is exactly the shape AgentGraph's outer loop feeds back
 *                  (agentNode returns `messages: [response]` into state.messages).
 *   C_control      provider.invoke([Human, <AIMessage WITH additional_kwargs.reasoning_content>])
 *                  The A/B pair for invariant 1: same converter, field present vs lost.
 *   E_tool_array   model.invoke([Human, AI(tool_calls), ToolMessage(content=[...])])
 *   F_tool_object  model.invoke([Human, AI(tool_calls), ToolMessage(content={...})])
 *                  Invariant 2: can a NON-string tool content even reach the wire?
 *
 * Invariants checked on every recorded body
 *   INV-1  an assistant message whose source carried reasoning_content must go out with it
 *   INV-2  every role:"tool" message must carry a string content
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-gateway-message-shape.ts
 * Optional: --out <dir>   default packages/eval/results/n6-probe
 * NOTE: keep this file ASCII-only.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { createPhase1Tools, ToolRuntime } from "@ai-se/tool-runtime";
import { createOpenAIChatModel } from "../src/llm/LangChainLLMProvider.js";
import { ToolRuntimeBackend } from "../src/professional/ToolRuntimeBackend.js";
import { DeepAgentLLMProvider } from "../src/professional/DeepAgentLLMProvider.js";
import { PROFESSIONAL_AGENT_DEFINITIONS } from "../src/professional/AgentRegistry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const REASONING = "PROBE_REASONING_SENTINEL";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old; use Node >= 22.`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}
const OUT_DIR = argValue("--out") ?? join(REPO_ROOT, "packages/eval/results/n6-probe");

/* ------------------------------------------------------------------ recording gateway */

interface Recorded {
  seq: number;
  scenario: string;
  stream: boolean;
  body: Record<string, unknown>;
}

const recorded: Recorded[] = [];
let scenario = "unset";
let queue: Record<string, unknown>[] = [];
let seq = 0;

/** Canned assistant message. `extra` is merged into the message object (e.g. tool_calls). */
function canned(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", content, reasoning_content: REASONING, ...extra };
}
const DEFAULT_MESSAGE = canned("probe final answer");

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

function sse(message: Record<string, unknown>, finish: string): string {
  const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 0, model: "probe-model" };
  const delta: Record<string, unknown> = { role: "assistant" };
  if (typeof message.content === "string" && message.content !== "") delta.content = message.content;
  if (typeof message.reasoning_content === "string") delta.reasoning_content = message.reasoning_content;
  if (message.tool_calls) delta.tool_calls = message.tool_calls;
  const parts = [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n"
  ];
  return parts.join("");
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
      const streaming = body.stream === true;
      recorded.push({ seq, scenario, stream: streaming, body });

      const message = (queue.shift() as Record<string, unknown>) ?? DEFAULT_MESSAGE;
      const finish = message.tool_calls ? "tool_calls" : "stop";
      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(message, finish));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(completion(message, finish));
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

/** Scenario G drives the real `read_file` tool, so `cat -- <path>` must be answerable. */
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

function buildProvider(port: number): DeepAgentLLMProvider {
  const definition = PROFESSIONAL_AGENT_DEFINITIONS.find((entry) => entry.type === "BACKEND");
  if (!definition) throw new Error("no BACKEND agent definition found");
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
  return new DeepAgentLLMProvider(model, definition, backend);
}

/* ------------------------------------------------------------------ analysis */

interface Shape {
  role: string;
  contentType: string;
  reasoning: boolean;
  preview: string;
}

function shapeOf(message: Record<string, unknown>): Shape {
  const content = message.content;
  const contentType =
    content === null || content === undefined
      ? String(content)
      : Array.isArray(content)
        ? "array"
        : typeof content;
  const reasoning =
    typeof message.reasoning_content === "string" && message.reasoning_content.length > 0;
  const preview = typeof content === "string" ? content.slice(0, 40) : JSON.stringify(content ?? null).slice(0, 40);
  return { role: String(message.role ?? "?"), contentType, reasoning, preview };
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages = body.messages;
  return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
}

/* ------------------------------------------------------------------ main */

const scenarioErrors: string[] = [];

/** A scenario that throws locally (before any request is sent) is itself a finding. */
async function runScenario(name: string, body: () => Promise<void>): Promise<void> {
  scenario = name;
  try {
    await body();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    scenarioErrors.push(`${name}: ${message}`);
    console.log(`[${name}] threw locally: ${message}`);
  }
}

async function main(): Promise<void> {
  const gateway = await startGateway();
  const provider = buildProvider(gateway.port);
  const human = new HumanMessage("probe task");
  const model = createOpenAIChatModel({
    baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
    apiKey: "probe-key",
    model: "probe-model"
  });
  const toolCall = { name: "probe_tool", args: {}, id: "call_probe", type: "tool_call" };
  const withCall = new AIMessage({ content: "", tool_calls: [toolCall as never] });

  // A_initial
  let a: AIMessage | undefined;
  await runScenario("A_initial", async () => {
    queue = [canned("A answer")];
    a = await provider.invoke([human]);
  });

  // B_accumulate - the exact shape AgentGraph's outer loop feeds back
  await runScenario("B_accumulate", async () => {
    queue = [canned("B answer")];
    await provider.invoke(a ? [human, a] : [human]);
  });

  // C_control - same converter, but the assistant message still carries the field
  await runScenario("C_control", async () => {
    queue = [canned("C answer")];
    await provider.invoke([
      human,
      new AIMessage({ content: "C answer", additional_kwargs: { reasoning_content: REASONING } })
    ]);
  });

  // G - drive the REAL read_file tool end to end, so its tool message is observed on the wire
  await runScenario("G_real_read_file", async () => {
    queue = [
      canned("", {
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ file_path: "/src/probe.txt" })
            }
          }
        ]
      }),
      canned("G answer")
    ];
    await provider.invoke([human]);
  });

  // E/F - can a non-string tool content reach the wire at all?
  await runScenario("E_tool_array", async () => {
    queue = [canned("E answer")];
    await model.invoke([
      human,
      withCall,
      new ToolMessage({ content: ["block-a", "block-b"] as never, tool_call_id: "call_probe" })
    ]);
  });

  await runScenario("F_tool_object", async () => {
    queue = [canned("F answer")];
    await model.invoke([
      human,
      withCall,
      new ToolMessage({ content: { ok: true, nested: { n: 1 } } as never, tool_call_id: "call_probe" })
    ]);
  });

  await gateway.close();

  /* ---------------------------------------------------------------- report */

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "captured-bodies.json"), JSON.stringify(recorded, null, 2), "utf8");

  const lines: string[] = [];
  const say = (line = "") => {
    lines.push(line);
    console.log(line);
  };

  say("=== N-6 PROBE: outbound message shape (docs/172, PL-M13) ===");
  say(`node ${process.versions.node}   bodies written to ${join(OUT_DIR, "captured-bodies.json")}`);
  say();

  const inv1: string[] = [];
  const inv2: string[] = [];

  for (const record of recorded) {
    say(`--- request #${record.seq}  scenario=${record.scenario}  stream=${record.stream} ---`);
    const messages = messagesOf(record.body);
    say(`messages=${messages.length}`);
    for (const message of messages) {
      const shape = shapeOf(message);
      say(
        `  role=${shape.role.padEnd(9)} content=${shape.contentType.padEnd(7)} reasoning=${shape.reasoning ? "YES" : "no "}  ${shape.preview}`
      );
      if (shape.role === "tool" && shape.contentType !== "string") {
        inv2.push(`request #${record.seq} (${record.scenario}): tool content type=${shape.contentType}`);
      }
    }
    const assistants = messages.filter((message) => message.role === "assistant");
    if (record.scenario === "B_accumulate") {
      const carries = assistants.some((message) => shapeOf(message).reasoning);
      inv1.push(`B_accumulate (platform's own accumulation shape): reasoning_content ${carries ? "PRESENT" : "ABSENT"}`);
    }
    if (record.scenario === "C_control") {
      const carries = assistants.some((message) => shapeOf(message).reasoning);
      inv1.push(`C_control (field kept on the message): reasoning_content ${carries ? "PRESENT" : "ABSENT"}`);
    }
    say();
  }

  say("=== INV-1 (error 1: reasoning_content round-trip) ===");
  for (const line of inv1) say(`  ${line}`);
  say();
  say("=== INV-2 (error 2: tool message content must be a string) ===");
  if (inv2.length === 0) say("  no non-string tool content observed in this probe window");
  for (const line of inv2) say(`  VIOLATION ${line}`);
  say();
  say("=== scenarios that threw LOCALLY (no request left the process) ===");
  if (scenarioErrors.length === 0) say("  none");
  for (const line of scenarioErrors) say(`  ${line}`);
  say();
  say("=== VERDICT ===");
  const b = inv1.find((line) => line.startsWith("B_accumulate"));
  const c = inv1.find((line) => line.startsWith("C_control"));
  say(`  INV-1: ${b ?? "?"}`);
  say(`  INV-1: ${c ?? "?"}`);
  say(
    `  INV-2: ${inv2.length === 0 ? "not reachable from this probe (see raw bodies)" : `${inv2.length} violation(s) - see above`}`
  );
  say("===============================================");

  writeFileSync(join(OUT_DIR, "probe-report.txt"), `${lines.join("\n")}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
