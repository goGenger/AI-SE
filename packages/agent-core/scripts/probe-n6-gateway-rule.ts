/**
 * N-6 RECURRENCE (docs/181, PL-M17) stage-1b probe: ask the REAL gateway what it accepts.
 *
 * Why this exists: `probe-n6-recurrence.ts` proved (H-A) that a request holding an
 * assistant message with `tool_calls` but no `reasoning_content` is rejected by the
 * gateway's rule, and that the platform's own inner-agent path produces exactly that
 * shape when a gateway response carries no reasoning. What it could NOT answer is the
 * next question, because its gateway rule is written by us, not by the gateway:
 *
 *   the platform cannot manufacture a `reasoning_content` it never received, so the only
 *   remaining remedies CHANGE THE SHAPE of that message -- and which shape the real
 *   gateway accepts is not knowable from a fake gateway.
 *
 * So this probe sends hand-built minimal conversations straight at the real endpoint and
 * reports, per variant, whether the gateway accepts it. Raw fetch on purpose: the point is
 * to learn the GATEWAY's rule, so the bytes must be exactly the ones named in the variant
 * (the platform's patched converter is exercised by the other probe instead).
 *
 * VARIANTS
 *   R0_sanity            [user]                                        expected: accepted
 *   R1_no_reasoning      assistant(tool_calls, NO reasoning) + tool    the production shape
 *   R2_empty_reasoning   assistant(tool_calls, reasoning:"")  + tool   remedy candidate 1
 *   R3_blank_reasoning   assistant(tool_calls, reasoning:" ") + tool   remedy candidate 2
 *   R4_real_reasoning    assistant(tool_calls, reasoning:"<text>") + tool  control
 *   R5_orphan_tool_msg   assistant(content, NO tool_calls) + tool      remedy candidate 3
 *   R6_drop_pair         assistant(content, NO tool_calls)             remedy candidate 4
 *   R7_platform_converter  R1's conversation built from LangChain message objects and sent
 *                          through the PLATFORM's own (patched) converter. R1-R6 measure the
 *                          gateway; R7 measures the fix. Expected accepted after the patch.
 *
 * COST: eight requests, `max_tokens: 8` on the hand-built ones. Negligible against the
 * weekly quota, but it does spend real gateway quota, so this probe is run deliberately,
 * not on every iteration.
 *
 * The API key is read from the environment and never printed.
 *
 * Run from the repo root (Node >= 22 on PATH):
 *   corepack pnpm --filter @ai-se/agent-core exec tsx scripts/probe-n6-gateway-rule.ts
 * Optional: --out <dir>   default packages/eval/results/n6-gateway-rule-probe
 * NOTE: keep this file ASCII-only.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createOpenAIChatModel, openCodeGatewayHeaders } from "../src/llm/LangChainLLMProvider.js";

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
// Resolved against the repo root: `pnpm --filter <pkg> exec` runs with the PACKAGE as its
// working directory, so a bare relative --out would land inside the package.
const OUT_DIR = resolve(
  REPO_ROOT,
  argValue("--out") ?? "packages/eval/results/n6-gateway-rule-probe"
);

/** Minimal .env reader: KEY=VALUE per line, `#` comments, surrounding quotes stripped. */
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = { ...loadEnv(join(REPO_ROOT, ".env")), ...process.env };
const BASE_URL = env.OPENAI_BASE_URL ?? "";
const API_KEY = env.OPENAI_API_KEY ?? "";
const MODEL = env.OPENAI_MODEL ?? "";
if (BASE_URL === "" || API_KEY === "" || MODEL === "") {
  console.error("OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL must be set (see .env).");
  process.exit(1);
}

type WireMessage = Record<string, unknown>;

const TOOL_CALL: WireMessage = {
  id: "call_probe_1",
  type: "function",
  function: { name: "read_file", arguments: JSON.stringify({ file_path: "src/probe.txt" }) }
};

function assistantToolCall(reasoning: string | undefined): WireMessage {
  const message: WireMessage = {
    role: "assistant",
    content: "",
    tool_calls: [TOOL_CALL]
  };
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  return message;
}

const TOOL_RESULT: WireMessage = {
  role: "tool",
  tool_call_id: "call_probe_1",
  content: "1\tPROBE_FILE_LINE_ONE\n2\tPROBE_FILE_LINE_TWO\n"
};

interface Variant {
  name: string;
  expectation: string;
  messages: WireMessage[];
}

const VARIANTS: Variant[] = [
  {
    name: "R0_sanity",
    expectation: "accepted (the endpoint works at all)",
    messages: [{ role: "user", content: "Reply with the single word: ok" }]
  },
  {
    name: "R1_no_reasoning",
    expectation: "the production shape - expected REJECTED if the rule is active now",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      assistantToolCall(undefined),
      TOOL_RESULT
    ]
  },
  {
    name: "R2_empty_reasoning",
    expectation: "remedy candidate 1: reasoning_content = \"\"",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      assistantToolCall(""),
      TOOL_RESULT
    ]
  },
  {
    name: "R3_blank_reasoning",
    expectation: "remedy candidate 2: reasoning_content = \" \"",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      assistantToolCall(" "),
      TOOL_RESULT
    ]
  },
  {
    name: "R4_real_reasoning",
    expectation: "control: a non-empty reasoning_content - expected accepted",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      assistantToolCall("I should read the file first."),
      TOOL_RESULT
    ]
  },
  {
    name: "R5_orphan_tool_msg",
    expectation: "remedy candidate 3: tool_calls dropped, tool result kept",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      { role: "assistant", content: "I should read the file first." },
      TOOL_RESULT
    ]
  },
  {
    name: "R6_drop_pair",
    expectation: "remedy candidate 4: tool_calls AND tool result dropped",
    messages: [
      { role: "user", content: "Read src/probe.txt and then reply with the single word: done" },
      { role: "assistant", content: "I should read the file first." }
    ]
  }
];

interface Outcome {
  name: string;
  expectation: string;
  status: number | null;
  errorMessage: string | null;
  replyPreview: string | null;
  networkError: string | null;
}

async function send(variant: Variant): Promise<Outcome> {
  const body = {
    model: MODEL,
    messages: variant.messages,
    max_tokens: 8,
    temperature: 0
  };
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        // The gateway routes on these compliance headers (see openCodeGatewayHeaders);
        // without them every request comes back 400 "missing x-opencode-session".
        ...(openCodeGatewayHeaders(BASE_URL, "ai-se-n6-rule-probe") ?? {})
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    let errorMessage: string | null = null;
    let replyPreview: string | null = null;
    if (response.ok) {
      const choices = parsed?.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown>;
        const message = first.message as Record<string, unknown> | undefined;
        const content = message?.content;
        replyPreview = typeof content === "string" ? content.slice(0, 40) : null;
      }
    } else {
      const error = parsed?.error as Record<string, unknown> | undefined;
      errorMessage =
        typeof error?.message === "string" ? error.message : text.replace(/\s+/g, " ").slice(0, 200);
    }
    return {
      name: variant.name,
      expectation: variant.expectation,
      status: response.status,
      errorMessage,
      replyPreview,
      networkError: null
    };
  } catch (error: unknown) {
    return {
      name: variant.name,
      expectation: variant.expectation,
      status: null,
      errorMessage: null,
      replyPreview: null,
      networkError: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * R7: the decisive one. R1-R6 hand-build the bytes, so they measure the GATEWAY. This one
 * builds the same offending conversation out of LangChain message objects and lets the
 * PLATFORM's own (patched) converter produce the bytes, which measures the FIX.
 *
 * The assistant message carries `tool_calls` and no `additional_kwargs` at all -- exactly
 * the shape the inner deep agent accumulates when the gateway answered a turn without
 * reasoning. Before the patch this went out without `reasoning_content` and the gateway
 * answered 400 (that is R1, one layer down). After the patch it goes out with
 * `reasoning_content: ""`, which R2 showed the gateway accepts.
 */
async function sendViaPlatformConverter(): Promise<Outcome> {
  const name = "R7_platform_converter";
  const expectation = "the platform's own converter, after the fix - expected accepted";
  try {
    const model = createOpenAIChatModel({ baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL });
    const withCall = new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "read_file",
          args: { file_path: "src/probe.txt" },
          id: "call_probe_1",
          type: "tool_call"
        } as never
      ]
    });
    const reply = await model.invoke([
      new HumanMessage("Read src/probe.txt and then reply with the single word: done"),
      withCall,
      new ToolMessage({
        content: "1\tPROBE_FILE_LINE_ONE\n2\tPROBE_FILE_LINE_TWO\n",
        tool_call_id: "call_probe_1"
      })
    ]);
    const content = reply.content;
    return {
      name,
      expectation,
      status: 200,
      errorMessage: null,
      replyPreview: typeof content === "string" ? content.slice(0, 40) : null,
      networkError: null
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      expectation,
      status: /400/.test(message) ? 400 : null,
      errorMessage: message.replace(/\s+/g, " ").slice(0, 200),
      replyPreview: null,
      networkError: /400/.test(message) ? null : message
    };
  }
}

/**
 * The gateway's thinking mode is INTERMITTENT (docs/173 Known Issue 6) -- the first run of
 * this probe saw R1 rejected, the next saw it accepted, minutes apart. So R7's verdict is
 * only evidence inside a window where the rule is demonstrably active.
 *
 * This loop probes R1 until it is rejected, then immediately measures R7 (the platform's
 * converter) and R2 (the empty-reasoning remedy) in that same window. If the rule never
 * fires within `maxRounds`, it reports that honestly instead of claiming a pass.
 */
interface RuleWindow {
  rounds: number;
  ruleActive: boolean;
  r1Status: number | null;
  r7Status: number | null;
  r7Error: string | null;
  r2Status: number | null;
}

async function verifyFixInRuleWindow(maxRounds: number): Promise<RuleWindow> {
  const r1Variant = VARIANTS.find((variant) => variant.name === "R1_no_reasoning");
  const r2Variant = VARIANTS.find((variant) => variant.name === "R2_empty_reasoning");
  if (!r1Variant || !r2Variant) throw new Error("R1/R2 variants missing");
  for (let round = 1; round <= maxRounds; round += 1) {
    const r1 = await send(r1Variant);
    if (r1.status !== 400) continue;
    const r7 = await sendViaPlatformConverter();
    const r2 = await send(r2Variant);
    return {
      rounds: round,
      ruleActive: true,
      r1Status: r1.status,
      r7Status: r7.status,
      r7Error: r7.errorMessage,
      r2Status: r2.status
    };
  }
  return {
    rounds: maxRounds,
    ruleActive: false,
    r1Status: null,
    r7Status: null,
    r7Error: null,
    r2Status: null
  };
}

async function main(): Promise<void> {
  const outcomes: Outcome[] = [];
  for (const variant of VARIANTS) {
    const outcome = await send(variant);
    outcomes.push(outcome);
    const verdict =
      outcome.networkError !== null
        ? `NETWORK ERROR: ${outcome.networkError}`
        : outcome.status === 200
          ? `accepted (200) reply=${JSON.stringify(outcome.replyPreview)}`
          : `REJECTED (${outcome.status}) ${outcome.errorMessage ?? ""}`;
    console.log(`[${outcome.name}] ${verdict}`);
  }

  const platformOutcome = await sendViaPlatformConverter();
  outcomes.push(platformOutcome);
  console.log(
    `[${platformOutcome.name}] ${
      platformOutcome.status === 200
        ? `accepted (200) reply=${JSON.stringify(platformOutcome.replyPreview)}`
        : `REJECTED (${platformOutcome.status}) ${platformOutcome.errorMessage ?? platformOutcome.networkError ?? ""}`
    }`
  );

  const maxRounds = Number(argValue("--rounds") ?? "12");
  const window = await verifyFixInRuleWindow(Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : 12);
  console.log(
    `[rule window] ${
      window.ruleActive
        ? `rule active on round ${window.rounds}: R1=${window.r1Status} R7=${window.r7Status} R2=${window.r2Status}`
        : `rule did NOT fire in ${window.rounds} rounds - the fix could not be verified against the real gateway in this window`
    }`
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "gateway-rule-outcomes.json"), JSON.stringify(outcomes, null, 2), "utf8");

  const lines: string[] = [];
  const say = (line = "") => {
    lines.push(line);
    console.log(line);
  };
  say();
  say("=== N-6 GATEWAY RULE PROBE (docs/181, PL-M17) ===");
  say(`endpoint=${BASE_URL} model=${MODEL}`);
  say(`outcomes written to ${join(OUT_DIR, "gateway-rule-outcomes.json")}`);
  say();
  for (const outcome of outcomes) {
    say(`${outcome.name}`);
    say(`  expectation: ${outcome.expectation}`);
    say(
      `  result: ${
        outcome.networkError !== null
          ? `NETWORK ERROR ${outcome.networkError}`
          : `${outcome.status} ${outcome.errorMessage ?? `reply=${JSON.stringify(outcome.replyPreview)}`}`
      }`
    );
    say();
  }
  const r1 = outcomes.find((outcome) => outcome.name === "R1_no_reasoning");
  const r4 = outcomes.find((outcome) => outcome.name === "R4_real_reasoning");
  say("=== VERDICT ===");
  say(
    `  the rule is ACTIVE right now if R1 is rejected and R4 is accepted: ` +
      `R1=${r1?.status ?? "network error"} R4=${r4?.status ?? "network error"}`
  );
  say("  every remedy candidate that came back 200 is a shape the gateway accepts.");
  say();
  say("=== RULE WINDOW (the only place R7 counts as evidence) ===");
  if (window.ruleActive) {
    say(
      `  the rule fired on round ${window.rounds} of ${window.rounds}: ` +
        `R1=${window.r1Status} (rejected, rule active)`
    );
    say(
      `  in that same window: R7 (platform converter, after the fix) = ${window.r7Status}, ` +
        `R2 (empty reasoning) = ${window.r2Status}`
    );
    say(
      `  => the fix is verified against the real gateway if R7 = 200 here.` +
        (window.r7Error ? ` R7 error: ${window.r7Error}` : "")
    );
  } else {
    say(
      `  the rule did NOT fire in ${window.rounds} consecutive rounds, so this window proves nothing`
    );
    say("  about the fix. Re-run the probe later; do not read R7's status as a pass.");
  }
  say("===============================================");
  writeFileSync(join(OUT_DIR, "gateway-rule-report.txt"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(join(OUT_DIR, "gateway-rule-window.json"), JSON.stringify(window, null, 2), "utf8");
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
