import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-se/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url)
      ),
      "@ai-se/database": fileURLToPath(
        new URL("../../packages/database/src/index.ts", import.meta.url)
      ),
      "@ai-se/observability": fileURLToPath(
        new URL("../../packages/observability/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node"
  }
});
