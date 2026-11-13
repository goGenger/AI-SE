import {
  ActionPolicy,
  applyActionPolicy,
  BROWSER_ACTION_POLICY,
  defaultActionPolicy
} from "@ai-se/action-policy";
import { ToolRuntime, type ToolDefinition, type ToolExecutionContext } from "@ai-se/tool-runtime";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  BrowserSession,
  COMPUTER_USE_BROWSER_TOOLS,
  createRealPlaywright,
  type NavigateAllowlist
} from "../index";

/**
 * Phase 5.7-3 REAL e2e (browser side): the unified Action Policy governs
 * Browser Actions with the SAME semantics as external actions — risk comes
 * from the platform table (never from arguments/metadata), policy-applied
 * definitions carry the decision into ToolRuntime audit, spoofed-low inputs
 * are rejected, and the shared approval gate works for browser actions too
 * (demonstrated with a platform-raise scenario). Real Chromium, data: fixture,
 * zero external network.
 */

const ALLOW_DATA: NavigateAllowlist = { allowedProtocols: ["data"] };

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();

const FIXTURE = `data:text/html,${encodeURIComponent(
  `<html><body>
     <h1>Policy fixture</h1>
     <button id="go">go</button>
     <span id="n">0</span>
     <script>
       document.getElementById("go").addEventListener("click", function () {
         var n = document.getElementById("n");
         n.textContent = String(Number(n.textContent) + 1);
       });
     </script>
   </body></html>`
)}`;

function makeContext(
  session: BrowserSession,
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-policy-browser",
    taskId: "task-policy-1",
    agentRunId: "run-policy-1",
    toolCallId: `call-${Math.random().toString(36).slice(2, 10)}`,
    actor: "policy-browser-e2e",
    workspacePath: process.cwd(),
    sandbox: {
      async runCommand() {
        throw new Error("browser policy tests never touch the sandbox");
      }
    },
    session,
    ...overrides
  } as unknown as ToolExecutionContext;
}

describe("5.7-3 browser action risk comes from the unified policy", () => {
  it("every computer-use tool carries the policy decision as its risk level", () => {
    for (const tool of COMPUTER_USE_BROWSER_TOOLS) {
      const decision = defaultActionPolicy.resolveBrowser(tool.name);
      expect(decision, tool.name).toBeDefined();
      expect(tool.riskLevel, tool.name).toBe(decision?.riskLevel);
      expect(decision?.requiresApproval, tool.name).toBe(false);
    }
    expect(
      Object.fromEntries(COMPUTER_USE_BROWSER_TOOLS.map((tool) => [tool.name, tool.riskLevel]))
    ).toEqual({
      "browser.observe": "LOW",
      "browser.action.navigate": "LOW",
      "browser.action.click": "MEDIUM",
      "browser.action.type": "MEDIUM",
      "browser.action.screenshot": "LOW"
    });
  });

  it("unknown browser actions and spoofed-low declarations deny at composition time", () => {
    expect(defaultActionPolicy.resolveBrowser("browser.action.evaluate")).toBeUndefined();
    expect(() =>
      applyActionPolicy([{ ...COMPUTER_USE_BROWSER_TOOLS[2], name: "browser.action.evaluate" }], {
        source: "browser"
      })
    ).toThrow(/unknown browser action/);
    expect(() =>
      applyActionPolicy([{ ...COMPUTER_USE_BROWSER_TOOLS[2], riskLevel: "LOW" }], {
        source: "browser"
      })
    ).toThrow(/below the policy decision MEDIUM/);
  });
});

describe.skipIf(!BROWSER_AVAILABLE)("5.7-3 policy enforcement e2e (real Chromium)", () => {
  it("policy-applied definitions run through ToolRuntime with policy audit; spoofed-low input rejected with zero action", async () => {
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_DATA,
      sessionId: "browser:policy:1"
    });
    await session.launch({ headless: true });
    await session.setViewport(1280, 720);
    const tools = applyActionPolicy(
      [...COMPUTER_USE_BROWSER_TOOLS] as ToolDefinition<unknown, unknown>[],
      { source: "browser" }
    );
    const runtime = new ToolRuntime({ tools });
    const context = makeContext(session);
    try {
      const nav = await runtime.execute("browser.action.navigate", { url: FIXTURE }, context);
      expect(nav.success).toBe(true);
      expect(nav.audit.riskLevel).toBe("LOW");

      const click = await runtime.execute("browser.action.click", { selector: "#go" }, context);
      expect(click.success).toBe(true);
      expect(click.audit.riskLevel).toBe("MEDIUM");

      // Tool arguments cannot declare a risk level: strict schema rejects.
      const spoof = await runtime.execute(
        "browser.action.click",
        { selector: "#go", riskLevel: "LOW" },
        context
      );
      expect(spoof.success).toBe(false);
      expect(spoof.error?.code).toBe("TOOL_ERROR");

      // Exactly ONE click happened: the page counter span reads 1.
      const observed = await runtime.execute("browser.observe", {}, context);
      expect(observed.success).toBe(true);
      const observation = observed.data as import("@ai-se/shared").Observation;
      expect(observation.dom?.nodes.find((node) => node.role === "generic")?.text).toBe("1");
      expect(observed.audit.riskLevel).toBe("LOW");
    } finally {
      await session.close();
    }
  }, 180_000);

  it("the shared approval gate applies to browser actions too: unapproved → zero browser action; approved → runs", async () => {
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_DATA,
      sessionId: "browser:policy:2"
    });
    await session.launch({ headless: true });
    await session.setViewport(1280, 720);
    // Platform-raise scenario: the policy marks navigate HIGH + approval; the
    // platform declares the same. (Production keeps navigate LOW — this
    // demonstrates the source-agnostic approval semantics.)
    const policy = new ActionPolicy({
      browserActions: {
        ...BROWSER_ACTION_POLICY,
        "browser.action.navigate": { riskLevel: "HIGH", requiresApproval: true }
      }
    });
    const raised = COMPUTER_USE_BROWSER_TOOLS.map((tool) =>
      tool.name === "browser.action.navigate" ? { ...tool, riskLevel: "HIGH" as const } : tool
    );
    const tools = applyActionPolicy(raised as ToolDefinition<unknown, unknown>[], {
      source: "browser",
      policy
    });
    const runtime = new ToolRuntime({ tools });
    try {
      const denied = await runtime.execute(
        "browser.action.navigate",
        { url: FIXTURE },
        makeContext(session)
      );
      expect(denied.success).toBe(false);
      expect(denied.error?.message).toContain("requires human approval");
      expect(denied.audit.riskLevel).toBe("HIGH");
      // Zero browser action: the session never left the blank page.
      expect(session.currentUrl()).toBe("about:blank");

      const approved = await runtime.execute(
        "browser.action.navigate",
        { url: FIXTURE },
        makeContext(session, { metadata: { approved: true } })
      );
      expect(approved.success).toBe(true);
      expect(session.currentUrl()).toBe(FIXTURE);
    } finally {
      await session.close();
    }
  }, 180_000);
});
