<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "reka-ui";
import { X } from "@lucide/vue";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Dialog（组件库弹窗，Reka UI Dialog 原语族）。
 *
 * 实现方式与 shadcn-vue 官方 `Dialog` 同构：
 *   DialogRoot → DialogTrigger（可选插槽，as-child）
 *   → DialogPortal → DialogOverlay + DialogContent（DialogTitle / DialogDescription / DialogClose）。
 * 视觉全部使用 AI-SE Design Token（--card / --border / --card-padding / --shadow-overlay / --radius-lg）。
 *
 * 两个刻意的实现决定（与官方默认不同，服务本仓库的行为稳定性与可测性）：
 *   1) `unmount-on-hide="false"`：关闭时内容保持挂载、由 Reka 以 `display:none` 隐藏。
 *      · 表单字段值在反复开关之间保持（调用方不需要另存草稿）；
 *      · SSR 契约测试（vue/server-renderer 字符串断言，本仓库测试惯例）仍能读到弹窗内容；
 *      · 关闭态安全：Reka 在 `present=false` 时不接管焦点、不拦截 Esc / 外部点击、
 *        不禁用页面指针事件（已核对 DialogContent / DismissableLayer 源码）。
 *   2) `force-mount`（Portal）：SSR / 首帧即输出 Teleport 内容 —— 本应用为纯客户端渲染，
 *      该开关只影响挂载时机，使上述 SSR 测试可见。
 *
 * 受控 / 非受控都支持：`v-model:open`（受控）或组件内部维护（默认关闭）。
 * 无业务依赖：不访问 API / Store / Router；标题与正文全部由调用方传入。
 */
const props = withDefaults(
  defineProps<{
    /** 标题（必需）：同时作为弹窗的可访问名称（aria-labelledby 指向它）。 */
    title: string;
    /** 说明文案（可选）：提供时渲染为 aria-describedby 目标；未提供时移除该属性避免悬空引用。 */
    description?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { description: "", class: "" }
);

/** 开合状态：`v-model:open`（受控）或组件内部维护（默认关闭）。 */
const open = defineModel<boolean>("open", { default: false });

const panelClass =
  "fixed left-1/2 top-1/2 z-50 flex max-h-[min(85vh,900px)] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-[var(--shadow-overlay)]";
const headerClass =
  "flex items-start justify-between gap-4 border-b border-border px-[var(--card-padding)] py-4";
const bodyClass = "min-h-0 flex-1 overflow-y-auto px-[var(--card-padding)] py-4";
</script>

<template>
  <DialogRoot v-model:open="open" :unmount-on-hide="false">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>

    <DialogPortal force-mount>
      <DialogOverlay class="fixed inset-0 z-50 bg-foreground/40" />
      <DialogContent
        v-bind="props.description ? {} : { 'aria-describedby': null }"
        :class="cn(panelClass, props.class)"
      >
        <header :class="headerClass">
          <div class="min-w-0">
            <DialogTitle class="m-0 text-section-title text-foreground">{{
              props.title
            }}</DialogTitle>
            <DialogDescription
              v-if="props.description"
              class="m-0 mt-1 text-secondary text-muted-foreground"
            >
              {{ props.description }}
            </DialogDescription>
          </div>
          <DialogClose
            :class="cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'shrink-0')"
            aria-label="关闭"
          >
            <X class="size-4" />
          </DialogClose>
        </header>
        <div :class="bodyClass">
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
