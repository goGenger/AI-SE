import { sanitizeLogData } from "@ai-se/observability";
import {
  ToolCallRecorder,
  ToolExecutionContext,
  ToolResult,
  ToolRuntime
} from "@ai-se/tool-runtime";
import {
  isPathUnderPrefixes,
  isProjectManifestPath,
  isRootDeliveryArtifactPath,
  isTestFilePath,
  JsonObject
} from "@ai-se/shared";
import { StructuredToolInterface, tool } from "@langchain/core/tools";
import {
  EditResult,
  ExecuteResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult
} from "deepagents";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AgentContext } from "../agent/AgentContext";
import { AgentPermissions } from "./AgentRegistry";
import { SUBMIT_RESULT_TOOL_NAME } from "./submitResult";

const CUSTOM_TOOL_NAMES = new Set([
  "git_status",
  "git_diff",
  "run_unit_test",
  "run_lint",
  "run_build",
  // T2：结构化提交（控制类工具，经 ToolRuntime 校验后作为自定义工具暴露给模型）。
  SUBMIT_RESULT_TOOL_NAME
]);

interface BackendOptions {
  runtime: ToolRuntime;
  context: AgentContext;
  permissions: AgentPermissions;
  toolCallRecorder?: ToolCallRecorder;
  onToolEvent?: (eventType: string, payload: JsonObject) => Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function message(result: ToolResult): string | undefined {
  return result.success ? undefined : (result.error?.message ?? `${result.toolName} failed`);
}

function relativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("..")) return normalized || ".";
  return normalized;
}

/**
 * PL-M12（`docs/170` §4 裁定 7）：前缀判定委托 `@ai-se/shared` 的 `isPathUnderPrefixes`——它现在是
 * **唯一**的一份实现，`apps/server` 的写范围审计也用它。此处只保留「先归一化再判」这一步
 * （`relativePath` 会处理 `./`、`..` 与绝对路径），语义与原先逐字相同。
 */
function allowed(filePath: string, prefixes: string[]): boolean {
  return isPathUnderPrefixes(
    relativePath(filePath),
    prefixes.map((prefix) => relativePath(prefix))
  );
}

/**
 * 无扩展名的常见文件名——渲染范围列表时不得被当成目录（`Dockerfile` 不是 `Dockerfile/`）。
 */
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Dockerfile",
  "Makefile",
  "LICENSE",
  "README",
  "CHANGELOG",
  "Procfile"
]);

/**
 * PL-M10（`docs/168` §2.5 M-1）：范围条目逐条渲染。原实现一律 `join("/, ") + "/"`，于是
 * **单文件条目**也被画成目录——`package.json` 渲染成 `package.json/`（实测出现于读侧拒绝
 * 消息）。判定逻辑本身正确，但这与 PL-M5 立的项目标「拒绝必须可被发现」相悖：agent 看到
 * `package.json/` 会以为要把文件写成目录。
 */
function renderScopeEntry(entry: string): string {
  const last = entry.split("/").pop() ?? entry;
  const fileLike = last.includes(".") || EXTENSIONLESS_FILE_NAMES.has(last);
  return fileLike ? entry : `${entry}/`;
}

function renderScopeList(entries: readonly string[]): string {
  return entries.length > 0 ? entries.map(renderScopeEntry).join(", ") : "none";
}

/**
 * PL-M5（`docs/158` §3）：把生效的写范围说清楚——**拒绝必须可被发现**。
 * 裸的 `Path is not writable` 让 agent 只能靠猜（真实案例：run 2 的 QA agent 连试三个
 * 非法路径后判定「沙箱禁止一切写入」并放弃，见 `docs/158` §1.5）。
 */
function describeWriteScope(permissions: AgentPermissions): string {
  const clauses = [renderScopeList(permissions.writePaths)];
  if (permissions.writeTestFiles === true) {
    clauses.push(
      "test files anywhere (test/spec by name, or under test/, tests/, __tests__/)"
    );
  }
  if (permissions.writeProjectManifests === true) {
    clauses.push(
      "project manifests/configs at the repository root (package.json, pnpm-lock.yaml, tsconfig*.json, .gitignore, ...)"
    );
  }
  if (permissions.writeRootDeliveryArtifacts === true) {
    clauses.push(
      "delivery artifacts at the repository root (Dockerfile, docker-compose*.yml, .dockerignore, README.md)"
    );
  }
  return clauses.join(", and ");
}

/**
 * PL-C1（`docs/159` Known Issue 3）：与 `describeWriteScope` 对称——读范围也要说清楚。
 * 拒绝必须可被发现，读侧与写侧同理。
 */
function describeReadScope(permissions: AgentPermissions): string {
  const clauses = [renderScopeList(permissions.readPaths)];
  // AFC fixture：声明了 writeTestFiles 的 agent 也必须能读测试文件（否则写夹具前读不到）。
  if (permissions.writeTestFiles === true) {
    clauses.push(
      "test files anywhere (test/spec by name, or under test/, tests/, __tests__/)"
    );
  }
  if (permissions.readWorkspaceRoot === true) {
    clauses.push("repository root listing (.)");
  }
  return clauses.join(", and ");
}

function textData(result: ToolResult, key: string): string {
  const value = object(result.data)[key];
  return typeof value === "string" ? value : "";
}

export class ToolRuntimeBackend implements SandboxBackendProtocolV2 {
  readonly id: string;
  private iteration = 0;
  private readonly results: ToolResult[] = [];

  constructor(private readonly options: BackendOptions) {
    this.id = `ai-se-${options.context.agentRunId}`;
  }

  get toolResults(): ToolResult[] {
    return [...this.results];
  }

  get iterations(): number {
    return Math.max(1, this.iteration + 1);
  }

  async ls(filePath: string): Promise<LsResult> {
    const pathValue = relativePath(filePath);
    if (!this.readAllowed(pathValue))
      return { error: await this.denyRead("list_directory", pathValue) };
    const result = await this.executeTool("list_directory", { path: pathValue });
    const entries = object(result.data).entries;
    return result.success && Array.isArray(entries)
      ? {
          files: entries
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => ({ path: `/${entry}` }))
        }
      : { error: message(result) };
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const pathValue = relativePath(filePath);
    if (!this.readAllowed(pathValue))
      return { error: await this.denyRead("read_file", pathValue) };
    const result = await this.executeTool("read_file", { path: pathValue });
    if (!result.success) return { error: message(result) };
    const lines = textData(result, "content").split("\n");
    const content = lines.slice(offset, offset + limit).join("\n");
    return {
      content,
      mimeType: "text/plain",
      totalLines: lines.length,
      startLine: offset + 1,
      endLine: Math.min(lines.length, offset + limit),
      nextOffset: offset + limit < lines.length ? offset + limit : undefined
    };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const result = await this.read(filePath, 0, Number.MAX_SAFE_INTEGER);
    if (result.error || typeof result.content !== "string")
      return { error: result.error ?? "Binary reads are disabled" };
    const now = new Date().toISOString();
    return {
      data: { content: result.content, mimeType: "text/plain", created_at: now, modified_at: now }
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const pathValue = relativePath(filePath);
    if (!this.writeAllowed(pathValue)) {
      return { error: await this.denyWrite("write_file", pathValue) };
    }
    const result = await this.executeTool("write_file", { path: pathValue, content });
    return result.success
      ? { path: `/${pathValue}`, filesUpdate: null }
      : { error: message(result) };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    const pathValue = relativePath(filePath);
    if (!this.writeAllowed(pathValue)) {
      return { error: await this.denyWrite("edit_file", pathValue) };
    }
    const result = await this.executeTool("edit_file", {
      path: pathValue,
      search: oldString,
      replace: newString,
      replaceAll
    });
    return result.success
      ? {
          path: `/${pathValue}`,
          filesUpdate: null,
          occurrences: Number(object(result.data).replacements ?? 0)
        }
      : { error: message(result) };
  }

  async grep(
    pattern: string,
    filePath: string | null = ".",
    _glob?: string | null,
    maxCount?: number | null
  ): Promise<GrepResult> {
    const pathValue = relativePath(filePath ?? ".");
    if (!this.readAllowed(pathValue))
      return { error: await this.denyRead("search_code", pathValue) };
    const result = await this.executeTool("search_code", { query: pattern, path: pathValue });
    const matches = object(result.data).matches;
    if (!result.success || !Array.isArray(matches)) return { error: message(result) };
    const parsed = matches
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(entry);
        return {
          path: match?.[1] ?? pathValue,
          line: Number(match?.[2] ?? 0),
          text: match?.[3] ?? entry
        };
      });
    const limited = maxCount ? parsed.slice(0, maxCount) : parsed;
    return { matches: limited, truncated: limited.length < parsed.length };
  }

  async glob(): Promise<GlobResult> {
    return { error: "Glob is disabled; use ls or grep" };
  }

  async delete(): Promise<{ error: string }> {
    return { error: "Delete is disabled" };
  }

  async execute(): Promise<ExecuteResponse> {
    return {
      output: "Command execution is disabled; use the explicit test, lint, or build tools",
      exitCode: 126,
      truncated: false
    };
  }

  createCustomTools(): StructuredToolInterface[] {
    return this.options.runtime
      .getToolDefinitions()
      .filter(
        (definition) =>
          CUSTOM_TOOL_NAMES.has(definition.name) &&
          this.options.permissions.tools.includes(definition.name)
      )
      .map((definition) =>
        tool(
          async (input) =>
            JSON.stringify(sanitizeLogData(await this.executeTool(definition.name, input))),
          {
            name: definition.name,
            description: definition.description,
            schema: definition.inputSchema as z.ZodType<Record<string, unknown>>
          }
        )
      );
  }

  /**
   * PL-M5（`docs/158` §3）：写权限判定——白名单前缀 **或**（显式声明 `writeTestFiles`
   * 且路径是测试文件）。只增加这一条语义化条件，`writePaths` 白名单本身不动。
   * PL-M10（`docs/168`）：同形再加一条——显式声明 `writeProjectManifests` 且路径是
   * **仓库根**的工程清单/配置文件。前缀白名单表达不了「仓库根本身」，故必须有这一条。
   * PL-M11（`docs/170`）：同形第三条——显式声明 `writeRootDeliveryArtifacts` 且路径是
   * **仓库根**的交付物（`Dockerfile` / `docker-compose*.yml` / `.dockerignore` / `README.md`）。
   */
  /**
   * AFC fixture：读侧与写侧对称——声明了 `writeTestFiles` 时可读任意测试文件/测试目录前缀，
   * 否则 FRONTEND 修 `tests/assembly/*.spec.ts` 夹具时会在 read 上被拒（AC-15 / getActivePinia）。
   */
  private readAllowed(relative: string): boolean {
    if (allowed(relative, this.options.permissions.readPaths)) return true;
    if (this.options.permissions.readWorkspaceRoot === true) {
      const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
      if (normalized === "" || normalized === ".") return true;
    }
    if (this.options.permissions.writeTestFiles !== true) return false;
    if (isTestFilePath(relative)) return true;
    const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    return segments.some(
      (segment) => segment === "test" || segment === "tests" || segment === "__tests__"
    );
  }

  private writeAllowed(relative: string): boolean {
    if (allowed(relative, this.options.permissions.writePaths)) return true;
    if (this.options.permissions.writeTestFiles === true && isTestFilePath(relative)) return true;
    if (
      this.options.permissions.writeProjectManifests === true &&
      isProjectManifestPath(relative)
    ) {
      return true;
    }
    return (
      this.options.permissions.writeRootDeliveryArtifacts === true &&
      isRootDeliveryArtifactPath(relative)
    );
  }

  /**
   * PL-M5 / PL-C1：被权限拒绝的调用必须留痕——与 `executeTool` 走**同一条**记录通道
   * （`onToolEvent` + `ToolCallRecorder`），不新开记录面，也不新造错误码（复用 `TOOL_ERROR`）。
   * 拒绝发生在调用 Tool Runtime **之前**，若不在这里补记，`tool_calls` 表将完全没有这次尝试。
   *
   * N-19（`docs/191`）：`kind` 写进记录的 `input.denied`，使「被拒写入」在库内**可结构化检索**
   * （`input->>'denied' = 'write'`），不再靠 `error.message` 的子串匹配。起因：写范围审计是
   * **diff 式**的（`git status --porcelain` 前后比对），被拒的写入**不产生 diff**，于是审计
   * 结构上看不见它；而生产里唯一的「被拦尝试」计数器（`blockedCommandAttempts`）匹配的是
   * `"blocked"`，写权限拒绝的消息是 `Path is not writable:` —— **这一类被静默漏掉**。
   */
  private async recordDeniedCall(
    toolName: string,
    relative: string,
    reason: string,
    kind: "read" | "write"
  ): Promise<string> {
    this.iteration += 1;
    const toolCallId = randomUUID();
    await this.options.onToolEvent?.("tool_call_started", {
      iteration: this.iteration,
      toolCallId,
      toolName,
      status: "running"
    });
    this.results.push({
      success: false,
      error: { code: "TOOL_ERROR", message: reason },
      duration: 0,
      toolName,
      toolCallId,
      audit: {
        requestId: this.options.context.requestId,
        projectId: this.options.context.projectId,
        workflowRunId: this.options.context.workflowRunId,
        taskId: this.options.context.taskId,
        agentRunId: this.options.context.agentRunId,
        toolCallId,
        toolName,
        riskLevel: "MEDIUM",
        actor: this.options.context.actor
      }
    });
    await this.options.onToolEvent?.("tool_call_finished", {
      iteration: this.iteration,
      toolCallId,
      toolName,
      status: "failed",
      duration: 0,
      errorCode: "TOOL_ERROR",
      error: sanitizeLogData({ code: "TOOL_ERROR", message: reason })
    });
    await this.options.toolCallRecorder?.recordToolCallStarted({
      agentRunId: this.options.context.agentRunId,
      iteration: this.iteration,
      toolCallId,
      toolName,
      input: { path: relative, denied: kind },
      startedAt: new Date().toISOString()
    });
    await this.options.toolCallRecorder?.recordToolCallFinished({
      agentRunId: this.options.context.agentRunId,
      toolCallId,
      status: "failed",
      error: { code: "TOOL_ERROR", message: reason },
      duration: 0,
      finishedAt: new Date().toISOString()
    });
    return reason;
  }

  private denyWrite(toolName: string, relative: string): Promise<string> {
    return this.recordDeniedCall(
      toolName,
      relative,
      `Path is not writable: ${relative} (allowed: ${describeWriteScope(this.options.permissions)})`,
      "write"
    );
  }

  /**
   * PL-C1（`docs/159` Known Issue 3）：读侧与写侧对称。`read` / `ls` / `grep` 的拒绝同样发生在
   * 调用 Tool Runtime **之前**，此前两侧都不落 `tool_calls`。当前各 agent 的 `readPaths` 都是
   * `["."]`，实际不易触发——但一旦触发，裸的 `Path is not readable` 同样只能让 agent 靠猜。
   */
  private denyRead(toolName: string, relative: string): Promise<string> {
    return this.recordDeniedCall(
      toolName,
      relative,
      `Path is not readable: ${relative} (allowed: ${describeReadScope(this.options.permissions)})`,
      "read"
    );
  }

  async executeTool(toolName: string, input: unknown): Promise<ToolResult> {
    this.iteration += 1;
    const toolCallId = randomUUID();
    if (!this.options.permissions.tools.includes(toolName)) {
      return {
        success: false,
        error: { code: "TOOL_ERROR", message: `Tool ${toolName} is not permitted` },
        duration: 0,
        toolName,
        toolCallId,
        audit: {
          requestId: this.options.context.requestId,
          projectId: this.options.context.projectId,
          workflowRunId: this.options.context.workflowRunId,
          taskId: this.options.context.taskId,
          agentRunId: this.options.context.agentRunId,
          toolCallId,
          toolName,
          riskLevel: "LOW",
          actor: this.options.context.actor
        }
      };
    }
    const context: ToolExecutionContext = {
      ...this.options.context,
      toolCallId,
      iteration: this.iteration,
      toolCallRecorder: this.options.toolCallRecorder
    };
    await this.options.onToolEvent?.("tool_call_started", {
      iteration: this.iteration,
      toolCallId,
      toolName,
      status: "running"
    });
    const result = await this.options.runtime.execute(toolName, input, context);
    this.results.push(result);
    await this.options.onToolEvent?.("tool_call_finished", {
      iteration: this.iteration,
      toolCallId,
      toolName,
      status: result.success ? "succeeded" : "failed",
      duration: result.duration,
      errorCode: result.error?.code,
      error: result.error ? sanitizeLogData(result.error) : undefined
    });
    return result;
  }
}
