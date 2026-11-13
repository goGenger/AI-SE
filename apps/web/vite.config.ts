import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      // Phase 3-A：shadcn-vue 组件生成产物统一使用 `@/` 前缀导入
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ai-se/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // 内网穿透临时演示用：Vite 6+ 会拦截未知 Host，需放行隧道域名
    allowedHosts: [".trycloudflare.com", ".loca.lt", ".localhost.run", ".cpolar.top"],
    // 前端统一走同源 /api，由 dev server 转发到后端：
    // 1) 隧道访问时不再有跨域问题；2) 远程访客的请求也能到达你本机的后端
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  }
});
