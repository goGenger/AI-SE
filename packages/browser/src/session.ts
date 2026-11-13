/**
 * Phase 5.6-3 BrowserSession: the ONLY module in @ai-se/browser allowed to
 * import Playwright (adapter). Everything else sees this interface.
 *
 * ponytail: no retry logic, no context pooling, no download support — nice
 * thing about 1 Chromium instance is there's nothing to pool. Add when
 * profiling says otherwise.
 */
export type PlaywrightLike = {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<BrowserLike>;
  };
};

export interface BrowserLike {
  newContext(options?: object): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** Phase 5.6-6: mouse press/release control (CSS :active while held). */
export interface MouseLike {
  down(): Promise<void>;
  up(): Promise<void>;
}

/** Phase 5.7-1: one DOM observation node (draft shape; the frozen 5.7-0
 * DomSnapshot schema is validated at the tool layer). */
export interface BrowserDomNode {
  /** Engine-generated stable selector for the node in this snapshot. */
  ref: string;
  role: string;
  name: string;
  clickable: boolean;
  text: string;
}

export interface PageLike {
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" }
  ): Promise<NavigationResult>;
  waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number }
  ): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, options?: { timeout?: number }): Promise<void>;
  /** Phase 5.6-6: real pointer move (CSS :hover) and DOM focus (CSS :focus). */
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  focus(selector: string, options?: { timeout?: number }): Promise<void>;
  mouse: MouseLike;
  /** Phase 5.7-1: current page URL (sync in Playwright). */
  url(): string;
  /** Phase 5.7-1: run a FIXED, self-contained page function (observation
   * scripts only — never caller-controlled code). */
  evaluate<R>(pageFunction: () => R): Promise<R>;
  on(event: "console", listener: (message: ConsoleMessageLike) => void): void;
  on(event: "requestfailed", listener: (request: RequestLike) => void): void;
  on(event: "response", listener: (response: ResponseLike) => void): void;
  close(): Promise<void>;
}

export interface ConsoleMessageLike {
  type(): string;
  text(): string;
  location(): { url?: string };
}

export interface RequestLike {
  url(): string;
  failure(): { errorText: string } | null;
  /** Optional for interface back-compat; Playwright always provides both. */
  method?(): string;
  resourceType?(): string;
}

/** Phase 5.6-3 Repair: response event shape (HTTP status detection). */
export interface ResponseLike {
  url(): string;
  status(): number;
  request(): RequestLike;
}

export interface NavigationResult {
  url: () => string;
  status: () => number | null;
}

/** Constants frozen by the 5.6-3 prompt (§三.2 / §三.6). */
export const RENDER_IDLE_MS = 500;
export const RENDER_HARD_TIMEOUT_MS = 3_000;
export const DEFAULT_NAV_TIMEOUT_MS = 15_000;

/** shared allowed source protocols for navigation (url:// semantics aligned). */
export interface NavigateAllowlist {
  /** Empty/absent = deny all (5.6-0 rule). Special: ["data:", "file:"] for fixtures. */
  allowedProtocols: string[];
  allowedHosts?: string[];
}

export function isNavigationAllowed(
  url: string,
  allowlist: NavigateAllowlist
): boolean {
  // Scheme-only URLs (data:, about:) and scheme:// both parse; protocol gate only.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/.*)?/.exec(url);
  if (!match) return false;
  const protocol = match[1].toLowerCase();
  return allowlist.allowedProtocols.includes(protocol);
}
