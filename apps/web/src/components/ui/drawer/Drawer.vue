<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle
} from "reka-ui";
import { X } from "@lucide/vue";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Drawer（组件库抽屉，Reka UI Dialog 原语族 + 右侧贴边版式）。
 *
 * 实现方式与 shadcn-vue 官方 `Sheet`（side="right"）一致：与 `components/ui/dialog`
 * 共用同一套 Reka Dialog 原语（遮罩 / 焦点接管 / Esc / 外部点击关闭），
 * 仅把内容面板固定在视口右侧（inset-y-0 right-0，全高）。
 * 选择 Dialog 原语而非 Reka 的手势 Drawer 原语：本控制台是桌面端工具，
 * 无滑动/吸附（snap point）语义，保持与 Dialog 同一行为面，避免第二套交互机制。
 *
 * 与 Dialog 相同的两个实现决定（原因见 `components/ui/dialog/Dialog.vue` 注释）：
 *   · `unmount-on-hide="false"` —— 关闭时内容保持挂载并以 `display:none` 隐藏；
 *   · Portal `force-mount` —— SSR / 首帧即输出 Teleport 内容。
 *
 * 受控 / 非受控都支持：`v-model:open`（受控）或组件内部维护（默认关闭）。
 * 无业务依赖：不访问 API / Store / Router；标题与正文全部由调用方传入。
 */
const props = withDefaults(
  defineProps<{
    /** 标题（必需）：同时作为抽屉的可访问名称（aria-labelledby 指向它）。 */
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
  "fixed inset-y-0 right-0 z-50 flex h-full w-[40%] flex-col overflow-hidden border-l border-border bg-card text-foreground shadow-[var(--shadow-overlay)]";
const headerClass =
  "flex items-start justify-between gap-4 border-b border-border px-[var(--card-padding)] py-4";
const bodyClass = "min-h-0 flex-1 overflow-y-auto px-[var(--card-padding)] py-4";
</script>

<template>
  <DialogRoot v-model:open="open" :unmount-on-hide="false">
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
