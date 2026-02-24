import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/helpers.ts', 'src/app.ts'],
      thresholds: {
        lines: 80,
        branches: 75
      }
    }
  }
});
