<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import {
  PaginationEllipsis,
  PaginationFirst,
  PaginationLast,
  PaginationList,
  PaginationListItem,
  PaginationNext,
  PaginationPrev,
  PaginationRoot
} from "reka-ui";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal
} from "@lucide/vue";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Pagination（组件库分页，Phase 12-E）。
 *
 * 实现方式与 shadcn-vue 官方 `Pagination` 一致：`reka-ui` 的 Pagination 原语族
 *   `PaginationRoot` → `PaginationList`（`v-slot="{ items }"`）
 *   → `PaginationFirst` / `PaginationPrev` / `PaginationListItem` / `PaginationEllipsis`
 *   → `PaginationNext` / `PaginationLast`
 * 视觉全部使用 AI-SE Design Token（`--border` / `--card` / `--muted` / `--primary` / `--ring`），
 * 与 Button 同一刻度（h-8 小号；圆角 --radius-md）。
 *
 * 受控 / 非受控都支持：`v-model:page`（受控）或 `default-page`（非受控，由原语内部维护）。
 * 当前页高亮不依赖调用方传值 —— 原语会在选中项上输出 `data-selected="true"` + `aria-current="page"`，
 * 本组件直接用 `data-[selected]:` 变体着色，避免重复维护状态。
 *
 * 无业务依赖：不访问 API / Store / Router；页码文案由原语生成（`aria-label="Page N"`），
 * 组件内不写死任何业务文案。
 */
const props = withDefaults(
  defineProps<{
    /** 数据总条数（必需，原语据此计算页数） */
    total: number;
    /** 每页条数（必需） */
    itemsPerPage: number;
    /** 当前页两侧显示的页码数量 */
    siblingCount?: number;
    /** 是否始终显示首页 / 末页与省略号 */
    showEdges?: boolean;
    disabled?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { siblingCount: 1, showEdges: false, disabled: false, class: "" }
);

/** 当前页：`v-model:page`（受控）或组件内部维护（默认第 1 页）。 */
const page = defineModel<number>("page", { default: 1 });

const buttonClass =
  "inline-flex h-8 min-w-8 cursor-pointer appearance-none items-center justify-center gap-1 rounded-md border border-input bg-card px-2 text-secondary font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-[selected]:border-primary data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[selected]:hover:bg-primary-hover";
const ellipsisClass =
  "inline-flex h-8 w-8 items-center justify-center text-secondary text-muted-foreground";
</script>

<template>
  <PaginationRoot
    :total="props.total"
    :items-per-page="props.itemsPerPage"
    :page="page"
    :sibling-count="props.siblingCount"
    :show-edges="props.showEdges"
    :disabled="props.disabled"
    :class="cn('flex w-full items-center justify-center gap-2', props.class)"
    @update:page="page = $event"
  >
    <PaginationList v-slot="{ items }" class="m-0 flex list-none items-center gap-1 p-0">
      <PaginationFirst as="button" :class="buttonClass" aria-label="首页">
        <ChevronsLeft class="size-4" />
      </PaginationFirst>
      <PaginationPrev as="button" :class="buttonClass" aria-label="上一页">
        <ChevronLeft class="size-4" />
      </PaginationPrev>

      <template v-for="(item, index) in items" :key="index">
        <PaginationListItem v-if="item.type === 'page'" :value="item.value" :class="buttonClass">
          {{ item.value }}
        </PaginationListItem>
        <PaginationEllipsis v-else :class="ellipsisClass">
          <MoreHorizontal class="size-4" />
        </PaginationEllipsis>
      </template>

      <PaginationNext as="button" :class="buttonClass" aria-label="下一页">
        <ChevronRight class="size-4" />
      </PaginationNext>
      <PaginationLast as="button" :class="buttonClass" aria-label="末页">
        <ChevronsRight class="size-4" />
      </PaginationLast>
    </PaginationList>
  </PaginationRoot>
</template>
