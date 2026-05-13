import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ApprovalType,
  CreateTurnRequest,
  GatewayEvent,
  InteractionType,
  ThreadStatus,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "./appServerPort.js";
import {
  gatewayDb,
  type ApprovalProjection,
  type InteractionProjection,
  type GatewayDbPort,
} from "./db.js";
import {
  approvalTypeFromMethod,
  isUserInputRequestMethod,
  kindFromMethod,
} from "./gatewayHelpers.js";
import { TerminalManager } from "./terminalManager.js";
import { ThreadContextResolver } from "./threadContext.js";
import { registerApprovalInteractionRoutes } from "./routes/approvalInteractionRoutes.js";
import { registerConfigRoutes } from "./routes/configRoutes.js";
import { registerMiscRoutes } from "./routes/miscRoutes.js";
import { registerTerminalRoutes } from "./routes/terminalRoutes.js";
import { registerThreadsRoutes } from "./routes/threadsRoutes.js";
import { registerTurnRoutes } from "./routes/turnRoutes.js";


export type GatewayAppConfig = {
  corsAllowlist: string[];
  loggerLevel?: string;
  bodyLimit?: number;
  websocketMaxPayload?: number;
  startAppServerOnBoot?: boolean;
  terminalEnabled?: boolean;
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

  const appServer = deps.appServer;
  const db = deps.db ?? gatewayDb;
  const terminalEnabled = config.terminalEnabled ?? true;
  const subscribers = new Map<string, Set<(event: GatewayEvent) => void>>();
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
  const pendingApprovals = new Map<
    string,
    {
      rpcId: string | number;
      threadId: string;
      turnId: string | null;
      type: ApprovalType;
    }
  >();
  const pendingInteractions = new Map<
    string,
    {
      rpcId: string | number;
      threadId: string;
      turnId: string | null;
      type: InteractionType;
    }
  >();
  const collaborationModeListSupported: { value: boolean | null } = { value: null };
  type InteractionCancelReason = "turn_completed" | "gateway_restarted";

function subscribe(threadId: string, fn: (event: GatewayEvent) => void): () => void {
  const set = subscribers.get(threadId) ?? new Set<(event: GatewayEvent) => void>();
  set.add(fn);
  subscribers.set(threadId, set);

  return () => {
    const current = subscribers.get(threadId);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      subscribers.delete(threadId);
    }
  };
}

function broadcast(event: GatewayEvent): void {
  const set = subscribers.get(event.threadId);
  if (!set || set.size === 0) {
    return;
  }

  for (const handler of set) {
    handler(event);
  }
}

function cancelInteraction(
  interactionId: string,
  reason: InteractionCancelReason,
  threadId: string,
  turnId: string | null,
): void {
  const resolvedAt = new Date().toISOString();
  db.respondInteractionRequest(
    interactionId,
    "cancelled",
    JSON.stringify({ reason }),
    resolvedAt,
  );
  pendingInteractions.delete(interactionId);
  db.insertAuditLog({
    ts: resolvedAt,
    actor: "gateway",
    action: "interaction.cancelled",
    threadId,
    turnId,
    metadata: {
      interactionId,
      reason,
    },
  });

  const eventBase: Omit<GatewayEvent, "seq"> = {
    serverTs: resolvedAt,
    threadId,
    turnId,
    kind: "interaction",
    name: "interaction/cancelled",
    payload: {
      interactionId,
      reason,
    },
  };
  const seq = db.insertGatewayEvent(eventBase);
  broadcast({ ...eventBase, seq });
}

function cancelPendingInteractionsForTurn(threadId: string, turnId: string): void {
  const candidates: Array<{ interactionId: string; turnId: string | null }> = [];
  for (const [interactionId, pending] of pendingInteractions.entries()) {
    if (pending.threadId !== threadId || pending.turnId !== turnId) {
      continue;
    }
    candidates.push({
      interactionId,
      turnId: pending.turnId,
    });
  }

  for (const candidate of candidates) {
    cancelInteraction(candidate.interactionId, "turn_completed", threadId, candidate.turnId);
  }
}

function reconcilePendingInteractionsOnStartup(): void {
  const stalePending = db.listPendingInteractions();
  for (const interaction of stalePending) {
    cancelInteraction(
      interaction.interactionId,
      "gateway_restarted",
      interaction.threadId,
      interaction.turnId,
    );
  }
}

function extractThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const p = params as Record<string, unknown>;
  if (typeof p.threadId === "string") return p.threadId;
  if (typeof p.thread_id === "string") return p.thread_id;
  if (p.thread && typeof p.thread === "object") {
    const thread = p.thread as Record<string, unknown>;
    if (typeof thread.id === "string") return thread.id;
  }
  return null;
}

function extractTurnId(params: unknown): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const p = params as Record<string, unknown>;
  if (typeof p.turnId === "string") return p.turnId;
  if (typeof p.turn_id === "string") return p.turn_id;
  if (p.turn && typeof p.turn === "object") {
    const turn = p.turn as Record<string, unknown>;
    if (typeof turn.id === "string") return turn.id;
  }
  return null;
}

appServer.on("stderr", (line) => {
  app.log.warn({ appServerStderr: line.trim() }, "app-server stderr");
});

appServer.on("message", (msg: unknown) => {
  if (!msg || typeof msg !== "object" || !("method" in (msg as Record<string, unknown>))) {
    return;
  }

  const raw = msg as {
    id?: string | number;
    method: string;
    params?: unknown;
  };

  const threadId = extractThreadId(raw.params);
  if (!threadId) {
    return;
  }

  const turnId = extractTurnId(raw.params);
  const approvalType = approvalTypeFromMethod(raw.method);
  const isUserInputRequest = isUserInputRequestMethod(raw.method);
  const paramsRecord =
    raw.params && typeof raw.params === "object"
      ? { ...(raw.params as Record<string, unknown>) }
      : null;

  let payloadForEvent: unknown = raw.params ?? null;

  if (approvalType && raw.id !== undefined) {
    const approvalId = String(raw.id);
    const createdAt = new Date().toISOString();
    const requestPayloadJson = JSON.stringify(raw.params ?? null);
    const itemId =
      paramsRecord && typeof paramsRecord.itemId === "string" ? paramsRecord.itemId : null;

    const projection: ApprovalProjection = {
      approval_id: approvalId,
      thread_id: threadId,
      turn_id: turnId,
      item_id: itemId,
      type: approvalType,
      status: "pending",
      request_payload_json: requestPayloadJson,
      decision: null,
      note: null,
      created_at: createdAt,
      resolved_at: null,
    };

    db.upsertApprovalRequest(projection);
    pendingApprovals.set(approvalId, {
      rpcId: raw.id,
      threadId,
      turnId,
      type: approvalType,
    });

    db.insertAuditLog({
      ts: createdAt,
      actor: "gateway",
      action: "approval.requested",
      threadId,
      turnId,
      metadata: {
        approvalId,
        type: approvalType,
        itemId,
      },
    });

    payloadForEvent = {
      ...(paramsRecord ?? {}),
      approvalId,
      approvalType,
    };
  } else if (isUserInputRequest && raw.id !== undefined) {
    const interactionId = String(raw.id);
    const createdAt = new Date().toISOString();
    const requestPayloadJson = JSON.stringify(raw.params ?? null);
    const itemId =
      paramsRecord && typeof paramsRecord.itemId === "string" ? paramsRecord.itemId : null;

    const projection: InteractionProjection = {
      interaction_id: interactionId,
      thread_id: threadId,
      turn_id: turnId,
      item_id: itemId,
      type: "userInput",
      status: "pending",
      request_payload_json: requestPayloadJson,
      response_payload_json: null,
      created_at: createdAt,
      resolved_at: null,
    };
    db.upsertInteractionRequest(projection);
    pendingInteractions.set(interactionId, {
      rpcId: raw.id,
      threadId,
      turnId,
      type: "userInput",
    });
    db.insertAuditLog({
      ts: createdAt,
      actor: "gateway",
      action: "interaction.requested",
      threadId,
      turnId,
      metadata: {
        interactionId,
        type: "userInput",
        itemId,
      },
    });
    payloadForEvent = {
      ...(paramsRecord ?? {}),
      interactionId,
      interactionType: "userInput",
    };
  }

  if (raw.method === "turn/started" && turnId) {
    activeTurnByThread.set(threadId, turnId);
  }

  if (raw.method === "turn/completed" && turnId) {
    cancelPendingInteractionsForTurn(threadId, turnId);
    const activeTurn = activeTurnByThread.get(threadId);
    if (activeTurn === turnId) {
      activeTurnByThread.delete(threadId);
    }
  }

  const eventBase: Omit<GatewayEvent, "seq"> = {
    serverTs: new Date().toISOString(),
    threadId,
    turnId,
    kind: kindFromMethod(raw.method),
    name: raw.method,
    payload: payloadForEvent,
  };

  const seq = db.insertGatewayEvent(eventBase);
  broadcast({ ...eventBase, seq });
});

reconcilePendingInteractionsOnStartup();

if (config.startAppServerOnBoot ?? true) {
  try {
    await appServer.start();
  } catch (error) {
    app.log.error({ err: error }, "Failed to start app-server on boot");
  }
}

registerMiscRoutes(app, { appServer });

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
