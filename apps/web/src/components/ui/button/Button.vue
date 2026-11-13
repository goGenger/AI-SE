<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Primitive, type PrimitiveProps } from "reka-ui";
import { cn } from "@/components/ui/utils";
import { type ButtonVariants, buttonVariants } from "./index";

/**
 * AI-SE Button（Phase 12-D：迁移为 shadcn-vue 标准结构）。
 *
 * 实现方式与 shadcn-vue 官方 `Button.vue` 一致：
 *   `reka-ui` 的 `Primitive` 作为根节点（支持 `as` / `as-child`，默认渲染 `<button>`），
 *   视觉全部由 `buttonVariants`（cva）提供并合并调用方 `class`。
 *   迁移前是「硬编码 <button> + Tailwind」，现在根节点可换成 `<a>` / `<RouterLink>` / 任意组件，
 *   且不再需要各页面自己 `:class="buttonVariants(...)"`（旧写法继续可用，未删除导出）。
 *
 * 对外 API 保持兼容（12 处调用零改动）：
 *   · `variant` / `size` / `class` 语义与取值完全不变（`button/index.ts` 的 cva 未改动）
 *   · `disabled`、`type`、`aria-*`、`@click` 等原生属性/事件经属性透传落到根节点
 *   · **新增**（纯增量）：`as` / `as-child`
 *
 * 说明：迁移前组件**不预设** `type`（在 <form> 内默认 submit），本阶段保持不变 —— 默认值只设 `as`。
 */
interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  class?: HTMLAttributes["class"];
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
  variant: "default",
  size: "default",
  class: ""
});
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
