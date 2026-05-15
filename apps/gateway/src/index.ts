import { fileURLToPath } from "node:url";
import { AppServerClient } from "./appServerClient.js";
import {
  createGatewayApp,
  createGatewayBootstrapConfigFromEnv,
} from "./gatewayApp.js";

// Load apps/gateway/.env (HOST, CORS_ALLOWLIST, …) before reading config, so
// every restart — manual, tsx-watch reload, or plain `pnpm dev` — picks up the
// binding/origin settings. Without it the defaults are loopback-only with
// localhost-only CORS, which silently breaks the user's Tailscale mobile
// access. Guarded: a missing .env is a no-op (tests/e2e/CI ship none and pass
// env explicitly).
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env present — use process.env / built-in defaults
}

const bootstrap = createGatewayBootstrapConfigFromEnv(process.env);
const app = await createGatewayApp(
  {
    appServer: new AppServerClient(),
  },
  bootstrap.app,
);

await app.listen({ host: bootstrap.host, port: bootstrap.port });
