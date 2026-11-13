#!/usr/bin/env node
/**
 * 核对「失败原因分布」的口径：**只按任务级统计，不再叠加 run 级**。
 *
 * 背景（2026-10-20）：`tasks.output` 与 `agent_runs.output` 是同一份 `outcome.metadata`
 * （`apps/server/src/services/workflowTaskExecutor.ts:355-389` 把同一个 output 对象既写进 run，
 * 又作为任务结果返回），旧口径把两级各计一次 ⇒ 相加正好翻倍。
 *
 * 用法（离线、零配额、不连库——SQL 由调用方给出）：
 *
 *   psql ... -t -A -c "SELECT json_agg(json_build_object('status',t.status,'errorType',t.output->>'errorType'))
 *     FROM tasks t WHERE t.workflow_run_id = ANY('{<workflowIds>}'::uuid[])" > /tmp/tasks.json
 *   node packages/eval/scripts/verify-error-types-granularity.mjs /tmp/tasks.json
 *
 * 输出 = 新口径下该 run 的 `errorTypes` 与 `failureLayers`，可直接与批次产物
 * `packages/eval/results/<batch>/run-<n>.json` 里的同名字段做 A/B。
 * 注意：本脚本读的是**当前库内状态**，只有当任务状态分布与批次产物一致时才是同一状态的复算。
 */
import { readFileSync } from "node:fs";
import { collectTaskMetrics, collectFailureLayers, classifyFailureLayer } from "../dist/harness.js";

const path = process.argv[2];
if (!path) {
  console.error("用法：node verify-error-types-granularity.mjs <tasks.json>");
  process.exit(2);
}

const rows = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(rows)) {
  console.error("输入必须是 JSON 数组：[{status, errorType}, ...]");
  process.exit(2);
}

const tasks = rows.map((row) => ({
  status: String(row.status ?? ""),
  output: row.errorType ? { errorType: String(row.errorType) } : {}
}));

const metrics = collectTaskMetrics(tasks);
const errorTypes = metrics.errorTypes;
const failureLayers = collectFailureLayers(errorTypes);

console.log(
  JSON.stringify(
    {
      taskCount: tasks.length,
      taskStatuses: metrics.taskStatuses,
      errorTypes,
      failureLayers,
      byCode: Object.fromEntries(
        Object.entries(errorTypes).map(([code, count]) => [code, { layer: classifyFailureLayer(code), count }])
      )
    },
    null,
    2
  )
);
