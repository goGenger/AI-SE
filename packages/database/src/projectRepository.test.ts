import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgProjectRepository } from "./projectRepository";
import { startPostgresContainer } from "./testPostgresContainer";

/**
 * UX-01: a project may exist without a Git repository (workspace-first) and
 * bind one later via attachRepository.
 */
describe("PgProjectRepository — optional repository (UX-01)", () => {
  let stop: () => Promise<void>;
  let projects: PgProjectRepository;

  beforeAll(async () => {
    const postgres = await startPostgresContainer();
    stop = postgres.stop;
    await runMigrations(postgres.pool);
    projects = new PgProjectRepository(postgres.pool);
  }, 180_000);

  afterAll(async () => {
    await stop();
  });

  it("creates a project without a repository and keeps it visible", async () => {
    const created = await projects.create({
      name: "Workspace First",
      description: "",
      status: "active"
    });
    expect(created.repository).toBeNull();
    expect(created.workspacePath).toBeNull();

    const fetched = await projects.findById(created.id);
    expect(fetched?.repository).toBeNull();

    const list = await projects.findMany();
    expect(list.some((project) => project.id === created.id)).toBe(true);
  });

  it("persists and updates workspacePath", async () => {
    const created = await projects.create({
      name: "With Workspace",
      description: "",
      status: "active",
      workspacePath: "/Users/me/Desktop/study/with-ws"
    });
    expect(created.workspacePath).toBe("/Users/me/Desktop/study/with-ws");
    expect((await projects.findById(created.id))?.workspacePath).toBe(
      "/Users/me/Desktop/study/with-ws"
    );

    const updated = await projects.updateWorkspacePath(
      created.id,
      "/Users/me/Desktop/study/with-ws-2"
    );
    expect(updated?.workspacePath).toBe("/Users/me/Desktop/study/with-ws-2");
    await expect(projects.updateWorkspacePath(randomUUID(), "/tmp/x")).resolves.toBeNull();
  });

  it("keeps the existing behavior when a repository is provided", async () => {
    const url = `https://github.com/example/${randomUUID()}`;
    const created = await projects.create({
      name: "With Repo",
      description: "",
      repository: url,
      status: "active"
    });
    expect(created.repository).toBe(url);
  });

  it("binds a repository later and replaces it on re-attach", async () => {
    const created = await projects.create({
      name: "Bind Later",
      description: "",
      status: "active"
    });
    const first = `https://github.com/example/${randomUUID()}`;
    const second = `https://github.com/example/${randomUUID()}`;

    const bound = await projects.attachRepository(created.id, first);
    expect(bound?.repository).toBe(first);
    expect((await projects.findById(created.id))?.repository).toBe(first);

    const rebound = await projects.attachRepository(created.id, second);
    expect(rebound?.repository).toBe(second);

    await expect(projects.attachRepository(randomUUID(), first)).resolves.toBeNull();
  });
});
