<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

/**
 * ErrorState（AI-SE Common Component，W5）。
 *
 * 可重试的错误态。改造前每个页面各自内联 `<p class="text-danger">{{ error }}</p>`，
 * 全站只有 2 处能重试（MCPServersView 的「刷新」、WorkflowsView 时间线的「重试」），
 * 其余错误只能靠刷新整页恢复。
 *
 * 配色用语义色三件套（README §8：提示条 = `bg-{名}-bg` + `border-{名}-border` + `text-{名}-foreground`），
 * 实测对比度 danger-foreground / danger-bg = 7.15:1，高于 AA 的 4.5:1。
 *
 * 无障碍：`role="alert"` 让错误被即时播报；重试按钮是真实 `<button>`，
 * 禁用期间文案变「重试中…」，避免重复点击。
 * 组件本身不发起任何请求——重试语义由调用方在 `@retry` 里决定。
 */
const props = withDefaults(
  defineProps<{
    /** 错误文案。由调用方传入 store 的 error，组件不编造任何默认文案。 */
    message: string;
    /** 是否可重试。为 false 时只显示错误，不渲染按钮（用于重试无意义的场景）。 */
    retryable?: boolean;
    /** 重试进行中：按钮禁用并改文案。 */
    retrying?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  {
    retryable: true,
    retrying: false,
    class: ""
  }
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div
    :class="cn('rounded-lg border border-danger-border bg-danger-bg p-6 text-center', props.class)"
    role="alert"
  >
    <p class="m-0 text-body text-danger-foreground">{{ props.message }}</p>
    <div v-if="props.retryable" class="mt-4 flex justify-center">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        :disabled="props.retrying"
        @click="emit('retry')"
      >
        {{ props.retrying ? "重试中…" : "重试" }}
      </Button>
    </div>
  </div>
</template>
