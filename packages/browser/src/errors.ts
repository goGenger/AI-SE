/**
 * Phase 5.6-3: self-contained error codes for the browser domain (style
 * aligned with @ai-se/visual errors.ts — never wraps/forwards raw Playwright
 * error objects).
 */
export type BrowserErrorCode =
  | "BROWSER_TIMEOUT"
  | "BROWSER_NAV_FAILED"
  | "BROWSER_RENDER_TIMEOUT"
  | "BROWSER_CLOSED"
  | "BROWSER_INPUT_INVALID";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}
