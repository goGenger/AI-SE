<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/** 同上：未启用 Preflight，段落的 UA 外边距需显式归零。 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <p :class="cn('m-0 text-secondary text-muted-foreground', props.class)">
    <slot />
  </p>
</template>
