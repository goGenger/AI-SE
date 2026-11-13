/**
 * Phase 5.6-5 Repair E2E: the REAL Auto Fix loop over production paths.
 *
 *   Visual Issue → Fix Task → Frontend Agent → ToolRuntime → Docker Sandbox
 *   → Code Change → Build/Test → Browser Runtime → Candidate Screenshot
 *   → Visual Evaluation (reference screenshot vs candidate screenshot)
 *   → RESOLVED / NEW_ISSUE / REGRESSED
 *
 * Real everywhere except the LLM and the VLM double:
 *  - the agent runs through ProfessionalAgent + ToolRuntime; code changes land
 *    in a Docker-mounted workspace and build/test run inside the sandbox;
 *  - Chromium renders the live dev server and captures REAL screenshots;
 *  - the candidate side handed to the frozen 5.6-4 `evaluateVisuals` is
 *    derived from those screenshot BYTES (decoded and scanned row by row — a
 *    deterministic screenshot-analysis double standing in for a real VLM),
 *    never from parsing the page HTML;
 *  - the reference side is the same pipeline over the reference screenshot;
 *  - the three-state outcome comes only from the re-evaluation, never from the
 *    agent's self-report.
 *
 * The fixture draws each section as a full-width colored band (#112233 Header,
 * #445566 Body, #778899 Footer), so the double detects sections from actual
 * rendered pixels.
 *
 * Scenarios:
 *   A  1 round resolved                      → RESOLVED → DONE
 *   B  wrong fix (new issue) then real fix   → NEW_ISSUE → RESOLVED → DONE
 *   D  identical wrong fix twice             → STALLED → human handoff
 *   E  new issue → regression → max rounds   → MAX_ROUNDS → human handoff
 */
import {
  AgentRegistry,
  ProfessionalAgent,
  ScriptedDeepAgentModel,
  type FrontendWorkspaceConventions,
  type ScriptedAgentStep
} from "@ai-se/agent-core";
import { BrowserSession, createRealPlaywright } from "@ai-se/browser";
import { DockerSandbox } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import {
  buildAnalysisReport,
  buildSpecification,
  collectWarnings,
  decodeMinimalPng,
  type EvaluationSide
} from "@ai-se/visual";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runVisualFixLoop,
  type CandidateAnalysis,
  type CandidateAnalysisInput,
  type VisualFixLoopResult
} from "../services/visualFixLoop";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();

const FIXTURE_SOURCE = path.resolve(process.cwd(), "../../examples/visual-fix-test-project");
const VIEWPORT = { width: 1440, height: 900 };
const PAGE_FILE = "apps/web/src/pages/fixture-page.js";
const CONVENTIONS: FrontendWorkspaceConventions = {
  appRoot: "apps/web",
  componentsDir: "apps/web/src/components",
  tokensFile: "apps/web/src/tokens.css",
  pagesDir: "apps/web/src/pages",
  assetsDir: "apps/web/src/assets",
  buildCommand: "node scripts/build.mjs",
  testCommand: "node --test tests/*.test.mjs"
};

/** Fixture section palette (band color → section name). */
const SECTION_COLOR_NAMES: Record<string, string> = {
  "#112233": "Header",
  "#445566": "Body",
  "#778899": "Footer"
};

function sectionNameFor(hex: string): string {
  return SECTION_COLOR_NAMES[hex] ?? `Color-${hex.replace("#", "")}`;
}

const PAGE_BACKGROUND = "#ffffff";

/**
 * Deterministic screenshot-analysis double (stands in for a real VLM): decodes
 * the candidate/reference screenshot bytes and reports one section per band of
 * constant non-background color, scanning the vertical center column row by
 * row. The 5.6-1 post-processing pipeline (normalize + frozen schema) runs
 * unchanged over the resulting observation.
 */
function analyzeScreenshotBands(input: CandidateAnalysisInput): CandidateAnalysis {
  const decoded = decodeMinimalPng(Buffer.from(input.base64, "base64"));
  if (decoded.width !== input.viewport.width || decoded.height !== input.viewport.height) {
    throw new Error(
      `screenshot size ${decoded.width}x${decoded.height} != viewport ${input.viewport.width}x${input.viewport.height}`
    );
  }
  const { width, height } = decoded;
  const centerX = Math.floor(width / 2);
  const bands: Array<{ color: string; start: number; end: number }> = [];
  let current: { color: string; start: number; end: number } | null = null;
  for (let y = 0; y < height; y += 1) {
    const index = (y * width + centerX) * 4;
    const hex = `#${[decoded.rgba[index], decoded.rgba[index + 1], decoded.rgba[index + 2]]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
    if (hex === PAGE_BACKGROUND) {
      current = null;
      continue;
    }
    if (current && current.color === hex) {
      current.end = y;
      continue;
    }
    current = { color: hex, start: y, end: y };
    bands.push(current);
  }

  const sections = bands
    .filter((band) => band.end - band.start + 1 >= 8)
    .map((band) => {
      const name = sectionNameFor(band.color);
      return {
        name,
        rect: { x: 0, y: band.start, width, height: band.end - band.start + 1 },
        elements: [{ name, role: "other" as const }]
      };
    });

  const record = {
    inputType: "screenshot" as const,
    source: input.assetRef,
    viewport: input.viewport
  };
  const specification = buildSpecification(
    { pageName: "Fixture Page", sections, warnings: [] },
    record
  );
  const analysis = buildAnalysisReport(
    specification,
    [],
    collectWarnings(specification, []),
    new Date().toISOString()
  );
  return { record, specification, analysis, knownGapSections: [] };
}

/** Page module source: renders the given body verbatim. */
function moduleSource(body: string): string {
  return `export function renderFixturePage() {\n  return \`${body}\`;\n}\n`;
}

/** The agent's tool script for one round (deterministic LLM double). */
function fixSteps(content: string): ScriptedAgentStep[] {
  return [
    { toolName: "read_file", input: { file_path: PAGE_FILE } },
    { toolName: "write_file", input: { file_path: PAGE_FILE, content } },
    { toolName: "run_build", input: { command: CONVENTIONS.buildCommand, cwd: CONVENTIONS.appRoot } },
    {
      toolName: "run_unit_test",
      input: { command: CONVENTIONS.testCommand, cwd: CONVENTIONS.appRoot }
    }
  ];
}

interface FixtureServer {
  base: string;
  port: number;
  stop: () => Promise<void>;
}

function startFixtureServer(workspacePath: string): Promise<FixtureServer> {
  const child: ChildProcess = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: path.join(workspacePath, "apps/web")
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("fixture server did not start")), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /PORT=(\d+)/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      const port = Number(match[1]);
      resolve({
        base: `http://127.0.0.1:${port}`,
        port,
        stop: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGTERM");
          })
      });
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error("fixture server exited early")));
  });
}

interface ScenarioRun {
  result: VisualFixLoopResult;
  reference: EvaluationSide;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function runScenario(roundBodies: string[]): Promise<ScenarioRun> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-se-fix-loop-"));
  const workspacePath = path.join(tempRoot, "workspace");
  await cp(FIXTURE_SOURCE, workspacePath, { recursive: true });
  const server = await startFixtureServer(workspacePath);
  const sandbox = new DockerSandbox({
    allowedWorkspaceRoot: tempRoot,
    limits: { timeoutMs: 45_000, network: "none", cpus: 1, memory: "512m", pidsLimit: 1024 }
  });
  const toolRuntime = new ToolRuntime({ tools: createPhase1Tools() });
  const browser = new BrowserSession({
    playwright: createRealPlaywright(),
    navigateAllowlist: { allowedProtocols: ["http"] },
    sessionId: `browser:fix-loop:${Date.now()}`
  });
  const cleanup = async (): Promise<void> => {
    await browser.close();
    await server.stop();
    await rm(tempRoot, { recursive: true, force: true });
  };
  try {
    await browser.launch({ headless: true });
    await browser.setViewport(VIEWPORT.width, VIEWPORT.height);

    // Reference (design target): REAL reference screenshot → screenshot
    // analysis double → reference EvaluationSide.
    await browser.goto(`${server.base}/reference.html`);
    await browser.waitForRender();
    const referenceShot = await browser.screenshot();
    const referenceInfo = analyzeScreenshotBands({
      round: 0,
      assetRef: browser.assetRefFor(referenceShot),
      base64: referenceShot.base64,
      viewport: VIEWPORT
    });
    const reference: EvaluationSide = {
      record: referenceInfo.record,
      base64: referenceShot.base64,
      analysis: referenceInfo.analysis,
      specification: referenceInfo.specification,
      knownGapSections: []
    };

    const definition = new AgentRegistry().get("frontend-agent");
    const result = await runVisualFixLoop({
      createFixAgent: (round) =>
        new ProfessionalAgent({
          definition,
          model: new ScriptedDeepAgentModel({
            steps: fixSteps(moduleSource(roundBodies[round - 1] ?? roundBodies.at(-1) ?? ""))
          }),
          toolRuntime,
          defaultTimeoutMs: 120_000
        }),
      toolRuntime,
      sandbox,
      workspacePath,
      actor: "vitest",
      projectId: "project-visual-fix-loop",
      browser,
      pageUrl: `${server.base}/`,
      reference,
      analyzeCandidateScreenshot: async (input) => analyzeScreenshotBands(input),
      conventions: CONVENTIONS,
      viewportName: "desktop",
      agentRunOptions: { maxIterations: 12, timeoutMs: 120_000 }
    });
    return { result, reference, workspacePath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function goldenBody(): Promise<string> {
  return await readFile(path.join(FIXTURE_SOURCE, "apps/web/reference/design.body.html"), "utf8");
}

describe.skipIf(!runDockerTests || !BROWSER_AVAILABLE)(
  "Phase 5.6-5 Repair visual fix loop (real Agent / Sandbox / Browser / screenshot Evaluation)",
  () => {
    it("A: one round implements the design and RESOLVES from screenshot re-evaluation", async () => {
      const scenario = await runScenario([await goldenBody()]);
      try {
        const { result, reference } = scenario;
        // Reference screenshot is real evidence (not a spec substitute).
        expect(reference.base64.length).toBeGreaterThan(1_000);

        // Initial screenshot evaluation found the real issue (missing band).
        expect(result.initial.issues.map((issue) => issue.issueId)).toContain(
          "issue:desktop:section:body:2"
        );

        expect(result.state.status).toBe("DONE");
        expect(result.state.rounds.map((round) => round.outcome)).toEqual(["RESOLVED"]);
        expect(result.handoff.required).toBe(false);

        const round = result.rounds[0];
        // Fix Task → Frontend Agent: the submitted draft is the REAL 5.6-2
        // converter output for the missing section, now actually submitted.
        expect(round.submitted).toMatchObject({
          taskKey: "visual:fixture-page:2",
          pageFile: PAGE_FILE,
          autoSubmitted: true
        });
        // Agent → ToolRuntime → Sandbox: every step is a real tool result.
        const toolNames = round.agent?.toolCalls.map((call) => call.toolName) ?? [];
        expect(toolNames).toEqual(
          expect.arrayContaining(["read_file", "write_file", "run_build", "run_unit_test"])
        );
        expect(round.agent?.toolCalls.every((call) => call.success)).toBe(true);
        expect(round.codeChanges).toEqual([
          { tool: "write_file", path: PAGE_FILE, bytes: expect.any(Number) }
        ]);
        expect(round.build.ok).toBe(true);
        expect(round.test.ok).toBe(true);

        // Candidate screenshot → evaluation pairing: the 5.6-4 report was
        // produced from the captured screenshot bytes scored against the
        // reference screenshot.
        expect(round.browser?.assetRef).toMatch(/^screenshot:\/\//);
        expect(round.browser?.bytes ?? 0).toBeGreaterThan(1_000);
        expect(round.browser?.networkErrors).toBe(0);
        expect(round.evaluation).toMatchObject({
          score: "PASS",
          outcome: "RESOLVED"
        });
        expect(round.evaluation?.candidateSource).toBe(round.browser?.assetRef);
        expect(round.evaluation?.referenceSource).toBe(reference.record.source);
        expect(round.evaluation?.resolvedIssues).toContain("issue:desktop:section:body:2");
        expect(round.status).toBe("DONE");

        // Real code change on disk: exactly the design body, nothing else touched.
        const pageSource = await readFile(path.join(scenario.workspacePath, PAGE_FILE), "utf8");
        expect(pageSource).toBe(moduleSource(await goldenBody()));
        // Audit trail is serializable and records the submission.
        expect(result.audits).toHaveLength(1);
        expect(result.audits[0]).toContain("outcome: RESOLVED");
        expect(result.audits[0]).toContain("autoSubmitted: true");
      } finally {
        await scenario.cleanup();
      }
    }, 300_000);

    it("B: a wrong fix raises a NEW_ISSUE from the screenshots, the next round resolves it", async () => {
      const wrongFooterBody = `\n<div style="width:100%;height:60px;background:#112233"></div>\n<div style="width:100%;height:60px;background:#778899"></div>\n`;
      const scenario = await runScenario([wrongFooterBody, await goldenBody()]);
      try {
        const { result } = scenario;
        expect(result.state.status).toBe("DONE");
        expect(result.state.rounds.map((round) => round.outcome)).toEqual([
          "NEW_ISSUE",
          "RESOLVED"
        ]);
        expect(result.handoff.required).toBe(false);

        // Round 1: the wrong section is detected as a NEW visual issue from
        // the screenshot comparison (never from the agent's self-report).
        expect(result.rounds[0].evaluation?.newIssues).toContain("issue:desktop:section:footer:2");
        expect(result.rounds[0].evaluation?.score).toBe("COMPONENT");
        expect(result.rounds[0].evaluation?.candidateSource).toMatch(/^screenshot:\/\//);
        // Round 2: the real fix resolves everything (screenshot score PASS).
        expect(result.rounds[1].evaluation?.score).toBe("PASS");
        expect(result.rounds[1].evaluation?.resolvedIssues).toEqual(
          expect.arrayContaining([
            "issue:desktop:section:body:2",
            "issue:desktop:section:footer:2"
          ])
        );
        // Round 2 was driven by the issue left over from round 1.
        expect(result.rounds[1].issues.map((issue) => issue.issueId)).toEqual(
          expect.arrayContaining(["issue:desktop:section:body:2", "issue:desktop:section:footer:2"])
        );
      } finally {
        await scenario.cleanup();
      }
    }, 300_000);

    it("D: identical non-progressing rounds STALL and hand off to human/re-plan", async () => {
      const wrongFooterBody = `\n<div style="width:100%;height:60px;background:#112233"></div>\n<div style="width:100%;height:60px;background:#778899"></div>\n`;
      const scenario = await runScenario([wrongFooterBody, wrongFooterBody]);
      try {
        const { result } = scenario;
        // Two identical non-resolving outcomes → STALLED before maxRounds(3).
        expect(result.state.status).toBe("STALLED");
        expect(result.state.rounds.map((round) => round.outcome)).toEqual([
          "NEW_ISSUE",
          "NEW_ISSUE"
        ]);
        expect(result.state.rounds).toHaveLength(2);

        // No-progress detection: round 2 sees the same unchanged issues.
        const second = result.rounds[1].evaluation;
        expect(second?.unchangedIssues).toEqual(
          expect.arrayContaining([
            "issue:desktop:section:body:2",
            "issue:desktop:section:footer:2"
          ])
        );
        expect(second?.newIssues).toEqual([]);
        expect(second?.resolvedIssues).toEqual([]);

        // Human / workflow boundary: existing workflow vocabulary only.
        expect(result.handoff).toEqual({
          required: true,
          workflowStatus: "WAITING_APPROVAL",
          failureStrategy: "REPLAN",
          reason: expect.stringContaining("no visual progress")
        });
      } finally {
        await scenario.cleanup();
      }
    }, 300_000);

    it("E: regression detection and the max-rounds cap end with a human handoff", async () => {
      const wrongFooterBody = `\n<div style="width:100%;height:60px;background:#112233"></div>\n<div style="width:100%;height:60px;background:#778899"></div>\n`;
      // Rounds 2-3 make the footer band visually huge (kept wrong on purpose):
      // the score worsens without new issue ids, then stops progressing.
      const giantBody = `\n<div style="width:100%;height:60px;background:#112233"></div>\n<div style="width:100%;height:820px;background:#778899"></div>\n`;
      const scenario = await runScenario([wrongFooterBody, giantBody, giantBody]);
      try {
        const { result } = scenario;
        expect(result.state.rounds.map((round) => round.outcome)).toEqual([
          "NEW_ISSUE",
          "REGRESSED",
          "NEW_ISSUE"
        ]);
        expect(result.state.status).toBe("MAX_ROUNDS");
        expect(result.state.maxRounds).toBe(3);

        // REGRESSED: the screenshot score got strictly worse (LAYOUT) while
        // nothing improved and no new issue ids appeared.
        expect(result.rounds[0].evaluation?.score).toBe("COMPONENT");
        expect(result.rounds[1].evaluation?.score).toBe("LAYOUT");
        expect(result.rounds[1].evaluation?.newIssues).toEqual([]);
        expect(result.rounds[1].evaluation?.candidateSource).toMatch(/^screenshot:\/\//);

        // Human / workflow boundary with the existing vocabulary.
        expect(result.handoff.required).toBe(true);
        expect(result.handoff.workflowStatus).toBe("WAITING_APPROVAL");
        expect(result.handoff.failureStrategy).toBe("REPLAN");
        expect(result.handoff.reason).toContain("maxRounds");
        expect(result.audits).toHaveLength(3);
      } finally {
        await scenario.cleanup();
      }
    }, 300_000);
  }
);
