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
  // Only "fast" is a positive tier. Anything else — key absent, "flex",
  // or any other variant — reads as Standard/default (null).
  return value === "fast" ? "fast" : null;
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
// service_tier accepts exactly two writes: the literal "fast" (1.5x,
// ChatGPT sign-in) and null (clear the key → Standard/default). The
// installed codex-cli 0.130.0 app-server enum is fast|flex and rejects a
// literal "standard" (unknown variant), so Standard MUST be expressed as
// null, never the string. "flex" is never accepted: it is the OpenAI API
// tier, 400s on this plan, and a write persists into the *global*
// ~/.codex/config.toml, bricking every codex turn machine-wide. The
// gateway value-validates writes — the UI is not the boundary.
const ALLOWED_CONFIG_WRITE_KEYS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ["service_tier", (value) => value === "fast" || value === null],
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
