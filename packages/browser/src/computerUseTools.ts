import {
  ActionResultSchema,
  ObservationSchema,
  type ActionResult,
  type ExternalActionRef,
  type Observation
} from "@ai-se/shared";
import { defaultActionPolicy } from "@ai-se/action-policy";
import { redactCredentialShapedText } from "@ai-se/observability";
import { ToolDefinition } from "@ai-se/tool-runtime";
import { z } from "zod";
import { BrowserError } from "./errors";
import type { BrowserSession } from "./browserSession";

/**
 * Phase 5.7-1: Browser Computer Use tools. Adapter layer over the frozen
 * 5.6-3 BrowserSession — nothing here touches Playwright, and the existing
 * 5.6 browser tool registry stays untouched. Every action yields a strict
 * 5.7-0 `ActionResult`; `browser.observe` yields a strict 5.7-0 `Observation`.
 *
 * Layering: the ToolResult is the ToolRuntime governance envelope — invalid
 * input / timeout / cancellation surface there as TOOL_ERROR / TIMEOUT_ERROR /
 * CANCELLED_ERROR. Once an action actually ran, its outcome (success or the
 * action's own failure) rides inside the ActionResult so downstream consumers
 * speak the computer-use protocol.
 */

export interface ComputerUseToolsContext {
  session: BrowserSession;
  /** ToolRuntime cancellation signal (optional; direct calls may omit it). */
  signal?: AbortSignal;
}

const urlSchema = z.string().trim().min(1).max(2000);
const selectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => !/^\s*(javascript|data|vbscript):/i.test(value),
    "selector must be a CSS selector, not a scheme"
  );
const actionTimeoutSchema = z.number().int().positive().max(30_000).optional();

type Risk = "LOW" | "MEDIUM" | "HIGH";

/**
 * Phase 5.7-3: the risk level of every computer-use action comes from the
 * unified Action Policy (platform table + verb floor) — never from tool
 * arguments. An action the policy does not know cannot be composed (fail
 * closed).
 */
function browserActionRisk(action: string): Risk {
  const decision = defaultActionPolicy.resolveBrowser(action);
  if (!decision) throw new Error(`Action policy DENY: unknown browser action ${action}`);
  return decision.riskLevel as Risk;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function browserActionRef(
  session: BrowserSession,
  toolName: string,
  target: string
): ExternalActionRef {
  // URLs can carry credential-shaped material (?token=…, data: fixtures) —
  // the target rides into agent state / audit, so it passes the redaction
  // sink like every other outbound string. Structure is preserved as-is.
  return {
    source: "browser",
    sessionId: session.sessionId,
    toolName,
    target: redactCredentialShapedText(target)
  };
}

/** Browser-domain failure → ActionResult error field (single normalizer). */
function actionError(error: unknown): { code: string; message: string } {
  if (error instanceof BrowserError) {
    return { code: error.code, message: redactCredentialShapedText(error.message) };
  }
  return {
    code: "BROWSER_ACTION_FAILED",
    message: redactCredentialShapedText(
      error instanceof Error ? error.message : "unknown browser action failure"
    )
  };
}

interface ObservationRequest {
  session: BrowserSession;
  toolName: string;
  target: string;
  dom?: boolean;
  accessibility?: boolean;
  maxNodes?: number;
  screenshotRef?: string;
}

/** Assemble + validate one 5.7-0 Observation from a live session pass. */
async function captureObservation(request: ObservationRequest): Promise<Observation> {
  const snapshot = await request.session.observe({
    dom: request.dom ?? true,
    accessibility: request.accessibility ?? true,
    maxNodes: request.maxNodes
  });
  return ObservationSchema.parse({
    observationId: newId("obs"),
    actionRef: browserActionRef(request.session, request.toolName, request.target || snapshot.url),
    ...(snapshot.dom ? { dom: snapshot.dom } : {}),
    ...(snapshot.accessibility ? { accessibility: snapshot.accessibility } : {}),
    ...(request.screenshotRef ? { screenshotRef: request.screenshotRef } : {}),
    takenAt: new Date().toISOString()
  });
}

interface ActionRun {
  session: BrowserSession;
  toolName: string;
  target: string;
  signal?: AbortSignal;
  /** The browser operation; may return extra protocol context (screenshotRef). */
  run: () => Promise<{ screenshotRef?: string } | void>;
  /** Post-action observation content (default: bounded DOM snapshot only). */
  observe?: { dom?: boolean; accessibility?: boolean; maxNodes?: number };
}

/** Execute one browser action and map success/failure/cancellation to the
 * frozen ActionResult protocol. Never throws for browser-op failures. */
async function runBrowserAction(action: ActionRun): Promise<ActionResult> {
  const started = Date.now();
  const occurredAt = () => new Date().toISOString();
  const base = () => ({
    resultId: newId("result"),
    actionRef: browserActionRef(action.session, action.toolName, action.target)
  });
  if (action.signal?.aborted) {
    return ActionResultSchema.parse({
      ...base(),
      status: "cancelled",
      cancelledAt: occurredAt(),
      durationMs: Date.now() - started,
      occurredAt: occurredAt()
    });
  }
  try {
    const outcome = await action.run();
    if (action.signal?.aborted) {
      return ActionResultSchema.parse({
        ...base(),
        status: "cancelled",
        cancelledAt: occurredAt(),
        durationMs: Date.now() - started,
        occurredAt: occurredAt()
      });
    }
    // Post-action observation is best-effort: the action already succeeded;
    // a failed capture omits the optional field instead of failing the run.
    let observation: Observation | undefined;
    try {
      observation = await captureObservation({
        session: action.session,
        toolName: action.toolName,
        target: action.target,
        dom: action.observe?.dom ?? true,
        accessibility: action.observe?.accessibility ?? false,
        maxNodes: action.observe?.maxNodes ?? 200,
        screenshotRef: outcome?.screenshotRef
      });
    } catch {
      observation = undefined;
    }
    return ActionResultSchema.parse({
      ...base(),
      status: "success",
      ...(observation ? { observation } : {}),
      durationMs: Date.now() - started,
      occurredAt: occurredAt()
    });
  } catch (error) {
    return ActionResultSchema.parse({
      ...base(),
      status: "failed",
      error: actionError(error),
      durationMs: Date.now() - started,
      occurredAt: occurredAt()
    });
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const BROWSER_OBSERVE_TOOL: ToolDefinition<
  { includeDom?: boolean; includeAccessibility?: boolean; maxNodes?: number },
  Observation
> = {
  name: "browser.observe",
  description:
    "Observe the current page: DOM snapshot and/or accessibility tree (5.7-0 Observation; observed refs are usable as action selectors).",
  riskLevel: browserActionRisk("browser.observe") as Risk,
  inputSchema: z
    .object({
      includeDom: z.boolean().optional(),
      includeAccessibility: z.boolean().optional(),
      maxNodes: z.number().int().min(1).max(2000).optional()
    })
    .strict()
    .refine((value) => value.includeDom !== false || value.includeAccessibility !== false, {
      message: "observation requires at least one of includeDom or includeAccessibility"
    }),
  async execute(
    input: { includeDom?: boolean; includeAccessibility?: boolean; maxNodes?: number },
    context: unknown
  ) {
    const { session } = context as ComputerUseToolsContext;
    return captureObservation({
      session,
      toolName: "browser.observe",
      target: session.currentUrl(),
      dom: input.includeDom ?? true,
      accessibility: input.includeAccessibility ?? true,
      maxNodes: input.maxNodes
    });
  }
};

export const BROWSER_ACTION_NAVIGATE_TOOL: ToolDefinition<
  { url: string; timeoutMs?: number },
  ActionResult
> = {
  name: "browser.action.navigate",
  description: "Navigate the controlled browser session to a URL (allowlist enforced).",
  riskLevel: browserActionRisk("browser.action.navigate") as Risk,
  inputSchema: z.object({ url: urlSchema, timeoutMs: actionTimeoutSchema }).strict(),
  async execute(input: { url: string; timeoutMs?: number }, context: unknown) {
    const { session, signal } = context as ComputerUseToolsContext;
    return runBrowserAction({
      session,
      toolName: "browser.action.navigate",
      target: input.url,
      signal,
      run: async () => {
        await session.goto(input.url, { timeoutMs: input.timeoutMs });
        await session.waitForRender();
      },
      observe: { dom: true, accessibility: true, maxNodes: 200 }
    });
  }
};

export const BROWSER_ACTION_CLICK_TOOL: ToolDefinition<
  { selector: string; timeoutMs?: number },
  ActionResult
> = {
  name: "browser.action.click",
  description:
    "Click an element by CSS selector (or an observed data-ai-se-ref selector); returns a 5.7-0 ActionResult.",
  riskLevel: browserActionRisk("browser.action.click") as Risk,
  inputSchema: z.object({ selector: selectorSchema, timeoutMs: actionTimeoutSchema }).strict(),
  async execute(input: { selector: string; timeoutMs?: number }, context: unknown) {
    const { session, signal } = context as ComputerUseToolsContext;
    return runBrowserAction({
      session,
      toolName: "browser.action.click",
      target: input.selector,
      signal,
      run: async () => {
        await session.click(input.selector, { timeoutMs: input.timeoutMs });
      }
    });
  }
};

export const BROWSER_ACTION_TYPE_TOOL: ToolDefinition<
  { selector: string; text: string; timeoutMs?: number },
  ActionResult
> = {
  name: "browser.action.type",
  description:
    "Type text into an element by CSS selector (or an observed data-ai-se-ref selector); returns a 5.7-0 ActionResult.",
  riskLevel: browserActionRisk("browser.action.type") as Risk,
  inputSchema: z
    .object({
      selector: selectorSchema,
      text: z.string().max(10_000),
      timeoutMs: actionTimeoutSchema
    })
    .strict(),
  async execute(input: { selector: string; text: string; timeoutMs?: number }, context: unknown) {
    const { session, signal } = context as ComputerUseToolsContext;
    return runBrowserAction({
      session,
      toolName: "browser.action.type",
      target: input.selector,
      signal,
      run: async () => {
        await session.type(input.selector, input.text);
      }
    });
  }
};

export const BROWSER_ACTION_SCREENSHOT_TOOL: ToolDefinition<{ fullPage?: boolean }, ActionResult> =
  {
    name: "browser.action.screenshot",
    description:
      "Capture a screenshot through the 5.6-3 asset pipeline; the 5.7-0 ActionResult observation carries the screenshot:// ref (never base64).",
    riskLevel: browserActionRisk("browser.action.screenshot") as Risk,
    inputSchema: z.object({ fullPage: z.boolean().optional() }).strict(),
    async execute(input: { fullPage?: boolean }, context: unknown) {
      const { session, signal } = context as ComputerUseToolsContext;
      return runBrowserAction({
        session,
        toolName: "browser.action.screenshot",
        target: session.currentUrl(),
        signal,
        run: async () => {
          const shot = await session.screenshot({ fullPage: input.fullPage });
          return { screenshotRef: session.assetRefFor(shot) };
        }
      });
    }
  };

/** Frozen 5.7-1 computer-use tool set (additive to the 5.6 browser tools). */
export const COMPUTER_USE_BROWSER_TOOLS = [
  BROWSER_OBSERVE_TOOL,
  BROWSER_ACTION_NAVIGATE_TOOL,
  BROWSER_ACTION_CLICK_TOOL,
  BROWSER_ACTION_TYPE_TOOL,
  BROWSER_ACTION_SCREENSHOT_TOOL
] as const;
