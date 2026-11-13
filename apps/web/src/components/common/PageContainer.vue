<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * PageContainer（AI-SE Common Component）—— 全站唯一的页面宽度来源。
 *
 * 为什么需要它：改造前 11 个页面的根节点清一色是裸 `<section>`，**全站没有任何内容宽度
 * 约束**，宽屏下表格与正文会被一路拉到屏幕边缘。
 *
 * 宽度只有两档（写进 `styles/README.md` §3）：
 *   · `default` 1200px —— 正文 / 表单 / 详情型页面
 *   · `wide`    1440px —— 表格 / 多列型列表页
 *
 * 内距与页头间距**不在这里**：
 *   · 内距由 AppShell 的 `<main>` 统一提供（`--app-main-padding`）；
 *   · 页头区与内容区的间距由 PageHeader 自己的 `mb-[var(--section-gap)]` 提供。
 * 两处都已统一，本组件不再重复，避免同一间距被叠加两次。
 *
 * 无业务依赖：不访问 API / Store / Router。
 */
const props = withDefaults(
  defineProps<{
    width?: "default" | "wide";
    class?: HTMLAttributes["class"];
  }>(),
  { width: "default", class: "" }
);
</script>

<template>
  <section
    :class="
      cn(
        'mx-auto w-full',
        props.width === 'wide'
          ? 'max-w-[var(--app-content-width-wide)]'
          : 'max-w-[var(--app-content-width)]',
        props.class
      )
    "
  >
    <slot />
  </section>
</template>
