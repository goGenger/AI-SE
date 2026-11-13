<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * ConfirmDialog（W8）—— 全站**唯一**的危险操作确认方式。
 *
 * 改造前有三种：`ProjectsView` 的行内二次确认、两处 `window.confirm()`、以及若干完全没有确认。
 * 前两者都有实质问题 —— 行内确认在详情页 / 页头动作里没有落点，`window.confirm()` 无法使用
 * 设计令牌、无法显示错误、阻塞主线程，并且与整个产品的外观割裂。本组件把「危险操作确认」
 * 收敛成一个组件：**用 `Dialog` 原语，危险按钮用 danger 语义色**。
 *
 * 与 `Dialog` 的分工：`Dialog` 负责「轻量新建 / 编辑」这类**中性**任务，本组件负责**破坏性**任务
 * （删除、撤销、解绑）。两者的可访问行为完全一致（同一套 Reka Dialog 原语：Esc 关闭、
 * 打开时焦点进入、关闭后返回触发元素、模态时焦点不逃出）。
 *
 * `description` 是**必填**：确认框必须在按下之前说清后果（「确定删除该项目吗？」不够，
 * 「删除后不可恢复」才够）。这条约束由类型强加，不靠自觉。
 *
 * 受控开合：`v-model:open`。触发按钮**不由本组件渲染** —— 列表里是每行一个按钮，用受控开合
 * 才能只挂一个对话框实例。
 */
const props = withDefaults(
  defineProps<{
    /** 确认框标题（同时是可访问名称） */
    title: string;
    /** 后果说明（必填）：按下确认之前必须让人知道会发生什么 */
    description: string;
    /** 确认按钮文案 */
    confirmLabel?: string;
    /** 取消按钮文案 */
    cancelLabel?: string;
    /** `busy` 时的确认按钮文案 */
    busyLabel?: string;
    /** 请求进行中：确认按钮禁用并改文案，防重复提交 */
    busy?: boolean;
    /** 失败信息：非空时显示在按钮上方，对话框保持打开 */
    error?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    confirmLabel: "确认",
    cancelLabel: "取消",
    busyLabel: "处理中…",
    busy: false,
    error: "",
    class: ""
  }
);

const emit = defineEmits<{ confirm: [] }>();

/** 开合状态：`v-model:open`（受控）或组件内部维护。 */
const open = defineModel<boolean>("open", { default: false });

const confirmText = computed(() => (props.busy ? props.busyLabel : props.confirmLabel));
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="props.title"
    :description="props.description"
    :class="props.class"
  >
    <div class="grid gap-4">
      <slot />

      <p v-if="props.error" role="alert" class="m-0 text-body text-danger">{{ props.error }}</p>

      <div class="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" :disabled="props.busy" @click="open = false">
          {{ props.cancelLabel }}
        </Button>
        <Button type="button" variant="destructive" :disabled="props.busy" @click="emit('confirm')">
          {{ confirmText }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>
