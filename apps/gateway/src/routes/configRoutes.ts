import type { FastifyInstance } from "fastify";
import type {
  GatewayConfigResponse,
  GatewayConfigSnapshot,
  GatewayConfigValueWriteRequest,
  GatewayConfigValueWriteResponse,
  ServiceTier,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";

type ConfigRoutesDeps = {
  appServer: GatewayAppServerPort;
};

function pickServiceTier(value: unknown): ServiceTier | null {
  return value === "fast" || value === "standard" ? value : null;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function snapshotFromAppServerConfig(raw: unknown): GatewayConfigSnapshot {
  const root = (raw as { config?: Record<string, unknown> })?.config ?? {};
  return {
    serviceTier: pickServiceTier(root.service_tier),
    model: pickString(root.model),
    reasoningEffort: pickString(root.reasoning_effort),
  };
}

// Allowlist of config keys the gateway will forward writes for. Tight by design:
// the UI only needs to flip a small set of safe knobs. Extend deliberately.
//
// service_tier allows codex's two documented values: "fast" (1.5x, ChatGPT
// sign-in only) and "standard" (default). It must NEVER accept "flex": that
// is the OpenAI *API* service tier, not a codex value, and the API rejects
// it on this plan (HTTP 400 "Unsupported service_tier: flex"). A write here
// persists into the *global* ~/.codex/config.toml, so a bad value silently
// bricks every codex turn machine-wide. The gateway must value-validate
// writes, never pass the UI's choice through — the UI is not the boundary.
const ALLOWED_CONFIG_WRITE_KEYS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ["service_tier", (value) => value === "fast" || value === "standard"],
]);

export function registerConfigRoutes(app: FastifyInstance, { appServer }: ConfigRoutesDeps): void {
  app.get("/api/config", async (): Promise<GatewayConfigResponse> => {
    const result = (await appServer.request("config/read", {})) as Record<string, unknown>;
    return {
      config: snapshotFromAppServerConfig(result),
      filePath: pickString((result as { filePath?: unknown }).filePath),
      version: pickString((result as { version?: unknown }).version),
    };
  });

  app.post("/api/config/value", async (request): Promise<GatewayConfigValueWriteResponse> => {
    const body = request.body as GatewayConfigValueWriteRequest;
    if (!body || typeof body.keyPath !== "string" || body.keyPath.length === 0) {
      const err = new Error("keyPath required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    const validate = ALLOWED_CONFIG_WRITE_KEYS.get(body.keyPath);
    if (!validate) {
      const err = new Error(`keyPath not writable: ${body.keyPath}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 403;
      throw err;
    }
    if (!validate(body.value)) {
      const err = new Error(`invalid value for ${body.keyPath}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
    const mergeStrategy = body.mergeStrategy ?? "replace";
    const result = (await appServer.request("config/value/write", {
      keyPath: body.keyPath,
      value: body.value,
      mergeStrategy,
      ...(body.expectedVersion ? { expectedVersion: body.expectedVersion } : {}),
    })) as Record<string, unknown>;
    const status = result.status === "noop" ? "noop" : "ok";
    return {
      status,
      filePath: pickString(result.filePath),
      version: pickString(result.version),
    };
  });
}
