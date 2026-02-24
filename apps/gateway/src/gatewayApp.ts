import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalType,
  CreateTurnRequest,
  CreateTurnResponse,
  GatewayEvent,
  HealthResponse,
  ModelOption,
  ModelsResponse,
  PendingApprovalsResponse,
  TerminalClientMessage,
  TerminalServerMessage,
  ThreadDetailResponse,
  ThreadContextResponse,
  ThreadControlRequest,
  ThreadControlResponse,
  ThreadListItem,
  ThreadListResponse,
  ThreadMeta,
  ThreadStatus,
  ThreadTimelineItem,
  ThreadTimelineResponse,
  TurnPermissionMode,
  TurnView,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "./appServerPort.js";
import {
  gatewayDb,
  type ApprovalProjection,
  type GatewayDbPort,
  type ThreadProjection,
} from "./db.js";
import { TerminalManager } from "./terminalManager.js";
import { ThreadContextResolver, normalizeProjectKey } from "./threadContext.js";

type RawTurn = {
  id: string;
  status?: string;
  error?: unknown;
  items?: unknown[];
  startedAt?: number;
  completedAt?: number;
};

type RawThread = {
  id: string;
  preview?: string;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
  turns?: RawTurn[];
};

type RawReasoningEffort = {
  effort?: unknown;
  reasoningEffort?: unknown;
  description?: unknown;
};

type RawModel = {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  defaultReasoningEffort?: unknown;
  reasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
  upgrade?: unknown;
  inputModalities?: unknown;
  supportsPersonality?: unknown;
  isDefault?: unknown;
};

type RawModelListResult = {
  data?: RawModel[];
  nextCursor?: string | null;
};

export type GatewayAppConfig = {
  corsAllowlist: string[];
  loggerLevel?: string;
  bodyLimit?: number;
  websocketMaxPayload?: number;
  startAppServerOnBoot?: boolean;
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

export function createGatewayBootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayBootstrapConfig {
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 8787);
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
  const subscribers = new Map<string, Set<(event: GatewayEvent) => void>>();
  const activeTurnByThread = new Map<string, string>();
  const threadContextResolver =
    deps.threadContextResolver ??
    new ThreadContextResolver({
      codexSessionsDir: process.env.CODEX_SESSIONS_DIR,
      logger: app.log,
    });
  const terminalManager =
    deps.terminalManager ??
    new TerminalManager({
      maxSessions: 5,
      ttlMs: 30 * 60 * 1000,
      logger: app.log,
    });
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

function statusFromRaw(raw: unknown): ThreadStatus {
  if (raw && typeof raw === "object" && "type" in (raw as Record<string, unknown>)) {
    const typeValue = (raw as Record<string, unknown>).type;
    if (typeof typeValue === "string") {
      if (typeValue === "notLoaded") return "notLoaded";
      if (typeValue === "idle") return "idle";
      if (typeValue === "active") return "active";
      if (typeValue === "systemError") return "systemError";
    }
  }

  if (typeof raw === "string") {
    if (raw === "notLoaded" || raw === "idle" || raw === "active" || raw === "systemError") {
      return raw;
    }
  }

  return "unknown";
}

function unixSecondsToIso(ts?: number): string {
  if (!ts || Number.isNaN(ts)) {
    return new Date().toISOString();
  }
  return new Date(ts * 1000).toISOString();
}

function permissionModeToTurnStartParams(
  mode?: TurnPermissionMode,
): Record<string, unknown> {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    };
  }
  if (mode === "local") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
      },
    };
  }
  return {};
}

function toThreadListItem(raw: RawThread, projectKey = "unknown"): ThreadListItem {
  const status = statusFromRaw(raw.status);
  const title = raw.name ?? raw.preview?.slice(0, 80) ?? raw.id;
  const preview = raw.preview ?? "";
  const lastActiveAt = unixSecondsToIso(raw.updatedAt ?? raw.createdAt);

  return {
    id: raw.id,
    projectKey,
    title,
    preview,
    status,
    lastActiveAt,
    archived: false,
    waitingApprovalCount: 0,
    errorCount: status === "systemError" ? 1 : 0,
  };
}

function toThreadMeta(raw: RawThread): ThreadMeta {
  return {
    id: raw.id,
    title: raw.name ?? raw.preview?.slice(0, 80) ?? raw.id,
    preview: raw.preview ?? "",
    status: statusFromRaw(raw.status),
    createdAt: raw.createdAt ? unixSecondsToIso(raw.createdAt) : null,
    updatedAt: raw.updatedAt ? unixSecondsToIso(raw.updatedAt) : null,
  };
}

function toTurnView(raw: RawTurn): TurnView {
  return {
    id: raw.id,
    status: raw.status ?? "unknown",
    startedAt: raw.startedAt ? unixSecondsToIso(raw.startedAt) : null,
    completedAt: raw.completedAt ? unixSecondsToIso(raw.completedAt) : null,
    error: raw.error ?? null,
    items: raw.items ?? [],
  };
}

function toModelOption(raw: RawModel): ModelOption | null {
  const fallbackId = typeof raw.model === "string" ? raw.model : null;
  const id = typeof raw.id === "string" ? raw.id : fallbackId;
  if (!id) {
    return null;
  }

  const model = typeof raw.model === "string" ? raw.model : id;
  const effortListRaw = Array.isArray(raw.reasoningEffort)
    ? raw.reasoningEffort
    : Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
      : null;
  const reasoningEffort = effortListRaw
    ? effortListRaw
        .map((option) => {
          const item = option as RawReasoningEffort;
          const effort =
            typeof item?.effort === "string"
              ? item.effort
              : typeof item?.reasoningEffort === "string"
                ? item.reasoningEffort
                : null;
          if (!effort) {
            return null;
          }
          return {
            effort,
            ...(typeof item.description === "string" ? { description: item.description } : {}),
          };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null)
    : undefined;

  return {
    id,
    model,
    ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
    ...(typeof raw.hidden === "boolean" ? { hidden: raw.hidden } : {}),
    ...(typeof raw.defaultReasoningEffort === "string"
      ? { defaultReasoningEffort: raw.defaultReasoningEffort }
      : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof raw.upgrade === "string" ? { upgrade: raw.upgrade } : {}),
    ...(Array.isArray(raw.inputModalities)
      ? {
          inputModalities: raw.inputModalities.filter(
            (modality): modality is string => typeof modality === "string",
          ),
        }
      : {}),
    ...(typeof raw.supportsPersonality === "boolean"
      ? { supportsPersonality: raw.supportsPersonality }
      : {}),
    ...(typeof raw.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  obj: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!obj) {
    return null;
  }
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function stringifyCompact(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string | null, maxLength = 2000): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...`;
}

function pushTimelineItem(
  items: ThreadTimelineItem[],
  next: ThreadTimelineItem,
): void {
  const previous = items[items.length - 1];
  if (
    previous &&
    previous.type === next.type &&
    previous.turnId === next.turnId &&
    previous.text === next.text &&
    previous.rawType === next.rawType
  ) {
    return;
  }
  items.push(next);
}

async function loadThreadTimelineFromSession(
  threadId: string,
  limit: number,
): Promise<ThreadTimelineItem[]> {
  const sessionFilePath = await threadContextResolver.getSessionFilePath(threadId);
  if (!sessionFilePath) {
    return [];
  }

  const stream = createReadStream(sessionFilePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const items: ThreadTimelineItem[] = [];
  let lineNumber = 0;
  let activeTurnId: string | null = null;

  const buildId = (prefix: string): string => `${prefix}-${threadId}-${lineNumber}`;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (!line) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const timestamp =
        (typeof parsed.timestamp === "string" ? parsed.timestamp : null) ??
        new Date().toISOString();
      const lineType = typeof parsed.type === "string" ? parsed.type : "";

      if (lineType === "event_msg") {
        const payload = asRecord(parsed.payload);
        const payloadType = pickString(payload, "type");
        const turnFromPayload = pickString(payload, "turn_id", "turnId");
        if (turnFromPayload) {
          activeTurnId = turnFromPayload;
        }
        const eventTurnId = turnFromPayload ?? activeTurnId;

        if (payloadType === "task_started") {
          pushTimelineItem(items, {
            id: buildId("status"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "status",
            title: "Turn started",
            text: eventTurnId ? `turn ${eventTurnId}` : null,
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          continue;
        }

        if (payloadType === "task_complete") {
          pushTimelineItem(items, {
            id: buildId("status"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "status",
            title: "Turn completed",
            text: eventTurnId ? `turn ${eventTurnId}` : null,
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          if (turnFromPayload && activeTurnId === turnFromPayload) {
            activeTurnId = null;
          }
          continue;
        }

        if (payloadType === "turn_aborted") {
          pushTimelineItem(items, {
            id: buildId("status"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "status",
            title: "Turn interrupted",
            text: eventTurnId ? `turn ${eventTurnId}` : null,
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          if (turnFromPayload && activeTurnId === turnFromPayload) {
            activeTurnId = null;
          }
          continue;
        }

        if (payloadType === "entered_review_mode" || payloadType === "exited_review_mode") {
          pushTimelineItem(items, {
            id: buildId("status"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "status",
            title: payloadType === "entered_review_mode" ? "Entered review mode" : "Exited review mode",
            text: pickString(payload, "user_facing_hint"),
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          continue;
        }

        if (payloadType === "context_compacted") {
          pushTimelineItem(items, {
            id: buildId("status"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "status",
            title: "Context compacted",
            text: null,
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          continue;
        }

        if (payloadType === "user_message") {
          pushTimelineItem(items, {
            id: buildId("user"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "userMessage",
            title: "User",
            text: truncateText(pickString(payload, "message"), 4000),
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          continue;
        }

        if (payloadType === "agent_message") {
          pushTimelineItem(items, {
            id: buildId("assistant"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "assistantMessage",
            title: "Assistant",
            text: truncateText(pickString(payload, "message"), 6000),
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
          continue;
        }

        if (payloadType === "agent_reasoning") {
          pushTimelineItem(items, {
            id: buildId("reasoning"),
            ts: timestamp,
            turnId: eventTurnId,
            type: "reasoning",
            title: "Thinking",
            text: truncateText(pickString(payload, "text"), 2000),
            rawType: payloadType,
            toolName: null,
            callId: null,
          });
        }
        continue;
      }

      if (lineType !== "response_item") {
        continue;
      }

      const payload = asRecord(parsed.payload);
      const payloadType = pickString(payload, "type");
      const callId = pickString(payload, "call_id");

      if (
        payloadType === "function_call" ||
        payloadType === "custom_tool_call" ||
        payloadType === "web_search_call"
      ) {
        const toolName =
          pickString(payload, "name") ??
          (payloadType === "web_search_call" ? "web_search" : "tool");
        const argumentsText = truncateText(
          pickString(payload, "arguments", "input", "query") ??
            stringifyCompact(payload?.arguments ?? payload?.input ?? payload?.query),
          1800,
        );
        pushTimelineItem(items, {
          id: buildId("tool-call"),
          ts: timestamp,
          turnId: activeTurnId,
          type: "toolCall",
          title: `Tool call: ${toolName}`,
          text: argumentsText,
          rawType: payloadType,
          toolName,
          callId,
        });
        continue;
      }

      if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output" ||
        payloadType === "web_search_call_output"
      ) {
        const outputText = truncateText(
          pickString(payload, "output") ??
            stringifyCompact(payload?.output ?? payload?.result ?? payload?.response),
          2200,
        );
        pushTimelineItem(items, {
          id: buildId("tool-result"),
          ts: timestamp,
          turnId: activeTurnId,
          type: "toolResult",
          title: "Tool output",
          text: outputText,
          rawType: payloadType,
          toolName: null,
          callId,
        });
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (items.length <= limit) {
    return items;
  }
  return items.slice(-limit);
}

function applyFilters(
  items: ThreadListItem[],
  options: { q?: string; status?: string; archived?: string },
): ThreadListItem[] {
  const q = options.q?.trim().toLowerCase();
  const status = options.status?.trim();
  const archived = options.archived;

  return items.filter((item) => {
    if (q && !`${item.title} ${item.preview}`.toLowerCase().includes(q)) {
      return false;
    }
    if (status && item.status !== status) {
      return false;
    }
    if (archived === "true" && !item.archived) {
      return false;
    }
    if (archived === "false" && item.archived) {
      return false;
    }
    return true;
  });
}

function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  return config.corsAllowlist.includes(origin);
}

function terminalError(message: string, code?: string): TerminalServerMessage {
  return {
    type: "terminal/error",
    message,
    ...(code ? { code } : {}),
  };
}

function parseTerminalClientMessage(raw: unknown): TerminalClientMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return null;
  }

  if (type === "terminal/open") {
    return {
      type,
      threadId: typeof record.threadId === "string" ? record.threadId : "",
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    };
  }

  if (type === "terminal/input") {
    if (typeof record.data !== "string") {
      return null;
    }
    return {
      type,
      data: record.data,
    };
  }

  if (type === "terminal/resize") {
    if (
      typeof record.cols !== "number" ||
      typeof record.rows !== "number" ||
      !Number.isFinite(record.cols) ||
      !Number.isFinite(record.rows)
    ) {
      return null;
    }
    return {
      type,
      cols: Math.floor(record.cols),
      rows: Math.floor(record.rows),
    };
  }

  if (type === "terminal/setCwd") {
    if (typeof record.cwd !== "string") {
      return null;
    }
    return {
      type,
      cwd: record.cwd,
    };
  }

  if (type === "terminal/close") {
    return { type };
  }

  return null;
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

function kindFromMethod(method: GatewayEvent["name"]): GatewayEvent["kind"] {
  if (method.includes("requestApproval") || method.startsWith("tool/requestUserInput")) {
    return "approval";
  }
  if (method.startsWith("thread/")) return "thread";
  if (method.startsWith("turn/")) return "turn";
  if (method.startsWith("item/")) return "item";
  return "system";
}

function approvalTypeFromMethod(method: string): ApprovalType | null {
  if (method === "item/commandExecution/requestApproval") {
    return "commandExecution";
  }
  if (method === "item/fileChange/requestApproval") {
    return "fileChange";
  }
  if (method === "tool/requestUserInput") {
    return "userInput";
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
  }

  if (raw.method === "turn/started" && turnId) {
    activeTurnByThread.set(threadId, turnId);
  }

  if (raw.method === "turn/completed" && turnId) {
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

if (config.startAppServerOnBoot ?? true) {
  try {
    await appServer.start();
  } catch (error) {
    app.log.error({ err: error }, "Failed to start app-server on boot");
  }
}

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

app.get("/api/threads", async (request): Promise<ThreadListResponse> => {
  const query = request.query as {
    q?: string;
    status?: string;
    archived?: string;
    cursor?: string;
    limit?: string;
  };

  const limit = Math.min(Math.max(Number(query.limit ?? "25") || 25, 1), 100);

  try {
    const result = (await appServer.request("thread/list", {
      cursor: query.cursor ?? null,
      limit,
      archived: query.archived === "true",
    })) as {
      data?: RawThread[];
      nextCursor?: string | null;
    };

    const items = await Promise.all(
      (result.data ?? []).map(async (thread) => {
        const projected = db.getProjectedThread(thread.id);
        let projectKey = projected?.projectKey ?? "unknown";
        if (projectKey === "unknown") {
          projectKey = await threadContextResolver.resolveProjectKey(thread.id, projected?.projectKey);
          if (projectKey !== "unknown") {
            db.updateThreadProjectKey(thread.id, projectKey);
            threadContextResolver.invalidate(thread.id);
          }
        }
        return toThreadListItem(thread, projectKey);
      }),
    );

    const rows: ThreadProjection[] = items.map((item) => ({
      thread_id: item.id,
      project_key: item.projectKey,
      title: item.title,
      preview: item.preview,
      status: item.status,
      archived: item.archived ? 1 : 0,
      updated_at: item.lastActiveAt,
      last_error: item.errorCount > 0 ? "systemError" : null,
    }));

    db.upsertThreads(rows);

    return {
      data: applyFilters(items, query),
      nextCursor: result.nextCursor ?? null,
    };
  } catch (error) {
    app.log.error({ err: error }, "thread/list failed, fallback to projection cache");

    const projected = db.listProjectedThreads(limit);
    const hydrated = await Promise.all(
      projected.map(async (thread) => {
        if (thread.projectKey !== "unknown") {
          return thread;
        }
        const projectKey = await threadContextResolver.resolveProjectKey(thread.id, thread.projectKey);
        if (projectKey !== "unknown") {
          db.updateThreadProjectKey(thread.id, projectKey);
          threadContextResolver.invalidate(thread.id);
        }
        return {
          ...thread,
          projectKey,
        };
      }),
    );

    return {
      data: applyFilters(hydrated, query),
      nextCursor: null,
    };
  }
});

app.post("/api/threads", async (request): Promise<{ threadId: string }> => {
  const body = request.body as {
    mode?: "new" | "fork";
    fromThreadId?: string;
    model?: string;
    cwd?: string;
  };

  if (body.mode === "fork" && body.fromThreadId) {
    const sourceThread = db.getProjectedThread(body.fromThreadId);
    const projectKey = sourceThread?.projectKey ?? "unknown";

    const result = (await appServer.request("thread/fork", {
      threadId: body.fromThreadId,
    })) as {
      thread?: RawThread;
    };
    const thread = result.thread;
    if (!thread?.id) {
      throw new Error("thread/fork response missing thread.id");
    }

    const item = toThreadListItem(thread, projectKey);
    db.upsertThreads([
      {
        thread_id: item.id,
        project_key: item.projectKey,
        title: item.title,
        preview: item.preview,
        status: item.status,
        archived: item.archived ? 1 : 0,
        updated_at: item.lastActiveAt,
        last_error: item.errorCount > 0 ? "systemError" : null,
      },
    ]);

    return { threadId: thread.id };
  }

  const projectKey = normalizeProjectKey(body.cwd);

  const result = (await appServer.request("thread/start", {
    model: body.model,
    cwd: body.cwd,
  })) as {
    thread?: RawThread;
  };

  const thread = result.thread;
  if (!thread?.id) {
    throw new Error("thread/start response missing thread.id");
  }

  const item = toThreadListItem(thread, projectKey);
  db.upsertThreads([
    {
      thread_id: item.id,
      project_key: item.projectKey,
      title: item.title,
      preview: item.preview,
      status: item.status,
      archived: item.archived ? 1 : 0,
      updated_at: item.lastActiveAt,
      last_error: item.errorCount > 0 ? "systemError" : null,
    },
  ]);

  return { threadId: thread.id };
});

app.get("/api/threads/:id", async (request): Promise<ThreadDetailResponse> => {
  const params = request.params as { id: string };
  const query = request.query as { includeTurns?: string };

  const includeTurnsRequested = query.includeTurns !== "false";

  const fallbackFromProjection = (): ThreadDetailResponse => {
    const projected = db.getProjectedThread(params.id);
    return {
      thread: {
        id: params.id,
        title: projected?.title ?? params.id,
        preview: projected?.preview ?? "",
        status: projected?.status ?? "unknown",
        createdAt: null,
        updatedAt: projected?.lastActiveAt ?? null,
      },
      turns: [],
      nextCursor: null,
    };
  };

  const readThread = async (includeTurns: boolean): Promise<{ thread?: RawThread }> =>
    (await appServer.request("thread/read", {
      threadId: params.id,
      includeTurns,
    })) as { thread?: RawThread };

  const tryReadWithFallback = async (): Promise<{ thread?: RawThread }> => {
    if (includeTurnsRequested) {
      try {
        return await readThread(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not materialized yet")) {
          return await readThread(false);
        }
        throw error;
      }
    }
    return await readThread(false);
  };

  let result: { thread?: RawThread };
  try {
    result = await tryReadWithFallback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no rollout found")) {
      return fallbackFromProjection();
    }

    if (!message.includes("thread not loaded")) {
      throw error;
    }

    await appServer.request("thread/resume", { threadId: params.id });

    try {
      result = await tryReadWithFallback();
    } catch (innerError) {
      const innerMessage =
        innerError instanceof Error ? innerError.message : String(innerError);
      if (innerMessage.includes("no rollout found")) {
        return fallbackFromProjection();
      }
      throw innerError;
    }
  }

  const thread = result.thread;
  if (!thread?.id) {
    return fallbackFromProjection();
  }

  return {
    thread: toThreadMeta(thread),
    turns: includeTurnsRequested ? (thread.turns ?? []).map(toTurnView) : [],
    nextCursor: null,
  };
});

app.get("/api/threads/:id/context", async (request): Promise<ThreadContextResponse> => {
  const params = request.params as { id: string };
  const projected = db.getProjectedThread(params.id);
  const context = await threadContextResolver.resolveThreadContext(
    params.id,
    projected?.projectKey,
  );
  if (!context.isFallback && context.cwd) {
    db.updateThreadProjectKey(params.id, normalizeProjectKey(context.cwd));
    threadContextResolver.invalidate(params.id);
  }
  return context;
});

app.get("/api/threads/:id/timeline", async (request): Promise<ThreadTimelineResponse> => {
  const params = request.params as { id: string };
  const query = request.query as { limit?: string };
  const limit = Math.min(Math.max(Number(query.limit ?? "800") || 800, 1), 2000);

  const data = await loadThreadTimelineFromSession(params.id, limit);
  return { data };
});

app.get("/api/terminal/ws", { websocket: true }, (ws, request) => {
  const origin =
    typeof request.headers.origin === "string" ? request.headers.origin : undefined;

  const send = (message: TerminalServerMessage): void => {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(message));
  };

  if (!isAllowedWsOrigin(origin)) {
    send(terminalError("origin not allowed", "TERMINAL_WS_ORIGIN_DENIED"));
    ws.close(1008, "origin not allowed");
    return;
  }

  const client = { send };

  ws.on(
    "message",
    (raw: string | Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        send(terminalError("binary payload is not supported", "TERMINAL_WS_BINARY_UNSUPPORTED"));
        return;
      }

      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        send(terminalError("invalid JSON payload", "TERMINAL_WS_INVALID_JSON"));
        return;
      }

      const message = parseTerminalClientMessage(parsed);
      if (!message) {
        send(terminalError("invalid terminal message", "TERMINAL_WS_INVALID_MESSAGE"));
        return;
      }

      if (message.type === "terminal/open") {
        if (!message.threadId) {
          send(terminalError("threadId is required", "TERMINAL_WS_MISSING_THREAD_ID"));
          return;
        }
        void (async () => {
          try {
            const projected = db.getProjectedThread(message.threadId);
            const context = await threadContextResolver.resolveThreadContext(
              message.threadId,
              projected?.projectKey,
            );
            terminalManager.openClient(client, message.threadId, context);
            if (!context.isFallback && context.cwd) {
              db.updateThreadProjectKey(message.threadId, normalizeProjectKey(context.cwd));
              threadContextResolver.invalidate(message.threadId);
            }
          } catch (error) {
            send(
              terminalError(
                error instanceof Error ? error.message : "failed to open terminal",
                "TERMINAL_WS_OPEN_FAILED",
              ),
            );
          }
        })();
        return;
      }

      if (message.type === "terminal/input") {
        if (!terminalManager.writeInput(client, message.data)) {
          send(terminalError("terminal session not ready", "TERMINAL_WS_NOT_READY"));
        }
        return;
      }

      if (message.type === "terminal/resize") {
        const cols = Math.max(2, Math.min(400, message.cols));
        const rows = Math.max(1, Math.min(200, message.rows));
        if (!terminalManager.resize(client, cols, rows)) {
          send(terminalError("terminal session not ready", "TERMINAL_WS_NOT_READY"));
        }
        return;
      }

      if (message.type === "terminal/setCwd") {
        if (!terminalManager.setCwd(client, message.cwd)) {
          send(terminalError("terminal session not ready", "TERMINAL_WS_NOT_READY"));
        }
        return;
      }

      if (message.type === "terminal/close") {
        terminalManager.closeClient(client);
      }
    },
  );

  ws.on("close", () => {
    terminalManager.onClientDisconnect(client);
  });
});

app.get("/api/threads/:id/events", async (request, reply) => {
  const params = request.params as { id: string };
  const query = request.query as { since?: string };
  const since = Number(query.since ?? "0") || 0;
  const origin =
    typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const allowOrigin =
    origin && config.corsAllowlist.includes(origin) ? origin : config.corsAllowlist[0];

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": allowOrigin ?? "",
    Vary: "Origin",
  });

  const writeEvent = (event: GatewayEvent): void => {
    reply.raw.write(`id: ${event.seq}\n`);
    reply.raw.write(`event: gateway\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const replay = db.listGatewayEventsSince(params.id, since, 1000);
  for (const event of replay) {
    writeEvent(event);
  }

  const unsubscribe = subscribe(params.id, writeEvent);

  const heartbeat = setInterval(() => {
    reply.raw.write("event: heartbeat\n");
    reply.raw.write(`data: {"ts":"${new Date().toISOString()}"}\n\n`);
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  });
});

app.get(
  "/api/threads/:id/approvals/pending",
  async (request): Promise<PendingApprovalsResponse> => {
    const params = request.params as { id: string };
    return {
      data: db.listPendingApprovalsByThread(params.id),
    };
  },
);

app.post("/api/threads/:id/turns", async (request): Promise<CreateTurnResponse> => {
  const params = request.params as { id: string };
  const body = request.body as CreateTurnRequest;

  if (!Array.isArray(body?.input) || body.input.length === 0) {
    const error = new Error("input is required") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  lastTurnInputByThread.set(params.id, {
    input: body.input,
    options: body.options,
  });

  const startTurn = async (): Promise<{ turn?: RawTurn }> =>
    (await appServer.request("turn/start", {
      threadId: params.id,
      input: body.input,
      ...(body.options?.model ? { model: body.options.model } : {}),
      ...(body.options?.effort ? { effort: body.options.effort } : {}),
      ...(body.options?.cwd ? { cwd: body.options.cwd } : {}),
      ...permissionModeToTurnStartParams(body.options?.permissionMode),
    })) as { turn?: RawTurn };

  const isResumeNeeded = (message: string): boolean =>
    message.includes("thread not loaded") || message.includes("thread not found");

  let result: { turn?: RawTurn };
  try {
    result = await startTurn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isResumeNeeded(message)) {
      throw error;
    }

    await appServer.request("thread/resume", { threadId: params.id });
    result = await startTurn();
  }

  const turnId = result.turn?.id;
  if (!turnId) {
    throw new Error("turn/start response missing turn.id");
  }

  activeTurnByThread.set(params.id, turnId);
  if (body.options?.cwd) {
    db.updateThreadProjectKey(params.id, normalizeProjectKey(body.options.cwd));
    threadContextResolver.invalidate(params.id);
  }

  return { turnId };
});

app.post(
  "/api/threads/:id/approvals/:approvalId",
  async (request): Promise<ApprovalDecisionResponse> => {
    const params = request.params as { id: string; approvalId: string };
    const body = request.body as ApprovalDecisionRequest;

    if (body.decision !== "allow" && body.decision !== "deny" && body.decision !== "cancel") {
      const error = new Error("invalid decision") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const pending = pendingApprovals.get(params.approvalId);
    const approval = db.getApprovalById(params.approvalId);
    if (!pending && !approval) {
      const error = new Error("approval not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    const fallbackRpcId: string | number = /^\d+$/.test(params.approvalId)
      ? Number(params.approvalId)
      : params.approvalId;
    const rpcId = pending?.rpcId ?? fallbackRpcId;
    const threadId = pending?.threadId ?? approval?.threadId ?? params.id;
    const turnId = pending?.turnId ?? approval?.turnId ?? null;

    const mappedDecision =
      body.decision === "allow"
        ? "accept"
        : body.decision === "deny"
          ? "decline"
          : "cancel";

    appServer.respond(rpcId, {
      decision: mappedDecision,
    });

    const resolvedAt = new Date().toISOString();
    const status = body.decision === "allow" ? "approved" : body.decision === "deny" ? "denied" : "cancelled";
    db.resolveApprovalRequest(
      params.approvalId,
      status,
      body.decision,
      body.note ?? null,
      resolvedAt,
    );

    pendingApprovals.delete(params.approvalId);

    db.insertAuditLog({
      ts: resolvedAt,
      actor: "user",
      action: "approval.decided",
      threadId,
      turnId,
      metadata: {
        approvalId: params.approvalId,
        decision: body.decision,
        note: body.note ?? null,
      },
    });

    const decisionEventBase: Omit<GatewayEvent, "seq"> = {
      serverTs: resolvedAt,
      threadId,
      turnId,
      kind: "approval",
      name: "approval/decision",
      payload: {
        approvalId: params.approvalId,
        decision: body.decision,
        note: body.note ?? null,
      },
    };

    const seq = db.insertGatewayEvent(decisionEventBase);
    broadcast({ ...decisionEventBase, seq });

    return { ok: true };
  },
);

app.post("/api/threads/:id/control", async (request): Promise<ThreadControlResponse> => {
  const params = request.params as { id: string };
  const body = request.body as ThreadControlRequest;

  if (body.action !== "stop" && body.action !== "retry" && body.action !== "cancel") {
    const error = new Error("invalid action") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  if (body.action === "retry") {
    const previous = lastTurnInputByThread.get(params.id);
    if (!previous) {
      const error = new Error("no previous turn input") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const startTurn = async (): Promise<{ turn?: RawTurn }> =>
      (await appServer.request("turn/start", {
        threadId: params.id,
        input: previous.input,
        ...(previous.options?.model ? { model: previous.options.model } : {}),
        ...(previous.options?.effort ? { effort: previous.options.effort } : {}),
        ...(previous.options?.cwd ? { cwd: previous.options.cwd } : {}),
        ...permissionModeToTurnStartParams(previous.options?.permissionMode),
      })) as { turn?: RawTurn };

    let result: { turn?: RawTurn };
    try {
      result = await startTurn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("thread not loaded")) {
        throw error;
      }
      await appServer.request("thread/resume", { threadId: params.id });
      result = await startTurn();
    }

    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error("turn/start response missing turn.id");
    }

    activeTurnByThread.set(params.id, turnId);
    if (previous.options?.cwd) {
      db.updateThreadProjectKey(params.id, normalizeProjectKey(previous.options.cwd));
      threadContextResolver.invalidate(params.id);
    }
    return { ok: true, appliedToTurnId: turnId };
  }

  const activeTurnId = activeTurnByThread.get(params.id);
  if (!activeTurnId) {
    return { ok: true };
  }

  const interruptTurn = async (): Promise<void> => {
    await appServer.request("turn/interrupt", {
      threadId: params.id,
      turnId: activeTurnId,
    });
  };

  try {
    await interruptTurn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("thread not loaded")) {
      throw error;
    }
    await appServer.request("thread/resume", { threadId: params.id });
    await interruptTurn();
  }

  return { ok: true, appliedToTurnId: activeTurnId };
});

app.addHook("onClose", async () => {
  terminalManager.destroy();
});
  return app;
}
