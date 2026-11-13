import { AgentDefinition, TaskContext, isolateTaskContext } from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgPlanningRepository,
  PgRequirementDocumentRepository,
  PgWorkflowRepository,
  ProjectRepository
} from "@ai-se/database";
import { JsonObject, Task, WorkflowRun, sliceAcKeys, taskAcKeys } from "@ai-se/shared";
import { officialVisualFromVerification } from "./officialVisualGate";

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * 验证记录留在任务输出里（切片 AC 覆盖判定与追溯表的事实来源），但**不进 Agent 输入**：
 * `observe` 模式因此真正只观测、不改变 Agent 的输入（2026-10-15 裁定，见 `docs/151`）。
 *
 * N-17（`docs/189` §4.3）：`enforce` 下任务**就是因此失败的**——失败理由必须能传到下游与重试。
 * 否则被 replan 出来的修复任务看不到上游为什么死，同一个死法必然重演：L1-M4l 那 7 次死亡里，
 * 每次重试都在**不知道**「我上次因为改了测试文件被判死」的情况下重做同一件事。
 *
 * **收窄而非推翻 `docs/151`**：`observe` 逐字节不变；`enforce` 只回灌**压缩投影**
 * （verdict / reason / failureCode）——该裁定实测的两处体积来源（`checks[]`、
 * `stdoutTail`/`stderrTail`，占验证记录 53%）一律不进。
 *
 * 返回新对象——同一条记录仍被其它读取方使用，不能就地删。
 */
function verificationForAgent(output: JsonObject | undefined): JsonObject | undefined {
  if (!output || !("verification" in output)) return output;
  const compact = compactEnforcedVerification(output.verification);
  const rest = { ...output };
  if (compact) {
    rest.verification = compact;
    return rest;
  }
  delete rest.verification;
  return rest;
}

/** `enforce` 的验证记录 → 压缩投影；`observe` 或形状不符 → null（整段剥掉）。 */
function compactEnforcedVerification(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode !== "enforce") return null;
  const compact: JsonObject = {
    verdict: typeof record.verdict === "string" ? record.verdict : "unknown"
  };
  if (typeof record.reason === "string") compact.reason = record.reason;
  if (typeof record.failureCode === "string") compact.failureCode = record.failureCode;
  // docs/265：审查/修复任务必须能读到官方视觉结论，不能只看到智能体自报。
  const officialVisual = officialVisualFromVerification(record);
  if (officialVisual) compact.officialVisual = officialVisual;
  return compact;
}

export class TaskContextBuilder {
  constructor(
    private readonly dependencies: {
      projects: ProjectRepository;
      planning: PgPlanningRepository;
      workflows: PgWorkflowRepository;
      agentRuns: PgAgentRunStore;
      artifacts: PgAgentArtifactRepository;
      documents?: Pick<PgRequirementDocumentRepository, "findUiReferencesByRequirementId">;
    }
  ) {}

  /**
   * N-40：本任务要覆盖的 AC 编号。
   *
   * 任务自己声明了 `input.acKeys` 就用它；否则用**同切片的并集**——与校验器的
   * `sliceScopeFallback` 是同一个口径（共用 `@ai-se/shared` 的 `sliceAcKeys`）。
   * 此前校验器按编号选测试，而编号从没告诉 agent：agent 写出的测试没有 `[AC-xx]` 标记，
   * 选取结果为零，任务被判「没有证据」。这个方法是那条断链的补口。
   */
  async acceptanceScope(workflow: WorkflowRun, task: Task): Promise<string[]> {
    const own = taskAcKeys(task);
    if (own.length > 0) return own;
    if (!task.sliceKey) return [];
    const tasks = await this.dependencies.workflows.findTasks(workflow.id).catch(() => []);
    return sliceAcKeys(
      tasks.filter((entry) => entry.sliceKey === task.sliceKey),
      task
    );
  }

  async build(
    definition: AgentDefinition,
    workflow: WorkflowRun,
    task: Task
  ): Promise<TaskContext> {    const [project, requirement, specifications, tasks, dependencies, previousAttempts] =
      await Promise.all([
        this.dependencies.projects.findById(workflow.projectId),
        this.dependencies.planning.findRequirementById(workflow.requirementId),
        this.dependencies.planning.findSpecificationsByRequirementId(workflow.requirementId),
        this.dependencies.workflows.findTasks(workflow.id),
        this.dependencies.workflows.findDependencies(workflow.id),
        this.dependencies.agentRuns.findByTaskId(task.id)
      ]);
    if (!project) throw new Error("Project not found while building TaskContext");

    const uiReferenceRows = this.dependencies.documents
      ? await this.dependencies.documents.findUiReferencesByRequirementId(workflow.requirementId)
      : [];
    const uiReferences = uiReferenceRows.map((row) => ({
      fileName: row.fileName,
      mimeType: row.mimeType,
      note: row.note
    }));

    const sourceIds = dependencies
      .filter((dependency) => dependency.active !== false && dependency.targetTaskId === task.id)
      .map((dependency) => dependency.sourceTaskId);
    const dependencyTasks = tasks.filter((entry) => sourceIds.includes(entry.id));
    const relatedIds = [...sourceIds, task.id];
    const artifacts = await this.dependencies.artifacts.findByTaskIds(relatedIds);

    return isolateTaskContext(definition, {
      project,
      requirement: requirement ?? undefined,
      task,
      specifications: specifications.filter(
        (specification) => specification.version === workflow.planningVersion
      ),
      dependencyResults: dependencyTasks.map((entry) => ({
        taskId: entry.id,
        taskKey: entry.taskKey,
        type: entry.type,
        output: verificationForAgent(entry.output)
      })),
      relevantFiles: strings(task.input.relevantFiles),
      previousAttempts: previousAttempts.map((run) => ({
        id: run.id,
        status: run.status,
        currentIteration: run.currentIteration,
        retryCount: run.retryCount,
        output: run.output,
        error: run.error
      })),
      testResults: artifacts.filter((artifact) => artifact.type === "TEST_RESULT"),
      reviewResults: artifacts.filter((artifact) => artifact.type === "REVIEW_RESULT"),
      ...(uiReferences.length > 0 ? { uiReferences } : {})
    });
  }
}
