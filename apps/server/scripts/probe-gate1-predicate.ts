/**
 * 自治 L2 判据的离线回放（`docs/227` §4 L2-7 的前半步）——**只读、零配额**。
 *
 * 对库里**现存**的切片计划跑一遍 `evaluateSlicePlanGate`，回答两件事：
 *   1. 判据在当前真实计划上会怎么判（自动批 / 送人工），以及未命中哪一条；
 *   2. 判据本身有没有写崩（异常、空值、全部拒绝/全部放行都是可疑信号）。
 *
 * **它不是批次**：切片计划不留历史（`replaceSlicePlan` 先删后插），所以样本只有当前计划，
 * 且"自动批"只是一个判决，没有真的批准任何东西。本脚本**不写库**。
 *
 * 用法：corepack pnpm --filter @ai-se/server exec tsx scripts/probe-gate1-predicate.ts
 */
import { isGlobalAcceptanceCriterion } from "@ai-se/agent-core";
import { PgPlanningRepository, createPool } from "@ai-se/database";
import {
  evaluateSlicePlanGate,
  isAutonomyLevel,
  SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS
} from "@ai-se/shared";

interface Row {
  requirementId: string;
  level: string;
  slices: number;
  finalSliceTasks: number;
  satisfied: boolean;
  unmet: string[];
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    `postgres://${process.env.POSTGRES_USER ?? "aise"}:${process.env.POSTGRES_PASSWORD ?? "aise"}@${
      process.env.POSTGRES_HOST ?? "127.0.0.1"
    }:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "aise"}`;
  const pool = createPool(connectionString);
  const planning = new PgPlanningRepository(pool);

  try {
    const requirements = await pool.query<{ id: string; autonomy_level: string | null }>(
      "SELECT id, autonomy_level FROM requirements ORDER BY created_at"
    );
    const rows: Row[] = [];
    for (const row of requirements.rows) {
      const slices = await planning.findSlicesByRequirementId(row.id);
      if (slices.length === 0) continue;
      const analysis = await planning.findLatestAnalysis(row.id);
      const criteria = await planning.findAcceptanceCriteriaByRequirementId(row.id);

      const ordered = [...slices].sort((left, right) => left.order - right.order);
      const finalSlice = ordered.at(-1);
      const globalAcCount = criteria.filter((record) => isGlobalAcceptanceCriterion(record)).length;
      const gate = evaluateSlicePlanGate({
        plan: {
          slices: ordered.map((slice) => ({
            id: slice.sliceKey,
            title: slice.title,
            goal: slice.goal,
            frKeys: slice.frKeys,
            dependsOn: slice.dependsOn,
            order: slice.order,
            involvesUi: slice.involvesUi
          })),
          milestones: []
        },
        functionalRequirementKeys: (analysis?.functionalRequirements ?? []).map((fr) => fr.id),
        estimatedFinalSliceTasks: (finalSlice?.frKeys.length ?? 0) + globalAcCount
      });
      rows.push({
        requirementId: row.id,
        level: isAutonomyLevel(row.autonomy_level) ? row.autonomy_level : "(none)",
        slices: slices.length,
        finalSliceTasks: (finalSlice?.frKeys.length ?? 0) + globalAcCount,
        satisfied: gate.satisfied,
        unmet: gate.unmet
      });
    }

    // eslint-disable-next-line no-console -- 探针的产物就是标准输出
    console.table(rows);
    const auto = rows.filter((row) => row.satisfied).length;
    // eslint-disable-next-line no-console -- 同上
    console.log(
      JSON.stringify({
        requirements: rows.length,
        wouldAutoApprove: auto,
        wouldEscalateToHuman: rows.length - auto,
        maxFinalSliceTasksThreshold: SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS,
        unmetDistribution: rows.reduce<Record<string, number>>((acc, row) => {
          for (const reason of row.unmet) acc[reason] = (acc[reason] ?? 0) + 1;
          return acc;
        }, {})
      })
    );
    if (rows.length === 0) {
      // eslint-disable-next-line no-console -- 同上
      console.log("NO_SAMPLE: 库里没有带切片计划的需求，判据无法回放");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- 探针失败必须可见
  console.error(error);
  process.exit(1);
});
