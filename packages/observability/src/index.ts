import pino, { Logger, LoggerOptions } from "pino";

const SENSITIVE_KEY_PARTS = [
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "token",
  "password",
  "secret"
];
const REDACTED = "[REDACTED]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactString(value: string): string {
  return value.replace(
    /(api[_-]?key|authorization|cookie|token|password|secret)\s*(=|:)\s*[^,\s&]+/gi,
    `$1$2 ${REDACTED}`
  );
}

/**
 * Error.message / Error.stack are non-enumerable, so a naive Object.entries walk
 * turns `sanitizeLogData({ error })` into `{ error: {} }` and the console loses
 * the only useful failure detail. Serialize Errors explicitly (then redact).
 */
function serializeErrorForLog(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    type: error.name || "Error",
    message: sanitizeLogData(error.message)
  };

  if (typeof error.stack === "string" && error.stack.length > 0) {
    serialized.stack = redactCredentialShapedText(redactString(error.stack));
  }

  for (const [key, entry] of Object.entries(error)) {
    if (key === "message" || key === "stack" || key === "name") {
      continue;
    }
    serialized[key] = isSensitiveKey(key) ? REDACTED : sanitizeLogData(entry);
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    serialized.cause = sanitizeLogData(cause);
  }

  return serialized;
}

export function sanitizeLogData(value: unknown): unknown {
  if (typeof value === "string") {
    // D-3（T8-c）：键值形态（redactString）+ 凭证形态串（sk-/eyJ/Bearer 等）一并打码。
    return redactCredentialShapedText(redactString(value));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogData(entry));
  }

  if (value instanceof Error) {
    return serializeErrorForLog(value);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? REDACTED : sanitizeLogData(entry)
    ])
  );
}

/**
 * Token-shaped substrings scrubbed from any text that leaves the platform
 * (Phase 5.5-4 introduced for MCP; Phase 5.6 sinks it here as the single
 * source of truth — `@ai-se/mcp` re-exports it for existing callers).
 *
 * N-65（`docs/232` §10）：`sk-` 分支**放过 kebab 词组**。
 *
 * 原实现是 `sk-[A-Za-z0-9_-]{8,}`，于是任何以 `task-` 开头的标识符都会被当成 OpenAI 密钥：
 * `ta` + `sk-title-input` ⇒ `ta[REDACTED]`。实测后果是 PRD 里的 `task-title-input` /
 * `task-done-toggle` / `task-delete-button` 在**每一条回到模型面前的工具结果**里都被打码，
 * 而 `task-item`（`sk-item` 只有 4 字符）安然无恙——「testid 自创」连续三轮的原因就是这个。
 *
 * 放行条件是**整段 `sk-` 之后全是「两个以上小写单词用连字符连接」**（`(?![a-z]+(?:-[a-z]+)+(?![A-Za-z0-9_-]))`
 * 是「后面整段都是这种词组」的否定前瞻）。这样：
 * - `sk-title-input` / `sk-done-toggle` / `sk-delete-button`（kebab 词组）⇒ 保留；
 * - `sk-abcdefghijklmnop`（单段、无连字符）⇒ 仍打码；
 * - `sk-test-redteam-0123456789abcdef`（第三段含数字）⇒ 仍打码；
 * - `sk-proj-ABCDEFGHIJKLMNOP`（含大写）⇒ 仍打码。
 * 代价是「纯小写、含连字符、且每段都是字母」的假想密钥会被放过——比误伤需求文本可接受得多。
 */
const CREDENTIAL_SHAPED_PATTERN =
  /(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*|sk-(?=[A-Za-z0-9_-]{8,})(?![a-z]+(?:-[a-z]+)+(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g;

/**
 * Redacts credential-shaped substrings plus any explicitly known secret value
 * from a text. Used before a message is stored, thrown, or logged.
 */
export function redactCredentialShapedText(
  text: string,
  knownSecrets: Iterable<string> = []
): string {
  let redacted = text.replace(CREDENTIAL_SHAPED_PATTERN, REDACTED);
  for (const secret of knownSecrets) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join(REDACTED);
    }
  }
  return redacted;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // LOG_LEVEL knob: debug | info | warn | error | silent (default info).
  // info already includes warn+error; the historical blind spot was Error payloads
  // being wiped by sanitizeLogData / HTTP 500s logging only "Internal server error".
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.apiKey",
        "*.api_key",
        "*.token",
        "*.password",
        "*.secret"
      ],
      censor: REDACTED
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    },
    ...options
  });
}
