<script setup lang="ts">
// mutant `empty-shell`（docs/233 §3.5 / §6.2 第 3 条）：与 reference 相同，但 `/` 只渲染空容器。
// 反向门必须命中：oracle 应当大面积失败，`uiSmoke` 应当报 `SURFACE_MISSING`。
</script>

<template>
  <div id="app-root"></div>
</template>
