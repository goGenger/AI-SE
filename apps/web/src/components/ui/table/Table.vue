<script setup lang="ts" generic="T extends object">
import type { HTMLAttributes } from "vue";
import { computed, ref, watch } from "vue";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "@lucide/vue";
import { cn } from "@/components/ui/utils";
import { Pagination } from "@/components/ui/pagination";
import { nextSortState, sortRows, type SortState } from "./sort";

/**
 * AI-SE Table（组件库表格）。
 *
 * Phase 12-C：让业务页面**不再书写任何原生 <table>/<thead>/<tr>/<th>/<td> 标记**；
 * 调用方只声明列（columns）+ 数据（rows），单元格内容通过 `#cell-<key>` 具名插槽定制，
 * 未提供插槽的列回退为 `String(row[key])`。
 *
 * Phase 12-E：结构对齐 shadcn-vue 官方表格范式（语义 `<table>` + Token 化的表头/行/单元格），
 * 样式（表头 12px muted、行高 56px、`--border` 分隔线、行 hover、末行无下边框、
 * 窄屏横向滚动）全部集中在组件内部；**内置分页**（`page-size > 0` 时切片并渲染 `Pagination`）。
 *
 * W7（列对齐与排序规范）—— 三条规则在组件内落地，调用方**不要**在 `cellClass` 里再写对齐：
 *   1. **默认左对齐**，只有声明 `align: "right"` 的列才右对齐；右对齐列自动带 `tabular-nums`
 *      （等宽数字，见 `styles/README.md` §1）。数字 / 时间 / 时长 / 操作列一律右对齐。
 *   2. **状态徽标列左对齐**，与文本列同一把「左边缘」的尺子 —— 旧版全表 `text-center`
 *      是「一列名称扫不下去」的直接原因，已在 W7 移除。
 *   3. 声明 `sortable: true` 的列，表头是可点按钮（三态：升序 → 降序 → 取消），
 *      并输出 `aria-sort`。取值默认 `row[key]`，嵌套字段用 `sortValue` 覆盖。
 *
 * 无业务依赖：不访问 API / Store / Router；列文案由调用方传入；分页只输出「共 N 条」这类通用计数文案。
 */
export type TableAlign = "left" | "right";

/**
 * 列声明。`T` 默认 `Record<string, unknown>` 只是为了给出一个可用的默认值；
 * 调用方应写成 `TableColumn<你的行类型>`，这样 `sortValue` 才有类型。
 */
export interface TableColumn<T = Record<string, unknown>> {
  /** 行数据字段名，同时用于 `#cell-<key>` 插槽名 */
  key: string;
  /** 表头文案（由调用方传入） */
  label: string;
  /** 对齐：默认 `left`。数字 / 时间 / 时长 / 操作列传 `right` */
  align?: TableAlign;
  /** 是否可按此列排序（表头变为可点按钮，三态切换） */
  sortable?: boolean;
  /** 排序取值，默认 `row[key]`；嵌套字段或需要归一化时覆盖 */
  sortValue?: (row: T) => unknown;
  /** 可选的表头 / 单元格附加类（列宽等；**不要**在这里写对齐） */
  headClass?: string;
  cellClass?: string;
}

/** 列表页默认每页条数。列表页不必再显式传 `:page-size`，摘要表显式传 `0` 关闭分页。 */
const DEFAULT_PAGE_SIZE = 10;

const props = withDefaults(
  defineProps<{
    columns: TableColumn<T>[];
    rows: T[];
    /** 行 key，必须返回稳定字符串 */
    rowKey: (row: T) => string;
    /** 表格最小宽度（Tailwind 类，默认窄屏横向滚动） */
    minWidth?: string;
    /** 行附加类 */
    rowClass?: string;
    /** 每页条数；`0` 表示不分页（仅用于摘要表，见 `styles/README.md` §14） */
    pageSize?: number;
    /** 控制页码显示范围（传给 Pagination） */
    siblingCount?: number;
    class?: HTMLAttributes["class"];
  }>(),
  {
    minWidth: "min-w-160",
    rowClass: "",
    pageSize: DEFAULT_PAGE_SIZE,
    siblingCount: 1,
    class: ""
  }
);

/** 当前页（可 `v-model:page` 受控；未绑定时由组件内部维护） */
const page = defineModel<number>("page", { default: 1 });

defineSlots<Record<string, (props: { row: T }) => unknown>>();

/** 对齐 → 实际类。字面量写死，Tailwind 才扫得到。 */
const ALIGN_HEAD: Record<TableAlign, string> = { left: "text-left", right: "text-right" };
const ALIGN_CELL: Record<TableAlign, string> = {
  left: "text-left",
  right: "text-right tabular-nums"
};
const ALIGN_BUTTON: Record<TableAlign, string> = { left: "justify-start", right: "justify-end" };

function alignOf(column: TableColumn<T>): TableAlign {
  return column.align ?? "left";
}

const sortState = ref<SortState | null>(null);

const sortedRows = computed(() => {
  const accessors: Record<string, ((row: T) => unknown) | undefined> = {};
  for (const column of props.columns) {
    accessors[column.key] = column.sortValue;
  }
  return sortRows(props.rows, sortState.value, accessors);
});

function toggleSort(key: string): void {
  sortState.value = nextSortState(sortState.value, key);
  page.value = 1;
}

function ariaSort(column: TableColumn<T>): "ascending" | "descending" | "none" | undefined {
  if (!column.sortable) return undefined;
  if (sortState.value?.key !== column.key) return "none";
  return sortState.value.direction === "asc" ? "ascending" : "descending";
}

const paginated = computed(() => props.pageSize > 0);
const totalPages = computed(() =>
  paginated.value ? Math.max(1, Math.ceil(sortedRows.value.length / props.pageSize)) : 1
);
const currentPage = computed(() => Math.min(Math.max(1, page.value), totalPages.value));
const displayRows = computed(() =>
  paginated.value
    ? sortedRows.value.slice(
        (currentPage.value - 1) * props.pageSize,
        currentPage.value * props.pageSize
      )
    : sortedRows.value
);

// 数据变少（如切换筛选/删除末页数据）时把页码收回到有效范围
watch(totalPages, (total) => {
  if (page.value > total) page.value = total;
});

function cellText(row: T, key: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}
</script>

<template>
  <div>
    <div class="overflow-x-auto">
      <table :class="cn('w-full border-collapse', props.minWidth, props.class)">
        <thead>
          <tr class="border-b border-border">
            <th
              v-for="column in props.columns"
              :key="column.key"
              scope="col"
              :aria-sort="ariaSort(column)"
              :class="
                cn(
                  'p-3 text-caption font-semibold text-muted-foreground',
                  ALIGN_HEAD[alignOf(column)],
                  column.headClass
                )
              "
            >
              <button
                v-if="column.sortable"
                type="button"
                :class="
                  cn(
                    // 本项目不含 Tailwind preflight（见 styles/app.css 文件头），
                    // 原生 button 的 UA 外观必须自己关掉，否则表头会变成一个带边框的灰按钮。
                    'cursor-pointer appearance-none border-0 bg-transparent p-0 text-inherit',
                    'inline-flex w-full items-center gap-1',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    ALIGN_BUTTON[alignOf(column)]
                  )
                "
                @click="toggleSort(column.key)"
              >
                <span>{{ column.label }}</span>
                <ArrowUp
                  v-if="sortState?.key === column.key && sortState.direction === 'asc'"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <ArrowDown
                  v-else-if="sortState?.key === column.key"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <ChevronsUpDown v-else class="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
              </button>
              <template v-else>{{ column.label }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in displayRows"
            :key="props.rowKey(row)"
            :class="cn('border-b border-border last:border-b-0 hover:bg-muted', props.rowClass)"
          >
            <td
              v-for="column in props.columns"
              :key="column.key"
              :class="
                cn(
                  'p-3 align-middle text-body',
                  ALIGN_CELL[alignOf(column)],
                  column.cellClass
                )
              "
            >
              <slot :name="`cell-${column.key}`" :row="row">{{ cellText(row, column.key) }}</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="paginated"
      class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p class="m-0 text-secondary text-muted-foreground">共 {{ props.rows.length }} 条</p>
      <Pagination
        v-model:page="page"
        :total="props.rows.length"
        :items-per-page="props.pageSize"
        :sibling-count="props.siblingCount"
      />
    </div>
  </div>
</template>
