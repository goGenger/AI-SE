/**
 * Phase 5.7-1 e2e: the AGENT-side boundary for Browser Computer Use.
 *
 *   Agent permissions → ToolRuntimeBackend → ToolRuntime → Browser Tool
 *   → BrowserSession → Playwright (never imported here)
 *
 * Verifies that the existing agent-tool permission gate (AgentPermissions.tools,
 * the 5.5-era mechanism — no second permission system) governs the computer-use
 * tools: denied tools never execute; permitted ones run through the frozen
 * ToolRuntime with audit records. Also statically asserts that agent-core has
 * no direct Playwright / browser dependency. Real Chromium, data: fixture,
 * zero external network.
 */
import { ToolRuntimeBackend, type AgentContext, type AgentPermissions } from "@ai-se/agent-core";
import { BrowserSession, COMPUTER_USE_BROWSER_TOOLS, createRealPlaywright, type NavigateAllowlist } from "@ai-se/browser";
import type { Observation } from "@ai-se/shared";
import {
  ToolRuntime,
  type ToolCallFinishedRecord,
  type ToolCallStartedRecord
} from "@ai-se/tool-runtime";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  `<html><body><h1>Agent-path fixture</h1><button id="go">go</button></body></html>`
)}`;

interface Recorder {
  started: ToolCallStartedRecord[];
  finished: ToolCallFinishedRecord[];
}

function makeRecorder(): { recorder: Recorder; api: { recordToolCallStarted(r: ToolCallStartedRecord): Promise<void>; recordToolCallFinished(r: ToolCallFinishedRecord): Promise<void> } } {
  const recorder: Recorder = { started: [], finished: [] };
  return {
    recorder,
    api: {
      async recordToolCallStarted(record) {
        recorder.started.push(record);
      },
      async recordToolCallFinished(record) {
        recorder.finished.push(record);
      }
    }
  };
}

describe.skipIf(!BROWSER_AVAILABLE)("5.7-1 agent-path e2e: permissions gate computer-use tools", () => {
  it(
    "denied tools never execute; permitted tools run through the backend with audit",
    async () => {
      const session = new BrowserSession({
        playwright: createRealPlaywright(),
        navigateAllowlist: ALLOW_DATA,
        sessionId: "browser:cu-agent:1"
      });
      await session.launch({ headless: true });
      await session.setViewport(1280, 720);
      const { recorder, api } = makeRecorder();
      const runtime = new ToolRuntime({ tools: [...COMPUTER_USE_BROWSER_TOOLS] });
      const context = {
        requestId: "req-agent-1",
        taskId: "task-agent-1",
        agentRunId: "run-agent-1",
        actor: "computer-use-agent",
        workspacePath: process.cwd(),
        sandbox: {
          async runCommand() {
            throw new Error("browser computer-use tests never touch the sandbox");
          }
        },
        session
      } as unknown as AgentContext;
      try {
        // 1. Tool NOT granted → the existing permission gate denies it.
        const deniedBackend = new ToolRuntimeBackend({
          runtime,
          permissions: { tools: ["read_file"], readPaths: [], writePaths: [] } as AgentPermissions,
          context
        });
        const denied = await deniedBackend.executeTool("browser.observe", {});
        expect(denied.success).toBe(false);
        expect(denied.error?.message).toContain("not permitted");
        // The denied call must not have reached the runtime/audit.
        expect(recorder.started).toHaveLength(0);

        // 2. Tool granted → real navigation + observation through the backend.
        const grantedBackend = new ToolRuntimeBackend({
          runtime,
          permissions: {
            tools: ["browser.action.navigate", "browser.observe"],
            readPaths: [],
            writePaths: []
          } as AgentPermissions,
          context,
          toolCallRecorder: api
        });
        const nav = await grantedBackend.executeTool("browser.action.navigate", { url: FIXTURE });
        expect(nav.success).toBe(true);
        const observed = await grantedBackend.executeTool("browser.observe", {});
        expect(observed.success).toBe(true);
        const observation = observed.data as Observation;
        expect(observation.actionRef.source).toBe("browser");
        expect(
          observation.dom?.nodes.some((node) => node.text.includes("Agent-path fixture"))
        ).toBe(true);

        // 3. Audit: both granted calls were recorded start → finish.
        expect(recorder.started.map((record) => record.toolName)).toEqual([
          "browser.action.navigate",
          "browser.observe"
        ]);
        expect(recorder.finished.map((record) => record.status)).toEqual([
          "succeeded",
          "succeeded"
        ]);
      } finally {
        await session.close();
      }
    },
    180_000
  );
});

describe("5.7-1 boundary: agent code has no direct Playwright / browser dependency", () => {
  it("agent-core never imports playwright or @ai-se/browser", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const grep = spawnSync(
      "grep",
      ["-rn", "playwright\\|@ai-se/browser", "packages/agent-core/src", "--include=*.ts"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    const matches = (grep.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(matches).toEqual([]);
  });
});
