<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * LoadingSkeleton（AI-SE Common Component，W5）。
 *
 * 骨架屏的基础条：一个占位脉冲块。`TableSkeleton` 与各页面的加载态由它拼出。
 *
 * 无障碍：本组件永远 `aria-hidden`——它是纯视觉占位，不含信息。
 * 加载中的语义由容器（如 TableSkeleton 的 role="status"）承担。
 * 动画在 `prefers-reduced-motion` 下降级为静态块（占位保留，只停动画）。
 */
const props = withDefaults(
  defineProps<{
    class?: HTMLAttributes["class"];
  }>(),
  {
    class: ""
  }
);
</script>

<template>
  <div
    :class="cn('animate-pulse rounded-sm bg-muted motion-reduce:animate-none', props.class)"
    aria-hidden="true"
  />
</template>
