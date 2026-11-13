<script setup lang="ts">
import { RouterView } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";

/**
 * 全局 AppShell（docs/design/03-page-layout.md §1）：
 *
 *   AppShell
 *   ├── AppSidebar   （164px，Token --app-sidebar-width）
 *   ├── AppHeader    （52px，Token --app-header-height）
 *   └── Main          （= PageContainer 职责，Token --app-main-padding = 20px）
 *       └── RouterView
 *
 * Main 承担 PageContainer 的全部职责，因此**不单独新建 PageContainer.vue**：
 *   · 页面内距 20px        → p-[var(--app-main-padding)]
 *   · 主内容区背景          → bg-background（= --background，见 styles/app.css）
 *   · min-height           → 根节点 min-h-screen + main flex-1（等价于设计文档的 calc(100vh - Header)）
 *   · 水平收缩             → min-w-0（避免宽内容把布局撑破）
 *   · 页面最大宽度         → 目前全站无内容宽度约束（各页面根节点均为裸 <section>）；
 *                            统一的最大宽度由 W4 的 PageContainer 承担
 *
 * AppShell 不持有任何业务数据，只负责骨架与布局；RouterView 的渲染方式未做任何改动。
 */
</script>

<template>
  <div class="flex min-h-screen bg-background">
    <AppSidebar />

    <div class="flex min-w-0 flex-1 flex-col">
      <AppHeader />

      <main class="min-w-0 flex-1 bg-background p-[var(--app-main-padding)]">
        <RouterView />
      </main>
    </div>
  </div>
</template>
