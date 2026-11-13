<script setup lang="ts">
import AppShell from "./components/layout/AppShell.vue";

/**
 * Phase 2-A：根组件只挂载 AppShell。
 * 新 AppShell = AppSidebar（164px）+ AppHeader（52px）+ Main（RouterView）。
 * 菜单项、路由、业务页面内容均未改动。
 */
</script>

<template>
  <AppShell />
</template>
