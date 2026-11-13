import { z } from "zod";
import { ToolDefinition } from "@ai-se/tool-runtime";
import type { BrowserSession } from "./browserSession";

/**
 * Phase 5.6-3: 7 frozen ToolDefinitions (§三.6). All execute against an
 * injected BrowserSession — never direct Playwright. Strict zod input.
 * riskLevel literals come from ToolRuntime's ToolRiskLevel.
 */

export interface BrowserToolsContext {
  session: BrowserSession;
}

const urlSchema = z.string().trim().min(1).max(2_000);
const selectorSchema = z.string().trim().min(1).max(500).refine(
  (value) => !/^\s*(javascript|data|vbscript):/i.test(value),
  "selector must be a CSS selector, not a scheme"
);
const viewportSchema = z.object({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) }).strict();

// tool-runtime will be imported for ToolRiskLevel typing; keep local aliases minimal.
type Risk = "LOW" | "MEDIUM" | "HIGH";

export const BROWSER_NAVIGATE_TOOL: ToolDefinition<{ url: string; timeoutMs?: number }, { finalUrl: string; status: number | null }> = {
  name: "browser.navigate",
  description: "Navigate the controlled browser session to a URL (allowlist enforced).",
  riskLevel: "LOW",
  inputSchema: z.object({ url: urlSchema, timeoutMs: z.number().int().positive().max(60_000).optional() }).strict(),
  async execute(input: { url: string; timeoutMs?: number }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    return session.goto(input.url, { timeoutMs: input.timeoutMs });
  }
};

export const BROWSER_SET_VIEWPORT_TOOL: ToolDefinition<{ width: number; height: number }, { applied: true }> = {
  name: "browser.setViewport",
  description: "Set the viewport size for the controlled browser session.",
  riskLevel: "LOW" as Risk,
  inputSchema: viewportSchema,
  async execute(input: { width: number; height: number }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    return session.setViewport(input.width, input.height);
  }
};

export const BROWSER_WAIT_FOR_RENDER_TOOL: ToolDefinition<Record<string, never>, { settled: "networkidle" | "timeout"; elapsedMs: number }> = {
  name: "browser.waitForRender",
  description: "Wait for render settle (networkidle with hard cap).",
  riskLevel: "LOW" as Risk,
  inputSchema: z.object({}).strict(),
  async execute(_input: Record<string, never>, context: unknown) {
    const { session } = context as BrowserToolsContext;
    return session.waitForRender();
  }
};

export const BROWSER_SCREENSHOT_TOOL: ToolDefinition<
  { fullPage?: boolean },
  Awaited<ReturnType<BrowserSession["screenshot"]>>
> = {
  name: "browser.screenshot",
  description: "Capture a screenshot of the current page.",
  riskLevel: "LOW" as Risk,
  inputSchema: z.object({ fullPage: z.boolean().optional() }).strict(),
  async execute(input: { fullPage?: boolean }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    return session.screenshot({ fullPage: input?.fullPage });
  }
};

export const BROWSER_CONSOLE_ERRORS_TOOL: ToolDefinition<
  { sinceSeq?: number },
  Awaited<ReturnType<BrowserSession["getErrors"]>>
> = {
  name: "browser.consoleErrors",
  description: "Fetch console/network error entries captured since a sequence.",
  riskLevel: "LOW" as Risk,
  inputSchema: z.object({ sinceSeq: z.number().int().min(0).optional() }).strict(),
  async execute(input: { sinceSeq?: number }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    return session.getErrors(input?.sinceSeq ?? 0);
  }
};

export const BROWSER_CLICK_TOOL: ToolDefinition<{ selector: string; timeoutMs?: number }, { ok: true }> = {
  name: "browser.click",
  description: "Click an element by CSS selector (MEDIUM: DOM state change).",
  riskLevel: "MEDIUM" as Risk,
  inputSchema: z.object({ selector: selectorSchema, timeoutMs: z.number().int().positive().max(30_000).optional() }).strict(),
  async execute(input: { selector: string; timeoutMs?: number }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    await session.click(input.selector, { timeoutMs: input.timeoutMs });
    return { ok: true as const };
  }
};

export const BROWSER_TYPE_TOOL: ToolDefinition<{ selector: string; text: string }, { ok: true }> = {
  name: "browser.type",
  description: "Type text into an element by CSS selector (MEDIUM: DOM state change).",
  riskLevel: "MEDIUM" as Risk,
  inputSchema: z.object({ selector: selectorSchema, text: z.string().max(10_000) }).strict(),
  async execute(input: { selector: string; text: string }, context: unknown) {
    const { session } = context as BrowserToolsContext;
    await session.type(input.selector, input.text);
    return { ok: true as const };
  }
};

/** Frozen 7-tool registry (prompt §三.6). */
export const BROWSER_TOOLS = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SET_VIEWPORT_TOOL,
  BROWSER_WAIT_FOR_RENDER_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_CONSOLE_ERRORS_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL
] as const;
