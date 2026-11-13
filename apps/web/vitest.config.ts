import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Phase 3-B：组件契约测试需要渲染 .vue 单文件组件（此前无任何渲染测试，故未接入）。
  // 插件已存在于 devDependencies（vite.config.ts 也在使用），未新增依赖。
  plugins: [vue()],
  resolve: {
    alias: {
      // Phase 3-A：与 vite.config.ts 保持一致的 `@/` 别名，避免测试与构建解析不一致
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ai-se/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
