import type { VisualViewport } from "@ai-se/shared";
import { VisualAnalyzerError } from "../errors";
import type { VLMPageObservation } from "./types";

/**
 * Phase 5.6-1 Repair: REAL URL adapter. Fetches pages ONLY from hosts on
 * the caller-injected allowlist (the 5.6-0 `url://` allowlist is enforced
 * before this provider runs — see validateVisualInput). No credential ever
 * enters a URL query; responses are plain HTML text.
 *
 * ponytail: deterministic DOM-less parse (regex over anchor/heading/paragraph
 * text) — a real headless DOM snapshot belongs to 5.7-1 Browser observe,
 * NOT to this adapter. Nothing here bypasses the 5.6-0 security boundary.
 */

export interface UrlFetchOptions {
  timeoutMs?: number;
}

export interface UrlHtmlFetcher {
  (url: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{
    status: number;
    html: string;
  }>;
}

export const DEFAULT_URL_TIMEOUT_MS = 15_000;

export class UrlFetchVLMProvider {
  readonly name = "url-fetch";

  constructor(private readonly fetcher: UrlHtmlFetcher = defaultFetcher) {}

  /** Recognizes a `url://<host>/<path>` reference → structured observation. */
  async recognize(
    assetRef: string,
    viewport: VisualViewport,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<VLMPageObservation> {
    // `url://example.com/path` — the allowlist check already ran; here we
    // reconstruct a real https URL for the fetch. Only https is allowed in
    // this adapter (skip http to keep the traffic encrypted; localhost
    // testing uses https fixtures or the browser adapter in 5.7-1).
    const httpsUrl = toHttpsUrl(assetRef);
    const timeout = options?.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let html: string;
      let status: number;
      try {
        const result = await this.fetcher(httpsUrl, { signal: controller.signal, timeoutMs: timeout });
        status = result.status;
        html = result.html;
      } catch (error) {
        throw new VisualAnalyzerError(
          "VLM_UNAVAILABLE",
          `URL fetch failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
      if (status !== 200) {
        throw new VisualAnalyzerError("VLM_UNAVAILABLE", `URL fetch returned ${status}`);
      }
      return parseHtmlToObservation(html, viewport);
    } catch (error) {
      if (controller.signal.aborted) {
        throw options?.signal?.aborted
          ? new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled")
          : new VisualAnalyzerError("VLM_TIMEOUT", `URL fetch exceeded ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** `url://host[:port]/path` → `https://host[:port]/path`. */
export function toHttpsUrl(assetRef: string): string {
  const match = /^url:\/\/([^/?#]+)(.*)$/.exec(assetRef.trim());
  if (!match) {
    throw new VisualAnalyzerError(
      "INPUT_INVALID",
      `url:// reference must be url://<host>/<path>; got ${assetRef.slice(0, 100)}`
    );
  }
  const rest = match[2] && match[2].length > 0 ? match[2] : "/";
  return `https://${match[1]}${rest}`;
}

/** Default fetcher: stdlib fetch with no credentials. */
async function defaultFetcher(
  url: string,
  options?: { signal?: AbortSignal }
): Promise<{ status: number; html: string }> {
  const response = await fetch(url, {
    headers: { accept: "text/html" },
    signal: options?.signal
  });
  return { status: response.status, html: await response.text() };
}

const ROLE_BY_TAG: Record<string, NonNullable<import("./types").VLMElementObservation["role"]>> = {
  button: "button",
  input: "input",
  img: "image",
  a: "link",
  ul: "list",
  ol: "list",
  table: "table",
  svg: "icon"
};

/** Deterministic DOM-less parse: heading/paragraph sections + elements. */
export function parseHtmlToObservation(html: string, viewport: VisualViewport): VLMPageObservation {
  // Strip script/style to avoid confusing code text with page content.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned);
  const pageName = titleMatch?.[1]?.trim() || "Untitled page";

  const sections: VLMPageObservation["sections"] = [];
  // Headings become section boundaries (h1/h2); body text collapses into them.
  const headingPattern = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [...cleaned.matchAll(headingPattern)];
  if (headings.length > 0) {
    let previousOffset = 0;
    headings.forEach((heading, index) => {
      const title = stripTags(heading[2]) || `Section ${index + 1}`;
      const nextMatch = headings[index + 1];
      const sectionBody = cleaned.slice(
        previousOffset + (heading[0]?.length ?? 0),
        nextMatch?.index ?? cleaned.length
      );
      const elements = collectElements(sectionBody);
      sections.push({
        name: title.slice(0, 300),
        rect: sectionRect(index, viewport),
        elements: elements.length > 0 ? elements : [{
          name: title.slice(0, 300),
          role: "text",
          rect: sectionRect(index, viewport)
        }]
      });
      previousOffset = (nextMatch?.index ?? cleaned.length) - (heading.index ?? 0);
    });
  } else {
    sections.push({
      name: pageName,
      rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      elements: [{ name: pageName, role: "text" }]
    });
  }
  return { pageName, sections, warnings: [] };
}

function sectionRect(index: number, viewport: VisualViewport) {
  // Even bands over the viewport; the analyzer clamps and orders afterwards.
  const band = Math.max(1, Math.floor(viewport.height / 4));
  return { x: 0, y: Math.min(viewport.height - 1, index * band), width: viewport.width, height: band };
}

function collectElements(html: string): Array<{ name: string; role: NonNullable<import("./types").VLMElementObservation["role"]> }> {
  const out: Array<{ name: string; role: NonNullable<import("./types").VLMElementObservation["role"]> }> = [];
  const elementPattern = /<(button|input|img|a|ul|ol|table|svg)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  const count = 0;
  while ((match = elementPattern.exec(html)) !== null && out.length < 500) {
    const tag = match[1].toLowerCase();
    out.push({ name: `${tag}[${match.index}]`, role: ROLE_BY_TAG[tag] ?? "other" });
  }
  void count;
  return out;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
