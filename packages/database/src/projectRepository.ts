import { CreateProjectData, Project, ProjectStatus } from "@ai-se/shared";
import { Pool, PoolClient } from "pg";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  repository: string | null;
  workspace_path: string | null;
  status: ProjectStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProjectRepository {
  create(input: CreateProjectData & { workspacePath?: string | null }): Promise<Project>;
  findMany(): Promise<Project[]>;
  findById(id: string): Promise<Project | null>;
  /** UX-01: bind (or replace) the Git repository of an existing project. */
  attachRepository(id: string, url: string): Promise<Project | null>;
  /** Persist (or replace) the durable local workspace path. */
  updateWorkspacePath(id: string, workspacePath: string): Promise<Project | null>;
  deleteById(id: string): Promise<boolean>;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repository: row.repository,
    workspacePath: row.workspace_path,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

const PROJECT_COLUMNS = `
  id,
  name,
  description,
  (SELECT url FROM repositories WHERE id = repository_id) AS repository,
  workspace_path,
  status,
  created_at,
  updated_at
`;

/** Upserts a repositories row by url and returns its id. */
async function upsertRepository(client: PoolClient, url: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO repositories (url)
      VALUES ($1)
      ON CONFLICT (url)
      DO UPDATE SET updated_at = now()
      RETURNING id
    `,
    [url]
  );
  return result.rows[0].id;
}

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateProjectData & { workspacePath?: string | null }): Promise<Project> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      // UX-01: no repository → the project starts workspace-first (repository_id NULL).
      const repositoryId = input.repository
        ? await upsertRepository(client, input.repository)
        : null;

      const projectResult = await client.query<ProjectRow>(
        `
          INSERT INTO projects (name, description, repository_id, workspace_path, status)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING ${PROJECT_COLUMNS}
        `,
        [
          input.name,
          input.description,
          repositoryId,
          input.workspacePath ?? null,
          input.status
        ]
      );

      await client.query("COMMIT");
      return mapProject(projectResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findMany(): Promise<Project[]> {
    // UX-01: LEFT JOIN — projects without a repository must stay visible.
    const result = await this.pool.query<ProjectRow>(`
      SELECT
        p.id,
        p.name,
        p.description,
        r.url AS repository,
        p.workspace_path,
        p.status,
        p.created_at,
        p.updated_at
      FROM projects p
      LEFT JOIN repositories r ON r.id = p.repository_id
      ORDER BY p.created_at DESC
    `);

    return result.rows.map(mapProject);
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.pool.query<ProjectRow>(
      `
        SELECT
          p.id,
          p.name,
          p.description,
          r.url AS repository,
          p.workspace_path,
          p.status,
          p.created_at,
          p.updated_at
        FROM projects p
        LEFT JOIN repositories r ON r.id = p.repository_id
        WHERE p.id = $1
      `,
      [id]
    );

    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  async attachRepository(id: string, url: string): Promise<Project | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const repositoryId = await upsertRepository(client, url);
      const updated = await client.query<ProjectRow>(
        `
          UPDATE projects
          SET repository_id = $2
          WHERE id = $1
          RETURNING ${PROJECT_COLUMNS}
        `,
        [id, repositoryId]
      );

      await client.query("COMMIT");
      return updated.rows[0] ? mapProject(updated.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateWorkspacePath(id: string, workspacePath: string): Promise<Project | null> {
    const result = await this.pool.query<ProjectRow>(
      `
        UPDATE projects
        SET workspace_path = $2
        WHERE id = $1
        RETURNING ${PROJECT_COLUMNS}
      `,
      [id, workspacePath]
    );
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM projects WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
