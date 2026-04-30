import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/": `${fileURLToPath(new URL("./src/", import.meta.url))}`,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts"],
    },
  },
});
