<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div :class="cn('p-[var(--card-padding)] pt-0', props.class)">
    <slot />
  </div>
</template>
