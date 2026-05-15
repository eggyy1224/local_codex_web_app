import type { FastifyInstance } from "fastify";
import type {
  GatewayConfigResponse,
  GatewayConfigSnapshot,
  GatewayConfigValueWriteRequest,
  GatewayConfigValueWriteResponse,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";

type ConfigRoutesDeps = {
  appServer: GatewayAppServerPort;
};

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function snapshotFromAppServerConfig(raw: unknown): GatewayConfigSnapshot {
  const root = (raw as { config?: Record<string, unknown> })?.config ?? {};
  return {
    model: pickString(root.model),
    reasoningEffort: pickString(root.reasoning_effort),
  };
}

// Allowlist of config keys the gateway will forward writes for. Currently
// EMPTY by design: the only key the UI ever wrote was `service_tier`, which
// codex 0.130.0 does not implement (verified against the app-server protocol
// + ResponsesApiRequest; openai/codex#2916 is an open, unimplemented feature
// request), so the Speed control was removed. Any future writable key must be
// added here with a value validator — the gateway value-validates writes and
// never passes the UI's choice through; the UI is not the security boundary.
const ALLOWED_CONFIG_WRITE_KEYS: ReadonlyMap<string, (value: unknown) => boolean> =
  new Map<string, (value: unknown) => boolean>();

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
