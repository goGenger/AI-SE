<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * SectionHeader（AI-SE Common Component，Phase 3-C）。
 *
 * 结构来源（实测现有页面 `.panel-header`，6 个页面共约 20 处，两种形态都有）：
 *   <div class="panel-header"><h2>历史</h2></div>
 *   <div class="panel-header">
 *     <div><p class="eyebrow">部署详情</p><h2>…</h2></div>
 *     <span class="status-pill">成功</span>
 *   </div>
 * 因此本组件覆盖：eyebrow（可选）+ Title + Actions（可选插槽，放 StatusBadge / Button）。
 *
 * `level` 用于保持标题层级语义（默认 h2；卡片内部可用 h3）。
 * 与 legacy `.panel-header` 的差异：底部间距 14px → `mb-4`（16px，回到设计文档 §5 的 4px 刻度）。
 *
 * 无业务依赖：标题与右侧内容均由调用方提供。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    eyebrow?: string;
    level?: 2 | 3 | 4;
    class?: HTMLAttributes["class"];
  }>(),
  {
    eyebrow: "",
    level: 2,
    class: ""
  }
);
</script>

<template>
  <div :class="cn('mb-4 flex flex-wrap items-center justify-between gap-3', props.class)">
    <div class="min-w-0 overflow-hidden">
      <p v-if="eyebrow" class="m-0 mb-1 text-caption font-semibold uppercase text-muted-foreground">{{ eyebrow }}</p>
      <component :is="`h${level}`" class="m-0 break-words text-section-title text-foreground">{{ title }}</component>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
