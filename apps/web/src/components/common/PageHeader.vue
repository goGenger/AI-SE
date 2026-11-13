<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * PageHeader（AI-SE Common Component，Phase 3-C；W5 定型）。
 *
 * 页头区是页面骨架的第一段（见 src/styles/README.md §14）：
 *   标题 + 一句话说明（description）+ 唯一主操作（actions 插槽）。
 *
 * W5 删除了 `eyebrow` prop：它在 11 个页面里零使用，且 W4 的顶栏面包屑
 * 已经承担了「这是哪个分组」的上下文，留着只会是又一个「声明了却没人用」的死代码。
 * 注意 `SectionHeader` 也有一个同名 prop，那是另一个组件，有真实使用，未动。
 *
 * 与 legacy `.page-header` 的差异（有意为之）：
 *   · 标题字号 32px → `--text-page-title`（24px / 600，设计文档 §4 规定 20-24px）
 *   · 底部间距改为 Design Token `--section-gap`（24px），与 legacy 的 24px 一致
 *
 * 无业务依赖：不访问 API / Store / Router / 业务状态，文案全部由调用方传入。
 * 本项目未启用 Preflight，故 h1 / p 显式 `m-0` 归零 UA 外边距。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    description: "",
    class: ""
  }
);
</script>

<template>
  <header :class="cn('mb-[var(--section-gap)] flex flex-wrap items-center justify-between gap-4', props.class)">
    <div class="min-w-0">
      <h1 class="m-0 text-page-title text-foreground">{{ title }}</h1>
      <p v-if="description" class="m-0 mt-1 text-secondary text-muted-foreground">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
