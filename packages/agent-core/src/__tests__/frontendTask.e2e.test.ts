/**
 * Phase 5.6-2 Repair E2E: UI Specification → Frontend Task → Frontend Agent →
 * REAL code change → build / run validation.
 *
 * The chain under test uses production code on every hop:
 *   FakeVLMProvider → VisualAnalyzer → VisualSpecification
 *   → buildFrontendTasks → attachDesignTokens (frozen FrontendTaskDraft)
 *   → buildFrontendAgentTask → ProfessionalAgent(frontend-agent definition)
 *   → ToolRuntime (file tools + run_build/run_unit_test) → DockerSandbox
 *   → real files in a mounted workspace → real node build + node --test.
 *
 * The LLM is the deterministic FrontendTaskModel (test stand-in); every tool
 * call, file write, command and permission check is real.
 */
import {
  attachDesignTokens,
  buildFrontendTasks,
  FakeVLMProvider,
  VisualAnalyzer
} from "@ai-se/visual";
import { DockerSandbox } from "@ai-se/sandbox";
import { ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import type { VisualInputRecord } from "@ai-se/shared";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../professional/AgentRegistry";
import { buildFrontendAgentTask } from "../professional/frontendTask";
import { FrontendTaskModel } from "../professional/FrontendTaskModel";
import { ProfessionalAgent } from "../professional/ProfessionalAgent";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

const execFileAsync = promisify(execFile);

const FIXTURE_SOURCE = path.resolve(
  process.cwd(),
  "../../examples/frontend-task-test-project"
);
const PAGE_FILE = "apps/web/src/pages/fixture-page.js";
const MARKER_PAYLOAD =
  'page:"Fixture Page" color:#1533ff font:14 radius:12 icon:logo button:submit image:avatar';

function screenshotRecord(): VisualInputRecord {
  return {
    inputType: "screenshot",
    source: "screenshot://fixtures/fixture-page.png",
    viewport: { width: 1440, height: 900 },
    assetRef: MARKER_PAYLOAD
  };
}

/** Real 5.6-1 + 5.6-2 chain: analysis → drafts → tokens attached. */
async function frontendDraft(knownComponents: string[]) {
  const outcome = await new VisualAnalyzer(new FakeVLMProvider()).analyzeFull(screenshotRecord());
  const { tasks, componentMap } = buildFrontendTasks(outcome.specification, { knownComponents });
  const enriched = attachDesignTokens(tasks, outcome.tokenFindings);
  return { draft: enriched[0], componentMap, outcome };
}

/** Component names actually present on disk (drives knownComponents). */
async function diskComponents(workspacePath: string): Promise<string[]> {
  const entries = await readdir(path.join(workspacePath, "apps/web/src/components"));
  return entries
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => entry.replace(/\.js$/, ""))
    .sort();
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        const content = await readFile(absolute);
        files.set(path.relative(root, absolute), createHash("sha256").update(content).digest("hex"));
      }
    }
  };
  await walk(root);
  return files;
}

function agentContext(workspacePath: string, sandbox: DockerSandbox, runId: string) {
  return {
    requestId: `req-${runId}`,
    projectId: "project-frontend-e2e",
    taskId: `task-${runId}`,
    agentRunId: runId,
    actor: "vitest",
    workspacePath,
    sandbox
  };
}

describe.skipIf(!runDockerTests)("Phase 5.6-2 Repair frontend task Docker E2E", () => {
  it("implements the visual task through the real agent path and passes build + tests", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-se-frontend-e2e-"));
    const workspacePath = path.join(tempRoot, "workspace");
    await cp(FIXTURE_SOURCE, workspacePath, { recursive: true });

    try {
      const knownComponents = await diskComponents(workspacePath);
      expect(knownComponents).toEqual(["Button", "Input"]);

      const { draft, componentMap } = await frontendDraft(knownComponents);
      expect(draft.taskKey).toBe("visual:fixture-page:1");
      expect(draft.instructions.sections[0].styleTokens.length).toBeGreaterThan(0);
      expect(componentMap[0].some((entry) => entry.matched && entry.componentName === "Button")).toBe(
        true
      );
      expect(componentMap[0].some((entry) => !entry.matched && entry.unmatchedReason)).toBe(true);

      const task = buildFrontendAgentTask(draft);
      const before = await snapshot(workspacePath);

      const sandbox = new DockerSandbox({
        allowedWorkspaceRoot: tempRoot,
        limits: { timeoutMs: 45_000, network: "none", cpus: 1, memory: "512m", pidsLimit: 1024 }
      });
      const toolRuntime = new ToolRuntime({ tools: createPhase1Tools() });
      const definition = new AgentRegistry().get("frontend-agent");
      const agent = new ProfessionalAgent({
        definition,
        model: new FrontendTaskModel(),
        toolRuntime,
        defaultTimeoutMs: 180_000
      });

      const result = await agent.run(
        task,
        agentContext(workspacePath, sandbox, "run-frontend-e2e"),
        { maxIterations: 20, timeoutMs: 180_000 }
      );

      // ── Agent outcome ─────────────────────────────────────────────────────
      expect(result.professionalResult?.status).toBe("SUCCESS");
      const byName = (name: string) => result.toolResults.filter((entry) => entry.toolName === name);
      expect(byName("list_directory").length).toBeGreaterThanOrEqual(2);
      expect(byName("read_file").length).toBeGreaterThanOrEqual(2);
      expect(byName("write_file")).toHaveLength(1);
      expect(byName("write_file")[0].success).toBe(true);
      expect(byName("run_build")[0].success).toBe(true);
      expect(byName("run_unit_test")[0].success).toBe(true);
      const metadata = result.professionalResult?.metadata ?? {};
      expect(metadata.reusedComponents).toContain("Button");
      expect(metadata.missingComponents).toContain("Icon");
      const artifactTypes = (result.professionalResult?.artifacts ?? []).map(
        (artifact) => artifact.type
      );
      expect(artifactTypes).toEqual(
        expect.arrayContaining(["GENERATED_FILE", "BUILD_RESULT", "TEST_RESULT"])
      );

      // ── Real code change on the mounted workspace ────────────────────────
      const pageSource = await readFile(path.join(workspacePath, PAGE_FILE), "utf8");
      const section = draft.instructions.sections[0];
      expect(pageSource).toContain(`data-section-id="${section.sectionId}"`);
      expect(pageSource).toContain(
        `data-rect="${section.rect.x},${section.rect.y},${section.rect.width},${section.rect.height}"`
      );
      expect(pageSource).toContain(`<h2>${section.title}</h2>`);
      expect(pageSource).toContain('import { Button } from "../components/Button.js";');
      for (const token of section.styleTokens) {
        expect(pageSource).toContain(`var(--${token.namespace}-${token.name})`);
      }
      expect(pageSource).toContain('src="../assets/logo.svg"');
      expect(pageSource).toContain('alt="avatar: image"');

      // Token values used by the page match the project tokens file.
      const tokensCss = await readFile(
        path.join(workspacePath, "apps/web/src/tokens.css"),
        "utf8"
      );
      const primary = section.styleTokens.find((token) => token.name === "primary");
      expect(primary?.value).toBe("#1533ff");
      expect(tokensCss).toContain(`--colors-primary: ${primary?.value};`);

      // ── Targeted change: nothing else touched ────────────────────────────
      const after = await snapshot(workspacePath);
      const added = [...after.keys()].filter((file) => !before.has(file));
      const changed = [...after.keys()].filter(
        (file) => before.has(file) && before.get(file) !== after.get(file)
      );
      expect(added).toEqual([PAGE_FILE]);
      expect(changed).toEqual([]);
      const indexSource = await readFile(
        path.join(workspacePath, "apps/web/src/pages/index.js"),
        "utf8"
      );
      expect(indexSource).toContain('data-page="index"');

      // ── Independent verification outside the agent ───────────────────────
      const independentContext = {
        ...agentContext(workspacePath, sandbox, "run-frontend-verify"),
        toolCallId: "tool-frontend-verify"
      };
      const buildCheck = await toolRuntime.execute(
        "run_build",
        { command: `node scripts/build.mjs`, cwd: "apps/web", timeoutMs: 45_000 },
        independentContext
      );
      expect(buildCheck.success).toBe(true);
      const testCheck = await toolRuntime.execute(
        "run_unit_test",
        { command: `node --test tests/*.test.mjs`, cwd: "apps/web", timeoutMs: 45_000 },
        independentContext
      );
      expect(testCheck.success).toBe(true);

      // ── The page really renders (native node child process) ──────────────
      const runnerFile = path.join(tempRoot, "render-check.mjs");
      await writeFile(
        runnerFile,
        [
          'import { pathToFileURL } from "node:url";',
          "const mod = await import(pathToFileURL(process.argv[2]).href);",
          "const name = Object.keys(mod).find((k) => /^render/.test(k));",
          "if (!name) throw new Error('no render* export');",
          "process.stdout.write(mod[name]());"
        ].join("\n")
      );
      const { stdout: rendered } = await execFileAsync(process.execPath, [
        runnerFile,
        path.join(workspacePath, PAGE_FILE)
      ]);
      expect(rendered).toContain(`data-section-id="${section.sectionId}"`);
      expect(rendered).toContain('<button class="btn" type="button">');
      expect(rendered).toContain('src="../assets/logo.svg"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 300_000);

  it("cannot modify code when the agent has no write permission for the path", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-se-frontend-deny-"));
    const workspacePath = path.join(tempRoot, "workspace");
    await cp(FIXTURE_SOURCE, workspacePath, { recursive: true });

    try {
      const knownComponents = await diskComponents(workspacePath);
      const { draft } = await frontendDraft(knownComponents);
      const task = buildFrontendAgentTask(draft);
      const before = await snapshot(workspacePath);

      const sandbox = new DockerSandbox({
        allowedWorkspaceRoot: tempRoot,
        limits: { timeoutMs: 45_000, network: "none", cpus: 1, memory: "512m", pidsLimit: 1024 }
      });
      const toolRuntime = new ToolRuntime({ tools: createPhase1Tools() });
      const definition = new AgentRegistry().get("frontend-agent");
      const readOnly = {
        ...definition,
        permissions: { ...definition.permissions, writePaths: [] }
      };
      const agent = new ProfessionalAgent({
        definition: readOnly,
        model: new FrontendTaskModel(),
        toolRuntime,
        defaultTimeoutMs: 120_000
      });

      const result = await agent.run(
        task,
        agentContext(workspacePath, sandbox, "run-frontend-deny"),
        { maxIterations: 20, timeoutMs: 120_000 }
      );

      // The agent inspected the project (read tools ran)…
      expect(
        result.toolResults.some(
          (entry) => entry.toolName === "list_directory" && entry.success
        )
      ).toBe(true);
      // …and no write ever executed. PL-M5（`docs/158`）起，被拒的写入**会留痕**——
      // 它现在落一条 failed 记录（此前完全不记，run 2 的 QA agent 就是这样消失的）；
      // 要钉住的仍是「没有任何一次写入**成功执行**」，以及磁盘未变（见下）。
      const writeCalls = result.toolResults.filter((entry) => entry.toolName === "write_file");
      expect(writeCalls.length).toBeGreaterThan(0);
      expect(writeCalls.every((entry) => !entry.success)).toBe(true);
      expect(result.professionalResult?.status).toBe("FAILED");
      expect(result.professionalResult?.issues[0]?.description).toContain("not writable");

      // And nothing on disk changed.
      const after = await snapshot(workspacePath);
      expect(after).toEqual(before);
      await expect(stat(path.join(workspacePath, PAGE_FILE))).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
