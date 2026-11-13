import { ToolCallRecorder, ToolRuntime } from "@ai-se/tool-runtime";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { Agent, AgentRunOptions } from "../agent/Agent";
import { AgentContext } from "../agent/AgentContext";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { AgentResult } from "../agent/AgentResult";
import { AgentRunner } from "../agent/AgentRunner";
import { ModelPricing } from "../llm/usage";
import { AgentDefinition } from "./AgentRegistry";
import { DeepAgentLLMProvider } from "./DeepAgentLLMProvider";
import { ToolRuntimeBackend } from "./ToolRuntimeBackend";
import { OutcomeSchema } from "./outcomeSchema";
import { captureSubmittedOutcome } from "./submitResult";
import { ProfessionalOutcome } from "./types";
import { withUntrustedInputClause } from "./untrustedInput";

export type ProfessionalModel = BaseLanguageModel;

const RESULT_INSTRUCTIONS_BASE = [
  "Complete only the supplied task. The Workflow Engine owns scheduling and other agents.",
  "Use only the tools visible to you. Never access host fs, child_process, git, Docker, or external systems directly.",
  "Deliver and stop: once the task's acceptance criteria are met, return the result JSON in that same turn — do not build ad-hoc verification harnesses, and never repeat the same check more than twice.",
  "If the budget is running out, stop and return the result JSON describing what is done and what remains instead of continuing silently.",
  'Keep the JSON valid: one line per string; escape every inner quote as \\" and prefer plain wording over pasted HTML/JS snippets.'
];

const RESULT_INSTRUCTIONS_META = [
  "QA metadata must include tests, passed, failed, errors, and summary.",
  "Reviewer metadata must include approved and findings with severity, file, description, and recommendation."
];

/**
 * T2：工具模式提示词——结果经 submit_result 工具提交（schema 校验失败会自动回传错误自修）；
 * 文本模式保持旧口径（同一份 JSON 契约以纯文本返回，作为降级路径）。
 */
function resultInstructions(outcomeTool?: string): string {
  if (!outcomeTool) {
    return [
      ...RESULT_INSTRUCTIONS_BASE,
      "Do not expose hidden reasoning. Return one JSON object only:",
      '{"status":"SUCCESS|FAILED|RETRY|REPLAN","summary":"...","artifacts":[],"issues":[],"recommendations":[],"metadata":{}}',
      ...RESULT_INSTRUCTIONS_META
    ].join("\n");
  }
  return [
    ...RESULT_INSTRUCTIONS_BASE,
    `Do not expose hidden reasoning. When the task is complete (or cannot proceed), call the \`${outcomeTool}\` tool with the result object as its arguments: {"status":"SUCCESS|FAILED|RETRY|REPLAN","summary":"...","artifacts":[],"issues":[],"recommendations":[],"fixTaskType":"...","metadata":{}}. What the four statuses mean: SUCCESS = the task's goal is met; FAILED = it is not met and you cannot say who should fix it; RETRY = this same task should be attempted again; REPLAN = the fix belongs to a DIFFERENT kind of task, which you MUST name in "fixTaskType" (for example "TEST" when the change belongs in test files, "BACKEND" when it belongs in backend code) — report REPLAN only together with fixTaskType. The tool validates the arguments; if it reports validation errors, fix them and call it again. Do not paste the result JSON as plain text.`,
    ...RESULT_INSTRUCTIONS_META
  ].join("\n");
}

/** Pulls the first top-level JSON object out of a possibly chatty answer. */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** JSON candidates in priority order: raw answer, fenced blocks, first balanced object. */
function outcomeCandidates(answer: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed !== "" && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const fenced = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(
    (match) => match[1] ?? ""
  );

  push(answer);
  for (const block of fenced) push(block);
  for (const candidate of [answer, ...fenced]) {
    const object = extractFirstJsonObject(candidate);
    if (object) push(object);
  }
  return candidates;
}

/**
 * Chatty 模型经常在 JSON 字符串里输出未转义的原始换行/制表符（长 summary 尤其常见），
 * 这会让 JSON.parse 失败。扫描引号对，把字符串字面量内的原始控制字符转义后再试一次。
 */
export function escapeControlCharsInStrings(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true;
      output += char;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      output +=
        char === "\n"
          ? "\\n"
          : char === "\r"
            ? "\\r"
            : char === "\t"
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += char;
  }
  return output;
}

/** JSON 里合法的转义字符。 */
const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

function nextNonWhitespace(text: string, from: number): string | undefined {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return char;
  }
  return undefined;
}

/**
 * 把"几乎是 JSON"的答案修到可解析。真实观测（2026-09-28 真实运行：4890 字答案被判不可解析，
 * 头/尾均合法，破损在中间）：长 summary / verification 内嵌 HTML·JS 片段时高发三类破损 ——
 *   1. 字符串里的原始控制字符（换行/制表符）；
 *   2. 字符串里的非法转义（正则片段 `\s` `\d` `\w`、孤立反斜杠）；
 *   3. 字符串里未转义的内层引号（如 `width="960"`）。
 * 判据：字符串中遇到的引号，其后第一个非空白字符不是 `,` `:` `}` `]` 即视为内层引号（转义之）。
 * 只作为"直接解析失败"后的后备候选，正常答案的解析结果不受影响。
 */
export function repairNearJson(text: string): string {
  let output = "";
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (!inString) {
      if (char === '"') inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      const unicodeEscape =
        next === "u" &&
        isHexDigit(text[index + 2]) &&
        isHexDigit(text[index + 3]) &&
        isHexDigit(text[index + 4]) &&
        isHexDigit(text[index + 5]);
      if (next !== undefined && VALID_ESCAPES.has(next) && (next !== "u" || unicodeEscape)) {
        const length = next === "u" ? 6 : 2;
        output += text.slice(index, index + length);
        index += length;
      } else {
        output += "\\\\";
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      const following = nextNonWhitespace(text, index + 1);
      if (following === undefined || ",:}]".includes(following)) {
        output += char;
        inString = false;
      } else {
        output += '\\"';
      }
      index += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      output +=
        char === "\n"
          ? "\\n"
          : char === "\r"
            ? "\\r"
            : char === "\t"
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function parseOutcomeCandidate(candidate: string): ProfessionalOutcome | undefined {
  const sanitized = escapeControlCharsInStrings(candidate);
  const repaired = repairNearJson(candidate);
  const attempts = [...new Set([candidate, sanitized, repaired])];
  for (const attempt of attempts) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(attempt);
    } catch {
      continue;
    }
    const outcome = OutcomeSchema.safeParse(parsedJson);
    if (outcome.success) return outcome.data;
  }
  return undefined;
}

function unescapeJsonText(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    switch (escape[0]) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "u":
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      default:
        return escape;
    }
  });
}

/**
 * 兜底抢救：JSON 整体不可解析、但顶层字段锚点完好时，按锚点把 status / summary 取回来。
 * 真实观测（2026-09-28 真实运行）：破损只发生在长 summary 字符串内部（内嵌 HTML·JS 片段、
 * 引号/转义破损），`"status":"` 与 `","<下一个键>":` 两个锚点本身完好 —— 因此本抢救与破损形态无关。
 * 只读取锚点之间的原文（不做任何推断）；status 不在枚举内、或 summary 锚点缺失时返回 undefined，
 * 由调用方继续走 INVALID 兜底（截断等场景因此不会被"抢救"成成功）。
 */
export function salvageOutcome(text: string): ProfessionalOutcome | undefined {
  const statusMatch = /"status"\s*:\s*"([A-Za-z]+)"/.exec(text);
  const status = statusMatch?.[1]?.toUpperCase();
  if (status !== "SUCCESS" && status !== "FAILED" && status !== "RETRY" && status !== "REPLAN") {
    return undefined;
  }

  const nextKey = /"summary"\s*:\s*"([\s\S]*?)"\s*,\s*"[A-Za-z_][\w-]*"\s*:/.exec(text);
  const lastBeforeBrace = /"summary"\s*:\s*"([\s\S]*)"\s*\}/.exec(text);
  const captured = nextKey?.[1] ?? lastBeforeBrace?.[1];
  if (captured === undefined) return undefined;

  return {
    status,
    summary: unescapeJsonText(captured),
    artifacts: [],
    issues: [],
    recommendations: [],
    metadata: { parseRecovery: "salvage" }
  };
}

/**
 * Chatty models (observed intermittently with DeepSeek thinking models) wrap
 * the required JSON in prose or code fences — extract before giving up. When
 * no candidate is a valid outcome, record head/tail diagnostics so a failed run
 * is debuggable from agent_runs.error alone.
 */
export function parseOutcome(answer: string): ProfessionalOutcome {
  for (const candidate of outcomeCandidates(answer)) {
    const outcome = parseOutcomeCandidate(candidate);
    if (outcome) return outcome;
  }

  // 修复会改变引号/括号平衡，对修复后的文本重新提取一次 JSON 对象再试。
  for (const candidate of outcomeCandidates(answer)) {
    const repaired = repairNearJson(candidate);
    if (repaired === candidate) continue;
    const extracted = extractFirstJsonObject(repaired);
    if (!extracted) continue;
    const outcome = parseOutcomeCandidate(extracted);
    if (outcome) return outcome;
  }

  // 最后一道：锚点抢救（破损在长字符串内部时仍然可用）。
  for (const candidate of outcomeCandidates(answer)) {
    const salvaged = salvageOutcome(candidate);
    if (salvaged) return salvaged;
  }

  return {
    status: "FAILED",
    summary: "Professional Agent returned an invalid structured result.",
    artifacts: [],
    issues: [
      {
        severity: "HIGH",
        description: answer.slice(0, 500) || "No result returned",
        recommendation: "Return the required AgentResult JSON object."
      }
    ],
    recommendations: [],
    metadata: {
      errorType: "INVALID_AGENT_RESULT",
      answerLength: answer.length,
      answerHead: answer.slice(0, 300),
      answerTail: answer.slice(-500),
      answerText: answer.slice(0, 8000)
    }
  };
}

function timeoutMsOf(result: AgentResult): number | undefined {
  const details = result.error?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as { timeoutMs?: unknown }).timeoutMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 运行超时：失败原因必须可读（旧行为把它伪装成"结果格式错误"）。 */
function timeoutBudgetLabel(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
}

function timedOutOutcome(result: AgentResult): ProfessionalOutcome {
  const timeoutMs = timeoutMsOf(result);
  return {
    status: "FAILED",
    summary:
      timeoutMs === undefined
        ? "Agent 运行超时，未返回结果。"
        : `Agent 运行超时（${timeoutBudgetLabel(timeoutMs)}），未返回结果。`,
    artifacts: [],
    issues: [
      {
        severity: "HIGH",
        description: "Agent run timed out before returning the result JSON.",
        recommendation:
          "提高任务超时预算（任务输入 execution.timeoutMs 或 TASK_TIMEOUT_MS）后重试。"
      }
    ],
    recommendations: [],
    metadata: { errorType: "TIMEOUT", ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  };
}

/** 连续空回复：图内重问已用尽，如实报告"未返回结果"。 */
function emptyFinalOutcome(answer: string): ProfessionalOutcome {
  return {
    status: "FAILED",
    summary: "Agent 未返回结果（连续空回复，重问次数已用尽）。",
    artifacts: [],
    issues: [
      {
        severity: "HIGH",
        description: answer.slice(0, 500) || "No result returned",
        recommendation: "Return the required AgentResult JSON object."
      }
    ],
    recommendations: [],
    metadata: { errorType: "EMPTY_FINAL_ANSWER", answerLength: answer.length }
  };
}

/**
 * N-24（`docs/204`）：**运行本身失败**（模型调用抛错）——不是「agent 没说话」。
 *
 * `AgentGraph.ts:302` 在模型调用抛错时以 `status: "failed"` + `error.code = "LLM_ERROR"` 结束运行，
 * `finalAnswer` 因此为空。上方 `:494` 的分类只判「超时」，其余码一律不看 ⇒ 上游 429
 * **被记成 `EMPTY_FINAL_ANSWER`**（实测 L1-M4o run 1：5/5 如此，其中一个 run 只跑了 **1 秒**）。
 *
 * 措辞固定、**不回显上游原文**（外部文本，本包无 sanitize 通道，`AGENTS.md` §10）；
 * `errorType` 只放**既有枚举码**，不新增词汇。
 */
function failedRunOutcome(result: AgentResult): ProfessionalOutcome {
  // N-61（`docs/232` §10）：`error.details.reason` 是「上游不可用」这一类的标记。
  // 它**不是**新的错误码（`AGENTS.md` §10），只是给归因用的附加信息：事后能分清
  // 「模型服务挂了」与「agent 做错了」。
  const details = result.error?.details as { reason?: unknown } | undefined;
  const errorReason = typeof details?.reason === "string" ? details.reason : undefined;
  return {
    status: "FAILED",
    summary: "Agent run failed before returning a result (the model call failed).",
    artifacts: [],
    issues: [
      {
        severity: "HIGH",
        description: "The model call failed; the agent never produced an answer.",
        recommendation: "Retry the task; if it recurs, check the model provider."
      }
    ],
    recommendations: [],
    metadata: {
      errorType: result.error?.code ?? "LLM_ERROR",
      ...(errorReason ? { errorReason } : {})
    }
  };
}

/**
 * One extra model turn when the agent answered with prose instead of the
 * required result JSON (observed with chatty thinking models). Bounded to a
 * single repair attempt; the previous answer is echoed back so the model only
 * has to reformat it. Runs even when a tool call failed: tool failures are
 * recorded but no longer decide the verdict, so a repair CAN change it (a
 * delivered-but-unformatted result must not fail the task).
 */
function repairPrompt(task: string, previousAnswer: string, outcomeTool?: string): string {
  const excerpt =
    previousAnswer.length > 4000
      ? `${previousAnswer.slice(0, 4000)}\n…[truncated]`
      : previousAnswer;
  return [
    task,
    resultInstructions(outcomeTool),
    "Your previous reply was not the required result JSON, so it could not be recorded. Previous reply:",
    '"""',
    excerpt,
    '"""',
    outcomeTool
      ? `Call the \`${outcomeTool}\` tool now with the result object (or reply with ONLY the result JSON object if the tool is unavailable).`
      : "Reply now with ONLY the result JSON object. No prose, no code fences, no markdown."
  ].join("\n\n");
}

export interface ProfessionalAgentOptions {
  definition: AgentDefinition;
  model: ProfessionalModel;
  toolRuntime: ToolRuntime;
  lifecycle?: AgentLifecycleHooks;
  toolCallRecorder?: ToolCallRecorder;
  defaultTimeoutMs?: number;
  /**
   * T2：结构化提交工具名（如 "submit_result"）。设置后为工具模式——结果优先取自该工具的
   * 成功提交（schema 校验由 Tool Runtime 完成）；缺省为文本模式（旧解析管线）。
   */
  outcomeTool?: string;
  /** PL-C2：每百万 token 的美元单价；未配置 → 不产出成本。 */
  modelPricing?: ModelPricing;
}

export class ProfessionalAgent implements Agent {
  readonly name: string;

  constructor(private readonly options: ProfessionalAgentOptions) {
    this.name = options.definition.name;
  }

  async run(task: string, context: AgentContext, options?: AgentRunOptions): Promise<AgentResult> {
    const backend = new ToolRuntimeBackend({
      runtime: this.options.toolRuntime,
      context,
      permissions: this.options.definition.permissions,
      toolCallRecorder: this.options.toolCallRecorder,
      onToolEvent: async (eventType, payload) => {
        await this.options.lifecycle?.onEvent?.({
          agentRunId: context.agentRunId,
          eventType,
          payload
        });
      }
    });
    const instructions = resultInstructions(this.options.outcomeTool);
    const prompt = `${task}\n\n${instructions}`;
    const runner = new AgentRunner({
      llmProvider: new DeepAgentLLMProvider(
        this.options.model,
        this.options.definition,
        backend,
        this.options.outcomeTool,
        this.options.modelPricing
      ),
      toolRuntime: this.options.toolRuntime,
      systemPrompt: withUntrustedInputClause(
        `${this.options.definition.systemInstructions}\n${instructions}`
      ),
      defaultMaxIterations: 50,
      defaultTimeoutMs: this.options.defaultTimeoutMs ?? 120_000,
      defaultMaxRetries: 1,
      lifecycle: this.options.lifecycle,
      toolCallRecorder: this.options.toolCallRecorder
    });
    const result = await runner.run(prompt, context, options);
    // T2：工具模式优先取 submit_result 的成功提交；缺省回落到文本解析（降级路径）。
    let submitted = captureSubmittedOutcome(backend.toolResults, this.options.outcomeTool);
    let outcome = submitted ?? parseOutcome(result.finalAnswer);
    let finalRun = result;

    // 解析失败时先分三类，避免"超时"被伪装成"结果格式错误"（真实运行 2026-09-28：
    // 主运行 120s 超时 → 空答案 → 旧逻辑对着空答案再问一次 → 模型把整个任务重做一遍，白烧预算）：
    //   · 可解析的答案优先（交付了结果就不该因时钟失败）；
    //   · 超时：不启动修复轮，如实报「运行超时」；
    //   · 连续空回复：图内重问已用尽（MAX_EMPTY_FINAL_NUDGES），如实报「未返回结果」；
    //   · 有内容但不可解析：保留既有修复轮（一次，回放上次答案，要求只输出 JSON）。
    if (!submitted && outcome.metadata.errorType === "INVALID_AGENT_RESULT") {
      const timedOut = result.status === "timed_out" || result.error?.code === "TIMEOUT_ERROR";
      if (timedOut) {
        outcome = timedOutOutcome(result);
      } else if (result.error?.code !== undefined) {
        // N-24（`docs/204`）：**放在空答案分支之前**——一个 run 若既带错误码、`finalAnswer` 又为空，
        // 根本原因是运行失败，空答案只是后果。实测 L1-M4o run 1 有一个 run 只跑了 1 秒就被记成
        // 「agent 连续空回复」，因果颠倒。
        outcome = failedRunOutcome(result);
      } else if (result.finalAnswer.trim() === "") {
        outcome = emptyFinalOutcome(result.finalAnswer);
      } else {
        const repair = await runner.run(
          repairPrompt(task, result.finalAnswer, this.options.outcomeTool),
          context,
          options
        );
        submitted = captureSubmittedOutcome(backend.toolResults, this.options.outcomeTool);
        const repaired = submitted ?? parseOutcome(repair.finalAnswer);
        if (repaired.metadata.errorType !== "INVALID_AGENT_RESULT") outcome = repaired;
        finalRun = repair;
      }
    }

    // 工具失败如实记录（metadata + issues），但不再无条件推翻 Agent 自报结果：
    //   · 自报 SUCCESS：保留 SUCCESS，将每次工具失败追加为 MEDIUM 问题（轨迹与审计仍完整保留）；
    //   · 自报非 SUCCESS：保留其自报状态与摘要；解析失败时保留 INVALID_AGENT_RESULT 的诊断摘要，
    //     不再被工具错误覆盖 —— 摘要必须反映真正的判定原因。
    // T2：submit_result 的校验失败属于控制流（错误已回传模型自修、计入迭代），不进入交付失败清单；
    // 若始终未获接受，降级路径与 outcomeMode 已如实记录。
    const failedTools = backend.toolResults.filter(
      (toolResult) => !toolResult.success && toolResult.toolName !== this.options.outcomeTool
    );
    if (failedTools.length > 0) {
      const firstFailure = failedTools[0];
      outcome.metadata = {
        ...outcome.metadata,
        failedTools: failedTools.map((toolResult) => toolResult.toolName),
        toolErrorCode: firstFailure.error?.code,
        toolErrors: failedTools.map(
          (toolResult) => toolResult.error?.details ?? toolResult.error?.message ?? "Tool failed"
        ),
        ...(this.options.definition.type === "REVIEWER" ? { approved: false } : {})
      };
      if (outcome.status === "SUCCESS") {
        outcome.issues = [
          ...outcome.issues,
          ...failedTools.map((toolResult) => ({
            severity: "MEDIUM" as const,
            description: `工具 ${toolResult.toolName} 调用失败：${
              toolResult.error?.message ?? "Tool failed"
            }`,
            recommendation: "确认该工具调用失败是否影响交付结果；完整调用记录见运行轨迹。"
          }))
        ];
      }
    }
    outcome.metadata = {
      ...outcome.metadata,
      outcomeMode: submitted ? "tool" : this.options.outcomeTool ? "text-fallback" : "text"
    };
    return {
      ...finalRun,
      iterations: Math.max(result.iterations, finalRun.iterations, backend.iterations),
      finalAnswer: outcome.summary,
      toolResults: backend.toolResults,
      professionalResult: outcome,
      metadata: {
        ...finalRun.metadata,
        agentName: this.name,
        agentType: this.options.definition.type
      }
    };
  }
}
