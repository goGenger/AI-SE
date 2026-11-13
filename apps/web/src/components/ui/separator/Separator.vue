<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Separator as SeparatorPrimitive, type SeparatorProps } from "reka-ui";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Separator（Phase 12-D：迁移为 shadcn-vue 标准结构）。
 *
 * 实现方式与 shadcn-vue 官方 `Separator.vue` 一致：`reka-ui` 的 `Separator` 原语
 * （输出 `role="separator"` + `data-orientation`，垂直时附 `aria-orientation`）。
 *
 * ⚠️ 与 shadcn-vue 默认值的**唯一差异**：`decorative` 默认 **false**（shadcn-vue 默认 true）。
 *   `decorative: true` 会让原语输出 `role="none"`，从而丢掉迁移前已有的无障碍语义
 *   （`role="separator"` + 垂直时的 `aria-orientation`，由既有契约测试锁定）。
 *   本阶段要求「保持现有 API / 行为」，故保留原语义；调用方仍可显式传 `decorative` 覆盖。
 *
 * 对外 API 保持兼容：`orientation`（默认 horizontal）、`class`；
 * 视觉类字符串与迁移前逐字一致（`shrink-0 bg-border` + 1px 横/竖）。
 */
const props = withDefaults(
  defineProps<
    SeparatorProps & {
      class?: HTMLAttributes["class"];
    }
  >(),
  {
    orientation: "horizontal",
    decorative: false,
    class: ""
  }
);
</script>

<template>
  <SeparatorPrimitive
    :orientation="props.orientation"
    :decorative="props.decorative"
    :as="props.as"
    :as-child="props.asChild"
    :class="
      cn(
        'shrink-0 bg-border',
        props.orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full',
        props.class
      )
    "
  />
</template>
