<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Primitive } from "reka-ui";
import { cn } from "@/components/ui/utils";

/**
 * AI-SE Input（Phase 12-E：渲染路径接入组件库原语）。
 *
 * 关于「为什么文本输入仍是原生元素」：
 *   Reka UI / shadcn-vue **没有**纯文本输入 primitive —— 官方 `Input.vue` 本身就是
 *   「原生 `<input>` + 类名」；Reka 只有 TagsInput / PinInput / NumberField / Editable
 *   这类**不同语义**的输入控件。因此这里保留原生元素作为语义载体，但把渲染路径改为
 *   Reka 的 `Primitive`（`as-child` 合并属性/事件），与 Button / Label / Select 同一套原语来源。
 *
 * 行为保持：`v-model` 仍**直接绑在原生 `<input>`** 上 ⇒ IME 组合输入、`.trim` / `.number`
 * 修饰符、原生校验与聚焦语义与迁移前完全一致。
 *
 * 状态表达（全部为标准 HTML/ARIA，可由使用方直接控制）：
 *   · focus-visible → 2px Primary ring
 *   · disabled      → 原生 disabled 属性（禁用光标 + 降低不透明度）
 *   · invalid       → 传入 aria-invalid="true" 即呈现危险色描边
 *
 * 本项目未启用 Preflight：UA 默认的 input 边框/内距/背景/文字色均已在此显式覆盖；
 * 字体族由基础层（styles/app.css 的 `@layer base`）的
 * `button, input, select, textarea { font: inherit }` 继承。
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();

const model = defineModel<string | number>({ default: "" });
</script>

<template>
  <Primitive as-child>
    <input
      v-model="model"
      :class="
        cn(
          'flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-body text-foreground transition-colors placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
          props.class
        )
      "
    />
  </Primitive>
</template>

