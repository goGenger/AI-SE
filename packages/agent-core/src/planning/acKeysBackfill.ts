import { AcceptanceCriterion, TaskPlan, TaskPlanItem, TaskType } from "@ai-se/shared";
import { selectAcceptanceCriteriaForSlice } from "./acceptanceCriteria";

/**
 * F1-2（发现①）：acKeys 确定性回填。
 * - LLM 输出的 acKeys 只作参考：AC-xx 直接解析（对齐记录中的规范键）；FR-xxx（含 [FR-001] 形式）
 *   按 FR/AC 记录展开为对应 AC；未知格式明确报错（PLAN_ACKEYS_INVALID，进入修复轮）。
 * - 未被任何任务引用的（切片范围内）AC → 确定性回填到实现类任务（无实现类时回退 TEST 任务），
 *   保证「凡有对应 AC 的任务非空 + 每条 AC 至少映射一个任务」。
 * - 冲突以代码为准：`changes` 记录前后差异，由调用方写入事件（PLAN_ACKEYS_BACKFILLED）。
 *
 * 口径备注：「切片 FR 范围 ∩ AC 记录」为回填来源（docs/128 §3 F1-2）；无 AC 记录时不做任何回填。
 */

/** 实现类任务（与验证门的开发类证据口径一致：BACKEND / FRONTEND / DATABASE / DEBUG）。 */
const IMPLEMENTATION_TYPES: readonly TaskType[] = ["BACKEND", "FRONTEND", "DATABASE", "DEBUG"];

type RefNamespace = "AC" | "FR";

interface NormalizedRef {
  namespace: RefNamespace;
  number: number;
}

/** 任务 acKeys 条目的严格解析：仅接受已知两种写法（AC-x / FR-x，含 [FR-001] 方括号与大小写变体）。 */
function normalizeRef(raw: string): NormalizedRef | null {
  const cleaned = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  const match = /^(AC|FR)-(\d+)$/i.exec(cleaned);
  if (!match) {
    return null;
  }
  return { namespace: match[1].toUpperCase() as RefNamespace, number: Number(match[2]) };
}

/** 记录侧 frKeys 的宽松解析（历史数据含 FR1 / FR-01 等形态）。 */
function normalizeFrKey(raw: string): number | null {
  const match = /^FR-?(\d+)$/i.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

export interface AcKeysBackfillInput {
  tasks: TaskPlan["tasks"];
  /** 解析后的 AC 记录（F1-1 的判定源：编号 PRD 解析优先、N3 库记录兜底）。 */
  criteria: AcceptanceCriterion[];
  /** 切片 FR 范围（第二级）；缺省 = 全需求。 */
  frKeys?: string[];
  /** F1-4：切片级归属（非最终切片剔除全局性 AC；最终切片并入全部全局性 AC）。 */
  isFinalSlice?: boolean;
}

export interface AcKeysBackfillChange {
  taskId: string;
  before: string[];
  after: string[];
  /** 范围回填新增的键。 */
  added: string[];
  /** FR 引用 → AC 键的展开明细。 */
  expanded: Array<{ ref: string; acKeys: string[] }>;
  /** 被移除的条目（未知格式已报错；FR 无对应记录时视为不可解析移除）。 */
  dropped: string[];
}

export interface AcKeysBackfillResult {
  tasks: TaskPlan["tasks"];
  errors: string[];
  changes: AcKeysBackfillChange[];
}

function stripAcKeys(task: TaskPlanItem): TaskPlanItem {
  const copy: TaskPlanItem = { ...task };
  delete copy.acKeys;
  return copy;
}

export function backfillTaskPlanAcKeys(input: AcKeysBackfillInput): AcKeysBackfillResult {
  const acByNumber = new Map<number, AcceptanceCriterion>();
  for (const criterion of input.criteria) {
    const ref = normalizeRef(criterion.acKey);
    if (ref && ref.namespace === "AC") {
      acByNumber.set(ref.number, criterion);
    }
  }
  const acsByFrNumber = new Map<number, AcceptanceCriterion[]>();
  for (const criterion of input.criteria) {
    for (const frKey of criterion.frKeys) {
      const number = normalizeFrKey(frKey);
      if (number === null) continue;
      const list = acsByFrNumber.get(number) ?? [];
      list.push(criterion);
      acsByFrNumber.set(number, list);
    }
  }

  const errors: string[] = [];
  const coveredNumbers = new Set<number>();
  const resolved = input.tasks.map((task) => {
    const before = [...(task.acKeys ?? [])];
    const output: string[] = [];
    const expanded: AcKeysBackfillChange["expanded"] = [];
    const dropped: string[] = [];
    const pushKey = (acKey: string) => {
      if (!output.includes(acKey)) {
        output.push(acKey);
      }
      const ref = normalizeRef(acKey);
      if (ref && ref.namespace === "AC") {
        coveredNumbers.add(ref.number);
      }
    };

    for (const entry of before) {
      const ref = normalizeRef(entry);
      if (!ref) {
        dropped.push(entry);
        errors.push(
          `PLAN_ACKEYS_INVALID: Task ${task.id} has acKeys entry "${entry}" that is neither AC-x nor FR-x; use acceptance-criteria keys (AC-01) or FR references (FR-1).`
        );
        continue;
      }
      if (ref.namespace === "AC") {
        const criterion = acByNumber.get(ref.number);
        pushKey(criterion ? criterion.acKey : `AC-${String(ref.number).padStart(2, "0")}`);
        continue;
      }
      const expandedAcs = (acsByFrNumber.get(ref.number) ?? []).map((criterion) => criterion.acKey);
      if (expandedAcs.length > 0) {
        expanded.push({ ref: entry, acKeys: expandedAcs });
        for (const acKey of expandedAcs) {
          pushKey(acKey);
        }
      } else {
        dropped.push(entry);
      }
    }

    return { task, before, output, expanded, dropped };
  });

  const preFill = resolved.map((entry) => [...entry.output]);

  // 范围回填：未被引用的（切片范围内）AC → 实现类任务（无实现类 → TEST 任务）。
  const scope = selectAcceptanceCriteriaForSlice(input.criteria, input.frKeys, {
    ...(input.isFinalSlice !== undefined ? { isFinalSlice: input.isFinalSlice } : {})
  });
  const uncovered = scope.filter((criterion) => {
    const ref = normalizeRef(criterion.acKey);
    return ref && ref.namespace === "AC" ? !coveredNumbers.has(ref.number) : true;
  });
  if (uncovered.length > 0) {
    const implTargets = input.tasks.filter((task) => IMPLEMENTATION_TYPES.includes(task.type));
    const targets =
      implTargets.length > 0 ? implTargets : input.tasks.filter((task) => task.type === "TEST");
    const targetIds = new Set(targets.map((task) => task.id));
    for (const entry of resolved) {
      if (!targetIds.has(entry.task.id)) continue;
      for (const criterion of uncovered) {
        if (!entry.output.includes(criterion.acKey)) {
          entry.output.push(criterion.acKey);
        }
      }
    }
  }

  const changes: AcKeysBackfillChange[] = [];
  const tasks: TaskPlan["tasks"] = [];
  resolved.forEach((entry, index) => {
    const snapshot = preFill[index] ?? [];
    if (JSON.stringify(entry.before) !== JSON.stringify(entry.output)) {
      changes.push({
        taskId: entry.task.id,
        before: entry.before,
        after: [...entry.output],
        added: entry.output.filter((key) => !snapshot.includes(key)),
        expanded: entry.expanded,
        dropped: entry.dropped
      });
    }
    tasks.push(
      entry.output.length > 0 ? { ...entry.task, acKeys: entry.output } : stripAcKeys(entry.task)
    );
  });

  return { tasks, errors, changes };
}
