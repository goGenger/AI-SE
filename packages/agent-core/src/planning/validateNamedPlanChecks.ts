export interface NamedPlanCheckItem {
  id: string;
  acceptanceCriteria?: string[] | undefined;
}

/**
 * docs/268：每个切片 / 任务必须点名一项能证明做完的检查（验收标准或官方门禁）。
 * 空缺或只含空白字符串的检查视为不完整的计划项。
 */
export function validateNamedPlanChecks(input: {
  items: ReadonlyArray<NamedPlanCheckItem>;
  kind: "slice" | "task";
}): string[] {
  const label = input.kind === "slice" ? "Slice" : "Task";
  const errors: string[] = [];
  for (const item of input.items) {
    const checks = (item.acceptanceCriteria ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (checks.length === 0) {
      errors.push(
        `${label} ${item.id} has no named verification check (acceptanceCriteria is empty).`
      );
    }
  }
  return errors;
}
