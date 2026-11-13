import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  // 预览只监听本机，端口由 `start` 脚本的 PORT 决定（夹具契约，见 docs/233 §3.2）。
  preview: { host: "127.0.0.1", strictPort: true }
});
