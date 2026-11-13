<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div :class="cn('flex flex-col gap-1.5 p-[var(--card-padding)]', props.class)">
    <slot />
  </div>
</template>
