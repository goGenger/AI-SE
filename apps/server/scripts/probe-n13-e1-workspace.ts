/**
 * PL-M24 / N-13 follow-up probe: measure the AC-scoped test command on a REAL workspace.
 *
 * Why this exists: the first measurement of the PL-M24 fix was driven by a throwaway script
 * (`/tmp/n13-e1/runner.mjs`). The numbers are recorded, but the tool was not. Re-running the
 * same measurement before the next E1 batch needs a committed, parameterised probe.
 *
 * The measurement only means anything on a real workspace: `--test-timeout` counts PER FILE and
 * the sandbox runs the files SERIALLY (`--cpus 1`), so N never-completing files burn N x the
 * per-file timeout. On an idle multi-core host the files run CONCURRENTLY and the defect hides.
 * **This probe runs on the HOST, so by default it measures the concurrent case.** Pass
 * `--serial` to append `--test-concurrency=1` and emulate the sandbox; the artifact records
 * which mode ran, because the two give different totals for the same command.
 *
 * Variants (A2 is derived from A1 by STRIPPING the flag, so the only difference is the fix):
 *   A1  production shape: scoped command as `buildAcScopedTestCommand` builds it   -> must EXIT
 *   A2  the same command with `--test-timeout` removed                             -> must HANG
 *
 * Bounded window; on expiry the whole process GROUP is SIGKILLed so no leaked fixture server
 * survives the measurement. A missing workspace is SKIP (exit 0), not a failure - the workspace
 * belongs to an eval batch and may legitimately be absent on a fresh checkout.
 *
 * Run from the repo root:
 *   corepack pnpm --filter @ai-se/server exec tsx scripts/probe-n13-e1-workspace.ts <workspace> \
 *     [--ac AC-01]... [--window 180000] [--serial]
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAcScopedTestCommand } from "../src/services/taskVerifierRules.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const OUT_DIR = join(REPO_ROOT, "packages/eval/results/n13-e1-probe");

/** The verifier's production budget (`taskVerifier.ts` DEFAULT_CHECK_TIMEOUT_MS). */
const CHECK_TIMEOUT_MS = 120_000;
const DEFAULT_WINDOW_MS = 180_000;

interface VariantResult {
  variant: string;
  command: string;
  exited: boolean;
  code: number | null;
  elapsedMs: number;
  tap: string;
  leakedCount: number;
  leaked: string[];
  tail: string;
}

interface ProbeArgs {
  workspace?: string;
  acKeys: string[];
  windowMs: number;
  serial: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
  const acKeys: string[] = [];
  let workspace: string | undefined;
  let windowMs = DEFAULT_WINDOW_MS;
  let serial = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ac") {
      const value = argv[i + 1];
      if (value !== undefined) acKeys.push(value);
      i += 1;
    } else if (arg === "--window") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) windowMs = value;
      i += 1;
    } else if (arg === "--serial") {
      serial = true;
    } else if (!arg.startsWith("--") && workspace === undefined) {
      workspace = arg;
    }
  }
  return { ...(workspace !== undefined ? { workspace } : {}), acKeys, windowMs, serial };
}

/**
 * Fixture servers the run left behind. Scoped to the workspace path so the probe does not match
 * its own command line (`n13-e1-workspace` contains the substring the old runner looked for),
 * and the probe's own pid is excluded.
 */
function survivors(workspace: string): string[] {
  try {
    return execSync("ps -eo pid,command", { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(workspace))
      .filter((line) => !line.includes("probe-n13-e1-workspace"))
      .filter((line) => !line.includes("ps -eo"))
      .filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function tapSummary(output: string): string {
  return output
    .split("\n")
    .filter((line) => /^# (duration_ms|pass|fail|cancelled|tests|suites)/.test(line.trim()))
    .join("\n");
}

function runVariant(variant: string, cwd: string, command: string, windowMs: number): Promise<VariantResult> {
  return new Promise((settle) => {
    const startedAt = Date.now();
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));

    const finish = (exited: boolean, code: number | null): void => {
      const leaked = survivors(cwd);
      settle({
        variant,
        command,
        exited,
        code,
        elapsedMs: Date.now() - startedAt,
        tap: tapSummary(output),
        leakedCount: leaked.length,
        leaked: leaked.slice(0, 8),
        tail: output.slice(-800)
      });
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
      finish(false, null);
    }, windowMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(true, code);
    });
  });
}

function baseTestCommand(workspace: string): { command: string; scriptText: string } | undefined {
  const manifestPath = join(workspace, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scripts =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { scripts?: Record<string, unknown> }).scripts
      : undefined;
  const scriptText = typeof scripts?.test === "string" ? scripts.test : undefined;
  if (scriptText === undefined) return undefined;
  return { command: "npm run test", scriptText };
}

async function main(): Promise<void> {
  const { workspace, acKeys, windowMs, serial } = parseArgs(process.argv.slice(2));
  const ac = acKeys.length > 0 ? acKeys : ["AC-01"];
  if (workspace === undefined) {
    process.stdout.write(JSON.stringify({ skipped: true, reason: "no workspace argument" }, null, 2) + "\n");
    return;
  }
  const cwd = resolve(workspace);
  if (!existsSync(cwd)) {
    process.stdout.write(JSON.stringify({ skipped: true, reason: "workspace missing", cwd }, null, 2) + "\n");
    return;
  }
  const base = baseTestCommand(cwd);
  if (base === undefined) {
    process.stdout.write(JSON.stringify({ skipped: true, reason: "no test script", cwd }, null, 2) + "\n");
    return;
  }

  const production = buildAcScopedTestCommand(base.command, ac, base.scriptText, CHECK_TIMEOUT_MS);
  if (production === null) {
    process.stdout.write(
      JSON.stringify({ skipped: true, reason: "scoped command not applicable", cwd }, null, 2) + "\n"
    );
    return;
  }
  // `--serial` emulates the sandbox (`--cpus 1`), where Node runs the test files one at a time.
  // It is NOT part of the production command - the sandbox achieves it via CPU count - so the
  // mode is recorded in the artifact rather than folded silently into the measurement.
  const withMode = serial ? `${production} --test-concurrency=1` : production;
  const stripped = withMode.replace(/\s--test-timeout=\d+/, "");

  const results = [
    await runVariant("A1-production", cwd, withMode, windowMs),
    await runVariant("A2-no-test-timeout", cwd, stripped, windowMs)
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  const artifact = {
    cwd,
    acKeys: ac,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    windowMs,
    concurrency: serial ? "serial (--test-concurrency=1, emulates the --cpus 1 sandbox)" : "host default",
    results
  };
  writeFileSync(join(OUT_DIR, "e1-workspace-ab.json"), JSON.stringify(artifact, null, 2) + "\n");
  process.stdout.write(JSON.stringify(artifact, null, 2) + "\n");
}

void main();
