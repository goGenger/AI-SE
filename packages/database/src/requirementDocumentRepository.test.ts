import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PgPlanningRepository } from "./planningRepositories";
import { PgRequirementDocumentRepository } from "./requirementDocumentRepository";
import { createTestProject, startPostgresContainer } from "./testPostgresContainer";

describe("PgRequirementDocumentRepository", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repository: PgRequirementDocumentRepository;
  let requirementId: string;

  beforeAll(async () => {
    const postgres = await startPostgresContainer();
    pool = postgres.pool;
    stop = postgres.stop;
    await runMigrations(pool);
    const projectId = await createTestProject(pool, "documents");
    const planning = new PgPlanningRepository(pool);
    const requirement = await planning.createRequirement(projectId, {
      title: "文档入口",
      description: "",
      rawContent: "# PRD\n\n正文"
    });
    requirementId = requirement.id;
    repository = new PgRequirementDocumentRepository(pool);
  }, 180_000);

  afterAll(async () => stop?.());

  const technical = (fileName: string, text: string) => ({
    requirementId,
    kind: "TECHNICAL" as const,
    fileName,
    mimeType: "text/markdown",
    byteSize: Buffer.byteLength(text),
    sha256: `sha-${fileName}`,
    contentText: text,
    rawBytes: Buffer.from(text, "utf8"),
    truncated: false
  });

  it("落库后能按需求列出元数据，且列表不携带正文", async () => {
    const created = await repository.create(technical("architecture.md", "# 架构\n微服务"));
    expect(created.charCount).toBe("# 架构\n微服务".length);
    expect(created.kind).toBe("TECHNICAL");

    const listed = await repository.findByRequirementId(requirementId);
    const found = listed.find((entry) => entry.id === created.id)!;
    expect(found.fileName).toBe("architecture.md");
    expect("contentText" in found).toBe(false);
  });

  it("规划读取只返回 TECHNICAL 正文（PRD 走 requirements.raw_content，不重复喂）", async () => {
    await repository.create({
      ...technical("prd.md", "# 文件版 PRD"),
      kind: "PRD"
    });
    const contents = await repository.findContentsByRequirementId(requirementId);
    expect(contents.every((entry) => entry.kind === "TECHNICAL")).toBe(true);
    expect(contents.map((entry) => entry.fileName)).toEqual(["architecture.md"]);
  });

  it("PRD 至多一份：重复上传即替换，旧行与旧原件一并消失", async () => {
    const replaced = await repository.create({
      ...technical("prd-v2.md", "# 第二版 PRD"),
      kind: "PRD"
    });
    const prdRows = await pool.query<{ file_name: string }>(
      "SELECT file_name FROM requirement_documents WHERE requirement_id = $1 AND kind = 'PRD'",
      [requirementId]
    );
    expect(prdRows.rows).toEqual([{ file_name: "prd-v2.md" }]);
    expect((await repository.findById(replaced.id))?.fileName).toBe("prd-v2.md");
  });

  it("删除按 id 生效，二次删除返回 false", async () => {
    const created = await repository.create(technical("api.md", "# 接口"));
    expect(await repository.delete(created.id)).toBe(true);
    expect(await repository.delete(created.id)).toBe(false);
    expect(await repository.findById(created.id)).toBeNull();
  });

  it("UI_REFERENCE 可多份，规划读取带回原件字节", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]);
    const created = await repository.create({
      requirementId,
      kind: "UI_REFERENCE",
      fileName: "home.png",
      mimeType: "image/png",
      byteSize: png.byteLength,
      sha256: "sha-ui-home",
      contentText: "[UI reference image: home.png]",
      rawBytes: png,
      truncated: false
    });
    expect(created.kind).toBe("UI_REFERENCE");
    const refs = await repository.findUiReferencesByRequirementId(requirementId);
    expect(refs.map((entry) => entry.fileName)).toContain("home.png");
    const found = refs.find((entry) => entry.fileName === "home.png")!;
    expect(Buffer.compare(found.rawBytes, png)).toBe(0);
    expect(await repository.countByRequirementIdAndKind(requirementId, "UI_REFERENCE")).toBeGreaterThanOrEqual(
      1
    );
    const raw = await repository.findRawById(created.id);
    expect(raw?.mimeType).toBe("image/png");
    expect(Buffer.compare(raw!.bytes, png)).toBe(0);
  });
});
