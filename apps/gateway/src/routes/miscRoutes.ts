import type { FastifyInstance } from "fastify";
import type {
  AccountRateLimitsResponse,
  FuzzyFileMatch,
  FuzzyFileSearchResponse,
  HealthResponse,
  ModelOption,
  ModelsResponse,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";
import { asRecord, readString, toModelOption, type RawModel } from "../gatewayHelpers.js";

export type MiscRoutesDeps = {
  appServer: GatewayAppServerPort;
};

type RawModelListResult = {
  data?: RawModel[];
  nextCursor?: string | null;
};

const FUZZY_FILE_SEARCH_LIMIT = 50;

export function registerMiscRoutes(
  app: FastifyInstance,
  { appServer }: MiscRoutesDeps,
): void {
  app.get("/health", async (): Promise<HealthResponse> => {
    const connected = appServer.isConnected;
    return {
      status: connected ? "ok" : "degraded",
      appServerConnected: connected,
      timestamp: new Date().toISOString(),
      message: appServer.errorMessage ?? undefined,
    };
  });

  app.get("/api/models", async (request): Promise<ModelsResponse> => {
    const query = request.query as { includeHidden?: string };
    const includeHidden = query.includeHidden === "true";

    const models: ModelOption[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;

    for (let i = 0; i < 20; i += 1) {
      const result = (await appServer.request("model/list", {
        cursor,
        limit: 100,
        includeHidden,
      })) as RawModelListResult;

      for (const rawModel of result.data ?? []) {
        const model = toModelOption(rawModel);
        if (!model || seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }

      cursor = result.nextCursor ?? null;
      if (!cursor) {
        break;
      }
    }

    return { data: models };
  });

  app.get("/api/account/rate-limits", async (): Promise<AccountRateLimitsResponse> => {
    try {
      const result = (await appServer.request("account/rateLimits/read")) as {
        rateLimits?: unknown;
        rateLimitsByLimitId?: unknown;
      };
      return {
        rateLimits: (result.rateLimits as AccountRateLimitsResponse["rateLimits"]) ?? null,
        rateLimitsByLimitId:
          (result.rateLimitsByLimitId as AccountRateLimitsResponse["rateLimitsByLimitId"]) ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn({ err: error }, "account/rateLimits/read failed");
      return {
        rateLimits: null,
        rateLimitsByLimitId: null,
        error: message,
      };
    }
  });

  app.get("/api/files/search", async (request): Promise<FuzzyFileSearchResponse> => {
    const query = request.query as { roots?: string; query?: string };
    const roots = (query.roots ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const queryString = typeof query.query === "string" ? query.query : "";

    if (roots.length === 0) {
      const err = new Error("roots is required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (queryString.length === 0) {
      const err = new Error("query is required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const result = (await appServer.request("fuzzyFileSearch", {
      roots,
      query: queryString,
    })) as { files?: unknown; data?: unknown };

    // app-server returns `{ files: [...] }`; keep a fallback to `data` in case the
    // protocol version emits either key.
    const raw = Array.isArray(result.files)
      ? result.files
      : Array.isArray(result.data)
        ? result.data
        : [];
    const data: FuzzyFileMatch[] = [];
    for (const entry of raw) {
      if (data.length >= FUZZY_FILE_SEARCH_LIMIT) {
        break;
      }
      const record = asRecord(entry);
      if (!record) {
        continue;
      }
      const root = readString(record.root);
      const filePath = readString(record.path);
      const fileName = readString(record.file_name) ?? readString(record.fileName);
      const matchType = readString(record.match_type) ?? readString(record.matchType);
      const score = typeof record.score === "number" ? record.score : null;
      const indicesRaw = Array.isArray(record.indices) ? record.indices : [];
      if (!root || !filePath || !fileName || !matchType || score === null) {
        continue;
      }
      const indices: number[] = [];
      for (const idx of indicesRaw) {
        if (typeof idx === "number" && Number.isFinite(idx)) {
          indices.push(idx);
        }
      }
      data.push({
        root,
        path: filePath,
        fileName,
        score,
        matchType,
        indices,
      });
    }

    return { data };
  });
}
