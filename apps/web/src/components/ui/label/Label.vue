<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Label as LabelPrimitive, type LabelProps } from "reka-ui";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Label（Phase 12-D：迁移为 shadcn-vue 标准结构）。
 *
 * 实现方式与 shadcn-vue 官方 `Label.vue` 一致：`reka-ui` 的 `Label` 原语
 * （内部渲染 `<label>`，并支持 `as` / `as-child`、`for` 关联、文本选择抑制）。
 *
 * 对外 API 保持兼容（26 处调用零改动）：
 *   · `class` 合并；`for`、`aria-*` 等经属性透传落到 <label>
 *   · 视觉类字符串与迁移前**逐字一致**（text-secondary / font-medium / peer-disabled 兜底）
 *   · **新增**（纯增量）：`as` / `as-child`
 */
const props = withDefaults(
  defineProps<
    LabelProps & {
      class?: HTMLAttributes["class"];
    }
  >(),
  { class: "" }
);
</script>

<template>
  <LabelPrimitive
    :for="props.for"
    :as="props.as"
    :as-child="props.asChild"
    :class="
      cn(
        'inline-block select-none text-secondary font-medium text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
        props.class
      )
    "
  >
    <slot />
  </LabelPrimitive>
</template>
