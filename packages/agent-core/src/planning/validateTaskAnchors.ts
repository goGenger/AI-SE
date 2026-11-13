import { canonicalAcKey, canonicalFrKey, selectAcceptanceCriteriaForSlice } from "./acceptanceCriteria";
import { TestFirstValidationInput } from "./validateTestFirstPlan";

/**
 * PL-M7（`docs/164` §3）：非最终切片的**任务锚点**校验。
 *
 * 背景（PL-M4 run 1 实测，`docs/164` §2）：既有五道 AC 作用域守卫——`GLOBAL_AC_OUTSIDE_FINAL_SLICE`
 * （`validateTaskGraph.ts`）、N4 测试先行顺序、实现覆盖（PL-M1）、验证门 F1-5 作用域
 * （`apps/server` 的 `taskTestScope`）、`PLAN_ACKEYS_MISSING`（计划级 `some()`）——**全部以「任务已
 * 声明 acKeys」为前置条件**。run 1 的 12 个任务里 8 个 acKeys 为空，于是五道守卫对它们同时隐形：
 * slice-1（范围内 AC 只有 AC-04）出现了一个以 **AC-25** 为主题的 TEST 任务，而 AC-25 既属
 * slice-2（`FR-8`）又是全局性 AC（`verification = 容器运行`）。计划期无任何校验器能看见它。
 *
 * 本文件交付两半，**严重度不同**（`docs/165` 对 `docs/164` 的裁定 1 有更正，见下）：
 *
 *  - **7a（越界，硬错误）**：`validateTaskAnchors` —— 非最终切片的任务**声明**的锚点必须落在切片
 *    范围内。这是既有 `GLOBAL_AC_OUTSIDE_FINAL_SLICE` 的一般化（后者只拦全局 AC，本条拦全部越界
 *    引用）。**零误报**：锚点是规划器自己写的，范围由 `frKeys` 与 AC 记录确定。
 *
 *  - **7b（必需，观察项）**：`findUnanchoredTestTasks` —— 非最终切片里**没有声明任何锚点**的 TEST
 *    任务。**本项不产生错误、只产生事件**（`PLAN_TEST_TASK_UNANCHORED`），理由见 `docs/165` §2：
 *    run 1 的 slice-1 三个 TEST 任务里有 2 个无锚点，`ScriptedPlanningModel` 的 todo 夹具同样如此
 *    ——「TEST 任务不逐条枚举 AC」是**常见形状**。把它做成硬错误会拒掉合法计划，风险是把「链死在
 *    slice-1」换成「计划根本出不来」（run 1 的规划已两次 `SLICE_PLANNING_FAILED` 才勉强收敛）。
 *    本项先以事件形式积累证据，再据实测裁定是否收紧。
 *
 * 只报错、不自动造任务（与 PL-M1 同口径，`docs/158` §6 第 3 项裁定 A）：错误汇入 `PlanningGraph`
 * 的既有 `errors[]`，交给既有 LLM 修复轮。
 *
 * **退路口径与既有校验器逐字一致**：需求没有编号 AC 记录（`criteria` 为空）→ 跳过。此时平台的 AC
 * 作用域保护整体处于 `acProtection = none`（`validateAcKeysPresence`），单独要求本校验器仍强制锚点
 * 会让「没有编号 AC 的需求」无法出计划。最终切片（`isFinalSlice === true`）与无切片场景
 * （`undefined`）同样逐字不变。
 */
interface Anchor {
  namespace: "AC" | "FR";
  key: string;
}

function normalizeAnchor(raw: string): Anchor | null {
  const cleaned = raw
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
  if (/^AC-\d+$/i.test(cleaned)) {
    return { namespace: "AC", key: canonicalAcKey(cleaned) };
  }
  if (/^FR-\d+$/i.test(cleaned)) {
    return { namespace: "FR", key: canonicalFrKey(cleaned) };
  }
  return null;
}

/** 锚点判定所需的切片范围；`null` = 本次不校验（最终切片 / 无切片 / 无编号 AC 记录）。 */
function anchorScope(input: TestFirstValidationInput): {
  inScopeAcs: Set<string>;
  inScopeFrs: Set<string>;
  hint: string;
} | null {
  if (input.isFinalSlice !== false || input.criteria.length === 0) {
    return null;
  }
  const scopedCriteria = selectAcceptanceCriteriaForSlice(input.criteria, input.frKeys, {
    isFinalSlice: false
  });
  const inScopeAcs = new Set(scopedCriteria.map((criterion) => canonicalAcKey(criterion.acKey)));
  const inScopeFrs = new Set((input.frKeys ?? []).map((key) => canonicalFrKey(key)));
  if (inScopeAcs.size === 0 && inScopeFrs.size === 0) {
    return null;
  }
  // 修复轮要对齐的目标清单——把范围内 AC/FR 写进信息，使修复是机械的而不是猜的。
  const hint = [
    inScopeAcs.size > 0 ? `acceptance criteria ${[...inScopeAcs].join(", ")}` : "",
    inScopeFrs.size > 0 ? `requirements ${[...inScopeFrs].join(", ")}` : ""
  ]
    .filter((part) => part !== "")
    .join("; ");
  return { inScopeAcs, inScopeFrs, hint };
}

/** PL-M7 7a：非最终切片的任务**声明**的锚点必须落在切片范围内（硬错误）。 */
export function validateTaskAnchors(input: TestFirstValidationInput): string[] {
  const scope = anchorScope(input);
  if (!scope) {
    return [];
  }

  const errors: string[] = [];
  for (const task of input.tasks) {
    // 无法解析的条目由 `backfillTaskPlanAcKeys` 以 PLAN_ACKEYS_INVALID 报出，这里不重复报。
    for (const anchor of (task.acKeys ?? []).map(normalizeAnchor)) {
      if (!anchor) continue;
      const inScope =
        anchor.namespace === "AC" ? scope.inScopeAcs.has(anchor.key) : scope.inScopeFrs.has(anchor.key);
      if (!inScope) {
        errors.push(
          `PLAN_ANCHOR_OUT_OF_SCOPE: Task ${task.id} references ${anchor.key}, which is outside this slice's scope (in scope: ${scope.hint}); plan that work in the slice that owns it — global deployment/documentation acceptance belongs to the final slice`
        );
      }
    }
  }
  return errors;
}

/**
 * PL-M7 7b：非最终切片里没有声明任何锚点的 TEST 任务（**观察项，不产生错误**）。
 * 返回 `taskId` 与本次的范围内清单，供调用方写入 `PLAN_TEST_TASK_UNANCHORED` 事件。
 */
export function findUnanchoredTestTasks(
  input: TestFirstValidationInput
): Array<{ taskId: string; inScope: string }> {
  const scope = anchorScope(input);
  if (!scope) {
    return [];
  }

  const findings: Array<{ taskId: string; inScope: string }> = [];
  for (const task of input.tasks) {
    if (task.type !== "TEST") continue;
    const anchored = (task.acKeys ?? []).map(normalizeAnchor).some((anchor) => anchor !== null);
    if (!anchored) {
      findings.push({ taskId: task.id, inScope: scope.hint });
    }
  }
  return findings;
}
