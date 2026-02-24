import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
const gatewayPort = Number(process.env.PLAYWRIGHT_GATEWAY_PORT ?? "8877");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
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
      use: { ...devices["iPhone 14"] },
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
      command: `NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:${gatewayPort} pnpm --filter @lcwa/web dev -- --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
