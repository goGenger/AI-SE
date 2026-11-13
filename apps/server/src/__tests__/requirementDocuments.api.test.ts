import { randomUUID } from "node:crypto";
import { Requirement, RequirementDocument } from "@ai-se/shared";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../http/errors";
import { createDocumentRouter } from "../routes/documents";
import { DocumentService } from "../services/documentService";

/**
 * 路由层测试用内存假仓储：真实的连接 / 迁移 / 唯一约束由
 * `packages/database/src/requirementDocumentRepository.test.ts`（真 postgres:16）覆盖，
 * 这里只验 HTTP 面的契约（状态码、错误码、PRD 回写、删除后的变化标记）。
 */
function buildHarness() {
  const requirement: Requirement = {
    id: randomUUID(),
    projectId: randomUUID(),
    title: "接口需求",
    description: "",
    rawContent: "# 原始 PRD",
    status: "DRAFT",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const stored: Array<{ document: RequirementDocument; text: string; raw?: Buffer }> = [];
  let changedAt: string | null = null;
  let latestAnalysisAt: string | null = null;

  const planning = {
    findRequirementById: async (id: string) => (id === requirement.id ? requirement : null),
    updateRequirementContent: async (id: string, rawContent: string) => {
      if (id !== requirement.id) return null;
      requirement.rawContent = rawContent;
      return requirement;
    },
    touchDocumentsChanged: async () => {
      changedAt = new Date().toISOString();
    },
    documentsChangedAt: async () => changedAt,
    latestAnalysisAt: async () => latestAnalysisAt
  };

  const documents = {
    create: async (input: {
      requirementId: string;
      kind: "PRD" | "TECHNICAL" | "UI_REFERENCE";
      fileName: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
      contentText: string;
      rawBytes?: Buffer;
      truncated: boolean;
    }) => {
      if (input.kind === "PRD") {
        const index = stored.findIndex((entry) => entry.document.kind === "PRD");
        if (index >= 0) stored.splice(index, 1);
      }
      const document: RequirementDocument = {
        id: randomUUID(),
        requirementId: input.requirementId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        charCount: input.contentText.length,
        truncated: input.truncated,
        createdAt: new Date().toISOString()
      };
      stored.push({ document, text: input.contentText, raw: input.rawBytes });
      return document;
    },
    findByRequirementId: async () => stored.map((entry) => entry.document),
    findContentsByRequirementId: async () =>
      stored
        .filter((entry) => entry.document.kind === "TECHNICAL")
        .map((entry) => ({
          id: entry.document.id,
          kind: entry.document.kind,
          fileName: entry.document.fileName,
          text: entry.text,
          truncated: entry.document.truncated
        })),
    findUiReferencesByRequirementId: async () =>
      stored
        .filter((entry) => entry.document.kind === "UI_REFERENCE")
        .map((entry) => ({
          id: entry.document.id,
          fileName: entry.document.fileName,
          mimeType: entry.document.mimeType,
          note: entry.text,
          rawBytes: entry.raw ?? Buffer.alloc(0)
        })),
    countByRequirementIdAndKind: async (_id: string, kind: string) =>
      stored.filter((entry) => entry.document.kind === kind).length,
    findRawById: async (id: string) => {
      const entry = stored.find((item) => item.document.id === id);
      if (!entry) return null;
      return {
        fileName: entry.document.fileName,
        mimeType: entry.document.mimeType,
        bytes: entry.raw ?? Buffer.alloc(0)
      };
    },
    findById: async (id: string) =>
      stored.find((entry) => entry.document.id === id)?.document ?? null,
    delete: async (id: string) => {
      const index = stored.findIndex((entry) => entry.document.id === id);
      if (index < 0) return false;
      stored.splice(index, 1);
      return true;
    }
  };

  const service = new DocumentService({ documents, planning });
  const app = express();
  app.use(express.json());
  app.use("/api", createDocumentRouter(service));
  app.use(errorHandler(pino({ level: "silent" })));

  return {
    app,
    requirement,
    setLatestAnalysisAt: (value: string | null) => {
      latestAnalysisAt = value;
    }
  };
}

describe("requirement documents API (D1)", () => {
  it("上传技术文档 → 201，列表可见且不返回正文", async () => {
    const { app, requirement } = buildHarness();
    const response = await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "TECHNICAL", fileName: "architecture.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# 架构设计\n\n服务拆分：api / worker", "utf8"))
      .expect(201);

    expect(response.body.data).toMatchObject({
      kind: "TECHNICAL",
      fileName: "architecture.md",
      truncated: false
    });
    expect(response.body.data.contentText).toBeUndefined();

    const listed = await request(app)
      .get(`/api/requirements/${requirement.id}/documents`)
      .expect(200);
    expect(listed.body.data.documents).toHaveLength(1);
    expect(listed.body.data.planningStale).toBe(false);
  });

  it("文件形态的 PRD 写回 raw_content（AC 解析器只读这一处）", async () => {
    const { app, requirement } = buildHarness();
    await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "PRD", fileName: "prd.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# 文件 PRD\n\n## FR-1 注册\n\n| AC-01 | 可注册 |", "utf8"))
      .expect(201);

    expect(requirement.rawContent).toContain("文件 PRD");
    expect(requirement.rawContent).toContain("AC-01");
  });

  it("不支持的扩展名被拒，原因可读", async () => {
    const { app, requirement } = buildHarness();
    const response = await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "TECHNICAL", fileName: "spec.pdf" })
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.7", "utf8"))
      .expect(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_DOCUMENT_FORMAT");
  });

  it("文档变化晚于最近一次规划 ⇒ planningStale=true（D1-8）", async () => {
    const harness = buildHarness();
    const { app, requirement } = harness;
    harness.setLatestAnalysisAt(new Date(Date.now() - 60_000).toISOString());

    await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "TECHNICAL", fileName: "api.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# 接口", "utf8"))
      .expect(201);

    const listed = await request(app)
      .get(`/api/requirements/${requirement.id}/documents`)
      .expect(200);
    expect(listed.body.data.planningStale).toBe(true);
  });

  it("删除后列表只剩 PRD，且需求被标记为文档已变化", async () => {
    const { app, requirement } = buildHarness();
    await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "PRD", fileName: "prd.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# PRD", "utf8"))
      .expect(201);
    const technical = await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "TECHNICAL", fileName: "data-model.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# 数据模型", "utf8"))
      .expect(201);

    await request(app).delete(`/api/documents/${technical.body.data.id}`).expect(200);

    const after = await request(app)
      .get(`/api/requirements/${requirement.id}/documents`)
      .expect(200);
    expect(after.body.data.documents.map((entry: { kind: string }) => entry.kind)).toEqual(["PRD"]);
    expect(after.body.data.documentsChangedAt).not.toBeNull();
  });

  it("上传 UI 参照图 → 201，列表可见，raw 可回读", async () => {
    const { app, requirement } = buildHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const response = await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "UI_REFERENCE", fileName: "home.png" })
      .set("Content-Type", "image/png")
      .send(png)
      .expect(201);

    expect(response.body.data).toMatchObject({
      kind: "UI_REFERENCE",
      fileName: "home.png",
      mimeType: "image/png"
    });
    expect(requirement.rawContent).toBe("# 原始 PRD");

    const listed = await request(app)
      .get(`/api/requirements/${requirement.id}/documents`)
      .expect(200);
    expect(listed.body.data.documents.some((d: { kind: string }) => d.kind === "UI_REFERENCE")).toBe(
      true
    );

    const raw = await request(app)
      .get(`/api/documents/${response.body.data.id}/raw`)
      .expect(200);
    expect(Buffer.from(raw.body)).toEqual(png);
  });

  it("把 .md 当成 UI_REFERENCE 上传被拒", async () => {
    const { app, requirement } = buildHarness();
    const response = await request(app)
      .post(`/api/requirements/${requirement.id}/documents`)
      .query({ kind: "UI_REFERENCE", fileName: "notes.md" })
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("# no", "utf8"))
      .expect(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_DOCUMENT_FORMAT");
  });
});
