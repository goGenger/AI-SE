/**
 * Table 排序的比较器与状态机（纯逻辑，可独立测试）。
 *
 * 与 `Table.vue` 同目录：这是组件库内部的实现细节，不对外导出为公共 API，
 * 也不属于业务判断（不依赖任何业务枚举 / Store / API），所以不放进 `viewmodels/`。
 */

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: string;
  direction: SortDirection;
}

/**
 * 表头点击的三态切换：未排序 → 升序 → 降序 → 未排序。
 * 点另一列时直接进入该列升序（不保留上一列的降序）。
 */
export function nextSortState(current: SortState | null, key: string): SortState | null {
  if (current === null || current.key !== key) {
    return { key, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { key, direction: "desc" };
  }
  return null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * 通用比较：两边都是数字按数值，其余按语言敏感的字符串序
 * （`numeric: true` 让「第 2 版」排在「第 10 版」之前；ISO 日期串按字典序即时间序）。
 */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), "zh-Hans-CN", { numeric: true });
}

/**
 * 按排序状态重排行。
 *
 * - `accessors` 给需要自定义取值的列（如行内嵌套字段）覆盖默认的 `row[key]`。
 * - **空值恒定排在末尾**，不随升降序翻转 —— 否则降序时一整列空白会顶到最上面。
 * - 不改动入参（返回新数组）；同值时保持原相对顺序（`Array.prototype.sort` 在现代引擎中稳定）。
 */
export function sortRows<T extends object>(
  rows: T[],
  state: SortState | null,
  accessors: Record<string, ((row: T) => unknown) | undefined> = {}
): T[] {
  if (state === null) {
    return rows;
  }
  const accessor = accessors[state.key];
  const valueOf = (row: T): unknown =>
    accessor ? accessor(row) : (row as Record<string, unknown>)[state.key];

  const sorted = [...rows].sort((left, right) => {
    const a = valueOf(left);
    const b = valueOf(right);
    if (isBlank(a) && isBlank(b)) return 0;
    if (isBlank(a)) return 1;
    if (isBlank(b)) return -1;
    const result = compareValues(a, b);
    return state.direction === "asc" ? result : -result;
  });
  return sorted;
}
