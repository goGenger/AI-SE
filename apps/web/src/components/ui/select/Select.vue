<script setup lang="ts" generic="V extends string = string">
import type { HTMLAttributes } from "vue";
import { computed, useAttrs } from "vue";
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport
} from "reka-ui";
import { Check, ChevronDown } from "@lucide/vue";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Select（组件库下拉选择，Phase 12-D-0：接入 shadcn-vue / Reka UI Primitive）。
 *
 * 实现：`reka-ui@2.10.4` 的 Select 原语族
 *   SelectRoot → SelectTrigger → SelectValue / SelectIcon
 *   SelectPortal → SelectContent → SelectViewport → SelectItem → SelectItemIndicator + SelectItemText
 * 依赖已存在于 package.json（reka-ui 2.10.4），本阶段未新增任何依赖。
 *
 * 调用方 API 与 12-C 完全一致（5 处调用零改动）：
 *   v-model（泛型 V extends string，可直接绑定 DeliveryEnvironment / WorkflowFailureStrategy 等联合类型）
 *   options: SelectOption[]、class、id、required、disabled、aria-*（其余属性透传到触发器）
 *
 * 两个必须由组件内部吸收的差异（否则会破坏调用方契约）：
 *   1) **空值选项**：reka-ui 的 SelectItem 明确禁止 `value === ""`
 *      （源码：`if (props.value === "") throw new Error("A <SelectItem /> must have a value prop that is not an
 *      empty string…")` —— 空串在 Radix/Reka 语义中表示"清空选择 + 显示 placeholder"）。
 *      而本仓库 5 处调用都把空值当成一个**可见选项**（「选择项目」/「选择已分析的需求」），且 v-model 初值就是 ""。
 *      故组件内部把 "" 映射为私有哨兵值，回传时再还原：触发器显示占位选项的 label（与迁移前的原生 <select> 一致），
 *      选中该选项 → emit ""（可清空），调用方把 v-model 设为 "" → 触发器显示占位选项 label。
 *      注：哨兵值只在组件内部存在，不会泄漏到 v-model；仅当调用方额外传 `name`（表单提交）时，
 *      隐藏的原生 select 会带出哨兵而非 ""（本仓库当前 5 处调用均未传 name，故无影响）。
 *   2) **required**：自定义下拉的触发器是 <button>，不再是可校验的表单控件，故 `required` 同时
 *      (a) 透传给 SelectRoot（reka 会渲染隐藏的原生 select 参与表单语义）与
 *      (b) 显式落到触发器的 `aria-required`。
 *      浏览器原生的"请选择一个项目"提示气泡不再出现（这是所有自定义下拉的固有限制）；
 *      各页面既有的 JS 守卫（create() / saveEnvironment() 的空值早退）保持不变。
 *
 * 无业务依赖：不访问 API / Store / Router，不写死任何业务文案（选项与占位全部由调用方传入）。
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    options: SelectOption[];
    /** 无匹配选项时的兜底文案（本仓库调用方都把空值作为可见选项，故默认不用）。 */
    placeholder?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { placeholder: "", class: "" }
);

const model = defineModel<V>({ required: true });

/** id / aria-* / 其它原生属性 → 触发器；required / disabled / name → SelectRoot。 */
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const ROOT_ATTRS = ["required", "disabled", "name", "class"];
const triggerAttrs = computed(() =>
  Object.fromEntries(Object.entries(attrs).filter(([key]) => !ROOT_ATTRS.includes(key)))
);

/** reka-ui SelectItem 不接受空串，故内部用哨兵承载"空值选项"。 */
const EMPTY_VALUE = "__ai_se_empty__";
const toInternal = (value: string) => (value === "" ? EMPTY_VALUE : value);
const internalValue = computed(() => toInternal(model.value as string));

function handleUpdate(value: unknown) {
  const next = value === EMPTY_VALUE || value === null || value === undefined ? "" : String(value);
  model.value = next as V;
}

/** 触发器显示文案：由 v-model 与 options 推导（SSR 也能渲染，与原生 select 的显示规则一致）。 */
const selectedLabel = computed(
  () => props.options.find((option) => option.value === (model.value as string))?.label ?? props.placeholder
);

const triggerClass =
  "flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-body text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";
const contentClass =
  "z-50 max-h-[min(20rem,var(--reka-select-content-available-height))] min-w-32 overflow-hidden rounded-md border border-border bg-card text-foreground shadow-[var(--shadow-overlay)]";
const itemClass =
  "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-body text-foreground outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-60";</script>

<template>
  <SelectRoot
    :model-value="internalValue"
    :required="attrs.required !== undefined ? true : undefined"
    :disabled="attrs.disabled !== undefined"
    :name="typeof attrs.name === 'string' ? attrs.name : undefined"
    @update:model-value="handleUpdate"
  >
    <SelectTrigger
      v-bind="triggerAttrs"
      :aria-required="attrs.required !== undefined ? 'true' : undefined"
      :class="cn(triggerClass, props.class)"
    >
      <SelectValue :placeholder="props.placeholder">{{ selectedLabel }}</SelectValue>
      <SelectIcon as-child>
        <ChevronDown class="size-4 shrink-0 opacity-60" />
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :class="contentClass"
        :style="{ width: 'var(--reka-select-trigger-width)' }"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="option in props.options"
            :key="option.value"
            :value="toInternal(option.value)"
            :disabled="option.disabled"
            :class="itemClass"
          >
            <SelectItemIndicator class="absolute left-2 flex size-4 items-center justify-center">
              <Check class="size-4" />
            </SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

