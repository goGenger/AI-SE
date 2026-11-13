/**
 * PL-M20 / N-13 probe: the AC-scoped test command hangs on files whose tests do not match.
 *
 * The defect is NOT in the agent's code and NOT in the E1 fixture - it is in the command the
 * platform builds. `--test-name-pattern` filters TEST NAMES, not FILES: a file whose tests all
 * fail to match still runs its hooks. Node then calls `after` while `before` is still pending
 * (observed: the variable holding the spawned child is still `undefined`), so the child the
 * `before` hook later spawns is never reaped. It keeps the test process's event loop alive and
 * `node --test` never returns - inside a verification budget of 120s.
 *
 * This probe builds its OWN fixture (offline, deterministic, zero quota) and drives the REAL
 * `buildAcScopedTestCommand` from `../src/services/taskVerifierRules.ts`, so the command under
 * test is production code, not a copy.
 *
 * Variants:
 *   P0  unscoped command (control)                  -> must EXIT
 *   P1  production shape: scoped command as it was  -> must HANG      (reproduces N-13)
 *   P2  after the fix: scoped command + --test-timeout -> must EXIT
 *   P3  red-light control: a test body that never returns, scoped + fixed
 *                                                   -> must FAIL, never PASS
 *
 * P1 is derived from P2 by STRIPPING the new flag, so the only difference between them is the
 * fix itself.
 *
 * Run from the repo root:
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/probe-n13-scoped-test-hang.ts
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildAcNamePattern,
  buildAcScopedTestCommand
} from "../src/services/taskVerifierRules.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const OUT_DIR = join(REPO_ROOT, "packages/eval/results/n13-probe");
const CHECK_TIMEOUT_MS = 12_000;
const PROBE_WINDOW_MS = 40_000;

/** The hook shape that makes a non-matching file leak a live child process. */
const HOOK_FIXTURE = `import test from "node:test";
import { spawn } from "node:child_process";

let server;

test.before(async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  server = { child };
});

test.after(() => {
  if (server) server.child.kill("SIGKILL");
});

test("[AC-01] a test that the scoped pattern does not match", () => {});
`;

/** A test body that genuinely never returns - the red light must stay red. */
const NEVER_FIXTURE = `import test from "node:test";

test("[AC-01] a test body that never returns", async () => {
  await new Promise(() => {});
});
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "n13-probe-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" }
  },
  null,
  2
)}\n`;

interface RunOutcome {
  exited: boolean;
  code: number | null;
  tail: string;
}

function makeFixture(root: string, name: string, testSource: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), PACKAGE_JSON);
  writeFileSync(join(dir, "case.test.mjs"), testSource);
  return dir;
}

/**
 * Run a shell command with a bounded window. The child is detached so the whole process GROUP
 * can be killed on expiry - otherwise the leaked fixture server would outlive the probe.
 */
function runBounded(command: string, cwd: string): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      resolvePromise({ exited: false, code: null, tail: output.slice(-600) });
    }, PROBE_WINDOW_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ exited: true, code, tail: output.slice(-600) });
    });
  });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "n13-probe-"));
  const hookDir = makeFixture(root, "hook", HOOK_FIXTURE);
  const neverDir = makeFixture(root, "never", NEVER_FIXTURE);

  const baseCommand = "npm run test";
  const scriptText = "node --test";

  // Unmatched scope for the hook fixture (its only test is [AC-01]); matched scope for the
  // never-returning fixture, so that test actually executes.
  const unmatched = buildAcScopedTestCommand(baseCommand, ["AC-99"], scriptText, CHECK_TIMEOUT_MS);
  const matched = buildAcScopedTestCommand(baseCommand, ["AC-01"], scriptText, CHECK_TIMEOUT_MS);
  if (unmatched === null || matched === null) {
    throw new Error("buildAcScopedTestCommand returned null for a node --test project");
  }
  // P1 = the production shape BEFORE the fix: same command with the new flag removed.
  const legacy = unmatched.replace(/ --test-timeout=\d+/, "");

  const results: Record<string, RunOutcome & { command: string }> = {};
  const record = async (key: string, command: string, cwd: string): Promise<void> => {
    const outcome = await runBounded(command, cwd);
    results[key] = { ...outcome, command };
    const verdict = outcome.exited ? `EXIT ${outcome.code}` : "HANG";
    process.stdout.write(`${key.padEnd(4)} ${verdict.padEnd(10)} ${command}\n`);
  };

  process.stdout.write(`pattern for [AC-99]: ${buildAcNamePattern(["AC-99"])}\n`);
  process.stdout.write(`fixture root: ${root}\n\n`);

  await record("P0", baseCommand, hookDir);
  await record("P1", legacy, hookDir);
  await record("P2", unmatched, hookDir);
  await record("P3", matched, neverDir);

  const p0 = results.P0;
  const p1 = results.P1;
  const p2 = results.P2;
  const p3 = results.P3;
  const invariants = {
    P0_UNSCOPED_EXITS: p0.exited,
    N13_REPRODUCED: !p1.exited,
    P2_FIX_EXITS: p2.exited,
    P3_RED_LIGHT_HELD: p3.exited && p3.code !== 0 && !/\bpass 1\b/.test(p3.tail)
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), invariants, results }, null, 2)}\n`
  );

  process.stdout.write("\n");
  for (const [name, ok] of Object.entries(invariants)) {
    process.stdout.write(`${ok ? "OK  " : "FAIL"}  ${name}\n`);
  }

  rmSync(root, { recursive: true, force: true });
  if (Object.values(invariants).some((ok) => !ok)) {
    process.exitCode = 1;
  }
}

void main();
