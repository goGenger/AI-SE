<script setup lang="ts">
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { Component, HTMLAttributes } from "vue";
import { computed } from "vue";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  LoaderCircle,
  TriangleAlert
} from "@lucide/vue";
import { cn } from "@/components/ui/utils";

/**
 * StatusBadge（AI-SE Common Component，Phase 3-C；W9 增加图标）。
 *
 * 设计文档 §11：所有业务状态统一使用 StatusBadge 或等价组件。
 * 本组件补齐 tone → 视觉的映射，视觉全部复用既有语义 Token。
 *
 * tone 取值（对应设计文档 §11 的示例状态）：
 *   success → 已完成 / 成功      running → 运行中 / 进行中 / 连接中
 *   pending → 待执行 / 未开始    warning → 等待审批 / 降级
 *   error   → 失败 / 回滚失败    neutral → 已停止 / 已取消 / 已归档
 *
 * ⚠️ 组件只负责「tone → 视觉」，**不做任何业务状态判断**：
 * 业务状态（如 WorkflowStatus / DeploymentStatus）到 tone 的映射属于业务层，
 * 由页面在 Phase 4+ 迁移时自行提供，组件内不出现任何业务枚举或业务文案。
 *
 * W9 —— **三重冗余**：状态同时用**颜色 + 文字 + 图标**表达。
 * 改造前只有颜色 + 文字，色觉障碍用户（约 8% 的男性）在红/绿两族之间无法分辨 ——
 * 「完成」与「失败」的徽标除文字外没有任何形状差异。现在每个 tone 带一枚专属图标
 * （对勾 / 叉 / 三角警示 / 实心点 / 虚线点 / 短横），于是**去色之后依然可区分**。
 * 图标是装饰性的（`aria-hidden`），因为旁边的文字已经朗读过同样的信息。
 */
const statusBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium",
  {
    variants: {
      tone: {
        success: "bg-success-bg text-success",
        running: "bg-info-bg text-info",
        pending: "bg-neutral-bg text-neutral",
        warning: "bg-warning-bg text-warning",
        error: "bg-danger-bg text-danger",
        neutral: "bg-muted text-muted-foreground"
      }
    },
    defaultVariants: {
      tone: "neutral"
    }
  }
);

/** tone → 图标。形状本身携带语义，不依赖颜色。 */
const TONE_ICON: Record<string, Component> = {
  success: CircleCheck,
  running: LoaderCircle,
  pending: CircleDashed,
  warning: TriangleAlert,
  error: CircleX,
  neutral: CircleMinus
};

const props = withDefaults(
  defineProps<{
    tone?: VariantProps<typeof statusBadgeVariants>["tone"];
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "neutral",
    class: ""
  }
);

const icon = computed(() => TONE_ICON[props.tone ?? "neutral"] ?? CircleMinus);
</script>

<template>
  <span :class="cn(statusBadgeVariants({ tone }), props.class)">
    <component :is="icon" class="size-3 shrink-0" aria-hidden="true" />
    <slot />
  </span>
</template>
