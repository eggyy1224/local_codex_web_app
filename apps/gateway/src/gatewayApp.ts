import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { CreateTurnRequest } from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "./appServerPort.js";
import {
  attachAppServerProjection,
  type PendingApprovalEntry,
  type PendingInteractionEntry,
} from "./appServerProjection.js";
import { gatewayDb, type GatewayDbPort } from "./db.js";
import { TerminalManager } from "./terminalManager.js";
import { ThreadContextResolver } from "./threadContext.js";
import { resolveUploadRoot } from "./uploads.js";
import { registerApprovalInteractionRoutes } from "./routes/approvalInteractionRoutes.js";
import { registerConfigRoutes } from "./routes/configRoutes.js";
import { registerMiscRoutes } from "./routes/miscRoutes.js";
import { registerTerminalRoutes } from "./routes/terminalRoutes.js";
import { registerThreadsRoutes } from "./routes/threadsRoutes.js";
import { registerTurnRoutes } from "./routes/turnRoutes.js";
import { registerUploadRoutes } from "./routes/uploadRoutes.js";

const UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_FILES = 8;

export type GatewayAppConfig = {
  corsAllowlist: string[];
  loggerLevel?: string;
  bodyLimit?: number;
  websocketMaxPayload?: number;
  startAppServerOnBoot?: boolean;
  terminalEnabled?: boolean;
  uploadRoot?: string;
};

export type GatewayBootstrapConfig = {
  host: string;
  port: number;
  app: GatewayAppConfig;
};

export type GatewayAppDeps = {
  appServer: GatewayAppServerPort;
  db?: GatewayDbPort;
  threadContextResolver?: ThreadContextResolver;
  terminalManager?: TerminalManager;
};

function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export function createGatewayBootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayBootstrapConfig {
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 8795);
  const defaultWebOrigin = env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const corsAllowlist = (env.CORS_ALLOWLIST ?? defaultWebOrigin)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    host,
    port,
    app: {
      corsAllowlist,
      loggerLevel: env.LOG_LEVEL ?? "info",
      bodyLimit: 1024 * 1024,
      websocketMaxPayload: 1024 * 128,
      startAppServerOnBoot: true,
      terminalEnabled: envFlagEnabled(env.TERMINAL_DOCK_ENABLED),
    },
  };
}

export async function createGatewayApp(
  deps: GatewayAppDeps,
  config: GatewayAppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.loggerLevel ?? "info",
    },
    bodyLimit: config.bodyLimit ?? 1024 * 1024,
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.corsAllowlist.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  });

  await app.register(websocket, {
    options: {
      maxPayload: config.websocketMaxPayload ?? 1024 * 128,
    },
  });

  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_MAX_FILE_BYTES,
      files: UPLOAD_MAX_FILES,
    },
    throwFileSizeLimit: false,
  });

  const uploadRoot = resolveUploadRoot({ explicit: config.uploadRoot });

  const appServer = deps.appServer;
  const db = deps.db ?? gatewayDb;
  const terminalEnabled = config.terminalEnabled ?? true;
  const activeTurnByThread = new Map<string, string>();
  const threadContextResolver =
    deps.threadContextResolver ??
    new ThreadContextResolver({
      codexSessionsDir: process.env.CODEX_SESSIONS_DIR,
      logger: app.log,
    });
  const terminalManager =
    terminalEnabled
      ? deps.terminalManager ??
        new TerminalManager({
          maxSessions: 5,
          ttlMs: 30 * 60 * 1000,
          logger: app.log,
        })
      : null;
  const lastTurnInputByThread = new Map<
    string,
    {
      input: CreateTurnRequest["input"];
      options?: CreateTurnRequest["options"];
    }
  >();
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const pendingInteractions = new Map<string, PendingInteractionEntry>();
  const collaborationModeListSupported: { value: boolean | null } = { value: null };

  const { subscribe, broadcast, reconcilePendingInteractionsOnStartup, stats: projectionStats } =
    attachAppServerProjection({
      appServer,
      db,
      logger: app.log,
      pendingApprovals,
      pendingInteractions,
      activeTurnByThread,
    });

  reconcilePendingInteractionsOnStartup();

if (config.startAppServerOnBoot ?? true) {
  try {
    await appServer.start();
  } catch (error) {
    app.log.error({ err: error }, "Failed to start app-server on boot");
  }
}

registerMiscRoutes(app, {
  appServer,
  gatewayStatus: () => {
    const projection = projectionStats();
    const connected = appServer.isConnected;
    return {
      status: connected ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      appServer: {
        connected,
        lastError: appServer.errorMessage ?? null,
      },
      terminal: {
        enabled: terminalEnabled,
        // Test stubs may not implement sessionCount(); guard defensively.
        sessionCount:
          terminalManager && typeof terminalManager.sessionCount === "function"
            ? terminalManager.sessionCount()
            : 0,
      },
      events: {
        subscriberThreadCount: projection.subscriberThreadCount,
        subscriberTotal: projection.subscriberTotal,
        activeTurnCount: activeTurnByThread.size,
      },
      sessionIndex: {
        ready:
          typeof threadContextResolver.isSessionIndexReady === "function"
            ? threadContextResolver.isSessionIndexReady()
            : true,
        size:
          typeof threadContextResolver.sessionIndexSize === "function"
            ? threadContextResolver.sessionIndexSize()
            : 0,
      },
      pending: {
        approvals: pendingApprovals.size,
        interactions: pendingInteractions.size,
      },
    };
  },
});

registerThreadsRoutes(app, {
  appServer,
  db,
  threadContextResolver,
  pendingApprovals,
  subscribe,
  corsAllowlist: config.corsAllowlist,
});


registerTerminalRoutes(app, {
  db,
  threadContextResolver,
  terminalManager,
  terminalEnabled,
  corsAllowlist: config.corsAllowlist,
});

registerApprovalInteractionRoutes(app, {
  appServer,
  db,
  pendingApprovals,
  pendingInteractions,
  broadcast,
});

registerConfigRoutes(app, { appServer });

registerUploadRoutes(app, { uploadRoot });

registerTurnRoutes(app, {
  appServer,
  db,
  threadContextResolver,
  activeTurnByThread,
  lastTurnInputByThread,
  collaborationModeListSupported,
});

app.addHook("onClose", async () => {
  terminalManager?.destroy();
});
  return app;
}
