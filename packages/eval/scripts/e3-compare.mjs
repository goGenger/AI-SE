#!/usr/bin/env node
// E-3 before/after comparison aggregator (docs/125 E-3).
// Reads eval result JSONs and prints a programmatic markdown comparison.
// Sources: B pass1 (2026-09-30T*), B fixbatch (2026-10-01T06-55-50), B E1 baseline
// (e1-baseline/), C-6 (e1-c6/), E-2 round1 (e2/), E-2b (e2b/), E-1 (e1/).
// NOTE: keep this file ASCII-only. Run: node packages/eval/scripts/e3-compare.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "results");

function loadFiles(paths) {
  const runs = [];
  const failures = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const d = JSON.parse(readFileSync(p, "utf8"));
    for (const r of d.records ?? []) {
      runs.push({
        fixture: r.fixtureId,
        tier: r.tier,
        oracle: !!r.oraclePassed,
        reported: !!r.reportedSuccess,
        fp: !!r.falsePositive,
        recov: r.parseRecoveryRuns ?? 0,
        runsIn: r.runCount ?? 1,
        inTok: r.tokenUsage?.input ?? 0,
        outTok: r.tokenUsage?.output ?? 0,
        ms: r.durationMs ?? 0,
        err: r.errorTypes ?? {}
      });
    }
    for (const f of d.failures ?? []) failures.push(`${f.fixtureId}/${f.stage}: ${f.message}`);
  }
  return { runs, failures };
}

function glob(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.includes("failure"))
    .map((n) => join(dir, n));
}

const topLevel = glob(RESULTS).filter((p) => {
  const n = p.split("/").pop();
  return n.startsWith("2026-09-30") || n.startsWith("2026-10-01T06");
});

// Official mapping (docs/115 B-4): summaryA = the 12:17-53 file (17 records, 70.6%);
// summaryB = the 10-01T06-55 file (12 records, 58.3%). The 09-30 18:36/18:53 files are
// intermediate attempts and are excluded from the official summaries.
const pick = (prefix) => topLevel.filter((p) => p.split("/").pop().startsWith(prefix));

const sources = {
  "B-summaryA (09-30 pass1)": loadFiles(pick("2026-09-30T12-17-53")),
  "B-summaryB (10-01 fixbatch)": loadFiles(pick("2026-10-01T06-55-50")),
  "B E1 baseline": loadFiles(glob(join(RESULTS, "e1-baseline"))),
  "C-6 E1": loadFiles(glob(join(RESULTS, "e1-c6"))),
  "E-2 round1 (old plans)": loadFiles(glob(join(RESULTS, "e2"))),
  "E-2b (replanned)": loadFiles(glob(join(RESULTS, "e2b"))),
  "E-1 (E1 x3)": loadFiles(glob(join(RESULTS, "e1")))
};

console.log("| batch | runs | trueSuccess(oracle) | reported | falsePositive | degradedRate | tokensIn | avgTime | failureModes |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [name, { runs, failures }] of Object.entries(sources)) {
  if (runs.length === 0 && failures.length === 0) {
    console.log(`| ${name} | - | - | - | - | - | - | - | (no data) |`);
    continue;
  }
  const n = runs.length;
  const orc = runs.filter((r) => r.oracle).length;
  const rep = runs.filter((r) => r.reported).length;
  const fp = runs.filter((r) => r.fp).length;
  const recovTotal = runs.reduce((a, r) => a + r.recov, 0);
  const runsTotal = runs.reduce((a, r) => a + r.runsIn, 0);
  const deg = runsTotal ? ((recovTotal / runsTotal) * 100).toFixed(1) + "%" : "-";
  const inM = (runs.reduce((a, r) => a + r.inTok, 0) / 1e6).toFixed(2);
  const avgMin = n ? (runs.reduce((a, r) => a + r.ms, 0) / n / 60000).toFixed(1) : "-";
  const errs = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.err)) errs[k] = (errs[k] ?? 0) + v;
  const errStr = Object.entries(errs).map(([k, v]) => `${k}x${v}`).join(", ") || "-";
  const fx = failures.length ? ` ; fixture-failures: ${failures.join(" | ")}` : "";
  console.log(`| ${name} | ${n} | ${orc}/${n} | ${rep}/${n} | ${fp}/${n} | ${deg} | ${inM}M | ${avgMin}min | ${errStr}${fx} |`);
}
console.log("");
console.log("Notes: trueSuccess = oracle passed (external judge); falsePositive = reported success but oracle failed.");
console.log("B-summaryA includes 7 defect-era isolated runs; B-summaryB includes 1 false positive;");
console.log("C-6 run-3 Must 28/29 was a ghost snapshot (not reachable evidence); E-1 run-3 first attempt = fixture-level failure (preserved).");
