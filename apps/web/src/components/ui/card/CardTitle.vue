<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * 注意：本项目**未启用 Tailwind Preflight**，浏览器默认的 h3 外边距仍然存在，
 * 因此这里显式 `m-0` 归零，避免卡片标题出现意外间距。
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <h3 :class="cn('m-0 text-section-title text-card-foreground', props.class)">
    <slot />
  </h3>
</template>
