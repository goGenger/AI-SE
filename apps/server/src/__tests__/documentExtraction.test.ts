import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { REQUIREMENT_CONTENT_MAX_CHARS } from "@ai-se/shared";
import {
  assertValidImageBytes,
  detectFormat,
  DocumentExtractionError,
  extractDocumentText,
  uiReferencePlaceholder
} from "../services/documentExtraction";

/**
 * 构造一个最小可解析的 .docx（ZIP + 必需的 OOXML 部件）。
 * 不引第三方测试夹具：mammoth 要的是真实的 ZIP 结构，手搓一个能把「.docx 解析」这条
 * 核心路径真正走通，而不是把它 mock 掉（`AGENTS.md` §7：核心链路要真实验证）。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

function docxWith(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  return buildZip([
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>"
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>"
    },
    {
      name: "word/document.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`
    }
  ]);
}

describe("detectFormat", () => {
  it("认 md / txt / docx 与 png/jpg/webp；PDF 仍拒绝", () => {
    expect(detectFormat("prd.md")).toBe("md");
    expect(detectFormat("spec.MARKDOWN")).toBe("md");
    expect(detectFormat("notes.txt")).toBe("txt");
    expect(detectFormat("技术方案.docx")).toBe("docx");
    expect(detectFormat("mock.png")).toBe("png");
    expect(detectFormat("shot.JPEG")).toBe("jpg");
    expect(detectFormat("a.webp")).toBe("webp");
    expect(detectFormat("prd.pdf")).toBeNull();
    expect(detectFormat("prd.doc")).toBeNull();
    expect(detectFormat("noext")).toBeNull();
  });
});

describe("extractDocumentText", () => {
  it("md/txt：统一换行、去 BOM、去首尾空白", async () => {
    const bytes = Buffer.from("\uFEFF# 标题\r\n\r\n正文\r\n", "utf8");
    const result = await extractDocumentText("md", bytes);
    expect(result.text).toBe("# 标题\n\n正文");
    expect(result.truncated).toBe(false);
  });

  it("docx：抽出真实 OOXML 里的文本", async () => {
    const result = await extractDocumentText(
      "docx",
      docxWith(["API 设计", "GET /api/tasks 返回 { items }"])
    );
    expect(result.text).toContain("API 设计");
    expect(result.text).toContain("GET /api/tasks 返回 { items }");
    expect(result.truncated).toBe(false);
  });

  it("把二进制文件改名成 .txt 必须被拒，而不是抽出乱码", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]);
    await expect(extractDocumentText("txt", bytes)).rejects.toMatchObject({
      code: "BINARY_CONTENT"
    });
  });

  it("坏 docx 报 PARSE_FAILED", async () => {
    await expect(
      extractDocumentText("docx", Buffer.from("this is not a zip", "utf8"))
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("空文档被拒（落库空文本等于让规划在没有材料的情况下静默跑完）", async () => {
    await expect(extractDocumentText("md", Buffer.from(" \n\t\n", "utf8"))).rejects.toMatchObject({
      code: "EMPTY_DOCUMENT"
    });
  });

  it("超过上限时截断并显性告知", async () => {
    const long = "a".repeat(REQUIREMENT_CONTENT_MAX_CHARS + 10);
    const result = await extractDocumentText("txt", Buffer.from(long, "utf8"));
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(REQUIREMENT_CONTENT_MAX_CHARS);
  });
});

describe("UI reference images", () => {
  it("占位说明不含 OCR，只记文件名", () => {
    expect(uiReferencePlaceholder("home.png")).toEqual({
      text: "[UI reference image: home.png]",
      truncated: false
    });
  });

  it("魔数校验：合法 PNG / 伪装扩展名", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(() => assertValidImageBytes("png", png)).not.toThrow();
    expect(() => assertValidImageBytes("png", Buffer.from("not-a-png"))).toThrow(
      DocumentExtractionError
    );
  });
});
