#!/usr/bin/env node
// E1 自检：① AC↔oracle 断言一一对应（无遗漏、无孤立）+ fixture.json 与 prd.md 一致性；
// ② oracle 对参考实现全 Must 通过；③ oracle 对全部变异版本全部检出（至少一个 Must 失败）。
// 用法：node selfcheck.mjs（cwd = 夹具目录）；结果写 selfcheck-results.json；exit 0 = 自检通过。
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(here, "oracle.mjs");
const PRD = join(here, "prd.md");
const REFERENCE = join(here, "reference");
const MUTANTS_DIR = join(here, "mutants");
const FIXTURE = join(here, "fixture.json");
// 暂存目录用 /tmp（Docker Desktop 默认共享；macOS 的 os.tmpdir() 为 /var/folders，部分环境不共享给 Docker）。
const STAGE = join("/tmp", `e1-selfcheck-${Date.now()}`);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr });
    });
  });
}

function acIdsFromPrd(text) {
  return [...new Set([...text.matchAll(/^\|\s*(AC-\d\d)\s*\|/gm)].map((match) => match[1]))].sort();
}

function acIdsFromOracle(text) {
  return [...new Set([...text.matchAll(/check\(\s*"(AC-\d\d)"/g)].map((match) => match[1]))].sort();
}

async function runOracleOn(workspace) {
  const result = await run(process.execPath, [ORACLE, workspace], {
    cwd: here,
    timeoutMs: 20 * 60 * 1000
  });
  const output = `${result.stdout}${result.stderr}`;
  const line = output.split("\n").find((entry) => entry.startsWith("E1_RESULTS_JSON:"));
  let parsed = null;
  if (line) {
    try {
      parsed = JSON.parse(line.slice("E1_RESULTS_JSON:".length));
    } catch {
      parsed = null;
    }
  }
  return { exitCode: result.code, parsed, outputTail: output.slice(-600) };
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(
      `selfcheck 需要 Node ≥ 22（当前 ${process.version}）。本机登录 shell 可能默认解析到旧版 node；` +
        `请先在命令前显式 export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`
    );
  }
  mkdirSync(STAGE, { recursive: true });

  const prd = readFileSync(PRD, "utf8");
  const oracleText = readFileSync(ORACLE, "utf8");
  const prdIds = acIdsFromPrd(prd);
  const oracleIds = acIdsFromOracle(oracleText);
  const consistency = {
    prdCount: prdIds.length,
    oracleCount: oracleIds.length,
    missingInOracle: prdIds.filter((id) => !oracleIds.includes(id)),
    orphanAssertions: oracleIds.filter((id) => !prdIds.includes(id))
  };
  let fixtureConsistent = null;
  if (existsSync(FIXTURE)) {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    fixtureConsistent = fixture.requirementText === prd;
  }

  const variants = [{ id: "reference", dir: REFERENCE }];
  if (existsSync(MUTANTS_DIR)) {
    for (const name of readdirSync(MUTANTS_DIR).sort()) {
      if (name.startsWith(".") || name.endsWith(".md")) {
        continue;
      }
      variants.push({ id: name, dir: join(MUTANTS_DIR, name) });
    }
  }

  const results = [];
  for (const variant of variants) {
    const workspace = join(STAGE, variant.id);
    cpSync(variant.dir, workspace, { recursive: true });
    const outcome = await runOracleOn(workspace);
    const failedAc =
      outcome.parsed === null
        ? null
        : outcome.parsed.results.filter((entry) => !entry.passed).map((entry) => entry.ac);
    const mustTotal =
      outcome.parsed === null ? null : outcome.parsed.results.filter((entry) => entry.must).length;
    const mustPassed =
      outcome.parsed === null
        ? null
        : outcome.parsed.results.filter((entry) => entry.must && entry.passed).length;
    results.push({
      variant: variant.id,
      exitCode: outcome.exitCode,
      mustPassed,
      mustTotal,
      failedAc,
      outputTail: failedAc === null ? outcome.outputTail : null
    });
    console.log(
      `[selfcheck] ${variant.id}: exit=${outcome.exitCode} must=${mustPassed}/${mustTotal} failed=${failedAc ? failedAc.join(",") || "none" : "PARSE_ERROR"}`
    );
  }

  const reference = results.find((entry) => entry.variant === "reference");
  const mutants = results.filter((entry) => entry.variant !== "reference");
  const pass =
    consistency.missingInOracle.length === 0 &&
    consistency.orphanAssertions.length === 0 &&
    fixtureConsistent !== false &&
    reference.exitCode === 0 &&
    Array.isArray(reference.failedAc) &&
    reference.failedAc.length === 0 &&
    mutants.length > 0 &&
    mutants.every((entry) => Array.isArray(entry.failedAc) && entry.failedAc.length > 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    pass,
    consistency,
    fixtureConsistent,
    reference,
    mutants
  };
  writeFileSync(join(here, "selfcheck-results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `selfcheck: ${pass ? "PASS" : "FAIL"}（reference 全过=${reference.exitCode === 0}；变异检出 ${
      mutants.filter((entry) => entry.failedAc && entry.failedAc.length > 0).length
    }/${mutants.length}）`
  );
  rmSync(STAGE, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
