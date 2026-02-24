import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["test/**/*.integration.test.ts", "test/**/*.integration.test.tsx"],
    passWithNoTests: true,
  },
});
