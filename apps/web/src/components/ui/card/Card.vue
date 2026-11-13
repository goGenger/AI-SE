<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * Card 容器（docs/design/00-design-system.md §9）：
 * 白底 + 1px border + 12px 圆角（--radius-lg），**默认不加阴影**（§7：普通 Card 优先使用 border）。
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div :class="cn('rounded-lg border border-border bg-card text-card-foreground', props.class)">
    <slot />
  </div>
</template>
