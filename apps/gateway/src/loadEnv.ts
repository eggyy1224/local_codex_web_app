import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Imported for its side effect as the FIRST import in index.ts so the .env is
// applied before any module that reads process.env at import time — notably
// db.ts, whose top-level `createGatewayDb()` reads GATEWAY_DATA_DIR. ESM
// evaluates the dependency graph in import order, so a first side-effect
// import runs before later imports' module init.
//
// Only a genuinely absent .env is silent (tests/e2e/CI ship none and pass env
// explicitly). A present-but-unreadable or malformed .env must fail fast:
// silently falling back to loopback bind + localhost-only CORS recreates the
// user's Tailscale "gateway unavailable" with zero diagnostic.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
