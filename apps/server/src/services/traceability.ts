import {
  AcceptanceCriterion,
  RequirementTraceabilityView,
  Task,
  TraceabilityStatus,
  TraceabilityTestRef
} from "@ai-se/shared";

/**
 * C-5（N5）追溯表生成器（确定性、零 LLM）：FR → AC → 测试 → 执行结果 → 证据。
 * 纯函数：输入全部来自既有记录（AC 一等记录）与任务输出（验证门证据），不调用任何模型。
 */

export interface TraceabilityInput {
  requirementId: string;
  criteria: AcceptanceCriterion[];
  /** 运行时任务（每计划任务取其最新一次执行）。 */
  runtimeTasks: Task[];
  generatedAt?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function acKeysOf(task: Task): string[] {
  const value = task.input.acKeys;
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

/** 同一计划任务（或同一任务 id）多次执行 → 仅保留最新一次（按 finishedAt/createdAt）；重跑覆盖旧证据。 */
function latestExecutions(tasks: Task[]): Task[] {
  const sorted = [...tasks].sort((left, right) => {
    const leftAt = left.finishedAt ?? left.createdAt;
    const rightAt = right.finishedAt ?? right.createdAt;
    return rightAt.localeCompare(leftAt);
  });
  const seen = new Set<string>();
  const latest: Task[] = [];
  for (const task of sorted) {
    const key = task.planTaskId ?? task.id;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(task);
  }
  return latest;
}

function evidenceRefs(task: Task, acKey: string): TraceabilityTestRef[] {
  const verification = asRecord(task.output?.verification);
  if (!verification) return [];
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const refs: TraceabilityTestRef[] = [];
  for (const entry of checks) {
    const check = asRecord(entry);
    if (!check) continue;
    const results = asRecord(check.acResults);
    const result = results?.[acKey];
    if (result !== "passed" && result !== "failed") continue;
    const commitSha =
      typeof check.commitSha === "string"
        ? check.commitSha
        : typeof verification.commitSha === "string"
          ? verification.commitSha
          : undefined;
    refs.push({
      taskKey: task.taskKey,
      taskType: task.type,
      ...(task.sliceKey ? { sliceKey: task.sliceKey } : {}),
      expected: check.expected === "fail" ? "fail" : "pass",
      result,
      ...(typeof check.command === "string" ? { command: check.command } : {}),
      ...(typeof check.exitCode === "number" || check.exitCode === null
        ? { exitCode: check.exitCode as number | null }
        : {}),
      ...(typeof verification.finishedAt === "string"
        ? { finishedAt: verification.finishedAt }
        : {}),
      ...(commitSha ? { commitSha } : {})
    });
  }
  return refs;
}

/**
 * F1-5（FX-18/19）：交付前全量（CI）证据——任务输出携带 `testResults`（在最终集成的 commit 上运行）时，
 * 为每条 AC 生成 authoritative 参考；追溯判定以这一次为准（覆盖早期分散的绿灯证据）。
 */
function authoritativeRefs(task: Task, acKey: string): TraceabilityTestRef[] {
  const output = asRecord(task.output);
  if (!output) return [];
  const results = asRecord(output.testResults);
  const result = results?.[acKey];
  if (result !== "passed" && result !== "failed") return [];
  return [
    {
      taskKey: task.taskKey,
      taskType: task.type,
      ...(task.sliceKey ? { sliceKey: task.sliceKey } : {}),
      expected: "pass",
      result,
      ...(typeof output.testCommand === "string" ? { command: output.testCommand } : {}),
      ...(typeof output.gitCommit === "string" ? { commitSha: output.gitCommit } : {}),
      ...(typeof task.finishedAt === "string" ? { finishedAt: task.finishedAt } : {}),
      authoritative: true
    }
  ];
}

export function buildRequirementTraceability(
  input: TraceabilityInput
): RequirementTraceabilityView {
  const latest = latestExecutions(input.runtimeTasks);

  const criteria = input.criteria.map((criterion) => {
    const mapped = latest.filter((task) => acKeysOf(task).includes(criterion.acKey));
    const testTasks = mapped.filter((task) => task.type === "TEST");
    const refs = [
      ...mapped.flatMap((task) => evidenceRefs(task, criterion.acKey)),
      // 交付前全量证据来自 CI/交付任务（通常不挂 acKeys）——在全部任务输出上检索。
      ...latest.flatMap((task) => authoritativeRefs(task, criterion.acKey))
    ];

    let status: TraceabilityStatus;
    // 判定顺序：绿灯证据（failed 优先）> 无 TEST 任务（no-test）> 未验证；
    // 红灯证据（expected=fail）不参与最终状态判定。
    // F1-5（FX-18/19）：存在交付前全量（authoritative）证据时，以这一次为准（覆盖早期绿灯证据）。
    const green = refs.filter((ref) => ref.expected === "pass");
    const authoritative = green.filter((ref) => ref.authoritative === true);
    const basis = authoritative.length > 0 ? authoritative : green;
    if (basis.some((ref) => ref.result === "failed")) {
      status = "failed";
    } else if (basis.some((ref) => ref.result === "passed")) {
      status = "passed";
    } else if (testTasks.length === 0) {
      status = "no-test";
    } else {
      status = "unverified";
    }

    return {
      acKey: criterion.acKey,
      text: criterion.text,
      priority: criterion.priority,
      smoke: criterion.smoke,
      frKeys: criterion.frKeys,
      status,
      tests: refs
    };
  });

  return {
    requirementId: input.requirementId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total: criteria.length,
      passed: criteria.filter((entry) => entry.status === "passed").length,
      failed: criteria.filter((entry) => entry.status === "failed").length,
      unverified: criteria.filter((entry) => entry.status === "unverified").length,
      noTest: criteria.filter((entry) => entry.status === "no-test").length
    },
    criteria
  };
}

const STATUS_LABEL: Record<TraceabilityStatus, string> = {
  passed: "通过",
  failed: "失败",
  unverified: "未验证",
  "no-test": "无测试覆盖"
};

/** 可选导出：Markdown 渲染（按需生成，不落盘）。 */
export function renderTraceabilityMarkdown(view: RequirementTraceabilityView): string {
  const lines = [
    `# 追溯表（${view.requirementId}）`,
    "",
    `生成时间：${view.generatedAt}`,
    `汇总：共 ${view.summary.total} · 通过 ${view.summary.passed} · 失败 ${view.summary.failed} · 未验证 ${view.summary.unverified} · 无测试覆盖 ${view.summary.noTest}`,
    "",
    "| AC | 优先级 | 状态 | 测试与证据 |",
    "| --- | --- | --- | --- |"
  ];
  for (const entry of view.criteria) {
    const evidence = entry.tests
      .map(
        (ref) =>
          `${ref.taskKey}（${ref.authoritative ? "交付前全量 " : ""}${
            ref.expected === "fail" ? "红灯" : "绿灯"
          } ${ref.result}${ref.command ? `，\`${ref.command}\`` : ""}${
            ref.exitCode !== undefined ? `，exit ${ref.exitCode ?? "null"}` : ""
          }${ref.commitSha ? `，${ref.commitSha.slice(0, 10)}` : ""}）`
      )
      .join("<br>");
    lines.push(
      `| ${entry.acKey} | ${entry.priority ?? "-"} | ${STATUS_LABEL[entry.status]} | ${evidence || "-"} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}
