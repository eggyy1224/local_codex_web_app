import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["test/**/*.unit.test.ts", "test/**/*.unit.test.tsx", "test/**/*.integration.test.ts", "test/**/*.integration.test.tsx"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/**/*.ts", "app/**/*.tsx"],
      exclude: ["app/layout.tsx"],
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
  },
});
