import { defineConfig } from "vitest/config";

// 组件测试要有 DOM；纯逻辑测试在 jsdom 下照常运行。
// 依赖由夹具提供：被测项目不需要（也不应该）自己加测试工具链。
export default defineConfig({ test: { environment: "jsdom" } });
