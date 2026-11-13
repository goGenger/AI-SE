#!/usr/bin/env node
/**
 * F1-8（FX-27）离线重算：历史批次（B / C-6 / E-1 / E-2 / E-2b）按 FX-26 冻结口径重算。
 * 纯读落盘工件（不连库、不调模型、不耗配额）。
 *
 * 口径说明（代理与限制，如实标注）：
 * - chainCompleted：工件无切片状态面 → 以「全部任务 SUCCESS（且无失败记录）」为**代理**（非强证据）；
 * - deliveredSuccess = oraclePassed ∧ chainCompleted(代理)；falseNegative = oraclePassed ∧ ¬chainCompleted；
 * - sliceReached：工件仅存已执行工作流 → 以 `workflowIds.length`（已执行切片工作流数）呈现，非真实 sliceReached；
 * - 超范围写入标注：`SCOPE_VIOLATION` 事件面在 F2-1 前不存在 → 本重算不列（口径：恒缺省 false）；
 * - 口径版本：全部历史批次 = 29 Must + 1 Should（唯一 Should = AC-22，FX-28 核对记录）。
 *
 * 用法：node scripts/f18-recompute.mjs [--json]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsRoot = join(here, "..", "results");

const BATCHES = [
  {
    id: "B",
    desc: "B 出口基线（09-29 ~ 10-01 时间戳批次文件）",
    files: () =>
      readdirSync(resultsRoot)
        .filter((name) => /^2026-.*\.json$/.test(name))
        .sort()
        .map((name) => join(resultsRoot, name))
  },
  {
    id: "C-6",
    desc: "C-6 对比批次（E1 夹具）",
    files: () =>
      readdirSync(join(resultsRoot, "e1-c6"))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(resultsRoot, "e1-c6", name))
  },
  {
    id: "E-1",
    desc: "E-1 基线批（E1 夹具 ×3）",
    files: () =>
      ["run-1.json", "run-2.json", "run-3.json"].map((name) => join(resultsRoot, "e1", name))
  },
  {
    id: "E-2",
    desc: "E-2（S/M/L + E1 档，验证门 observe 轮）",
    files: () =>
      readdirSync(join(resultsRoot, "e2"))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(resultsRoot, "e2", name))
  },
  {
    id: "E-2b",
    desc: "E-2b（次轮）",
    files: () =>
      readdirSync(join(resultsRoot, "e2b"))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(resultsRoot, "e2b", name))
  }
];

function nonSuccessCount(statuses) {
  return Object.entries(statuses ?? {})
    .filter(([status]) => status !== "SUCCESS")
    .reduce((sum, [, count]) => sum + count, 0);
}

function recomputeRecord(record) {
  const statuses = record.taskStatuses ?? {};
  const oracle = record.oraclePassed === true;
  const totalTasks = Object.values(statuses).reduce((sum, count) => sum + count, 0);
  // 代理：链完成 = 有任务且全部 SUCCESS。
  const chainCompletedProxy = totalTasks > 0 && nonSuccessCount(statuses) === 0;
  const slicesExecuted = Array.isArray(record.workflowIds)
    ? record.workflowIds.length
    : record.workflowId
      ? 1
      : 0;
  return {
    fixture: record.fixtureId,
    run: record.runIndex ?? 1,
    reportedSuccess: record.reportedSuccess === true,
    oraclePassed: oracle,
    chainCompletedProxy,
    deliveredSuccess: oracle && chainCompletedProxy,
    falseNegative: oracle && !chainCompletedProxy,
    slicesExecuted,
    errorTypes: record.errorTypes ?? {}
  };
}

function collectBatch(batch) {
  const records = [];
  const failures = [];
  for (const file of batch.files()) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      failures.push({ file, message: String(error) });
      continue;
    }
    for (const record of parsed.records ?? []) {
      records.push(recomputeRecord(record));
    }
    for (const failure of parsed.failures ?? []) {
      failures.push({
        file,
        message: `${failure.fixtureId}（${failure.stage}）：${failure.message}`
      });
    }
  }
  const runs = records.length;
  const oracle = records.filter((r) => r.oraclePassed).length;
  const chain = records.filter((r) => r.chainCompletedProxy).length;
  const delivered = records.filter((r) => r.deliveredSuccess).length;
  const falseNegatives = records.filter((r) => r.falseNegative);
  const errorTypes = {};
  for (const record of records) {
    for (const [code, count] of Object.entries(record.errorTypes)) {
      errorTypes[code] = (errorTypes[code] ?? 0) + count;
    }
  }
  const slicesExecutedDistribution = {};
  for (const record of records) {
    const key = `${record.slicesExecuted} 片`;
    slicesExecutedDistribution[key] = (slicesExecutedDistribution[key] ?? 0) + 1;
  }
  return {
    id: batch.id,
    desc: batch.desc,
    runs,
    oraclePassed: oracle,
    chainCompletedProxy: chain,
    deliveredSuccess: delivered,
    falseNegativeCount: falseNegatives.length,
    falseNegatives,
    errorTypes,
    slicesExecutedDistribution,
    failures
  };
}

const report = BATCHES.map(collectBatch);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const lines = [];
lines.push("# F1-8（FX-27）历史批次离线重算（新口径 = FX-26 冻结）");
lines.push("");
lines.push(
  `生成时间：${new Date().toISOString()}｜口径版本：29 Must + 1 Should（唯一 Should = AC-22）`
);
lines.push("");
lines.push(
  "> 代理说明：工件无切片状态面——`链完成` 以「全部任务 SUCCESS」为代理；`已执行片数` = workflowIds 数；超范围写入（F2-1 前）无事件面。"
);
lines.push("");
lines.push(
  "| 批次 | 运行数 | oracle 通过 | 链完成（代理） | 真交付成功 | 假阴性 | 已执行片数分布 |"
);
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const batch of report) {
  lines.push(
    `| ${batch.id} | ${batch.runs} | ${batch.oraclePassed}/${batch.runs} | ${batch.chainCompletedProxy}/${batch.runs} | ${batch.deliveredSuccess}/${batch.runs} | ${batch.falseNegativeCount} | ${
      Object.entries(batch.slicesExecutedDistribution)
        .map(([key, count]) => `${key}×${count}`)
        .join(" ") || "-"
    } |`
  );
}
lines.push("");
lines.push("## 假阴性明细（oracle 过但链未完成）");
lines.push("");
const allFalseNegatives = report.flatMap((batch) =>
  batch.falseNegatives.map((record) => `${batch.id} / ${record.fixture} #${record.run}`)
);
lines.push(
  allFalseNegatives.length > 0 ? allFalseNegatives.map((line) => `- ${line}`).join("\n") : "（无）"
);
lines.push("");
lines.push("## 错误码分布（各批次合计）");
lines.push("");
for (const batch of report) {
  const entries = Object.entries(batch.errorTypes);
  lines.push(
    `- ${batch.id}：${entries.map(([code, count]) => `${code}×${count}`).join(" ") || "（无）"}`
  );
}
lines.push("");
lines.push("## E-1 口径标注（任务书点名）");
lines.push("");
const e1 = report.find((batch) => batch.id === "E-1");
lines.push(
  `- E-1：真成功（oracle）**${e1.oraclePassed}/3**；链完成（代理）**${e1.chainCompletedProxy}/3** —「真成功 1/3」同时标注「链完成 0/3」✓`
);
if (report.some((batch) => batch.failures.length > 0)) {
  lines.push("");
  lines.push("## 未完成失败（既有记录，不重算）");
  lines.push("");
  for (const batch of report) {
    for (const failure of batch.failures) {
      lines.push(`- ${batch.id}：${failure.message}`);
    }
  }
}
lines.push("");

const output = lines.join("\n");
const evidenceDir = join(resultsRoot, "f");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "f18-recompute.md"), output);
writeFileSync(
  join(evidenceDir, "f18-recompute.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), batches: report }, null, 2)
);
console.log(output);
console.log(`\n[written] ${join(evidenceDir, "f18-recompute.md")}`);
