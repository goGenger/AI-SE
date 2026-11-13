import { REQUIREMENT_CONTENT_MAX_CHARS } from "@ai-se/shared";
import mammoth from "mammoth";

export type ExtractableFormat = "md" | "txt" | "docx";
export type ImageFormat = "png" | "jpg" | "webp";
export type DocumentFormat = ExtractableFormat | ImageFormat;

export interface ExtractionResult {
  text: string;
  truncated: boolean;
}

/** 抽取失败的原因码（复用既有错误封套的 `details`，不新建错误码体系）。 */
export type ExtractionErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "EMPTY_DOCUMENT"
  | "BINARY_CONTENT"
  | "PARSE_FAILED"
  | "INVALID_IMAGE";

export class DocumentExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

const MIME_BY_FORMAT: Record<DocumentFormat, string> = {
  md: "text/markdown",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp"
};

const TEXT_FORMATS = new Set<DocumentFormat>(["md", "txt", "docx"]);
const IMAGE_FORMATS = new Set<DocumentFormat>(["png", "jpg", "webp"]);

/** 按扩展名判定格式；不在白名单里一律拒绝。 */
export function detectFormat(fileName: string): DocumentFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg";
  if (lower.endsWith(".webp")) return "webp";
  return null;
}

export function isImageFormat(format: DocumentFormat): format is ImageFormat {
  return IMAGE_FORMATS.has(format);
}

export function isTextFormat(format: DocumentFormat): format is ExtractableFormat {
  return TEXT_FORMATS.has(format);
}

export function mimeForFormat(format: DocumentFormat): string {
  return MIME_BY_FORMAT[format];
}

/** 统一换行、去 BOM、去首尾空白——三种文本格式走同一条收尾逻辑。 */
function normalize(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function truncate(text: string): ExtractionResult {
  if (text.length <= REQUIREMENT_CONTENT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, REQUIREMENT_CONTENT_MAX_CHARS), truncated: true };
}

/** 纯文本格式：NUL 字节即判二进制。 */
function extractPlainText(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw new DocumentExtractionError(
      "BINARY_CONTENT",
      "文件含二进制内容，无法按纯文本解析；.docx 请使用 .docx 扩展名上传"
    );
  }
  return bytes.toString("utf8");
}

async function extractDocx(bytes: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value;
  } catch (error) {
    throw new DocumentExtractionError(
      "PARSE_FAILED",
      `.docx 解析失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 抽取正文。**空文档一律拒绝**：落库一份空文本等于让后续规划在「没有材料」的情况下静默跑完。
 * 超长**截断而非拒绝**，并由 `truncated` 显性告知（`docs/229` D1-4）。
 */
export async function extractDocumentText(
  format: ExtractableFormat,
  bytes: Buffer
): Promise<ExtractionResult> {
  const raw = format === "docx" ? await extractDocx(bytes) : extractPlainText(bytes);
  const text = normalize(raw);
  if (text.length === 0) {
    throw new DocumentExtractionError("EMPTY_DOCUMENT", "文件里没有可读文本");
  }
  return truncate(text);
}

/** 魔数校验：扩展名与内容不一致时拒绝（不做 OCR）。 */
export function assertValidImageBytes(format: ImageFormat, bytes: Buffer): void {
  if (bytes.byteLength === 0) {
    throw new DocumentExtractionError("EMPTY_DOCUMENT", "图片内容为空");
  }
  if (format === "png") {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.subarray(0, 8).equals(sig)) return;
  } else if (format === "jpg") {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return;
  } else if (format === "webp") {
    if (
      bytes.byteLength >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return;
    }
  }
  throw new DocumentExtractionError(
    "INVALID_IMAGE",
    `文件内容不是有效的 ${format.toUpperCase()} 图片`
  );
}

/** UI 参照图不 OCR：只落一条短说明进 content_text，原件走 raw_bytes。 */
export function uiReferencePlaceholder(fileName: string): ExtractionResult {
  return {
    text: `[UI reference image: ${fileName}]`,
    truncated: false
  };
}
