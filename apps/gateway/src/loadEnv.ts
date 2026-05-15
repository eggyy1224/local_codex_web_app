import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Imported for its side effect as the FIRST import in index.ts so the .env is
// applied before any module that reads process.env at import time — notably
// db.ts, whose top-level `createGatewayDb()` reads GATEWAY_DATA_DIR. ESM
// evaluates the dependency graph in import order, so a first side-effect
// import runs before later imports' module init.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

// Only a genuinely absent .env is silent (tests/e2e/CI ship none and pass env
// explicitly). When the file IS present it exists solely to set the
// mobile-critical HOST + CORS_ALLOWLIST. process.loadEnvFile() does NOT throw
// on malformed lines — it silently skips the affected assignments — so a typo
// could otherwise let the gateway start on loopback bind + localhost-only CORS
// and recreate the user's Tailscale "gateway unavailable" with zero
// diagnostic. The post-load assertion turns that into an immediate, explicit
// failure instead.
const REQUIRED_KEYS = ["HOST", "CORS_ALLOWLIST"] as const;

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `${envPath} is present but did not set ${missing.join(", ")} ` +
        "(malformed or incomplete .env). Refusing to start on loopback / " +
        "localhost-only-CORS defaults — that silently breaks Tailscale " +
        "mobile access. Fix the file or remove it to use process.env.",
    );
  }
}
