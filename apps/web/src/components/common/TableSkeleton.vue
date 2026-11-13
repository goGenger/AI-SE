<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";
import LoadingSkeleton from "./LoadingSkeleton.vue";

/**
 * TableSkeleton（AI-SE Common Component，W5）。
 *
 * 列表页加载态的骨架屏，形状与 `Table` 的数据态一致（同款 Card 容器 + 表头行 + N 个数据行），
 * 所以加载完成时不会有布局跳动。
 *
 * 列宽用 `flex-1` 均分而不是动态 `grid-template-columns`——
 * 既不需要内联 style，也不引入新的任意值。
 *
 * 无障碍：容器 `role="status"` + `aria-label` 让屏幕阅读器播报「加载中」，
 * 内部的占位条由 LoadingSkeleton 自行 `aria-hidden`。
 */
const props = withDefaults(
  defineProps<{
    /** 占位列数。调用方传真实表格的列数（如 `columns.length`）。 */
    columns?: number;
    /** 占位数据行数。 */
    rows?: number;
    class?: HTMLAttributes["class"];
  }>(),
  {
    columns: 4,
    rows: 5,
    class: ""
  }
);
</script>

<template>
  <div
    :class="cn('rounded-lg border border-border bg-card p-3', props.class)"
    role="status"
    aria-label="加载中"
  >
    <div class="grid gap-3">
      <!-- 第 1 行是表头（略矮），其余为数据行 -->
      <div v-for="row in props.rows + 1" :key="row" class="flex items-center gap-4">
        <LoadingSkeleton
          v-for="column in props.columns"
          :key="column"
          :class="cn('flex-1', row === 1 ? 'h-3' : 'h-4')"
        />
      </div>
    </div>
  </div>
</template>
