import {
  CreateRequirementData,
  isAutonomyLevel,
  JsonObject,
  Requirement,
  RequirementAnalysis,
  RequirementSlice,
  RequirementStatus,
  SlicePlan,
  SliceStatus,
  Specification,
  SpecificationType,
  Task,
  TaskDependencyView,
  TaskPlan,
  TaskPriority,
  TaskStatus,
  TaskType
} from "@ai-se/shared";
import { Pool, PoolClient } from "pg";

interface RequirementRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  raw_content: string;
  autonomy_level: string | null;
  status: RequirementStatus;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SpecificationRow {
  id: string;
  project_id: string;
  requirement_id: string;
  type: SpecificationType;
  version: number;
  status: Specification["status"];
  content: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskRow {
  id: string;
  project_id: string;
  requirement_id: string | null;
  workflow_run_id: string | null;
  task_key: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent: string | null;
  input: unknown;
  output: unknown | null;
  retry_count: number;
  version: number;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  plan_task_id?: string | null;
  origin?: Task["origin"];
  creation_reason?: string | null;
  source_task_id?: string | null;
  resolved_by_task_id?: string | null;
  approval_required?: boolean;
  claim_token?: string | null;
  claimed_at?: Date | string | null;
  failure_handled?: boolean;
  /** N2：第二级任务计划的切片归属（旧数据/单级路径为 NULL）。 */
  slice_key?: string | null;
  /** F1-2：旧版本计划行标记（非空 = 已被更高版本取代；仓储读取面默认过滤）。 */
  superseded_at?: Date | string | null;
}

interface RequirementSliceRow {
  id: string;
  project_id: string;
  requirement_id: string;
  planning_version: number | null;
  slice_key: string;
  title: string;
  goal: string;
  fr_keys: unknown;
  depends_on: unknown;
  slice_order: number;
  involves_ui: boolean;
  involves_data: boolean | null;
  status: SliceStatus;
  workflow_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskDependencyRow {
  id: string;
  source_task_id: string;
  target_task_id: string;
  source_task_key: string;
  target_task_key: string;
  created_at: Date | string;
  workflow_run_id?: string | null;
  origin?: TaskDependencyView["origin"];
  active?: boolean;
}

interface RequirementAcceptanceCriterionRow {
  id: string;
  project_id: string;
  requirement_id: string;
  ac_key: string;
  text: string;
  text_hash: string;
  priority: string | null;
  verification: string | null;
  smoke: boolean;
  fr_keys: unknown;
  source: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** N3：需求 AC 一等记录（requirement_acceptance_criteria 行）。 */
export interface AcceptanceCriterionRecord {
  acKey: string;
  text: string;
  textHash: string;
  priority: "Must" | "Should" | null;
  verification: string | null;
  smoke: boolean;
  frKeys: string[];
  source: "parsed" | "llm";
}

export interface SaveSpecificationInput {
  type: SpecificationType;
  content: JsonObject;
}

export interface SavePlanningResultInput {
  projectId: string;
  requirementId: string;
  requirementVersion: number;
  version: number;
  analysis: RequirementAnalysis;
  specifications: SaveSpecificationInput[];
  taskPlan: TaskPlan;
  /**
   * `docs/235` §7：本条计划属于哪个能力 profile（`id@version`）。写进新任务的
   * `input.profile`，批次后可直接把读数归因到口径；缺省不落键（历史行为不变）。
   */
  profile?: string;
}

export interface SavedPlanningResult {
  specifications: Specification[];
  tasks: Task[];
  dependencies: TaskDependencyView[];
}

/** N2：第一级切片计划落盘（重做=整体替换）。 */
export interface SlicePlanInput {
  projectId: string;
  requirementId: string;
  plan: SlicePlan;
}

/** N2：第二级单切片产物落盘（切片 scoped specifications + tasks）。 */
export interface SaveSlicePlanningResultInput {
  projectId: string;
  requirementId: string;
  requirementVersion: number;
  version: number;
  sliceKey: string;
  analysis: RequirementAnalysis;
  specifications: SaveSpecificationInput[];
  taskPlan: TaskPlan;
  /** `docs/235` §7：见 `SavePlanningResultInput.profile`。 */
  profile?: string;
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function optionalJsonObject(value: unknown | null): JsonObject | undefined {
  if (!value) {
    return undefined;
  }

  return jsonObject(value);
}

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    rawContent: row.raw_content,
    ...(isAutonomyLevel(row.autonomy_level) ? { autonomyLevel: row.autonomy_level } : {}),
    status: row.status,
    version: row.version,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapSpecification(row: SpecificationRow): Specification {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    type: row.type,
    version: row.version,
    status: row.status,
    content: jsonObject(row.content),
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskKey: row.task_key,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    priority: row.priority,
    assignedAgent: row.assigned_agent ?? undefined,
    input: jsonObject(row.input),
    output: optionalJsonObject(row.output),
    retryCount: row.retry_count,
    version: row.version,
    planTaskId: row.plan_task_id ?? undefined,
    origin: row.origin,
    creationReason: row.creation_reason ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    resolvedByTaskId: row.resolved_by_task_id ?? undefined,
    approvalRequired: row.approval_required ?? false,
    claimToken: row.claim_token ?? undefined,
    claimedAt: toIsoString(row.claimed_at ?? null),
    failureHandled: row.failure_handled ?? false,
    sliceKey: row.slice_key ?? undefined,
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapTaskDependency(row: TaskDependencyRow): TaskDependencyView {
  return {
    id: row.id,
    sourceTaskId: row.source_task_id,
    targetTaskId: row.target_task_id,
    sourceTaskKey: row.source_task_key,
    targetTaskKey: row.target_task_key,
    workflowRunId: row.workflow_run_id ?? undefined,
    origin: row.origin,
    active: row.active ?? true,
    createdAt: toIsoString(row.created_at) ?? ""
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mapAcceptanceCriterion(row: RequirementAcceptanceCriterionRow): AcceptanceCriterionRecord {
  return {
    acKey: row.ac_key,
    text: row.text,
    textHash: row.text_hash,
    priority: row.priority === "Must" || row.priority === "Should" ? row.priority : null,
    verification: row.verification,
    smoke: row.smoke,
    frKeys: stringArray(row.fr_keys),
    source: row.source === "llm" ? "llm" : "parsed"
  };
}

function mapRequirementSlice(row: RequirementSliceRow): RequirementSlice {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    planningVersion: row.planning_version,
    sliceKey: row.slice_key,
    title: row.title,
    goal: row.goal,
    frKeys: stringArray(row.fr_keys),
    dependsOn: stringArray(row.depends_on),
    order: row.slice_order,
    involvesUi: row.involves_ui,
    involvesData: row.involves_data ?? undefined,
    status: row.status,
    workflowRunId: row.workflow_run_id ?? undefined,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

async function insertSpecification(
  client: PoolClient,
  input: {
    projectId: string;
    requirementId: string;
    version: number;
    type: SpecificationType;
    content: JsonObject;
  }
): Promise<Specification> {
  const result = await client.query<SpecificationRow>(
    `
      INSERT INTO specifications (project_id, requirement_id, type, version, status, content)
      VALUES ($1, $2, $3, $4, 'VALIDATED', $5)
      RETURNING *
    `,
    [input.projectId, input.requirementId, input.type, input.version, input.content]
  );

  return mapSpecification(result.rows[0]);
}

function sourceSpecificationIds(
  specifications: Specification[],
  sourceSpecTypes: SpecificationType[]
): string[] {
  return specifications
    .filter((specification) => sourceSpecTypes.includes(specification.type))
    .map((specification) => specification.id);
}

export class PgPlanningRepository {
  constructor(private readonly pool: Pool) {}

  async createRequirement(projectId: string, input: CreateRequirementData): Promise<Requirement> {
    const result = await this.pool.query<RequirementRow>(
      `
        INSERT INTO requirements (project_id, title, description, raw_content, autonomy_level)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        projectId,
        input.title,
        input.description,
        input.rawContent,
        input.autonomyLevel ?? null
      ]
    );

    return mapRequirement(result.rows[0]);
  }

  async findRequirementsByProjectId(projectId: string): Promise<Requirement[]> {
    const result = await this.pool.query<RequirementRow>(
      `
        SELECT *
        FROM requirements
        WHERE project_id = $1
        ORDER BY created_at DESC
      `,
      [projectId]
    );

    return result.rows.map(mapRequirement);
  }

  async findRequirementById(id: string): Promise<Requirement | null> {
    const result = await this.pool.query<RequirementRow>(
      "SELECT * FROM requirements WHERE id = $1",
      [id]
    );

    return result.rows[0] ? mapRequirement(result.rows[0]) : null;
  }

  async findRequirementsByStatus(status: RequirementStatus): Promise<Requirement[]> {
    const result = await this.pool.query<RequirementRow>(
      `
        SELECT *
        FROM requirements
        WHERE status = $1
        ORDER BY updated_at ASC
      `,
      [status]
    );

    return result.rows.map(mapRequirement);
  }

  async updateRequirementStatus(
    id: string,
    status: RequirementStatus
  ): Promise<Requirement | null> {
    const result = await this.pool.query<RequirementRow>(
      `
        UPDATE requirements
        SET status = $2
        WHERE id = $1
        RETURNING *
      `,
      [id, status]
    );

    return result.rows[0] ? mapRequirement(result.rows[0]) : null;
  }

  /**
   * D1（`docs/229`）：文件形态的 PRD 抽取后写回 `raw_content`。
   * **不动 `version`**——版本号是规划产物的归属，改正文不等于加一版；是否过期由
   * `requirement_documents` 的上传时间与规划时间比较得出（见 `DocumentService.list`）。
   */
  async updateRequirementContent(id: string, rawContent: string): Promise<Requirement | null> {
    const result = await this.pool.query<RequirementRow>(
      `
        UPDATE requirements
        SET raw_content = $2
        WHERE id = $1
        RETURNING *
      `,
      [id, rawContent]
    );

    return result.rows[0] ? mapRequirement(result.rows[0]) : null;
  }

  /** D1：文档集合发生变化（上传/删除）——用于判定「规划是否过期」。 */
  async touchDocumentsChanged(id: string): Promise<void> {
    await this.pool.query("UPDATE requirements SET documents_changed_at = now() WHERE id = $1", [
      id
    ]);
  }

  async documentsChangedAt(requirementId: string): Promise<string | null> {
    const result = await this.pool.query<{ changed_at: Date | string | null }>(
      "SELECT documents_changed_at AS changed_at FROM requirements WHERE id = $1",
      [requirementId]
    );
    const value = result.rows[0]?.changed_at ?? null;
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value.toISOString() : value;
  }

  /** D1：最近一次规划产物的写入时间；从未规划返回 null。 */
  async latestAnalysisAt(requirementId: string): Promise<string | null> {
    const result = await this.pool.query<{ latest: Date | string | null }>(
      "SELECT MAX(created_at) AS latest FROM specifications WHERE requirement_id = $1",
      [requirementId]
    );
    const latest = result.rows[0]?.latest ?? null;
    if (latest === null) return null;
    return latest instanceof Date ? latest.toISOString() : latest;
  }

  async latestPlanningVersion(requirementId: string): Promise<number> {    const result = await this.pool.query<{ version: number | string | null }>(
      `
        SELECT GREATEST(
          COALESCE((SELECT MAX(version) FROM specifications WHERE requirement_id = $1), 0),
          COALESCE((SELECT MAX(version) FROM tasks WHERE requirement_id = $1), 0)
        ) AS version
      `,
      [requirementId]
    );

    return Number(result.rows[0]?.version ?? 0);
  }

  async findSpecificationsByRequirementId(requirementId: string): Promise<Specification[]> {
    const result = await this.pool.query<SpecificationRow>(
      `
        SELECT *
        FROM specifications
        WHERE requirement_id = $1
        ORDER BY version DESC, type ASC
      `,
      [requirementId]
    );

    return result.rows.map(mapSpecification);
  }

  /**
   * F1-2：需求下的原始计划行（默认过滤被取代的旧版本；需要旧版本时显式 includeSuperseded）。
   */
  async findTasksByRequirementId(
    requirementId: string,
    options: { includeSuperseded?: boolean } = {}
  ): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      `
        SELECT *
        FROM tasks
        WHERE requirement_id = $1
          AND ($2::boolean OR superseded_at IS NULL)
        ORDER BY version DESC, task_key ASC
      `,
      [requirementId, options.includeSuperseded ?? false]
    );

    return result.rows.map(mapTask);
  }

  /** N5：需求下全部运行时任务（经 workflow_runs 关联；携带 output.verification 证据）。 */
  async findRuntimeTasksByRequirementId(requirementId: string): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      `
        SELECT t.*
        FROM tasks t
        JOIN workflow_runs wr ON wr.id = t.workflow_run_id
        WHERE wr.requirement_id = $1
        ORDER BY t.finished_at DESC NULLS LAST, t.created_at DESC
      `,
      [requirementId]
    );

    return result.rows.map(mapTask);
  }

  async findTaskById(id: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async findTaskDependencies(taskId: string): Promise<TaskDependencyView[]> {
    const result = await this.pool.query<TaskDependencyRow>(
      `
        SELECT
          d.id,
          d.source_task_id,
          d.target_task_id,
          source.task_key AS source_task_key,
          target.task_key AS target_task_key,
          d.created_at
        FROM task_dependencies d
        JOIN tasks source ON source.id = d.source_task_id
        JOIN tasks target ON target.id = d.target_task_id
        WHERE d.source_task_id = $1 OR d.target_task_id = $1
        ORDER BY d.created_at ASC
      `,
      [taskId]
    );

    return result.rows.map(mapTaskDependency);
  }

  async findDependenciesByRequirementId(
    requirementId: string,
    options: { includeSuperseded?: boolean } = {}
  ): Promise<TaskDependencyView[]> {
    const result = await this.pool.query<TaskDependencyRow>(
      `
        SELECT
          d.id,
          d.source_task_id,
          d.target_task_id,
          source.task_key AS source_task_key,
          target.task_key AS target_task_key,
          d.created_at
        FROM task_dependencies d
        JOIN tasks source ON source.id = d.source_task_id
        JOIN tasks target ON target.id = d.target_task_id
        WHERE source.requirement_id = $1 AND target.requirement_id = $1
          AND ($2::boolean OR (source.superseded_at IS NULL AND target.superseded_at IS NULL))
        ORDER BY d.created_at ASC
      `,
      [requirementId, options.includeSuperseded ?? false]
    );

    return result.rows.map(mapTaskDependency);
  }

  /** N2：第一级切片计划落盘（重做=整体替换该需求的切片）。 */
  async replaceSlicePlan(input: SlicePlanInput): Promise<RequirementSlice[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM requirement_slices WHERE requirement_id = $1", [
        input.requirementId
      ]);
      for (const slice of input.plan.slices) {
        await client.query(
          `
            INSERT INTO requirement_slices (
              project_id, requirement_id, slice_key, title, goal,
              fr_keys, depends_on, slice_order, involves_ui, involves_data
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            input.projectId,
            input.requirementId,
            slice.id,
            slice.title,
            slice.goal,
            JSON.stringify(slice.frKeys),
            JSON.stringify(slice.dependsOn),
            slice.order,
            slice.involvesUi,
            slice.involvesData ?? null
          ]
        );
      }

      // F1-2：切片计划重做后，退役切片键（不在新切片集内）的旧计划行标记 SUPERSEDED。
      await client.query(
        `
          UPDATE tasks SET superseded_at = now()
          WHERE requirement_id = $1 AND workflow_run_id IS NULL
            AND slice_key IS NOT NULL AND superseded_at IS NULL
            AND NOT (slice_key = ANY($2::text[]))
        `,
        [input.requirementId, input.plan.slices.map((slice) => slice.id)]
      );

      await client.query("COMMIT");
      return await this.findSlicesByRequirementId(input.requirementId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findSlicesByRequirementId(requirementId: string): Promise<RequirementSlice[]> {
    const result = await this.pool.query<RequirementSliceRow>(
      "SELECT * FROM requirement_slices WHERE requirement_id = $1 ORDER BY slice_order ASC",
      [requirementId]
    );
    return result.rows.map(mapRequirementSlice);
  }

  async findSliceByKey(requirementId: string, sliceKey: string): Promise<RequirementSlice | null> {
    const result = await this.pool.query<RequirementSliceRow>(
      "SELECT * FROM requirement_slices WHERE requirement_id = $1 AND slice_key = $2",
      [requirementId, sliceKey]
    );
    return result.rows[0] ? mapRequirementSlice(result.rows[0]) : null;
  }

  async findSliceByWorkflowRunId(workflowRunId: string): Promise<RequirementSlice | null> {
    const result = await this.pool.query<RequirementSliceRow>(
      "SELECT * FROM requirement_slices WHERE workflow_run_id = $1",
      [workflowRunId]
    );
    return result.rows[0] ? mapRequirementSlice(result.rows[0]) : null;
  }

  async updateSliceStatus(
    id: string,
    status: SliceStatus,
    patch: { planningVersion?: number; workflowRunId?: string } = {}
  ): Promise<RequirementSlice | null> {
    const result = await this.pool.query<RequirementSliceRow>(
      `
        UPDATE requirement_slices
        SET status = $2,
            planning_version = COALESCE($3, planning_version),
            workflow_run_id = COALESCE($4, workflow_run_id)
        WHERE id = $1
        RETURNING *
      `,
      [id, status, patch.planningVersion ?? null, patch.workflowRunId ?? null]
    );
    return result.rows[0] ? mapRequirementSlice(result.rows[0]) : null;
  }

  /**
   * F1-4（FX-15b）：最终切片拆分——追加一个新切片行（「部署验证」段）。
   * 只 INSERT 新行；既有切片行零触碰（已完成切片的 FR 范围/任务/计划行原样保留、不标 SUPERSEDED）。
   */
  async insertRequirementSlice(input: {
    projectId: string;
    requirementId: string;
    sliceKey: string;
    title: string;
    goal: string;
    frKeys: string[];
    dependsOn: string[];
    order: number;
    involvesUi: boolean;
    involvesData?: boolean;
  }): Promise<RequirementSlice> {
    const result = await this.pool.query<RequirementSliceRow>(
      `
        INSERT INTO requirement_slices (
          project_id, requirement_id, slice_key, title, goal,
          fr_keys, depends_on, slice_order, involves_ui, involves_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
      [
        input.projectId,
        input.requirementId,
        input.sliceKey,
        input.title,
        input.goal,
        JSON.stringify(input.frKeys),
        JSON.stringify(input.dependsOn),
        input.order,
        input.involvesUi,
        input.involvesData ?? null
      ]
    );
    return mapRequirementSlice(result.rows[0]);
  }

  /** F1-4（FX-15b）：切片展示字段更新（拆分时标记「工程契约」段；不动 FR 范围/状态/计划行）。 */
  async updateSliceMeta(
    id: string,
    patch: { title?: string; goal?: string }
  ): Promise<RequirementSlice | null> {
    const result = await this.pool.query<RequirementSliceRow>(
      `
        UPDATE requirement_slices
        SET title = COALESCE($2, title), goal = COALESCE($3, goal)
        WHERE id = $1
        RETURNING *
      `,
      [id, patch.title ?? null, patch.goal ?? null]
    );
    return result.rows[0] ? mapRequirementSlice(result.rows[0]) : null;
  }

  /** N2 第二级输入：最近一次 requirement_analysis（去掉落盘时附加的归属字段）。 */
  async findLatestAnalysis(requirementId: string): Promise<RequirementAnalysis | null> {
    const result = await this.pool.query<SpecificationRow>(
      `
        SELECT *
        FROM specifications
        WHERE requirement_id = $1 AND type = 'REQUIREMENT_ANALYSIS'
        ORDER BY version DESC
        LIMIT 1
      `,
      [requirementId]
    );
    if (!result.rows[0]) {
      return null;
    }
    const content = jsonObject(result.rows[0].content);
    const {
      requirementId: _requirementId,
      requirementVersion: _requirementVersion,
      ...analysis
    } = content;
    return analysis as unknown as RequirementAnalysis;
  }

  /**
   * N3：需求 AC 记录整体替换（提取=替换，先例 replaceSlicePlan）。
   * fr_keys 是顶层数组参数 → 显式 JSON.stringify（node-pg 会把数组参数转成 PG 数组字面量）。
   */
  async replaceAcceptanceCriteria(input: {
    projectId: string;
    requirementId: string;
    records: AcceptanceCriterionRecord[];
  }): Promise<AcceptanceCriterionRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM requirement_acceptance_criteria WHERE requirement_id = $1", [
        input.requirementId
      ]);

      const saved: AcceptanceCriterionRecord[] = [];
      for (const record of input.records) {
        const result = await client.query<RequirementAcceptanceCriterionRow>(
          `
            INSERT INTO requirement_acceptance_criteria (
              project_id, requirement_id, ac_key, text, text_hash,
              priority, verification, smoke, fr_keys, source
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
          `,
          [
            input.projectId,
            input.requirementId,
            record.acKey,
            record.text,
            record.textHash,
            record.priority,
            record.verification,
            record.smoke,
            JSON.stringify(record.frKeys),
            record.source
          ]
        );
        saved.push(mapAcceptanceCriterion(result.rows[0]));
      }

      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** N3：需求 AC 记录（按编号升序）。 */
  async findAcceptanceCriteriaByRequirementId(
    requirementId: string
  ): Promise<AcceptanceCriterionRecord[]> {
    const result = await this.pool.query<RequirementAcceptanceCriterionRow>(
      `
        SELECT *
        FROM requirement_acceptance_criteria
        WHERE requirement_id = $1
        ORDER BY ac_key ASC
      `,
      [requirementId]
    );

    return result.rows.map(mapAcceptanceCriterion);
  }

  /** N3：AC → 任务映射数（按各切片最新版本的原始计划行 tasks.input.acKeys 计数）。 */
  async acceptanceCriteriaMappingCounts(requirementId: string): Promise<Map<string, number>> {
    const result = await this.pool.query<{
      slice_key: string | null;
      version: number;
      ac_keys: unknown;
    }>(
      `
        SELECT slice_key, version, input->'acKeys' AS ac_keys
        FROM tasks
        WHERE requirement_id = $1 AND workflow_run_id IS NULL
          AND superseded_at IS NULL
      `,
      [requirementId]
    );

    const latestVersionBySlice = new Map<string, number>();
    for (const row of result.rows) {
      const sliceKey = row.slice_key ?? "";
      const current = latestVersionBySlice.get(sliceKey);
      if (current === undefined || row.version > current) {
        latestVersionBySlice.set(sliceKey, row.version);
      }
    }

    const counts = new Map<string, number>();
    for (const row of result.rows) {
      if (
        row.version !== latestVersionBySlice.get(row.slice_key ?? "") ||
        !Array.isArray(row.ac_keys)
      ) {
        continue;
      }

      for (const acKey of new Set(
        row.ac_keys.filter((key): key is string => typeof key === "string")
      )) {
        counts.set(acKey, (counts.get(acKey) ?? 0) + 1);
      }
    }

    return counts;
  }

  /** N2 第一级：把 requirement_analysis 单独落盘为规格（第二级种子 + 控制台可见），独立版本占位。 */
  async saveAnalysisSpecification(input: {
    projectId: string;
    requirementId: string;
    requirementVersion: number;
    version: number;
    analysis: RequirementAnalysis;
  }): Promise<Specification> {
    const content: JsonObject = {
      ...input.analysis,
      requirementId: input.requirementId,
      requirementVersion: input.requirementVersion
    };
    const result = await this.pool.query<SpecificationRow>(
      `
        INSERT INTO specifications (project_id, requirement_id, type, version, status, content)
        VALUES ($1, $2, 'REQUIREMENT_ANALYSIS', $3, 'VALIDATED', $4)
        RETURNING *
      `,
      [input.projectId, input.requirementId, input.version, content]
    );
    return mapSpecification(result.rows[0]);
  }

  /** N2：第二级单切片产物落盘——切片 scoped specifications + tasks（带 slice_key），并把切片置 PLANNED。 */
  async saveSlicePlanningResult(input: SaveSlicePlanningResultInput): Promise<SavedPlanningResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 仅写切片 scoped 规格；requirement_analysis 由第一级单独落盘（saveAnalysisSpecification）。
      const specifications: Specification[] = [];
      for (const specification of input.specifications) {
        specifications.push(
          await insertSpecification(client, {
            projectId: input.projectId,
            requirementId: input.requirementId,
            version: input.version,
            type: specification.type,
            content: specification.content
          })
        );
      }

      const tasks: Task[] = [];
      const taskIdsByKey = new Map<string, string>();

      for (const plannedTask of input.taskPlan.tasks) {
        const taskInput: JsonObject = {
          requirementId: input.requirementId,
          requirementVersion: input.requirementVersion,
          sliceKey: input.sliceKey,
          sourceSpecTypes: plannedTask.sourceSpecTypes,
          specificationIds: sourceSpecificationIds(specifications, plannedTask.sourceSpecTypes),
          acceptanceCriteria: plannedTask.acceptanceCriteria,
          // N3：任务 ↔ AC 映射（供追溯/覆盖统计；缺省不落键）。
          ...(plannedTask.acKeys ? { acKeys: plannedTask.acKeys } : {}),
          estimatedComplexity: plannedTask.estimatedComplexity,
          delivery: plannedTask.delivery,
          ...(input.profile ? { profile: input.profile } : {})
        };
        const result = await client.query<TaskRow>(
          `
            INSERT INTO tasks (
              project_id,
              requirement_id,
              task_key,
              title,
              description,
              type,
              status,
              priority,
              input,
              version,
              slice_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10)
            RETURNING *
          `,
          [
            input.projectId,
            input.requirementId,
            plannedTask.id,
            plannedTask.title,
            plannedTask.description,
            plannedTask.type,
            plannedTask.priority,
            taskInput,
            input.version,
            input.sliceKey
          ]
        );
        const task = mapTask(result.rows[0]);
        tasks.push(task);
        taskIdsByKey.set(plannedTask.id, task.id);
      }

      for (const plannedTask of input.taskPlan.tasks) {
        const targetTaskId = taskIdsByKey.get(plannedTask.id);
        if (!targetTaskId) {
          throw new Error(`Missing target task id for ${plannedTask.id}`);
        }

        for (const dependency of plannedTask.dependencies) {
          const sourceTaskId = taskIdsByKey.get(dependency);
          if (!sourceTaskId) {
            throw new Error(`Missing source task id for ${dependency}`);
          }

          await client.query(
            `
              INSERT INTO task_dependencies (source_task_id, target_task_id)
              VALUES ($1, $2)
            `,
            [sourceTaskId, targetTaskId]
          );
        }
      }

      await client.query(
        `
          UPDATE requirement_slices
          SET planning_version = $3, status = 'PLANNED'
          WHERE requirement_id = $1 AND slice_key = $2
        `,
        [input.requirementId, input.sliceKey, input.version]
      );

      // F1-2：单一生效计划版本——同切片旧版本计划行标记 SUPERSEDED（读取面默认过滤）。
      await client.query(
        `
          UPDATE tasks SET superseded_at = now()
          WHERE requirement_id = $1 AND slice_key = $2
            AND workflow_run_id IS NULL AND version < $3 AND superseded_at IS NULL
        `,
        [input.requirementId, input.sliceKey, input.version]
      );

      await client.query("COMMIT");

      return {
        specifications,
        tasks,
        dependencies: await this.findDependenciesByRequirementId(input.requirementId)
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async savePlanningResult(input: SavePlanningResultInput): Promise<SavedPlanningResult> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const specifications: Specification[] = [];
      const analysisContent: JsonObject = {
        ...input.analysis,
        requirementId: input.requirementId,
        requirementVersion: input.requirementVersion
      };

      specifications.push(
        await insertSpecification(client, {
          projectId: input.projectId,
          requirementId: input.requirementId,
          version: input.version,
          type: "REQUIREMENT_ANALYSIS",
          content: analysisContent
        })
      );

      for (const specification of input.specifications) {
        specifications.push(
          await insertSpecification(client, {
            projectId: input.projectId,
            requirementId: input.requirementId,
            version: input.version,
            type: specification.type,
            content: specification.content
          })
        );
      }

      const tasks: Task[] = [];
      const taskIdsByKey = new Map<string, string>();

      for (const plannedTask of input.taskPlan.tasks) {
        const taskInput: JsonObject = {
          requirementId: input.requirementId,
          requirementVersion: input.requirementVersion,
          sourceSpecTypes: plannedTask.sourceSpecTypes,
          specificationIds: sourceSpecificationIds(specifications, plannedTask.sourceSpecTypes),
          acceptanceCriteria: plannedTask.acceptanceCriteria,
          // N3：任务 ↔ AC 映射（供追溯/覆盖统计；缺省不落键）。
          ...(plannedTask.acKeys ? { acKeys: plannedTask.acKeys } : {}),
          estimatedComplexity: plannedTask.estimatedComplexity,
          delivery: plannedTask.delivery,
          ...(input.profile ? { profile: input.profile } : {})
        };
        const result = await client.query<TaskRow>(
          `
            INSERT INTO tasks (
              project_id,
              requirement_id,
              task_key,
              title,
              description,
              type,
              status,
              priority,
              input,
              version
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9)
            RETURNING *
          `,
          [
            input.projectId,
            input.requirementId,
            plannedTask.id,
            plannedTask.title,
            plannedTask.description,
            plannedTask.type,
            plannedTask.priority,
            taskInput,
            input.version
          ]
        );
        const task = mapTask(result.rows[0]);
        tasks.push(task);
        taskIdsByKey.set(plannedTask.id, task.id);
      }

      for (const plannedTask of input.taskPlan.tasks) {
        const targetTaskId = taskIdsByKey.get(plannedTask.id);
        if (!targetTaskId) {
          throw new Error(`Missing target task id for ${plannedTask.id}`);
        }

        for (const dependency of plannedTask.dependencies) {
          const sourceTaskId = taskIdsByKey.get(dependency);
          if (!sourceTaskId) {
            throw new Error(`Missing source task id for ${dependency}`);
          }

          await client.query(
            `
              INSERT INTO task_dependencies (source_task_id, target_task_id)
              VALUES ($1, $2)
            `,
            [sourceTaskId, targetTaskId]
          );
        }
      }

      await client.query(
        `
          UPDATE requirements
          SET status = 'ANALYZED'
          WHERE id = $1
        `,
        [input.requirementId]
      );

      // F1-2：单一生效计划版本——单级（无切片键）旧版本计划行标记 SUPERSEDED。
      await client.query(
        `
          UPDATE tasks SET superseded_at = now()
          WHERE requirement_id = $1 AND slice_key IS NULL
            AND workflow_run_id IS NULL AND version < $2 AND superseded_at IS NULL
        `,
        [input.requirementId, input.version]
      );

      await client.query("COMMIT");

      return {
        specifications,
        tasks,
        dependencies: await this.findDependenciesByRequirementId(input.requirementId)
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
