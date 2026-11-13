<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CheckboxIndicator, CheckboxRoot, type CheckboxRootProps } from "reka-ui";
import { Check } from "@lucide/vue";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Checkbox（组件库复选框）。
 *
 * Phase 12-D：由「原生 <input type="checkbox"> + accent-color」迁移为 shadcn-vue 标准实现 ——
 * `reka-ui` 的 `CheckboxRoot` + `CheckboxIndicator`（与 Select 同一套原语来源），
 * 视觉状态全部由 `data-[state=…]` + Design Token 驱动，不再依赖浏览器原生勾选外观。
 *
 * 对外 API 保持兼容（2 处调用零改动：Workflows「需要人工审批」、MCP 绑定「启用」）：
 *   · `v-model` / `v-model:modelValue`：**boolean**（shadcn-vue 原语允许 'indeterminate'，本适配层不产出该值）
 *   · `class` 合并到根节点；`id`、`disabled`、`required`、`name`、`aria-*` 经属性透传落到根节点
 *   · 根节点渲染为可聚焦的 `<button role="checkbox">`，属 HTML「可标记元素」，
 *     因此页面侧 `<label>…<Checkbox/><span>文案</span></label>` 仍可点击文案切换（行为不回归）
 *
 * 本项目未启用 Tailwind Preflight，故 `size-4 / shrink-0 / border` 等 UA 兜底在此显式声明。
 */
const props = withDefaults(
  defineProps<{
    class?: HTMLAttributes["class"];
  }>(),
  { class: "" }
);

const model = defineModel<boolean>({ default: false });

function handleUpdate(value: CheckboxRootProps["modelValue"]) {
  model.value = value === true;
}
</script>

<template>
  <CheckboxRoot
    v-bind="$attrs"
    :model-value="model"
    :class="
      cn(
        'peer size-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-input bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        props.class
      )
    "
    @update:model-value="handleUpdate"
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="size-3" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
