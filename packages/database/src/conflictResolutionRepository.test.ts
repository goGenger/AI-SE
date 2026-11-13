import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgConflictResolutionRepository } from "./conflictResolutionRepository";
import { PgPlanningRepository } from "./planningRepositories";
import { runMigrations } from "./migrate";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

describe("PgConflictResolutionRepository", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: PgConflictResolutionRepository;
  let requirementId: string;

  beforeAll(async () => {
    const postgres = await startPostgresContainer();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const projectId = await createTestProject(pool, "conflicts");
    const planning = new PgPlanningRepository(pool);
    const requirement = await planning.createRequirement(projectId, {
      title: "冲突裁决",
      description: "",
      rawContent: "# PRD\n\nJWT"
    });
    requirementId = requirement.id;
    repository = new PgConflictResolutionRepository(pool);
  }, 180_000);

  afterAll(async () => stop?.());

  it("upserts by (requirement, topic, source) and lists for planning injection", async () => {
    const first = await repository.upsertMany(requirementId, [
      {
        topic: "auth",
        source: "trd.md",
        prdSays: "JWT",
        documentSays: "session cookie",
        choice: "FOLLOW_PRD"
      }
    ]);
    expect(first).toHaveLength(1);
    expect(first[0].choice).toBe("FOLLOW_PRD");
    expect(first[0].note).toBeNull();

    const updated = await repository.upsertMany(requirementId, [
      {
        topic: "auth",
        source: "trd.md",
        prdSays: "JWT",
        documentSays: "session cookie",
        choice: "CUSTOM",
        note: "先 JWT"
      }
    ]);
    expect(updated).toHaveLength(1);
    expect(updated[0].choice).toBe("CUSTOM");
    expect(updated[0].note).toBe("先 JWT");

    const listed = await repository.findByRequirementId(requirementId);
    expect(listed.map((row) => `${row.topic}|${row.choice}`)).toEqual(["auth|CUSTOM"]);
  });
});
