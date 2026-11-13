<script setup lang="ts">
import type { Component, HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * EmptyState（AI-SE Common Component，Phase 3-C）。
 *
 * 真实用法（实测）：`.empty` 在 11 个业务页面共出现约 25 次，形态一致 ——
 * 白底卡片 + 1px 边框 + 8px 圆角 + 居中灰色文字，多为单句文案（如「暂无项目。」），
 * 另有 `.compact-empty` 变体（仅内距更小，用于面板内部）。
 *
 * 设计文档 §10 规定结构为 Icon + Title + Description + Action，因此：
 *   · title / description 为可选 prop（当前页面大多数只用到 title）
 *   · icon 由调用方传入组件（如 @lucide/vue 图标），组件不内置任何图标
 *   · action 走 `actions` 插槽（放 Button）
 * 圆角按设计文档 §9 的 Card 规范取 12px（legacy 为 8px）。
 *
 * 无业务依赖：不写死任何业务文案。
 */
const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    icon?: Component;
    size?: "default" | "compact";
    class?: HTMLAttributes["class"];
  }>(),
  {
    title: "",
    description: "",
    icon: undefined,
    size: "default",
    class: ""
  }
);
</script>

<template>
  <div
    :class="
      cn(
        'rounded-lg border border-border bg-card text-center',
        size === 'compact' ? 'p-4' : 'p-6',
        props.class
      )
    "
  >
    <component :is="icon" v-if="icon" class="mx-auto mb-3 size-5 text-foreground-disabled" />
    <p v-if="title" class="m-0 text-body text-foreground">{{ title }}</p>
    <p v-if="description" class="m-0 text-secondary text-muted-foreground" :class="title ? 'mt-1' : ''">
      {{ description }}
    </p>
    <div v-if="$slots.actions" class="mt-4 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
