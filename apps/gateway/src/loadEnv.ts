import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Imported for its side effect as the FIRST import in index.ts so the .env is
// applied before any module that reads process.env at import time — notably
// db.ts, whose top-level `createGatewayDb()` reads GATEWAY_DATA_DIR. ESM
// evaluates the dependency graph in import order, so a first side-effect
// import runs before later imports' module init.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

// This .env exists solely to set the mobile-critical HOST + CORS_ALLOWLIST.
// process.loadEnvFile() silently skips malformed lines rather than throwing,
// and a post-load check against process.env is unreliable because a shell /
// launcher that already exports these would mask a broken file. So validate
// the FILE's own contents (independent of process.env): a present .env must
// parse cleanly and define the required keys, otherwise fail fast instead of
// silently degrading to loopback bind + localhost-only CORS (which breaks the
// user's Tailscale mobile access with no diagnostic). Only a genuinely absent
// file is silent — tests/e2e/CI ship none and pass env explicitly.
const REQUIRED_KEYS = ["HOST", "CORS_ALLOWLIST"] as const;
// Matches the simple `KEY=VALUE` (optional `export `) format this .env uses.
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

if (existsSync(envPath)) {
  const definedKeys = new Set<string>();
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      return;
    }
    const match = ENV_LINE.exec(line);
    if (!match) {
      throw new Error(
        `${envPath}: malformed line ${index + 1} (${JSON.stringify(rawLine)}). ` +
          "Expected KEY=VALUE. Refusing to start with a broken gateway .env.",
      );
    }
    definedKeys.add(match[1]);
  });

  const missing = REQUIRED_KEYS.filter((key) => !definedKeys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `${envPath} does not define ${missing.join(", ")}. Refusing to start ` +
        "on loopback / localhost-only-CORS defaults — that silently breaks " +
        "Tailscale mobile access. Fix the file or remove it to use process.env.",
    );
  }

  process.loadEnvFile(envPath);
}
