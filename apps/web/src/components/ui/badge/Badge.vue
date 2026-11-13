<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";
import { type BadgeVariants, badgeVariants } from "./index";

/**
 * AI-SE Badge（Phase 3-B）：纯展示组件，无业务依赖。
 * 文案由使用方提供（不在组件内写死业务文案）。
 */
const props = withDefaults(
  defineProps<{
    variant?: BadgeVariants["variant"];
    class?: HTMLAttributes["class"];
  }>(),
  {
    variant: "default",
    class: ""
  }
);
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), props.class)">
    <slot />
  </span>
</template>
