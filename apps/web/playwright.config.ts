import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
const gatewayPort = Number(process.env.PLAYWRIGHT_GATEWAY_PORT ?? "8877");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Bump from the 5s default so a Next.js dev cold-compile of /threads/[id]
  // (the page weighs ~3k lines) doesn't flake the toHaveURL assertions after
  // a fresh `rm -rf .next`. Tight enough to still surface real client hangs.
  expect: { timeout: 15_000 },
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @lcwa/gateway test:e2e:server -- --port=${gatewayPort}`,
      url: `http://127.0.0.1:${gatewayPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @lcwa/web exec next dev --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
