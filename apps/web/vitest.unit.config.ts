import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["test/**/*.unit.test.ts", "test/**/*.unit.test.tsx"],
    passWithNoTests: true,
  },
});
