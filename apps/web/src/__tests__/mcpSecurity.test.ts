import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

/**
 * Phase 5.5-5 — "No browser direct MCP connection" (source-level guard).
 *
 * The console must talk to the AI-SE backend REST API only. This test walks
 * the whole frontend source tree (raw text via Vite) and fails if any file:
 *   - imports the MCP SDK or the MCP runtime package,
 *   - references MCP client classes or protocol operations,
 *   - persists MCP data into browser storage.
 * It also asserts the web package has no MCP dependencies.
 */

const SELF = "mcpSecurity.test.ts";

const rawSources = import.meta.glob("../**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

const sourceFiles = Object.entries(rawSources)
  .map(([file, text]) => ({ file, text }))
  .filter(({ file }) => !file.endsWith(SELF));

/**
 * Production sources only: security LITERAL assertions (storage APIs, sandbox
 * tokens) must target shipped code — the scan/tests themselves mention those
 * tokens by design.
 */
const productionFiles = sourceFiles.filter(({ file }) => !/\.test\.ts$/.test(file));

const mcpRuntimeFiles = productionFiles.filter(({ file }) =>
  /mcp/i.test(file.split("/").pop() ?? "")
);

describe("no direct browser MCP access", () => {
  it("never imports the MCP SDK or the MCP runtime package", () => {
    for (const { file, text } of sourceFiles) {
      expect(text, file).not.toMatch(/["']@modelcontextprotocol/);
      expect(text, file).not.toMatch(/["']@ai-se\/mcp["']/);
    }
  });

  it("never uses MCP clients or protocol operations", () => {
    for (const { file, text } of sourceFiles) {
      expect(text, file).not.toMatch(/\bMCPClient(Port)?\b/);
      expect(text, file).not.toMatch(/\b(StdioMCPClient|RemoteMCPClient)\b/);
      expect(text, file).not.toMatch(/\b(callTool|listTools)\s*\(/);
      expect(text, file).not.toMatch(/\bStreamableHTTP/);
    }
  });

  it("keeps MCP data out of browser storage", () => {
    expect(mcpRuntimeFiles.length).toBeGreaterThan(0);
    for (const { file, text } of mcpRuntimeFiles) {
      expect(text, file).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(text, file).not.toMatch(/\b(access_token|password|api[_-]?key|client[_-]?secret)\b/i);
    }
  });

  it("has no MCP dependencies in package.json", () => {
    const names = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {})
    ];
    expect(names.filter((name) => /^@modelcontextprotocol\//.test(name))).toEqual([]);
    expect(names).not.toContain("@ai-se/mcp");
  });

  it("renders MCP apps in a minimal sandbox (Phase 5.5-7)", () => {
    // No production file may weaken the sandbox for app frames.
    for (const { file, text } of productionFiles) {
      expect(text, file).not.toMatch(/allow-same-origin/);
      expect(text, file).not.toMatch(/allow-top-navigation/);
      expect(text, file).not.toMatch(/allow-popups/);
    }

    const view = productionFiles.find(({ file }) => file.endsWith("MCPAppView.vue"));
    expect(view).toBeDefined();
    // The frame must be srcdoc + the shared constant sandbox (never inline).
    expect(view!.text).toContain(':sandbox="MCP_APP_SANDBOX"');
    expect(view!.text).toContain(':srcdoc="srcdoc"');

    const bridge = productionFiles.find(({ file }) => file.endsWith("mcpAppBridge.ts"));
    expect(bridge).toBeDefined();
    expect(bridge!.text).toContain('export const MCP_APP_SANDBOX = "allow-scripts"');
  });

  it("talks to the backend REST API only", () => {
    const api = sourceFiles.find(({ file }) => file.endsWith("api/mcp.ts"));
    expect(api).toBeDefined();
    expect(api!.text).toContain("/api/mcp/servers");
    // Every MCP network call goes through the shared REST helper.
    expect(api!.text).toMatch(/fetch\(`\$\{API_BASE_URL\}/);
  });
});
