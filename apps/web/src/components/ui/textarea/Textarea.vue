<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Primitive } from "reka-ui";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Textarea（Phase 12-E：渲染路径接入组件库原语）。
 *
 * 与 Input 同源：Reka / shadcn-vue 没有多行文本输入 primitive（官方 `Textarea.vue` 同为
 * 「原生 `<textarea>` + 类名」），故保留原生语义载体，渲染路径改走 Reka `Primitive`
 * （`as-child` 合并属性/事件）。`v-model` 直接绑在原生元素上 ⇒ IME / 修饰符 / 聚焦语义不变。
 * 状态与 Input 一致（focus-visible / disabled / aria-invalid）。
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();

const model = defineModel<string | number>({ default: "" });
</script>

<template>
  <Primitive as-child>
    <textarea
      v-model="model"
      :class="
        cn(
          'flex min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 text-body text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
          props.class
        )
      "
    />
  </Primitive>
</template>
