import type { VisualViewport } from "@ai-se/shared";
import { VisualAnalyzerError } from "../errors";
import type {
  VLMElementObservation,
  VLMPageObservation,
  VLMSectionObservation
} from "./types";

/**
 * Phase 5.6-1 Repair: REAL Figma adapter (deterministic, no VLM). Reads
 * `GET /v1/files/{key}` with an injected X-Figma-Token and maps the node
 * tree into VLMPageObservation. The token is injected; never logged.
 *
 * API surface verified via Context7 (/figma/rest-api-spec):
 *   GET https://api.figma.com/v1/files/{fileKey}  header: X-Figma-Token
 *   → { name, document: { children: [CANVAS…] } } (DOM-like node tree)
 * Rendering nodeBitmaps at real pixel geometry is streaming-work for 5.7-1+
 * (the analyzer normalizes rects into the viewport regardless of origin).
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";

export interface FigmaVLMOptions {
  /** Injected Figma personal-access token; absent → construction fails. */
  token: string;
  /** Optional single file/node fetch override (tests point at a mock URL). */
  baseUrl?: string;
  timeoutMs?: number;
}

export class FigmaVLMProvider {
  readonly name = "figma-rest";

  constructor(private readonly options: FigmaVLMOptions) {
    if (!options.token) {
      throw new VisualAnalyzerError(
        "VLM_UNAVAILABLE",
        "FigmaVLMProvider requires an injected token (cannot fake PASS)"
      );
    }
  }

  /** Recognizes a `figma://file/<key>` reference → structured observation. */
  async recognize(
    assetRef: string,
    viewport: VisualViewport,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<VLMPageObservation> {
    const fileKey = extractFileKey(assetRef);
    const timeout = options?.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${this.options.baseUrl ?? FIGMA_API_BASE}/files/${fileKey}`, {
        headers: { "X-Figma-Token": this.options.token },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new VisualAnalyzerError(
          "VLM_UNAVAILABLE",
          `Figma API returned ${response.status}`
        );
      }
      const raw = (await response.json()) as unknown;
      const file = raw as {
        name?: unknown;
        document?: { children?: unknown };
      };
      if (typeof file.name !== "string" || file.name.length === 0) {
        throw new VisualAnalyzerError("VLM_MALFORMED", "Figma file JSON missing name");
      }
      // First canvas is the target page (fixture scope); nodes map deterministically.
      const firstCanvas = (file.document?.children as unknown[] | undefined)?.[0] as
        | { children?: unknown }
        | undefined;
      if (!firstCanvas) {
        throw new VisualAnalyzerError("VLM_MALFORMED", "Figma file has no canvas");
      }
      return mapNodesToObservation(
        file.name,
        (firstCanvas.children ?? []) as FigmaNode[],
        viewport
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw options?.signal?.aborted
          ? new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled")
          : new VisualAnalyzerError("VLM_TIMEOUT", `Figma fetch exceeded ${timeout}ms`);
      }
      if (error instanceof VisualAnalyzerError) throw error;
      throw new VisualAnalyzerError(
        "VLM_UNAVAILABLE",
        `Figma fetch failed: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
    finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

interface FigmaNode {
  name?: unknown;
  type?: unknown;
  absoluteBoundingBox?: unknown;
  fills?: unknown;
  children?: unknown;
}

function extractFileKey(assetRef: string): string {
  // figma://file/<key>
  const match = /^figma:\/\/file\/([A-Za-z0-9]+)/.exec(assetRef.trim());
  if (!match) {
    throw new VisualAnalyzerError(
      "INPUT_INVALID",
      `figma:// reference must be figma://file/<key>; got ${assetRef.slice(0, 100)}`
    );
  }
  return match[1];
}

const ROLE_BY_TYPE: Record<string, NonNullable<VLMElementObservation["role"]>> = {
  FRAME: "container",
  GROUP: "container",
  INSTANCE: "container",
  TEXT: "text",
  RECTANGLE: "container",
  VECTOR: "icon",
  IMAGE: "image"
};

function mapNodesToObservation(
  pageName: string,
  nodes: FigmaNode[],
  viewport: VisualViewport
): VLMPageObservation {
  const warnings: string[] = [];
  const sections: VLMSectionObservation[] = [];
  const nodeIndex = 0;
  void nodeIndex;
  for (const raw of nodes) {
    const node = raw;
    if (typeof node.name !== "string" || !isRect(node.absoluteBoundingBox)) continue;
    const type = typeof node.type === "string" ? node.type.toUpperCase() : "";
    const elements: VLMElementObservation[] = [];
    if (Array.isArray(node.children) && node.children.length > 0) {
      for (const childRaw of node.children as FigmaNode[]) {
        if (typeof childRaw.name !== "string" || !isRect(childRaw.absoluteBoundingBox)) continue;
        const childType = typeof childRaw.type === "string" ? childRaw.type.toUpperCase() : "";
        elements.push({
          name: childRaw.name.slice(0, 300),
          role:
            ROLE_BY_TYPE[childType] ??
            inferRoleFromName(childRaw.name),
          rect: childRaw.absoluteBoundingBox
        });
      }
    } else {
      elements.push({
        name: node.name.slice(0, 300),
        role: ROLE_BY_TYPE[type] ?? "container",
        rect: node.absoluteBoundingBox
      });
    }
    if (Array.isArray(node.fills)) {
      const color = firstSolidHex(node.fills);
      if (color) {
        sections.push({
          name: node.name.slice(0, 300),
          rect: node.absoluteBoundingBox,
          style: { color },
          elements
        });
        continue;
      }
      warnings.push(`section ${node.name}: no solid fill for style extraction`);
    } else {
      warnings.push(`section ${node.name}: no fills array`);
    }
    sections.push({ name: node.name.slice(0, 300), rect: node.absoluteBoundingBox, elements });
  }
  void viewport;
  return { pageName: pageName, sections, warnings };
}

function inferRoleFromName(name: string): NonNullable<VLMElementObservation["role"]> {
  // ponytail: minimal keyword-based role inference for Figma node names.
  const lowered = name.toLowerCase();
  if (/(button|btn)/.test(lowered)) return "button";
  if (/(input|field)/.test(lowered)) return "input";
  if (/(image|img|photo)/.test(lowered)) return "image";
  if (/(list)/.test(lowered)) return "list";
  return "text";
}

interface Paint {
  type?: unknown;
  color?: { r?: unknown; g?: unknown; b?: unknown };
  opacity?: unknown;
}

function firstSolidHex(fills: unknown[]): string | undefined {
  for (const fill of fills as Paint[]) {
    if (fill.type !== "SOLID") continue;
    const { r, g, b } = fill.color ?? {};
    if (typeof r === "number" && typeof g === "number" && typeof b === "number") {
      return `#${[r, g, b]
        .map((channel) =>
          Math.round(Math.max(0, Math.min(1, channel)) * 255)
            .toString(16)
            .padStart(2, "0")
        )
        .join("")}`;
    }
  }
  return undefined;
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return (
    typeof rect?.x === "number" &&
    typeof rect?.y === "number" &&
    typeof rect?.width === "number" &&
    typeof rect?.height === "number"
  );
}
