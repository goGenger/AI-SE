import type { ActionResult, Observation } from "@ai-se/shared";
import { ObservationSchema } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallStartedRecord,
  type ToolExecutionContext
} from "@ai-se/tool-runtime";
import { createServer } from "node:http";
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
 * Phase 5.7-1 REAL e2e: Browser Computer Use over actual Chromium, driven
 * ONLY through ToolRuntime (the Agent→ToolRuntime→BrowserTool→BrowserSession→
 * Playwright path — Playwright never appears in this file). Flow: navigate →
 * observe → click/type → observe → screenshot → navigate, plus the governance
 * envelopes (invalid input / timeout / cancellation) and ToolRuntime audit.
 * data: URL fixtures — zero external network. Skips (DEGRADED) without
 * Chromium assets.
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

const PAGE_ONE = `data:text/html,${encodeURIComponent(
  `<html><body>
     <h1>AI-SE CU Fixture</h1>
     <button id="counter" aria-label="Increment counter">count: <span id="n">0</span></button>
     <label for="name">Name</label>
     <input id="name" placeholder="your name">
     <span id="secret">sk-live1234567890abcdef</span>
     <div id="panel" role="alert" style="display:none">panel revealed</div>
     <script>
       document.getElementById("counter").addEventListener("click", function () {
         var n = document.getElementById("n");
         n.textContent = String(Number(n.textContent) + 1);
         document.getElementById("panel").style.display = "block";
       });
     </script>
   </body></html>`
)}`;

const PAGE_TWO = `data:text/html,${encodeURIComponent(
  `<html><body><h1>Second Page</h1><a href="#again">Back</a></body></html>`
)}`;

const PAGE_SENSITIVE_HTML = `<html><body>
     <h1>Security fixture</h1>
     <input id="pw" type="password" placeholder="enter secret" value="ArbitraryP@ss-007">
     <input id="otp" autocomplete="one-time-code" value="918273">
     <input id="newpw" autocomplete="new-password" value="hunter2-arbitrary">
     <input id="plain" placeholder="plain field" value="visible-ok">
     <input id="cred" value="sk-live1234567890abcdef">
     <textarea id="ta">sk-live1234567890abcdef</textarea>
     <textarea id="ta-notes">plain notes are observable</textarea>
   </body></html>`;

function makeRecorder() {
  const started: ToolCallStartedRecord[] = [];
  const finished: ToolCallFinishedRecord[] = [];
  const toolCallRecorder = {
    async recordToolCallStarted(record: ToolCallStartedRecord) {
      started.push(record);
    },
    async recordToolCallFinished(record: ToolCallFinishedRecord) {
      finished.push(record);
    }
  };
  return { toolCallRecorder, started, finished };
}

interface Harness {
  session: BrowserSession;
  runtime: ToolRuntime;
  context: ToolExecutionContext;
  started: ToolCallStartedRecord[];
  finished: ToolCallFinishedRecord[];
}

async function startHarness(sessionId: string): Promise<Harness> {
  const session = new BrowserSession({
    playwright: createRealPlaywright(),
    navigateAllowlist: ALLOW_DATA,
    sessionId
  });
  await session.launch({ headless: true });
  await session.setViewport(1280, 720);
  const { toolCallRecorder, started, finished } = makeRecorder();
  return {
    session,
    runtime: new ToolRuntime({ tools: [...COMPUTER_USE_BROWSER_TOOLS] }),
    context: {
      requestId: "req-cu-1",
      taskId: "task-cu-1",
      agentRunId: "run-cu-1",
      toolCallId: "call-cu-1",
      actor: "computer-use-e2e",
      workspacePath: process.cwd(),
      sandbox: {
        async runCommand() {
          throw new Error("browser computer-use tests never touch the sandbox");
        }
      },
      toolCallRecorder,
      session
    } as unknown as ToolExecutionContext,
    started,
    finished
  };
}

describe.skipIf(!BROWSER_AVAILABLE)("5.7-1 REAL Chromium computer-use e2e", () => {
  it(
    "navigate → observe → click/type → observe → screenshot → navigate (all via ToolRuntime)",
    async () => {
      const harness = await startHarness("browser:cu:1");
      try {
        const { runtime, context } = harness;

        // navigate → ActionResult with a post-action observation.
        const nav = await runtime.execute("browser.action.navigate", { url: PAGE_ONE }, context);
        expect(nav.success).toBe(true);
        const navResult = nav.data as ActionResult;
        expect(navResult.status).toBe("success");
        expect(navResult.actionRef).toMatchObject({
          source: "browser",
          sessionId: "browser:cu:1",
          toolName: "browser.action.navigate"
        });
        if (navResult.actionRef.source === "browser") {
          expect(navResult.actionRef.target.startsWith("data:text/html")).toBe(true);
        }
        // The fixture embeds a credential-shaped token in its data: URL — the
        // actionRef target must not carry it verbatim into agent-visible state.
        expect(JSON.stringify(navResult)).not.toContain("sk-live1234567890abcdef");
        expect(
          navResult.observation?.dom?.nodes.some((node) => node.text.includes("AI-SE CU Fixture"))
        ).toBe(true);

        // observe → strict 5.7-0 Observation (DOM + accessibility).
        const observed = await runtime.execute("browser.observe", {}, context);
        expect(observed.success).toBe(true);
        const observation = observed.data as Observation;
        expect(observation.dom?.nodes.some((node) => node.role === "button" && node.clickable)).toBe(
          true
        );
        expect(observation.accessibility?.interactiveCount).toBeGreaterThanOrEqual(2);
        expect(observation.accessibility?.tree ?? "").toContain("button");

        // Credential-shaped page content is redacted inside the observation.
        const serialized = JSON.stringify(observation);
        expect(serialized).toContain("[REDACTED]");
        expect(serialized).not.toContain("sk-live1234567890abcdef");

        // click → the post-action observation shows the real DOM change.
        const clicked = await runtime.execute("browser.action.click", { selector: "#counter" }, context);
        expect(clicked.success).toBe(true);
        const clickResult = clicked.data as ActionResult;
        expect(clickResult.status).toBe("success");
        expect(
          clickResult.observation?.dom?.nodes.some((node) => node.text.includes("count: 1"))
        ).toBe(true);

        // type → ActionResult; a FRESH observe reads the typed value back.
        const typed = await runtime.execute(
          "browser.action.type",
          { selector: "#name", text: "hello ai-se" },
          context
        );
        expect((typed.data as ActionResult).status).toBe("success");
        const reobserved = await runtime.execute("browser.observe", {}, context);
        const nodes = (reobserved.data as Observation).dom?.nodes ?? [];
        expect(nodes.some((node) => node.text.includes("hello ai-se"))).toBe(true);

        // screenshot → ActionResult whose observation carries the 5.6-3 ref
        // (and never base64).
        const shot = await runtime.execute("browser.action.screenshot", {}, context);
        expect(shot.success).toBe(true);
        const shotResult = shot.data as ActionResult;
        expect(shotResult.status).toBe("success");
        expect(shotResult.observation?.screenshotRef).toBe("screenshot://browser:cu:1/1.png");
        expect(JSON.stringify(shotResult)).not.toContain("base64");

        // navigate again → second page visible in the post-action observation.
        const nav2 = await runtime.execute("browser.action.navigate", { url: PAGE_TWO }, context);
        const nav2Result = nav2.data as ActionResult;
        expect(nav2Result.status).toBe("success");
        expect(
          nav2Result.observation?.dom?.nodes.some((node) => node.text.includes("Second Page"))
        ).toBe(true);

        // ToolRuntime audit trail: every call recorded start→finish, succeeded.
        expect(harness.finished.map((record) => record.status)).toEqual([
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded"
        ]);
        expect(harness.started[1].toolName).toBe("browser.observe");
      } finally {
        await harness.session.close();
      }
    },
    180_000
  );

  it(
    "governance: invalid input / unknown tool / timeout / cancellation surface as ToolRuntime envelopes",
    async () => {
      const harness = await startHarness("browser:cu:2");
      try {
        const { runtime, context } = harness;

        const invalid = await runtime.execute("browser.action.click", {}, context);
        expect(invalid.success).toBe(false);
        expect(invalid.error?.code).toBe("TOOL_ERROR");

        const unknown = await runtime.execute("browser.not-a-tool", {}, context);
        expect(unknown.success).toBe(false);
        expect(unknown.error?.code).toBe("TOOL_ERROR");

        const badSelector = await runtime.execute(
          "browser.action.click",
          { selector: "javascript:alert(1)" },
          context
        );
        expect(badSelector.success).toBe(false);
        expect(badSelector.error?.code).toBe("TOOL_ERROR");

        await runtime.execute("browser.action.navigate", { url: PAGE_ONE }, context);

        // timeout: the click cannot resolve; the runtime's timeout kills it.
        const timed = await runtime.execute(
          "browser.action.click",
          { selector: "#never-appears" },
          { ...context, timeoutMs: 300 } as unknown as ToolExecutionContext
        );
        expect(timed.success).toBe(false);
        expect(timed.error?.code).toBe("TIMEOUT_ERROR");

        // pre-cancelled signal.
        const preCancelledController = new AbortController();
        preCancelledController.abort();
        const preCancelled = await runtime.execute(
          "browser.action.click",
          { selector: "#counter" },
          { ...context, signal: preCancelledController.signal } as unknown as ToolExecutionContext
        );
        expect(preCancelled.success).toBe(false);
        expect(preCancelled.error?.code).toBe("CANCELLED_ERROR");

        // mid-flight cancellation.
        const controller = new AbortController();
        const pending = runtime.execute(
          "browser.action.click",
          { selector: "#never-appears" },
          { ...context, signal: controller.signal, timeoutMs: 10_000 } as unknown as ToolExecutionContext
        );
        setTimeout(() => controller.abort(), 150);
        const cancelled = await pending;
        expect(cancelled.success).toBe(false);
        expect(cancelled.error?.code).toBe("CANCELLED_ERROR");

        const statuses = harness.finished.map((record) => record.status);
        expect(statuses).toContain("timed_out");
        expect(statuses).toContain("cancelled");
        expect(statuses.filter((status) => status === "succeeded").length).toBe(1); // the navigate
        const timeoutRecord = harness.finished.find((record) => record.status === "timed_out");
        expect(timeoutRecord).toBeDefined();
        const timeoutStarted = harness.started.find(
          (record) => record.toolCallId === timeoutRecord?.toolCallId
        );
        expect(timeoutStarted?.toolName).toBe("browser.action.click");
      } finally {
        await harness.session.close();
      }
    },
    180_000
  );

  it(
    "observation security: credential-semantic fields are structurally masked in both channels",
    async () => {
      const server = createServer((req, res) => {
        if (req.url === "/favicon.ico") {
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE_SENSITIVE_HTML);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no port");
      const session = new BrowserSession({
        playwright: createRealPlaywright(),
        navigateAllowlist: { allowedProtocols: ["http"] },
        sessionId: "browser:cu:sec"
      });
      await session.launch({ headless: true });
      await session.setViewport(1280, 720);
      const { toolCallRecorder, finished } = makeRecorder();
      const runtime = new ToolRuntime({ tools: [...COMPUTER_USE_BROWSER_TOOLS] });
      const context = {
        requestId: "req-cu-sec",
        taskId: "task-cu-sec",
        agentRunId: "run-cu-sec",
        toolCallId: "call-cu-sec",
        actor: "computer-use-security-e2e",
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("browser computer-use tests never touch the sandbox");
          }
        },
        toolCallRecorder,
        session
      } as unknown as ToolExecutionContext;
      try {
        const nav = await runtime.execute(
          "browser.action.navigate",
          { url: `http://127.0.0.1:${address.port}/secure` },
          context
        );
        expect(nav.success).toBe(true);
        const navResult = nav.data as ActionResult;
        expect(navResult.actionRef).toMatchObject({
          target: `http://127.0.0.1:${address.port}/secure`
        });
        for (const secret of ["ArbitraryP@ss-007", "918273", "hunter2-arbitrary", "sk-live1234567890abcdef"]) {
          expect(JSON.stringify(nav), `navigate result leaked ${secret}`).not.toContain(secret);
        }

        const observed = await runtime.execute("browser.observe", {}, context);
        expect(observed.success).toBe(true);
        const observation = observed.data as Observation;
        expect(ObservationSchema.parse(observation)).toEqual(observation);
        const nodes = observation.dom?.nodes ?? [];
        const tree = observation.accessibility?.tree ?? "";

        // 1. Raw secrets never appear — in the observation, the tool result
        // (data + audit) or the accessibility tree.
        for (const secret of [
          "ArbitraryP@ss-007", // arbitrary password value (regex-invisible — structural fix)
          "918273", // one-time-code
          "hunter2-arbitrary", // new-password
          "sk-live1234567890abcdef" // credential-shaped plain content
        ]) {
          const observationJson = JSON.stringify(observation);
          expect(observationJson, `observation leaked ${secret}`).not.toContain(secret);
          expect(JSON.stringify(observed), `tool result leaked ${secret}`).not.toContain(secret);
          expect(tree, `a11y tree leaked ${secret}`).not.toContain(secret);
        }
        // Credential-SHAPED content in ordinary elements is still redacted
        // (shared sink), the structural mask covers the rest.
        expect(JSON.stringify(observation)).toContain("[REDACTED]");

        // 2. Sensitive fields are masked WITH presence info (type / role /
        // name / hasValue — never the value).
        const passwordNode = nodes.find((node) => node.name === "enter secret");
        expect(passwordNode?.text).toBe("[value hidden: password input; hasValue: true]");
        expect(passwordNode?.role).toBe("textbox");
        expect(passwordNode?.clickable).toBe(true);
        const otpNode = nodes.find(
          (node) => node.text === "[value hidden: credential-like input; hasValue: true]" && node.name === "credential-like input"
        );
        expect(otpNode).toBeDefined();
        const newPwNodes = nodes.filter(
          (node) => node.text === "[value hidden: credential-like input; hasValue: true]"
        );
        expect(newPwNodes.length).toBe(2); // one-time-code + new-password
        // Tree carries presence markers, never values.
        expect(tree).toContain("[value hidden]");

        // 3. Ordinary inputs stay observable (value shown in the DOM channel).
        const plainNode = nodes.find((node) => node.name === "plain field");
        expect(plainNode?.text).toBe("visible-ok");
        // The tree is structure-only: no field values at all in that channel.
        expect(tree).toContain('textbox "plain field"');
        expect(tree).not.toContain("visible-ok");
        expect(nodes.some((node) => node.text.includes("plain notes are observable"))).toBe(true);

        // 4. screenshotRef is unaffected by the masking work.
        const shot = await runtime.execute("browser.action.screenshot", {}, context);
        const shotResult = shot.data as ActionResult;
        expect(shotResult.status).toBe("success");
        expect(shotResult.observation?.screenshotRef).toBe("screenshot://browser:cu:sec/1.png");

        // 5. Audit records (ToolCallRecorder payloads) are clean of raw values.
        const auditJson = JSON.stringify(finished);
        for (const secret of ["ArbitraryP@ss-007", "918273", "hunter2-arbitrary", "sk-live1234567890abcdef"]) {
          expect(auditJson, `audit leaked ${secret}`).not.toContain(secret);
        }
      } finally {
        await session.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    180_000
  );
});
