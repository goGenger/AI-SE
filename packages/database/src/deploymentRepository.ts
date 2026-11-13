import {
  ApiErrorBody,
  CiRun,
  CiRunStatus,
  DeliveryEnvironment,
  Deployment,
  DeploymentEnvironmentConfig,
  DeploymentLog,
  DeploymentStatus,
  JsonObject,
  UpsertDeploymentEnvironmentData
} from "@ai-se/shared";
import { Pool } from "pg";

type Row = Record<string, unknown>;

function date(value: unknown): string | undefined {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      ? value
      : undefined;
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function environment(row: Row): DeploymentEnvironmentConfig {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: row.name as DeliveryEnvironment,
    endpoint: String(row.endpoint),
    // N-73：适配器要**读库里的值**——此前硬编码成 "docker"，`static` 环境读出来会被当成 docker。
    adapter: row.adapter === "static" ? "static" : "docker",
    configuration: object(row.configuration),
    secretReference: typeof row.secret_reference === "string" ? row.secret_reference : undefined,
    createdAt: date(row.created_at) ?? "",
    updatedAt: date(row.updated_at) ?? ""
  };
}

function ciRun(row: Row): CiRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id),
    taskId: String(row.task_id),
    agentRunId: typeof row.agent_run_id === "string" ? row.agent_run_id : undefined,
    provider: row.provider as CiRun["provider"],
    providerRunId: typeof row.provider_run_id === "string" ? row.provider_run_id : undefined,
    workflowFile: String(row.workflow_file),
    gitCommit: typeof row.git_commit === "string" ? row.git_commit : undefined,
    pullRequest: typeof row.pull_request === "number" ? row.pull_request : undefined,
    image: typeof row.image === "string" ? row.image : undefined,
    status: row.status as CiRunStatus,
    url: typeof row.url === "string" ? row.url : undefined,
    error: row.error ? (row.error as ApiErrorBody) : undefined,
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    createdAt: date(row.created_at) ?? "",
    updatedAt: date(row.updated_at) ?? ""
  };
}

function deployment(row: Row): Deployment {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id),
    taskId: String(row.task_id),
    agentRunId: typeof row.agent_run_id === "string" ? row.agent_run_id : undefined,
    ciRunId: typeof row.ci_run_id === "string" ? row.ci_run_id : undefined,
    version: String(row.version),
    environment: row.environment as DeliveryEnvironment,
    image: String(row.image),
    gitCommit: String(row.git_commit),
    operation: row.operation as Deployment["operation"],
    status: row.status as DeploymentStatus,
    endpoint: String(row.endpoint),
    healthCheck: object(row.health_check),
    rollbackVersion: typeof row.rollback_version === "string" ? row.rollback_version : undefined,
    rollbackDeploymentId:
      typeof row.rollback_deployment_id === "string" ? row.rollback_deployment_id : undefined,
    rollbackReason: typeof row.rollback_reason === "string" ? row.rollback_reason : undefined,
    rollbackAt: date(row.rollback_at),
    error: row.error ? (row.error as ApiErrorBody) : undefined,
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    createdAt: date(row.created_at) ?? "",
    updatedAt: date(row.updated_at) ?? ""
  };
}

function log(row: Row): DeploymentLog {
  return {
    id: String(row.id),
    deploymentId: String(row.deployment_id),
    level: row.level as DeploymentLog["level"],
    message: String(row.message),
    metadata: object(row.metadata),
    createdAt: date(row.created_at) ?? ""
  };
}

export interface CreateCiRunRecord {
  projectId: string;
  workflowRunId: string;
  taskId: string;
  agentRunId?: string;
  provider: CiRun["provider"];
  workflowFile: string;
  gitCommit?: string;
  image?: string;
}

export interface CreateDeploymentRecord {
  projectId: string;
  workflowRunId: string;
  taskId: string;
  agentRunId?: string;
  ciRunId?: string;
  version: string;
  environment: DeliveryEnvironment;
  image: string;
  gitCommit: string;
  operation?: Deployment["operation"];
  endpoint: string;
  rollbackVersion?: string;
  rollbackDeploymentId?: string;
  rollbackReason?: string;
  idempotencyKey: string;
}

export class PgDeploymentRepository {
  constructor(private readonly pool: Pool) {}

  async upsertEnvironment(
    input: UpsertDeploymentEnvironmentData
  ): Promise<DeploymentEnvironmentConfig> {
    const result = await this.pool.query(
      `
        INSERT INTO deployment_environments (
          project_id, name, endpoint, adapter, configuration, secret_reference
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (project_id, name) DO UPDATE SET
          endpoint = EXCLUDED.endpoint,
          adapter = EXCLUDED.adapter,
          configuration = EXCLUDED.configuration,
          secret_reference = EXCLUDED.secret_reference
        RETURNING *
      `,
      [
        input.projectId,
        input.name,
        input.endpoint,
        input.adapter,
        input.configuration,
        input.secretReference ?? null
      ]
    );
    return environment(result.rows[0] as Row);
  }

  async findEnvironments(projectId?: string): Promise<DeploymentEnvironmentConfig[]> {
    const result = projectId
      ? await this.pool.query(
          "SELECT * FROM deployment_environments WHERE project_id = $1 ORDER BY name",
          [projectId]
        )
      : await this.pool.query("SELECT * FROM deployment_environments ORDER BY project_id, name");
    return result.rows.map((row) => environment(row as Row));
  }

  async findEnvironment(
    projectId: string,
    name: DeliveryEnvironment
  ): Promise<DeploymentEnvironmentConfig | null> {
    const result = await this.pool.query(
      "SELECT * FROM deployment_environments WHERE project_id = $1 AND name = $2",
      [projectId, name]
    );
    return result.rows[0] ? environment(result.rows[0] as Row) : null;
  }

  async createCiRun(input: CreateCiRunRecord): Promise<CiRun> {
    const result = await this.pool.query(
      `
        INSERT INTO ci_runs (
          project_id, workflow_run_id, task_id, agent_run_id, provider,
          workflow_file, git_commit, image
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (workflow_run_id, task_id) DO UPDATE SET workflow_file = ci_runs.workflow_file
        RETURNING *
      `,
      [
        input.projectId,
        input.workflowRunId,
        input.taskId,
        input.agentRunId ?? null,
        input.provider,
        input.workflowFile,
        input.gitCommit ?? null,
        input.image ?? null
      ]
    );
    return ciRun(result.rows[0] as Row);
  }

  async updateCiRun(
    id: string,
    patch: {
      providerRunId?: string;
      status?: CiRunStatus;
      url?: string;
      gitCommit?: string;
      pullRequest?: number;
      image?: string;
      error?: ApiErrorBody;
      startedAt?: string;
      finishedAt?: string;
    }
  ): Promise<CiRun | null> {
    const result = await this.pool.query(
      `
        UPDATE ci_runs SET
          provider_run_id = COALESCE($2, provider_run_id),
          status = COALESCE($3, status),
          url = COALESCE($4, url),
          git_commit = COALESCE($5, git_commit),
          pull_request = COALESCE($6, pull_request),
          image = COALESCE($7, image),
          error = CASE WHEN $3 IS NOT NULL THEN $8 ELSE COALESCE($8, error) END,
          started_at = COALESCE($9, started_at),
          finished_at = COALESCE($10, finished_at)
        WHERE id = $1 RETURNING *
      `,
      [
        id,
        patch.providerRunId ?? null,
        patch.status ?? null,
        patch.url ?? null,
        patch.gitCommit ?? null,
        patch.pullRequest ?? null,
        patch.image ?? null,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null
      ]
    );
    return result.rows[0] ? ciRun(result.rows[0] as Row) : null;
  }

  async findCiRun(id: string): Promise<CiRun | null> {
    const result = await this.pool.query("SELECT * FROM ci_runs WHERE id = $1", [id]);
    return result.rows[0] ? ciRun(result.rows[0] as Row) : null;
  }

  async findLatestSuccessfulCi(workflowRunId: string): Promise<CiRun | null> {
    const result = await this.pool.query(
      `SELECT * FROM ci_runs
       WHERE workflow_run_id = $1 AND status = 'SUCCESS'
       ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [workflowRunId]
    );
    return result.rows[0] ? ciRun(result.rows[0] as Row) : null;
  }

  async createDeployment(input: CreateDeploymentRecord): Promise<Deployment> {
    const result = await this.pool.query(
      `
        INSERT INTO deployments (
          project_id, workflow_run_id, task_id, agent_run_id, ci_run_id,
          version, environment, image, git_commit, operation, endpoint,
          rollback_version, rollback_deployment_id, rollback_reason, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = deployments.idempotency_key
        RETURNING *
      `,
      [
        input.projectId,
        input.workflowRunId,
        input.taskId,
        input.agentRunId ?? null,
        input.ciRunId ?? null,
        input.version,
        input.environment,
        input.image,
        input.gitCommit,
        input.operation ?? "DEPLOY",
        input.endpoint,
        input.rollbackVersion ?? null,
        input.rollbackDeploymentId ?? null,
        input.rollbackReason ?? null,
        input.idempotencyKey
      ]
    );
    return deployment(result.rows[0] as Row);
  }

  async updateDeployment(
    id: string,
    patch: {
      status?: DeploymentStatus;
      healthCheck?: JsonObject;
      error?: ApiErrorBody;
      rollbackVersion?: string;
      rollbackDeploymentId?: string;
      rollbackReason?: string;
      rollbackAt?: string;
      startedAt?: string;
      finishedAt?: string;
    }
  ): Promise<Deployment | null> {
    const result = await this.pool.query(
      `
        UPDATE deployments SET
          status = COALESCE($2, status),
          health_check = COALESCE($3, health_check),
          error = CASE WHEN $2 IS NOT NULL THEN $4 ELSE COALESCE($4, error) END,
          rollback_version = COALESCE($5, rollback_version),
          rollback_deployment_id = COALESCE($6, rollback_deployment_id),
          rollback_reason = COALESCE($7, rollback_reason),
          rollback_at = COALESCE($8, rollback_at),
          started_at = COALESCE($9, started_at),
          finished_at = COALESCE($10, finished_at)
        WHERE id = $1 RETURNING *
      `,
      [
        id,
        patch.status ?? null,
        patch.healthCheck ?? null,
        patch.error ?? null,
        patch.rollbackVersion ?? null,
        patch.rollbackDeploymentId ?? null,
        patch.rollbackReason ?? null,
        patch.rollbackAt ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null
      ]
    );
    return result.rows[0] ? deployment(result.rows[0] as Row) : null;
  }

  async appendLog(
    deploymentId: string,
    level: DeploymentLog["level"],
    message: string,
    metadata: JsonObject = {}
  ): Promise<DeploymentLog> {
    const result = await this.pool.query(
      `INSERT INTO deployment_logs (deployment_id, level, message, metadata)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [deploymentId, level, message, metadata]
    );
    return log(result.rows[0] as Row);
  }

  async findMany(projectId?: string): Promise<Deployment[]> {
    const result = projectId
      ? await this.pool.query(
          "SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC",
          [projectId]
        )
      : await this.pool.query("SELECT * FROM deployments ORDER BY created_at DESC");
    return result.rows.map((row) => deployment(row as Row));
  }

  async findById(id: string): Promise<Deployment | null> {
    const result = await this.pool.query("SELECT * FROM deployments WHERE id = $1", [id]);
    return result.rows[0] ? deployment(result.rows[0] as Row) : null;
  }

  /** 7-C：一次运行的全部部署记录（追踪树；含 ROLLBACK 与失败记录，按创建时间升序）。 */
  async findByWorkflowRunId(workflowRunId: string): Promise<Deployment[]> {
    const result = await this.pool.query(
      "SELECT * FROM deployments WHERE workflow_run_id = $1 ORDER BY created_at ASC, id ASC",
      [workflowRunId]
    );
    return result.rows.map((row) => deployment(row as Row));
  }

  async findLogs(deploymentId: string): Promise<DeploymentLog[]> {
    const result = await this.pool.query(
      "SELECT * FROM deployment_logs WHERE deployment_id = $1 ORDER BY created_at ASC",
      [deploymentId]
    );
    return result.rows.map((row) => log(row as Row));
  }

  async findPreviousSuccessful(
    projectId: string,
    environmentName: DeliveryEnvironment,
    excludingDeploymentId: string
  ): Promise<Deployment | null> {
    const result = await this.pool.query(
      `
        SELECT * FROM deployments
        WHERE project_id = $1 AND environment = $2 AND id <> $3
          AND operation = 'DEPLOY' AND status = 'SUCCESS'
        ORDER BY finished_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [projectId, environmentName, excludingDeploymentId]
    );
    return result.rows[0] ? deployment(result.rows[0] as Row) : null;
  }

  async findLatestSuccessful(
    projectId: string,
    environmentName: DeliveryEnvironment
  ): Promise<Deployment | null> {
    const result = await this.pool.query(
      `
        SELECT * FROM deployments
        WHERE project_id = $1 AND environment = $2 AND status = 'SUCCESS'
        ORDER BY finished_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [projectId, environmentName]
    );
    return result.rows[0] ? deployment(result.rows[0] as Row) : null;
  }

  async findLatestAgentRunId(workflowRunId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `
        SELECT ar.id
        FROM agent_runs ar
        JOIN tasks t ON t.id = ar.task_id
        WHERE t.workflow_run_id = $1 AND ar.status = 'succeeded'
        ORDER BY ar.finished_at DESC NULLS LAST, ar.created_at DESC
        LIMIT 1
      `,
      [workflowRunId]
    );
    return result.rows[0]?.id;
  }
}
