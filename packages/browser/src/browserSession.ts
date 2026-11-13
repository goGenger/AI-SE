import { redactCredentialShapedText } from "@ai-se/observability";
import { BrowserError } from "./errors";
import {
  DEFAULT_NAV_TIMEOUT_MS,
  RENDER_HARD_TIMEOUT_MS,
  isNavigationAllowed,
  type BrowserDomNode,
  type BrowserLike,
  type ConsoleMessageLike,
  type ContextLike,
  type NavigateAllowlist,
  type NavigationResult,
  type PageLike,
  type PlaywrightLike,
  type RequestLike,
  type ResponseLike
} from "./session";

/**
 * Phase 5.6-3: BrowserSession — lifecycle + screenshot pipeline + console/
 * network capture. One Chromium instance, one page; no pooling (ponytail).
 */

export interface ConsoleEntry {
  seq: number;
  level: "error" | "warning";
  /** Redacted console text (URL-queries with tokens scrubbed). */
  text: string;
  url: string;
  timestamp: string;
}

/** Phase 5.6-3 Repair: network failure classes carried by the session. */
export type NetworkErrorKind = "requestfailed" | "http_4xx" | "http_5xx";

export interface NetworkErrorEntry {
  seq: number;
  kind: NetworkErrorKind;
  /** HTTP status for 4xx/5xx; null for transport-level failures. */
  status: number | null;
  /** Redacted URL. */
  url: string;
  method: string;
  reason: string;
  timestamp: string;
}

export interface ScreenshotAsset {
  buffer: Buffer;
  base64: string;
  mimeType: "image/png";
  takenAt: string;
  /** Console errors observed since the previous screenshot (§三.4 anchor). */
  consoleErrorCountSinceLast: number;
  /** Network errors observed since the previous screenshot (same anchor). */
  networkErrorCountSinceLast: number;
  fullPage: boolean;
  seq: number;
}

export interface BrowserSessionOptions {
  playwright: PlaywrightLike;
  navigateAllowlist: NavigateAllowlist;
  headless?: boolean;
  /** Deterministic id used for assetRef naming. */
  sessionId?: string;
}

export interface LaunchResult {
  sessionId: string;
  headless: boolean;
}

let SESSION_COUNTER = 0;

/**
 * Page-side DOM surface used by the observation script. The browser package
 * compiles WITHOUT the DOM lib (adapter boundary discipline) — these are
 * module-local ambient declarations covering exactly the globals the fixed
 * script touches. They are compile-time only; the function itself executes
 * inside Chromium.
 */
interface PageElement {
  tagName: string;
  children: { length: number };
  parentElement: PageElement | null;
  tabIndex: number;
  innerText: string;
  textContent: string | null;
  value: string;
  placeholder: string;
  alt: string;
  href: string;
  type: string;
  getClientRects(): { length: number };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<PageElement>;
  body: PageElement;
};
declare const window: { getComputedStyle(element: PageElement): { visibility: string } };

/**
 * Phase 5.7-1 Repair: fixed in-page observation script. MUST be self-contained
 * (Playwright serializes the function source; no closures, no outer
 * references). Emits BOTH channels from one deterministic walk:
 *
 *  - `nodes`: meaningful elements in document order with an engine-assigned
 *    stable ref attribute (`data-ai-se-ref`), so an observed ref doubles as an
 *    action selector.
 *  - `tree`: serialized accessibility-style tree (role + accessible name,
 *    indentation by DOM depth). It NEVER carries raw form-field values —
 *    Playwright's own aria snapshot renders textbox values (observed leaking
 *    password values verbatim), so the observation derives its tree here where
 *    value exposure is controlled structurally.
 *
 * Sensitive-input isolation (structural, not regex): inputs with
 * `type=password` or credential-semantic `autocomplete` tokens
 * (current-password / new-password / one-time-code / *password*) never expose
 * their value in ANY channel — the value stays in the page; the node carries a
 * marker with `hasValue` instead. Ordinary inputs remain observable.
 * Credential-SHAPED content in ordinary elements is still covered by the
 * shared redaction sink applied to every emitted string in the session.
 */
const OBSERVATION_SNAPSHOT_SCRIPT = (): {
  nodes: Array<{ ref: string; role: string; name: string; clickable: boolean; text: string }>;
  tree: string;
} => {
  const MAX_NODES = 2000;
  const MAX_TEXT = 2000;
  const MAX_NAME = 300;
  const nodes: Array<{ ref: string; role: string; name: string; clickable: boolean; text: string }> = [];
  const lines: string[] = [];
  const interactiveRoles: Record<string, boolean> = {
    button: true,
    link: true,
    textbox: true,
    checkbox: true,
    radio: true,
    switch: true,
    combobox: true,
    listbox: true,
    option: true,
    menuitem: true,
    menuitemcheckbox: true,
    menuitemradio: true,
    tab: true,
    slider: true,
    spinbutton: true,
    searchbox: true
  };
  const tagRoles: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    SUMMARY: "button",
    IMG: "img",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    LABEL: "label",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    FORM: "form",
    DIALOG: "dialog",
    TABLE: "table",
    LI: "listitem"
  };
  const inputRoles: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    button: "button",
    submit: "button",
    reset: "button",
    search: "searchbox",
    number: "spinbutton"
  };
  const skipTags: Record<string, boolean> = {
    SCRIPT: true,
    STYLE: true,
    HEAD: true,
    META: true,
    LINK: true,
    TITLE: true,
    NOSCRIPT: true
  };
  const credentialAutocomplete = (raw: string | null): boolean => {
    if (!raw) return false;
    const token = raw.trim().toLowerCase();
    return token.indexOf("password") >= 0 || token === "one-time-code";
  };
  const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim();
  const elements = document.querySelectorAll("*");
  let counter = 0;
  for (let index = 0; index < elements.length && nodes.length < MAX_NODES; index += 1) {
    const el = elements[index];
    const tag = el.tagName;
    if (skipTags[tag]) continue;
    // Not rendered (display:none subtree has no client rects) or hidden.
    if (el.getClientRects().length === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility !== "visible") continue;
    if (el.getAttribute("aria-hidden") === "true") continue;

    let role = el.getAttribute("role") || "";
    if (!role && tag === "INPUT") {
      role = inputRoles[el.type || "text"] || "textbox";
    }
    if (!role) role = tagRoles[tag] || "";
    if (role === "hidden") continue;

    const clickable =
      tag === "BUTTON" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "SUMMARY" ||
      tag === "OPTION" ||
      tag === "INPUT" ||
      (tag === "A" && Boolean(el.href)) ||
      (role !== "" && interactiveRoles[role] === true) ||
      el.tabIndex >= 0;

    // Structural sensitive-input isolation: credential semantics, not regex.
    const isFormField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const sensitive =
      isFormField &&
      ((tag === "INPUT" && el.type === "password") ||
        credentialAutocomplete(el.getAttribute("autocomplete")));

    const isHeading = /^H[1-6]$/.test(tag);
    const leaf = el.children.length === 0;
    const needsText = clickable || isHeading || leaf;
    const text = needsText ? singleLine(el.innerText || el.textContent || "") : "";
    let value = "";
    if (isFormField) {
      value = String(el.value || "");
    }
    const ariaLabel = el.getAttribute("aria-label") || "";
    const placeholder = el.placeholder || "";
    const alt = tag === "IMG" ? el.alt || "" : "";

    const include =
      clickable ||
      Boolean(el.getAttribute("role")) ||
      tag === "IMG" ||
      isHeading ||
      (leaf && (text.length > 0 || value.length > 0));
    if (!include) continue;

    counter += 1;
    const refValue = `r${counter}`;
    el.setAttribute("data-ai-se-ref", refValue);

    let nodeName: string;
    let nodeText: string;
    if (sensitive) {
      // The raw value NEVER leaves the page for credential-semantic fields.
      const kind =
        tag === "INPUT" && el.type === "password"
          ? "password input"
          : `credential-like ${tag.toLowerCase()}`;
      nodeName = singleLine(ariaLabel || placeholder || kind).slice(0, MAX_NAME);
      nodeText = `[value hidden: ${kind}; hasValue: ${value.length > 0}]`;
    } else {
      nodeName = singleLine(ariaLabel || placeholder || alt || value || text).slice(0, MAX_NAME);
      nodeText = (text || value).slice(0, MAX_TEXT);
    }
    nodes.push({
      ref: `[data-ai-se-ref="${refValue}"]`,
      role: role || "generic",
      name: nodeName,
      clickable,
      text: nodeText
    });

    // Accessibility-style tree line: structure only — form-field values (of
    // any kind) never appear here; sensitive fields get a presence marker.
    let depth = 0;
    let cursor = el.parentElement;
    while (cursor && cursor !== document.body) {
      depth += 1;
      cursor = cursor.parentElement;
    }
    const indent = "  ".repeat(depth > 20 ? 20 : depth);
    const renderedRole = role || "generic";
    const quotedName = singleLine(ariaLabel || placeholder || alt || (sensitive ? "" : text))
      .slice(0, MAX_NAME)
      .replace(/"/g, "'");
    let line = `${indent}- ${renderedRole}`;
    if (quotedName) line += ` "${quotedName}"`;
    if (sensitive) line += value.length > 0 ? " [value hidden]" : " [value absent]";
    lines.push(line);
  }
  return { nodes, tree: lines.join("\n") };
};

/** Phase 5.7-1 observation draft (validated against 5.7-0 at the tool layer). */
export interface ObservationSnapshot {
  url: string;
  dom?: { nodes: BrowserDomNode[] };
  accessibility?: { tree: string; interactiveCount: number };
}

export interface ObserveOptions {
  /** Include the DOM snapshot (default true). */
  dom?: boolean;
  /** Include the accessibility snapshot (default true). */
  accessibility?: boolean;
  /** DOM node cap after slicing (1..2000, default 500). */
  maxNodes?: number;
}

/** Roles counted as interactive in the accessibility tree text. */
const A11Y_INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "searchbox"
]);

const MAX_A11Y_TREE_LENGTH = 200_000; // frozen 5.7-0 cap
const TRUNCATION_MARKER = "\n…[truncated]";

function countInteractiveRoles(tree: string): number {
  let count = 0;
  for (const line of tree.split("\n")) {
    const match = /^\s*-\s+([a-zA-Z]+)/.exec(line);
    if (match && A11Y_INTERACTIVE_ROLES.has(match[1])) count += 1;
  }
  return count;
}

export class BrowserSession {
  private browser: BrowserLike | null = null;
  private context: ContextLike | null = null;
  private page: PageLike | null = null;
  private readonly allowlist: NavigateAllowlist;
  private readonly playwright: PlaywrightLike;
  readonly sessionId: string;
  private consoleEntries: ConsoleEntry[] = [];
  private networkErrors: NetworkErrorEntry[] = [];
  private seq = 0;
  private screenshotCount = 0;
  private closed = false;
  private consoleErrorsSinceScreenshot = 0;
  private networkErrorsSinceScreenshot = 0;

  constructor(options: BrowserSessionOptions) {
    this.playwright = options.playwright;
    this.allowlist = options.navigateAllowlist;
    this.sessionId = options.sessionId ?? `browser:${Date.now()}:${++SESSION_COUNTER}`;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  async launch(options?: { headless?: boolean }): Promise<LaunchResult> {
    if (this.closed) throw new BrowserError("BROWSER_CLOSED", "session already closed");
    if (this.browser) throw new BrowserError("BROWSER_CLOSED", "already launched");
    const headless = options?.headless ?? true;
    try {
      const browser = await this.playwright.chromium.launch({ headless });
      this.browser = browser;
      const context = await browser.newContext();
      this.context = context;
      const page = await context.newPage();
      this.page = page;
      page.on("console", (message: ConsoleMessageLike) => {
        const level = message.type() === "error" ? "error" : message.type() === "warning" ? "warning" : null;
        if (!level) return;
        this.seq += 1;
        this.consoleEntries.push({
          seq: this.seq,
          level,
          text: redactCredentialShapedText(message.text()),
          url: redactCredentialShapedText(message.location()?.url ?? ""),
          timestamp: new Date().toISOString()
        });
        if (level === "error") this.consoleErrorsSinceScreenshot += 1;
      });
      // Phase 5.6-3 Repair: real transport-failure capture. Reason text comes
      // from Playwright (`net::ERR_*`); URLs may carry credential-shaped
      // query values, so both fields pass the shared redaction sink.
      page.on("requestfailed", (request: RequestLike) => {
        const reason = request.failure()?.errorText ?? "unknown request failure";
        // Chromium emits net::ERR_ABORTED when the CLIENT cancels a request
        // (navigation away, parser-aborted subresource after an error
        // response). That is not a network fault — recording it would
        // double-count real errors already captured by the response listener.
        if (reason === "net::ERR_ABORTED") return;
        this.pushNetworkError({
          kind: "requestfailed",
          status: null,
          url: request.url(),
          method: request.method?.() ?? "",
          reason
        });
      });
      // Phase 5.6-3 Repair: real HTTP error capture (4xx/5xx responses,
      // including the main navigation document).
      page.on("response", (response: ResponseLike) => {
        const status = response.status();
        if (status < 400) return;
        this.pushNetworkError({
          kind: status >= 500 ? "http_5xx" : "http_4xx",
          status,
          url: response.url(),
          method: response.request?.()?.method?.() ?? "",
          reason: `HTTP ${status}`
        });
      });
    } catch (error) {
      throw new BrowserError(
        "BROWSER_NAV_FAILED",
        // ponytail: swallow cause details — Playwright errors may embed env paths.
        `chromium launch failed: ${error instanceof Error ? "internal error" : "unknown"}`
      );
    }
    return { sessionId: this.sessionId, headless };
  }

  async goto(
    rawUrl: string,
    options?: { timeoutMs?: number }
  ): Promise<{ finalUrl: string; status: number | null }> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    if (!isNavigationAllowed(rawUrl, this.allowlist)) {
      throw new BrowserError("BROWSER_INPUT_INVALID", `url not allowed by protocol allowlist: ${redactCredentialShapedText(rawUrl)}`);
    }
    const timeout = options?.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    let result: NavigationResult | null;
    try {
      result = await this.page.goto(rawUrl, { timeout, waitUntil: "load" });
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", `navigation failed: ${redactCredentialShapedText(rawUrl)}`);
    }
    // data:/about: navigations legitimately return a null Response object
    // (Playwright behavior). The page DID navigate — treat as opaque success.
    const finalUrl = result?.url() ?? rawUrl;
    const status = result?.status() ?? null;
    return { finalUrl, status };
  }

  /**
   * Frozen settled check (5.6-3 prompt §三.2): after load, wait networkidle
   * (500ms quiet) with a hard cap (RENDER_HARD_TIMEOUT_MS); .settled tells
   * 5.6-4 whether the shot is fully stable.
   */
  async waitForRender(): Promise<{ settled: "networkidle" | "timeout"; elapsedMs: number }> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    const startedAt = Date.now();
    try {
      await this.page.waitForLoadState("networkidle", { timeout: RENDER_HARD_TIMEOUT_MS });
      return { settled: "networkidle", elapsedMs: Date.now() - startedAt };
    } catch {
      // Hard-cap path: return, never throw (5.6-4 needs the frame anyway).
      return { settled: "timeout", elapsedMs: Date.now() - startedAt };
    }
  }

  async setViewport(width: number, height: number): Promise<{ applied: true }> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    // shared VisualViewportSchema range: int 1..20000
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 20_000 || height > 20_000) {
      throw new BrowserError("BROWSER_INPUT_INVALID", `viewport out of range: ${width}x${height}`);
    }
    await this.page.setViewportSize({ width, height });
    return { applied: true };
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<ScreenshotAsset> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    const fullPage = options?.fullPage ?? false;
    let buffer: Buffer;
    try {
      buffer = await this.page.screenshot({ fullPage });
    } catch {
      throw new BrowserError("BROWSER_RENDER_TIMEOUT", "screenshot failed (render unstable?)");
    }
    this.screenshotCount += 1;
    const consoleErrorCount = this.consoleErrorsSinceScreenshot;
    this.consoleErrorsSinceScreenshot = 0;
    const networkErrorCount = this.networkErrorsSinceScreenshot;
    this.networkErrorsSinceScreenshot = 0;
    return {
      buffer,
      base64: buffer.toString("base64"),
      mimeType: "image/png",
      takenAt: new Date().toISOString(),
      consoleErrorCountSinceLast: consoleErrorCount,
      networkErrorCountSinceLast: networkErrorCount,
      seq: this.screenshotCount,
      fullPage
    };
  }

  /** Controlled interaction (5.6-6 seed). CSS selector only — no scheme URLs. */
  async click(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.click(selector, { timeout: options?.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS });
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", `click failed on ${redactCredentialShapedText(selector)}`);
    }
  }

  async type(selector: string, text: string): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.fill(selector, text);
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", `type failed on ${redactCredentialShapedText(selector)}`);
    }
  }

  /**
   * Phase 5.6-6: controlled :hover — real pointer move, real CSS
   * pseudo-class. Screenshot while hovered; move the pointer elsewhere via
   * `hover` on another element to revert.
   */
  async hover(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.hover(selector, { timeout: options?.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS });
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", `hover failed on ${redactCredentialShapedText(selector)}`);
    }
  }

  /** Phase 5.6-6: controlled :focus — DOM focus, real CSS pseudo-class. */
  async focus(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.focus(selector, { timeout: options?.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS });
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", `focus failed on ${redactCredentialShapedText(selector)}`);
    }
  }

  /**
   * Phase 5.6-6: press-and-hold for CSS :active. `hover` first positions the
   * pointer over the element center (no bounding-box math), then the button
   * stays down — screenshot while held, then `mouseUp()`.
   */
  async mouseDown(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.hover(selector, { timeout: options?.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS });
      await this.page.mouse.down();
    } catch {
      throw new BrowserError(
        "BROWSER_NAV_FAILED",
        `mouseDown failed on ${redactCredentialShapedText(selector)}`
      );
    }
  }

  /** Phase 5.6-6: release a held pointer (ends :active). */
  async mouseUp(): Promise<void> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    try {
      await this.page.mouse.up();
    } catch {
      throw new BrowserError("BROWSER_NAV_FAILED", "mouseUp failed");
    }
  }

  /** Phase 5.7-1: current page URL (context for action refs / observations). */
  currentUrl(): string {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    return this.page.url();
  }

  /**
   * Phase 5.7-1 Repair: one observation pass from a single fixed script —
   * DOM nodes (credential-semantic fields structurally masked) and the
   * accessibility-style tree (structure only; no raw field values, so it can
   * not leak what the DOM channel masks). Credential-shaped content on every
   * emitted string still passes the shared redaction sink; the tree is
   * truncated to the frozen 5.7-0 cap. Base64 never rides along — images stay
   * behind screenshot:// refs (5.6-3 pipeline).
   */
  async observe(options?: ObserveOptions): Promise<ObservationSnapshot> {
    if (this.closed || !this.page) throw new BrowserError("BROWSER_CLOSED", "session is closed");
    const includeDom = options?.dom ?? true;
    const includeAccessibility = options?.accessibility ?? true;
    const maxNodes = Math.min(Math.max(options?.maxNodes ?? 500, 1), 2000);
    const snapshot: ObservationSnapshot = { url: this.page.url() };
    if (!includeDom && !includeAccessibility) return snapshot;
    let raw: { nodes: BrowserDomNode[]; tree: string };
    try {
      raw = await this.page.evaluate(OBSERVATION_SNAPSHOT_SCRIPT);
    } catch {
      throw new BrowserError("BROWSER_RENDER_TIMEOUT", "observation snapshot failed");
    }
    if (includeDom) {
      snapshot.dom = {
        nodes: raw.nodes.slice(0, maxNodes).map((node) => ({
          ref: node.ref,
          role: node.role,
          name: redactCredentialShapedText(node.name),
          clickable: node.clickable,
          text: redactCredentialShapedText(node.text)
        }))
      };
    }
    if (includeAccessibility) {
      let tree = redactCredentialShapedText(raw.tree);
      if (tree.length > MAX_A11Y_TREE_LENGTH) {
        tree = tree.slice(0, MAX_A11Y_TREE_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
      }
      snapshot.accessibility = { tree, interactiveCount: countInteractiveRoles(tree) };
    }
    return snapshot;
  }

  /**
   * Phase 5.6-3 Repair: single sink for network evidence — one seq space with
   * console entries (session-scoped), redacted, counted for the next
   * screenshot anchor. 4xx/5xx and transport failures share this shape.
   */
  private pushNetworkError(input: {
    kind: NetworkErrorKind;
    status: number | null;
    url: string;
    method: string;
    reason: string;
  }): void {
    this.seq += 1;
    this.networkErrors.push({
      seq: this.seq,
      kind: input.kind,
      status: input.status,
      url: redactCredentialShapedText(input.url),
      method: input.method,
      reason: redactCredentialShapedText(input.reason),
      timestamp: new Date().toISOString()
    });
    this.networkErrorsSinceScreenshot += 1;
  }

  getErrors(sinceSeq = 0): { console: ConsoleEntry[]; network: NetworkErrorEntry[] } {
    return {
      console: this.consoleEntries.filter((entry) => entry.seq > sinceSeq),
      network: this.networkErrors.filter((entry) => entry.seq > sinceSeq)
    };
  }

  /** Deterministic assetRef (5.6-3 naming rule). */
  assetRefFor(asset: { seq: number; fullPage: boolean }): string {
    return `screenshot://${this.sessionId}/${asset.seq}${asset.fullPage ? "-fullpage" : ""}.png`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.page?.close();
    } catch {
      // ponytail: teardown must never throw even if the page is already dead.
    }
    try {
      await this.context?.close();
    } catch {
      /* same */
    }
    try {
      await this.browser?.close();
    } catch {
      /* same */
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
