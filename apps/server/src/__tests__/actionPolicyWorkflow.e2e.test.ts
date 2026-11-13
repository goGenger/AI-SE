import { defaultActionPolicy } from "@ai-se/action-policy";
import {
  PgPlanningRepository,
  PgProjectRepository,
  PgWorkflowRepository,
  createPool,
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
import { RequirementAnalysis, TaskPlan, type JsonObject, type WorkflowPolicy } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallRecorder,
  type ToolCallStartedRecord,
  type ToolExecutionContext
} from "@ai-se/tool-runtime";
import type { WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowService } from "../services/workflowService";

/**
 * Phase 5.7-3 REAL e2e: Agent path → ToolRuntime → Action Policy → Approval
 * (the EXISTING workflow-engine WAITING_APPROVAL chain) → external execution.
 *
 *   task (action = releases.publish)
 *     → policy decision {HIGH, requiresApproval:true}   (derivation)
 *     → engine creates Approval, task/workflow WAITING_APPROVAL
 *     → reject  → task FAILED, ZERO MCP requests
 *     → approve → task READY → executor → ToolRuntime → MCPToolAdapter
 *       → REAL MCP stdio → mock external system  (+ ToolCallRecorder audit)
 *
 * Plus: LOW actions skip approval and execute directly; a misdeclared-low
 * catalog entry is raised by the policy and the action-level gate still
 * blocks execution with zero requests. Real PostgreSQL, real stdio child,
 * zero external network.
 */

const execFileAsync = promisify(execFile);
const TASK_KEY = "EXTERNAL_TASK";

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

  totalRequests(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
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

const analysis: RequirementAnalysis = {
  id: "ACTION_POLICY_E2E",
  summary: "Run one external engineering action",
  goals: ["Action policy → approval → execution"],
  constraints: [],
  assumptions: [],
  acceptanceCriteria: ["Action completes"],
  risks: []
};

const plan: TaskPlan = {
  summary: "External action",
  tasks: [
    {
      id: TASK_KEY,
      title: "Run external action",
      description: "Run one external engineering action through the action policy.",
      type: "BUILD",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["Action completes"],
      sourceSpecTypes: ["TECHNICAL"]
    }
  ]
};

const AGENT = "external-agent";

describe("5.7-3 action policy → workflow approval → external execution", () => {
  let stop: () => Promise<void>;
  let pool: ReturnType<typeof createPool>;
  let projects: PgProjectRepository;
  let planning: PgPlanningRepository;
  let workflows: PgWorkflowRepository;
  let service: WorkflowService;
  let projectId = "";
  let stdioClient: StdioMCPClient;
  let client: CountingMCPClient;
  let catalog: ExternalToolCatalog;
  let registry: ReturnType<typeof createExternalToolRegistry>;
  let connector: ExternalEngineeringConnector;
  let runtime: ToolRuntime;
  let recorder: MemoryToolCallRecorder;
  let pid: number;
  const executed: Array<{
    action: string;
    risk: string;
    status: string;
    toolCallId: string;
    error?: string;
  }> = [];

  const QUERY = () => ({ projectId, agentName: AGENT });

  const executor: WorkflowTaskExecutor = {
    async execute(workflow, task) {
      const action = typeof task.input.action === "string" ? task.input.action : "";
      const entry = catalog.toolEntry(FAKE_EXTERNAL_SERVER_ID, action);
      const decision = entry ? defaultActionPolicy.resolveExternal(action, entry) : undefined;
      if (!decision) {
        return {
          status: "failed",
          error: { code: "ACTION_POLICY_DENIED", message: `Action policy denied ${action}` }
        };
      }
      const approvals = await workflows.findApprovals(workflow.id);
      const approved = approvals.some(
        (approval) => approval.taskId === task.id && approval.status === "APPROVED"
      );
      const result = await runtime.execute(action, (task.input.args ?? {}) as JsonObject, {
        requestId: randomUUID(),
        projectId: workflow.projectId,
        taskId: task.id,
        agentRunId: randomUUID(),
        toolCallId: randomUUID(),
        actor: "ExternalActionExecutor",
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("action policy e2e never uses the coding sandbox");
          }
        },
        metadata: { workflowRunId: workflow.id, approved },
        toolCallRecorder: recorder
      });
      executed.push({
        action,
        risk: result.audit.riskLevel,
        status: result.success ? "succeeded" : "failed",
        toolCallId: result.toolCallId,
        error: result.error?.message
      });
      if (!result.success) {
        return {
          status: "failed",
          error: { code: result.error?.code ?? "TOOL_ERROR", message: result.error?.message ?? "" }
        };
      }
      const outcome = result.data as ExternalToolOutcome;
      return { status: "succeeded", output: { action, actionStatus: outcome.actionResult.status } };
    },
    async cancel() {}
  };

  beforeAll(async () => {
    const postgresContainer = `ai-se-action-policy-db-${randomUUID()}`;
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      postgresContainer,
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
    const databasePort = (await docker(["port", postgresContainer, "5432/tcp"])).split(":").at(-1);
    if (!databasePort) throw new Error("Cannot resolve PostgreSQL port");
    pool = createPool(`postgres://aise@127.0.0.1:${databasePort}/aise`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch {
        await sleep(500);
      }
    }
    await runMigrations(pool);
    projects = new PgProjectRepository(pool);
    planning = new PgPlanningRepository(pool);
    workflows = new PgWorkflowRepository(pool);
    service = new WorkflowService({ workflows, projects, executor });

    const project = await projects.create({
      name: "Action policy E2E",
      description: "Phase 5.7-3",
      repository: "https://local.test/action-policy-e2e",
      status: "active"
    });
    projectId = project.id;

    stdioClient = new StdioMCPClient();
    client = new CountingMCPClient(stdioClient);
    catalog = new ExternalToolCatalog([createFakeExternalSystemEntry()]);
    const approvalGate = (context: ToolExecutionContext) => context.metadata?.approved === true;
    registry = createExternalToolRegistry({ client, catalog, approvalGate });
    connector = new ExternalEngineeringConnector({
      client,
      catalog,
      registry,
      approvalGate
    });
    await connector.connectAll();
    registry.bindProject({ projectId, serverId: FAKE_EXTERNAL_SERVER_ID });
    registry.bindAgent({ projectId, agentName: AGENT, serverId: FAKE_EXTERNAL_SERVER_ID });
    runtime = new ToolRuntime({ tools: connector.toolDefinitions(QUERY()) });
    recorder = new MemoryToolCallRecorder();
    pid = stdioClient.pidOf(FAKE_EXTERNAL_SERVER_ID) as number;

    stop = async () => {
      await registry.disconnectAll();
      await pool.end();
      await docker(["rm", "-f", postgresContainer]).catch(() => undefined);
    };
  }, 180_000);

  afterAll(async () => {
    await stop?.();
    await waitForProcessExit(pid, 3000);
  });

  async function createWorkflow(
    approvalTaskKeys: string[],
    policyOverride: Partial<WorkflowPolicy> = {}
  ): Promise<string> {
    const requirement = await planning.createRequirement(projectId, {
      title: `External action ${randomUUID()}`,
      description: "",
      rawContent: "Run one external engineering action"
    });
    await planning.savePlanningResult({
      projectId,
      requirementId: requirement.id,
      requirementVersion: 1,
      version: 1,
      analysis,
      specifications: [
        { type: "FUNCTIONAL", content: { requirements: [] } },
        { type: "TECHNICAL", content: { requirements: [] } },
        { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
        { type: "API", content: { endpoints: [] } },
        { type: "DATABASE", content: { tables: [] } },
        { type: "UI", content: { pages: [] } }
      ],
      taskPlan: plan
    });
    const workflow = await service.create({
      projectId,
      requirementId: requirement.id,
      workspacePath: process.cwd(),
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: false,
        allowReplan: false,
        approvalRequired: false,
        ...policyOverride
      },
      approvalTaskKeys
    });
    return workflow.id;
  }

  async function setTaskAction(
    workflowId: string,
    action: string,
    args: JsonObject
  ): Promise<void> {
    await pool.query(
      `UPDATE tasks SET input = input || $2::jsonb WHERE workflow_run_id = $1 AND task_key = $3`,
      [workflowId, JSON.stringify({ action, args }), TASK_KEY]
    );
  }

  async function waitForWorkflowStatus(workflowId: string, status: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const detail = await service.getDetail(workflowId);
      if (detail?.workflow.status === status) return detail;
      await sleep(50);
    }
    throw new Error(`Workflow ${workflowId} did not reach ${status}`);
  }

  /** 5.7-3 derivation: approvalRequired comes from the unified Action Policy. */
  function approvalKeysFor(action: string): string[] {
    const entry = catalog.toolEntry(FAKE_EXTERNAL_SERVER_ID, action);
    const decision = entry ? defaultActionPolicy.resolveExternal(action, entry) : undefined;
    return decision?.requiresApproval ? [TASK_KEY] : [];
  }

  it("HIGH action + REJECT: workflow waits in WAITING_APPROVAL, rejection yields ZERO MCP requests", async () => {
    // Precondition: the policy marks releases.publish HIGH + approval.
    const entry = catalog.toolEntry(FAKE_EXTERNAL_SERVER_ID, "releases.publish");
    expect(entry && defaultActionPolicy.resolveExternal("releases.publish", entry)).toEqual({
      riskLevel: "HIGH",
      requiresApproval: true
    });
    expect(approvalKeysFor("releases.publish")).toEqual([TASK_KEY]);

    const workflowId = await createWorkflow(approvalKeysFor("releases.publish"));
    await setTaskAction(workflowId, "releases.publish", { tag: "v1" });
    await service.start(workflowId);
    const waiting = await waitForWorkflowStatus(workflowId, "WAITING_APPROVAL");
    expect(waiting.tasks.find((task) => task.taskKey === TASK_KEY)?.status).toBe(
      "WAITING_APPROVAL"
    );
    const pending = waiting.approvals.find((approval) => approval.status === "PENDING");
    expect(pending).toBeDefined();
    expect(waiting.events.map((event) => event.eventType)).toContain("APPROVAL_REQUIRED");

    // Nothing has been executed: zero requests, no tool calls, no execution record.
    const requestsBefore = client.totalRequests();
    expect(client.requestCount("releases.publish")).toBe(0);
    expect(recorder.started).toHaveLength(0);
    expect(executed).toHaveLength(0);

    await service.reject(pending!.id, { comment: "not now" });
    const finished = await service.waitForTerminal(workflowId, 30_000);
    expect(finished?.workflow.status).toBe("FAILED");
    expect(finished?.events.map((event) => event.eventType)).toContain("APPROVAL_REJECTED");
    expect(client.totalRequests()).toBe(requestsBefore); // ZERO MCP requests
    expect(executed).toHaveLength(0);
  });

  it("L1-3: an L1 workflow cannot waive the approval gate of a HIGH-risk action", async () => {
    // 策略把 approvalRequired 声明为 false、并声明自治级别 L1——高风险门仍必须成立：
    // 审批要求由 Action Policy 从风险派生（`packages/action-policy/src/policy.ts:62`），
    // 工作流策略无从关闭它（L1-9 红线）。
    const workflowId = await createWorkflow(approvalKeysFor("releases.publish"), {
      autonomyLevel: "L1",
      failureStrategy: "RETRY",
      maxRetries: 2,
      deployFailureStrategy: "ROLLBACK"
    });
    await setTaskAction(workflowId, "releases.publish", { tag: "v1" });
    await service.start(workflowId);

    const waiting = await waitForWorkflowStatus(workflowId, "WAITING_APPROVAL");
    const task = waiting.tasks.find((entry) => entry.taskKey === TASK_KEY);
    expect(task?.status).toBe("WAITING_APPROVAL");
    expect(task?.approvalRequired).toBe(true);
    expect(waiting.approvals.find((approval) => approval.status === "PENDING")).toBeDefined();
    expect(executed).toHaveLength(0); // 批准前一次都没执行
  });

  it("HIGH action + APPROVE: task resumes and executes for real; audit correlates tool ↔ risk ↔ approval ↔ outcome", async () => {
    const workflowId = await createWorkflow(approvalKeysFor("releases.publish"));
    await setTaskAction(workflowId, "releases.publish", { tag: "v9" });
    await service.start(workflowId);
    const waiting = await waitForWorkflowStatus(workflowId, "WAITING_APPROVAL");
    const pending = waiting.approvals.find((approval) => approval.status === "PENDING");

    await service.approve(pending!.id, { comment: "ship it" });
    const finished = await service.waitForTerminal(workflowId, 30_000);
    expect(finished?.workflow.status).toBe("SUCCESS");
    const eventTypes = finished?.events.map((event) => event.eventType) ?? [];
    expect(eventTypes).toContain("APPROVAL_GRANTED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");

    // The external action really ran exactly once.
    expect(client.requestCount("releases.publish")).toBe(1);
    const record = executed.find((entry) => entry.action === "releases.publish");
    expect(record).toMatchObject({ risk: "HIGH", status: "succeeded" });

    // Audit correlation: ToolCallRecorder carries tool + outcome; the started
    // record's toolCallId matches the ToolResult used for execution; risk
    // traveled on the ToolResult audit (policy decision).
    const started = recorder.started.find((entry) => entry.toolName === "releases.publish");
    const finishedRecord = recorder.finished.find(
      (entry) => entry.toolCallId === started?.toolCallId
    );
    expect(started).toBeDefined();
    expect(finishedRecord?.status).toBe("succeeded");
    expect(started?.toolCallId).toBe(record?.toolCallId);
  });

  it("LOW action: no approval task, direct real execution with LOW audit risk", async () => {
    expect(approvalKeysFor("issues.list")).toEqual([]);
    const workflowId = await createWorkflow(approvalKeysFor("issues.list"));
    await setTaskAction(workflowId, "issues.list", {});
    await service.start(workflowId);
    const finished = await service.waitForTerminal(workflowId, 30_000);
    expect(finished?.workflow.status).toBe("SUCCESS");
    expect((finished?.events ?? []).some((event) => event.eventType === "APPROVAL_REQUIRED")).toBe(
      false
    );
    expect(client.requestCount("issues.list")).toBe(1);
    const record = executed.find((entry) => entry.action === "issues.list");
    expect(record).toMatchObject({ risk: "LOW", status: "succeeded" });
  });

  it("misdeclared-low catalog cannot lower risk: the action gate still blocks with zero requests", async () => {
    // A variant catalog declares releases.publish as LOW/no-approval. The
    // platform derivation (approvalKeysFor) would NOT create an approval task,
    // so the execution path must catch it: the policy raises the decision to
    // HIGH + approval, and the adapter's approval gate (approved=false, since
    // no approval record exists) denies the call before any request.
    const misdeclared = createFakeExternalSystemEntry({
      tools: createFakeExternalSystemEntry().tools.map((tool) =>
        tool.name === "releases.publish"
          ? { name: tool.name, riskLevel: "LOW" as const, requiresApproval: false }
          : tool
      )
    });
    const variantClient = new CountingMCPClient(new StdioMCPClient());
    const variantCatalog = new ExternalToolCatalog([misdeclared]);
    const variantRegistry = createExternalToolRegistry({
      client: variantClient,
      catalog: variantCatalog,
      approvalGate: (context) => context.metadata?.approved === true
    });
    const variantConnector = new ExternalEngineeringConnector({
      client: variantClient,
      catalog: variantCatalog,
      registry: variantRegistry,
      approvalGate: (context) => context.metadata?.approved === true
    });
    try {
      await variantConnector.connectAll();
      variantRegistry.bindProject({ projectId, serverId: FAKE_EXTERNAL_SERVER_ID });
      variantRegistry.bindAgent({ projectId, agentName: AGENT, serverId: FAKE_EXTERNAL_SERVER_ID });
      const definitions = variantConnector.toolDefinitions(QUERY());
      expect(definitions.find((def) => def.name === "releases.publish")?.riskLevel).toBe("HIGH");

      const variantRuntime = new ToolRuntime({ tools: definitions });
      const result = await variantRuntime.execute("releases.publish", { tag: "v1" }, {
        requestId: randomUUID(),
        projectId,
        taskId: "task-misdeclared",
        agentRunId: randomUUID(),
        toolCallId: randomUUID(),
        actor: "ExternalActionExecutor",
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("not used");
          }
        },
        metadata: { approved: false },
        toolCallRecorder: recorder
      } as unknown as ToolExecutionContext);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("not approved");
      expect(result.audit.riskLevel).toBe("HIGH");
      expect(variantClient.requestCount("releases.publish")).toBe(0);
    } finally {
      await variantRegistry.disconnectAll();
    }
  });
});
