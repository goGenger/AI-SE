import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { listMigrationFiles, runMigrations } from "./migrate";
import { startPostgresContainer } from "./testPostgresContainer";

describe("listMigrationFiles", () => {
  it("returns sorted SQL migration files only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ai-se-migrations-"));

    try {
      await writeFile(path.join(dir, "002_second.sql"), "SELECT 2;");
      await writeFile(path.join(dir, "001_first.sql"), "SELECT 1;");
      await writeFile(path.join(dir, "README.md"), "skip");

      await expect(listMigrationFiles(dir)).resolves.toEqual(["001_first.sql", "002_second.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes the current delivery migration", async () => {
    await expect(listMigrationFiles()).resolves.toEqual(
      expect.arrayContaining([
        "006_phase6_delivery.sql",
        "007_phase6_pr_traceability.sql",
        "008_phase5_mcp_registry.sql",
        "009_phase5_evidence.sql",
        "010_ux01_project_repository_optional.sql",
        "011_phaseB_two_level_planning.sql",
        "012_phaseB_workflow_budget_limits.sql",
        "013_phaseC_requirement_acceptance_criteria.sql",
        "014_phaseF_plan_supersede.sql",
        "015_phaseG_involves_data.sql",
        "016_phaseL2_requirement_autonomy.sql",
        "017_phaseN38_workflow_autonomy.sql",
        "018_phaseD1_requirement_documents.sql",
        "019_n73_static_delivery_adapter.sql",
        "020_phase8a_incidents.sql",
        "021_phase8b_incident_diagnosis.sql",
        "022_phase8c_incident_remediation.sql"
      ])
    );
  });
});

describe("runMigrations checksum guard (fresh PostgreSQL)", () => {
  it("applies every migration once, is idempotent, and rejects a tampered checksum", async () => {
    const postgres = await startPostgresContainer();
    try {
      const applied = await runMigrations(postgres.pool);
      expect(applied).toHaveLength(22);
      expect(applied.at(0)).toBe("001_phase0_foundation.sql");
      expect(applied.at(-1)).toBe("022_phase8c_incident_remediation.sql");

      // Second run hits the stored-checksum match path: nothing re-applied.
      await expect(runMigrations(postgres.pool)).resolves.toEqual([]);

      await postgres.pool.query(
        "UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '001_phase0_foundation.sql'"
      );
      await expect(runMigrations(postgres.pool)).rejects.toThrow(
        "Migration checksum changed: 001_phase0_foundation.sql"
      );
    } finally {
      await postgres.stop();
    }
  }, 180_000);
});
