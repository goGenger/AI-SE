import { captureActionEvidence } from "@ai-se/evidence";
import {
  BrowserSession,
  COMPUTER_USE_BROWSER_TOOLS,
  createRealPlaywright,
  type NavigateAllowlist
} from "@ai-se/browser";
import {
  createPool,
  PgEvidenceRepository,
  PgProjectRepository,
  runMigrations
} from "@ai-se/database";
import {
  createExternalToolRegistry,
  createFakeExternalSystemEntry,
  ExternalEngineeringConnector,
  ExternalToolCatalog,
  FAKE_EXTERNAL_SERVER_ID,
  StdioMCPClient,
  type ExternalToolOutcome,
  type MCPClientPort,
  type MCPServerDefinition,
  type MCPToolDefinition
} from "@ai-se/mcp";
import type { ActionResult, EvidenceSnapshot, Observation } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallRecorder,
  type ToolCallStartedRecord,
  type ToolDefinition,
  type ToolExecutionContext
} from "@ai-se/tool-runtime";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 5.7-4 evidence lifecycle E2E — REAL everything:
 *
 *   before observation → action → after observation (→ screenshot)
 *   → verification → EvidenceRecord → PostgreSQL
 *
 * Browser actions run through the real ToolRuntime over real Chromium; the
 * external action runs through ToolRuntime → MCPToolAdapter → REAL MCP stdio
 * child (mock GitHub-like system). Evidence is built by @ai-se/evidence
 * (real before/after data, redaction sink, strict contract) and read back
 * from real PostgreSQL. Failure captures (action failed / expectation not
 * met) keep the failure facts. Zero external network.
 */

const execFileAsync = promisify(execFile);
const ALLOW_DATA: NavigateAllowlist = { allowedProtocols: ["data"] };
const CREDENTIAL = "sk-live1234567890abcdefghij";

const FIXTURE = `data:text/html,${encodeURIComponent(
  `<html><body>
     <h1>Evidence fixture</h1>
     <button id="go">go</button>
     <span id="n">0</span>
     <script>
       document.getElementById("go").addEventListener("click", function () {
         var n = document.getElementById("n");
         n.textContent = String(Number(n.textContent) + 1);
       });
     </script>
   </body></html>`
)}`;

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} still alive after ${timeoutMs}ms`);
}

class CountingMCPClient implements MCPClientPort {
  private readonly counts = new Map<string, number>();

  constructor(private readonly delegate: MCPClientPort) {}

  requestCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  async connect(server: MCPServerDefinition): Promise<void> {
    return await this.delegate.connect(server);
  }

  async disconnect(serverId: string): Promise<void> {
    return await this.delegate.disconnect(serverId);
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    return await this.delegate.listTools(serverId);
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.counts.set(name, this.requestCount(name) + 1);
    return await this.delegate.callTool(serverId, name, input, signal);
  }

  async listResources(serverId: string) {
    return await this.delegate.listResources(serverId);
  }

  async readResource(serverId: string, uri: string, signal?: AbortSignal) {
    return await this.delegate.readResource(serverId, uri, signal);
  }

  async listPrompts(serverId: string) {
    return await this.delegate.listPrompts(serverId);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ) {
    return await this.delegate.getPrompt(serverId, name, args, signal);
  }
}

class MemoryToolCallRecorder implements ToolCallRecorder {
  readonly started: ToolCallStartedRecord[] = [];
  readonly finished: ToolCallFinishedRecord[] = [];

  async recordToolCallStarted(record: ToolCallStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async recordToolCallFinished(record: ToolCallFinishedRecord): Promise<void> {
    this.finished.push(record);
  }
}

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function browserContext(
  session: BrowserSession,
  recorder: ToolCallRecorder,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-evidence-browser",
    taskId: "task-evidence-1",
    agentRunId: "run-evidence-1",
    toolCallId: `call-${Math.random().toString(36).slice(2, 10)}`,
    actor: "evidence-browser-e2e",
    workspacePath: process.cwd(),
    sandbox: fakeSandbox,
    toolCallRecorder: recorder,
    session,
    ...overrides
  } as unknown as ToolExecutionContext;
}

function externalContext(
  recorder: ToolCallRecorder,
  projectId: string,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-evidence-external",
    projectId,
    taskId: "task-evidence-1",
    agentRunId: "run-evidence-1",
    toolCallId: randomUUID(),
    actor: "evidence-external-agent",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    toolCallRecorder: recorder,
    ...overrides
  };
}

describe.skipIf(!BROWSER_AVAILABLE)(
  "5.7-4 evidence lifecycle (real Chromium + real MCP + real PostgreSQL)",
  () => {
    let pool: ReturnType<typeof createPool>;
    let repository: PgEvidenceRepository;
    let containerName = "";
    let projectId = "";
    let workflowRunId = "";
    let taskId = "";
    let session: BrowserSession;
    let browserRuntime: ToolRuntime;
    let externalRuntime: ToolRuntime;
    let connector: ExternalEngineeringConnector;
    let registry: ReturnType<typeof createExternalToolRegistry>;
    let stdioClient: StdioMCPClient;
    let recorder: MemoryToolCallRecorder;
    let pid = 0;

    beforeAll(async () => {
      const name = `ai-se-evidence-lifecycle-${randomUUID()}`;
      containerName = name;
      await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e",
        "POSTGRES_USER=aise",
        "-e",
        "POSTGRES_DB=aise",
        "-p",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "postgres:16-alpine"
      ]);
      const port = (await docker(["port", name, "5432/tcp"])).split(":").at(-1);
      if (!port) throw new Error("Cannot resolve PostgreSQL test port");
      pool = createPool(`postgres://aise@127.0.0.1:${port}/aise`);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await pool.query("SELECT 1");
          break;
        } catch {
          await sleep(500);
        }
      }
      await runMigrations(pool);
      repository = new PgEvidenceRepository(pool);
      const projects = new PgProjectRepository(pool);
      projectId = (
        await projects.create({
          name: "Evidence lifecycle E2E",
          description: "Phase 5.7-4",
          repository: "https://local.test/evidence-lifecycle",
          status: "active"
        })
      ).id;
      const requirementId = await pool
        .query<{
          id: string;
        }>(
          `INSERT INTO requirements (project_id, title, raw_content) VALUES ($1, 'Evidence lifecycle run', 'raw') RETURNING id`,
          [projectId]
        )
        .then((result) => result.rows[0]!.id);
      workflowRunId = await pool
        .query<{
          id: string;
        }>(
          `INSERT INTO workflow_runs (project_id, requirement_id, planning_version, status) VALUES ($1, $2, 1, 'RUNNING') RETURNING id`,
          [projectId, requirementId]
        )
        .then((result) => result.rows[0]!.id);
      taskId = await pool
        .query<{
          id: string;
        }>(
          `INSERT INTO tasks (project_id, requirement_id, task_key, title, type) VALUES ($1, $2, 'EVIDENCE_LIFECYCLE', 'Evidence lifecycle task', 'TEST') RETURNING id`,
          [projectId, requirementId]
        )
        .then((result) => result.rows[0]!.id);

      recorder = new MemoryToolCallRecorder();
      session = new BrowserSession({
        playwright: createRealPlaywright(),
        navigateAllowlist: ALLOW_DATA,
        sessionId: "browser:evidence:1"
      });
      await session.launch({ headless: true });
      await session.setViewport(1280, 720);
      browserRuntime = new ToolRuntime({
        tools: [...COMPUTER_USE_BROWSER_TOOLS] as ToolDefinition<unknown, unknown>[]
      });

      stdioClient = new StdioMCPClient();
      const client = new CountingMCPClient(stdioClient);
      const catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
      registry = createExternalToolRegistry({ client, catalog });
      connector = new ExternalEngineeringConnector({ client, catalog, registry });
      await connector.connectAll();
      registry.bindProject({ projectId, serverId: FAKE_EXTERNAL_SERVER_ID });
      registry.bindAgent({
        projectId,
        agentName: "evidence-agent",
        serverId: FAKE_EXTERNAL_SERVER_ID
      });
      externalRuntime = new ToolRuntime({
        tools: connector.toolDefinitions({ projectId, agentName: "evidence-agent" })
      });
      pid = stdioClient.pidOf(FAKE_EXTERNAL_SERVER_ID) as number;
    }, 300_000);

    afterAll(async () => {
      await registry?.disconnectAll();
      if (pid) await waitForProcessExit(pid, 3000).catch(() => undefined);
      await session?.close();
      await pool.end();
      await docker(["rm", "-f", containerName]).catch(() => undefined);
    });

    async function observeSnapshot(context: ToolExecutionContext): Promise<EvidenceSnapshot> {
      const observed = await browserRuntime.execute("browser.observe", {}, context);
      expect(observed.success).toBe(true);
      return {
        observation: observed.data as Observation,
        capturedAt: new Date().toISOString()
      };
    }

    async function listSnapshot(context: ToolExecutionContext): Promise<EvidenceSnapshot> {
      const listed = await externalRuntime.execute("issues.list", {}, context);
      expect(listed.success).toBe(true);
      return {
        result: (listed.data as ExternalToolOutcome).result,
        capturedAt: new Date().toISOString()
      };
    }

    function domTexts(
      record: { after?: EvidenceSnapshot; before?: EvidenceSnapshot },
      side: "before" | "after"
    ) {
      const snapshot = record[side];
      return (snapshot?.observation?.dom?.nodes ?? []).map((node) => node.text);
    }

    it("browser: observe → click → observe → screenshot → VERIFIED evidence persisted", async () => {
      const nav = await browserRuntime.execute(
        "browser.action.navigate",
        { url: FIXTURE },
        browserContext(session, recorder)
      );
      expect(nav.success).toBe(true);

      const draft = await captureActionEvidence({
        identity: {
          projectId,
          workflowRunId,
          taskId,
          toolCallId: "call-evidence-click",
          actionRef: {
            source: "browser",
            sessionId: "browser:evidence:1",
            toolName: "browser.action.click",
            target: "#go"
          }
        },
        expectations: [
          { kind: "action-succeeded" },
          { kind: "changed" },
          { kind: "contains", value: "go" }
        ],
        before: () => observeSnapshot(browserContext(session, recorder)),
        act: async () => {
          const clicked = await browserRuntime.execute(
            "browser.action.click",
            { selector: "#go" },
            browserContext(session, recorder, { toolCallId: "call-evidence-click" })
          );
          expect(clicked.success).toBe(true);
          const actionResult = clicked.data as ActionResult;
          expect(actionResult.status).toBe("success");
          return { result: actionResult, actionRef: actionResult.actionRef };
        },
        after: () => observeSnapshot(browserContext(session, recorder)),
        screenshot: async () => {
          const shot = await browserRuntime.execute(
            "browser.action.screenshot",
            {},
            browserContext(session, recorder)
          );
          expect(shot.success).toBe(true);
          return (shot.data as ActionResult).observation?.screenshotRef;
        }
      });

      expect(draft.verification.status).toBe("VERIFIED");
      expect(draft.screenshotRef).toMatch(/^screenshot:\/\/browser:evidence:1\//);
      expect(draft.toolCallId).toBe("call-evidence-click");

      const stored = await repository.create(draft);
      const readBack = await repository.findById(stored.id);
      expect(readBack).not.toBeNull();
      expect(readBack!.verification.status).toBe("VERIFIED");
      expect(readBack!.screenshotRef).toBe(draft.screenshotRef);
      expect(readBack!.workflowRunId).toBe(workflowRunId);
      expect(readBack!.taskId).toBe(taskId);
      // Real data on both sides: the fixture counter moved 0 → 1.
      expect(domTexts(readBack!, "before")).toContain("0");
      expect(domTexts(readBack!, "before")).not.toContain("1");
      expect(domTexts(readBack!, "after")).toContain("1");
      expect(readBack!.result.status).toBe("success");
      expect(readBack!.actionRef).toMatchObject({
        source: "browser",
        sessionId: "browser:evidence:1",
        toolName: "browser.action.click"
      });
      // Audit: the click tool call was recorded by the runtime recorder and the
      // evidence record links to the same toolCallId.
      expect(recorder.finished.some((entry) => entry.toolCallId === "call-evidence-click")).toBe(
        true
      );
      expect(readBack!.toolCallId).toBe("call-evidence-click");
    }, 240_000);

    it("browser failure: action failed → FAILED evidence keeps the failure facts", async () => {
      const nav = await browserRuntime.execute(
        "browser.action.navigate",
        { url: FIXTURE },
        browserContext(session, recorder)
      );
      expect(nav.success).toBe(true);

      const draft = await captureActionEvidence({
        identity: {
          projectId,
          taskId,
          toolCallId: "call-evidence-missing",
          actionRef: {
            source: "browser",
            sessionId: "browser:evidence:1",
            toolName: "browser.action.click",
            target: "#missing"
          }
        },
        expectations: [{ kind: "action-succeeded" }, { kind: "changed" }],
        before: () => observeSnapshot(browserContext(session, recorder)),
        act: async () => {
          const clicked = await browserRuntime.execute(
            "browser.action.click",
            { selector: "#missing" },
            browserContext(session, recorder)
          );
          // The tool reports failure as a failed ActionResult (never a throw).
          expect(clicked.success).toBe(true);
          const actionResult = clicked.data as ActionResult;
          expect(actionResult.status).toBe("failed");
          return { result: actionResult };
        },
        after: () => observeSnapshot(browserContext(session, recorder))
      });

      expect(draft.verification.status).toBe("FAILED");
      expect(draft.verification.findings.map((finding) => finding.ok)).toEqual([false, false]);
      expect(draft.result.status).toBe("failed");

      const stored = await repository.create(draft);
      const readBack = await repository.findById(stored.id);
      expect(readBack!.verification.status).toBe("FAILED");
      expect(readBack!.result.status).toBe("failed");
      expect(readBack!.result.error?.code).toBeTruthy();
      // Failure facts preserved: page never changed (still 0 on both sides).
      expect(domTexts(readBack!, "after")).toContain("0");
    }, 240_000);

    it("browser expectation not met: action succeeded but after does not satisfy expected → FAILED", async () => {
      const nav = await browserRuntime.execute(
        "browser.action.navigate",
        { url: FIXTURE },
        browserContext(session, recorder)
      );
      expect(nav.success).toBe(true);

      const draft = await captureActionEvidence({
        identity: {
          projectId,
          toolCallId: "call-evidence-expectation",
          actionRef: {
            source: "browser",
            sessionId: "browser:evidence:1",
            toolName: "browser.action.click",
            target: "#go"
          }
        },
        expectations: [{ kind: "action-succeeded" }, { kind: "contains", value: "count: 99" }],
        before: () => observeSnapshot(browserContext(session, recorder)),
        act: async () => {
          const clicked = await browserRuntime.execute(
            "browser.action.click",
            { selector: "#go" },
            browserContext(session, recorder)
          );
          return { result: clicked.data as ActionResult };
        },
        after: () => observeSnapshot(browserContext(session, recorder))
      });

      expect(draft.verification.status).toBe("FAILED");
      expect(draft.verification.findings.map((finding) => finding.ok)).toEqual([true, false]);
      expect(draft.verification.findings[1]?.detail).toContain("count: 99");

      const stored = await repository.create(draft);
      const readBack = await repository.findById(stored.id);
      expect(readBack!.verification.status).toBe("FAILED");
      expect(domTexts(readBack!, "after")).toContain("1"); // the fact still shows the real change
    }, 240_000);

    it("external: before list → issues.create over real MCP → after list → VERIFIED evidence persisted", async () => {
      const draft = await captureActionEvidence({
        identity: {
          projectId,
          workflowRunId,
          taskId,
          toolCallId: "call-evidence-create",
          actionRef: {
            source: "mcp",
            serverName: "github",
            toolName: "issues.create",
            callId: "call-evidence-create"
          }
        },
        expectations: [
          { kind: "action-succeeded" },
          { kind: "contains", value: "ISS-101" },
          { kind: "changed" }
        ],
        before: () => listSnapshot(externalContext(recorder, projectId)),
        act: async () => {
          const created = await externalRuntime.execute(
            "issues.create",
            { title: "Evidence lifecycle issue" },
            externalContext(recorder, projectId, { toolCallId: "call-evidence-create" })
          );
          expect(created.success).toBe(true);
          const outcome = created.data as ExternalToolOutcome;
          return {
            result: outcome.actionResult,
            actionRef: outcome.actionResult.actionRef,
            externalId: (outcome.result as { id?: string }).id
          };
        },
        after: () => listSnapshot(externalContext(recorder, projectId))
      });

      expect(draft.verification.status).toBe("VERIFIED");
      expect(draft.externalId).toBe("ISS-101");
      expect(draft.actionRef).toEqual({
        source: "mcp",
        serverName: "github",
        toolName: "issues.create",
        callId: "call-evidence-create"
      });

      const stored = await repository.create(draft);
      const readBack = await repository.findById(stored.id);
      expect(readBack!.verification.status).toBe("VERIFIED");
      const beforeIssues = (readBack!.before.result as { issues: { id: string }[] }).issues;
      const afterIssues = (readBack!.after.result as { issues: { id: string }[] }).issues;
      expect(beforeIssues.map((issue) => issue.id)).toEqual(["ISS-1", "ISS-2"]);
      expect(afterIssues.map((issue) => issue.id)).toEqual(["ISS-1", "ISS-2", "ISS-101"]);
      // Audit: the MCP action was recorded; evidence links to the same call.
      expect(recorder.finished.some((entry) => entry.toolCallId === "call-evidence-create")).toBe(
        true
      );
    }, 240_000);

    it("external failure: MCP action failed → FAILED evidence keeps the failure facts", async () => {
      const draft = await captureActionEvidence({
        identity: {
          projectId,
          toolCallId: "call-evidence-failed",
          actionRef: {
            source: "mcp",
            serverName: "github",
            toolName: "issues.fail",
            callId: "call-evidence-failed"
          }
        },
        expectations: [{ kind: "action-succeeded" }, { kind: "contains", value: "created" }],
        before: () => listSnapshot(externalContext(recorder, projectId)),
        act: async () => {
          const failed = await externalRuntime.execute(
            "issues.fail",
            { message: "remote issue tracker failure" },
            externalContext(recorder, projectId, { toolCallId: "call-evidence-failed" })
          );
          // Invocation completed; the ACTION failed (failed ActionResult).
          expect(failed.success).toBe(true);
          const outcome = failed.data as ExternalToolOutcome;
          expect(outcome.actionResult.status).toBe("failed");
          return { result: outcome.actionResult };
        },
        after: () => listSnapshot(externalContext(recorder, projectId))
      });

      expect(draft.verification.status).toBe("FAILED");
      expect(draft.result.status).toBe("failed");
      const stored = await repository.create(draft);
      const readBack = await repository.findById(stored.id);
      expect(readBack!.verification.status).toBe("FAILED");
      expect(readBack!.result.error?.code).toBeTruthy();
    }, 240_000);

    it("credential isolation: credential-shaped external content never reaches evidence or the database", async () => {
      // The credential enters through a REAL external flow: it is created as an
      // issue title over MCP and therefore appears in the AFTER snapshot's real
      // data (list). From there it must never survive into the evidence record
      // or the database in raw form — every layer (connector redaction +
      // evidence redaction sink) is asserted together.
      const createWithCredential = await externalRuntime.execute(
        "issues.create",
        { title: `leak probe ${CREDENTIAL}` },
        externalContext(recorder, projectId, { toolCallId: "call-evidence-credential-seed" })
      );
      expect(createWithCredential.success).toBe(true);

      const draft = await captureActionEvidence({
        identity: {
          projectId,
          toolCallId: "call-evidence-credential",
          actionRef: {
            source: "mcp",
            serverName: "github",
            toolName: "issues.create",
            callId: "call-evidence-credential"
          }
        },
        expectations: [{ kind: "changed" }],
        before: () => listSnapshot(externalContext(recorder, projectId)),
        act: async () => {
          const created = await externalRuntime.execute(
            "issues.create",
            { title: "credential carry", body: `key: ${CREDENTIAL}` },
            externalContext(recorder, projectId, { toolCallId: "call-evidence-credential" })
          );
          expect(created.success).toBe(true);
          const outcome = created.data as ExternalToolOutcome;
          return { result: outcome.actionResult, actionRef: outcome.actionResult.actionRef };
        },
        after: () => listSnapshot(externalContext(recorder, projectId))
      });

      // The raw credential REALLY flowed through the capture: both snapshots
      // observed the seeded issue — as redacted data only.
      expect(JSON.stringify(draft.before.result)).toContain("[REDACTED]");
      expect(JSON.stringify(draft.after.result)).toContain("[REDACTED]");
      expect(JSON.stringify(draft)).not.toContain(CREDENTIAL);

      const stored = await repository.create(draft);
      expect(JSON.stringify(stored)).not.toContain(CREDENTIAL);
      expect(JSON.stringify(stored)).toContain("[REDACTED]");

      const rawRows = await pool.query<{
        before_text: string;
        after_text: string;
        result_text: string;
      }>(
        `SELECT before_snapshot::text AS before_text, after_snapshot::text AS after_text, result::text AS result_text
         FROM evidence_records WHERE id = $1`,
        [stored.id]
      );
      const blob = JSON.stringify(rawRows.rows[0]);
      expect(blob).not.toContain(CREDENTIAL);
      expect(blob).toContain("[REDACTED]");
    }, 240_000);
  }
);
