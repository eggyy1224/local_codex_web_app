import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  AccountRateLimitsResponse,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalType,
  CreateReviewRequest,
  CreateReviewResponse,
  InteractionRespondRequest,
  InteractionRespondResponse,
  InteractionType,
  CreateTurnRequest,
  CreateTurnResponse,
  GatewayEvent,
  HealthResponse,
  ModelOption,
  ModelsResponse,
  PendingApprovalsResponse,
  PendingInteractionsResponse,
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
  TurnView,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "./appServerPort.js";
import {
  gatewayDb,
  type ApprovalProjection,
  type InteractionProjection,
  type GatewayDbPort,
  type ThreadProjection,
} from "./db.js";
import {
  approvalTypeFromMethod,
  applyFilters,
  isUserInputRequestMethod,
  kindFromMethod,
  permissionModeToTurnStartParams,
  statusFromRaw,
  toModelOption,
  type RawModel,
} from "./gatewayHelpers.js";
import { TerminalManager } from "./terminalManager.js";
import { parseTimelineItemsFromLines } from "./timelineParser.js";
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

type RawModelListResult = {
  data?: RawModel[];
  nextCursor?: string | null;
};

type RawSkillMetadata = {
  name?: unknown;
  path?: unknown;
  enabled?: unknown;
};

type RawSkillsListEntry = {
  cwd?: unknown;
  skills?: RawSkillMetadata[];
};

type RawSkillsListResult = {
  data?: RawSkillsListEntry[];
};

type RawAppInfo = {
  id?: unknown;
  name?: unknown;
  isAccessible?: unknown;
  isEnabled?: unknown;
};

type RawAppListResult = {
  data?: RawAppInfo[];
  nextCursor?: string | null;
};

type RawCollaborationModeMask = {
  name?: unknown;
  mode?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  developer_instructions?: unknown;
};

type RawCollaborationModeListResult = {
  data?: RawCollaborationModeMask[];
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
  const pendingInteractions = new Map<
    string,
    {
      rpcId: string | number;
      threadId: string;
      turnId: string | null;
      type: InteractionType;
    }
  >();
  let collaborationModeListSupported: boolean | null = null;

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

function unixSecondsToIso(ts?: number): string {
  if (!ts || Number.isNaN(ts)) {
    return new Date().toISOString();
  }
  return new Date(ts * 1000).toISOString();
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isResumeNeeded(message: string): boolean {
  return message.includes("thread not loaded") || message.includes("thread not found");
}

function dedupeInputItemKey(inputItem: { type: string; name: string; path: string }): string {
  return `${inputItem.type}|${inputItem.name}|${inputItem.path}`;
}

function findSlashTokens(input: CreateTurnRequest["input"]): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (item.type !== "text") {
      continue;
    }
    const matches = item.text.match(/\$[A-Za-z0-9._-]+/g);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const token = match.slice(1);
      const normalized = token.toLowerCase();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      tokens.push(normalized);
    }
  }

  return tokens;
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
  const lines: string[] = [];

  try {
    for await (const line of reader) {
      lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return parseTimelineItemsFromLines(lines, threadId, limit);
}

function readCollaborationModeMasks(raw: unknown): RawCollaborationModeMask[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  const data = record.data;
  if (Array.isArray(data)) {
    return data.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  const presets = record.collaborationModes;
  if (Array.isArray(presets)) {
    return presets.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  return [];
}

function makeReadableModeError(mode: "plan" | "default", message: string): Error {
  const error = new Error(`collaboration mode "${mode}" unavailable: ${message}`) as Error & {
    statusCode?: number;
  };
  error.statusCode = 400;
  return error;
}

function isCollaborationModeListUnsupported(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unsupported method: collaborationmode/list") ||
    normalized.includes("unhandled method: collaborationmode/list") ||
    (normalized.includes("method not found") && normalized.includes("collaborationmode/list"))
  );
}

async function resolveCollaborationMode(
  mode: "plan" | "default",
  fallbackModel?: string,
): Promise<{
  mode: "plan" | "default";
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: string | null;
  };
}> {
  if (collaborationModeListSupported === false) {
    throw makeReadableModeError(mode, "unsupported method: collaborationMode/list");
  }

  let rawResult: unknown;
  try {
    rawResult = await appServer.request("collaborationMode/list", {});
    collaborationModeListSupported = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCollaborationModeListUnsupported(message)) {
      collaborationModeListSupported = false;
    }
    throw makeReadableModeError(mode, message);
  }

  const presets = readCollaborationModeMasks(rawResult);
  const preset =
    presets.find((entry) => readString(entry.mode) === mode) ??
    presets.find((entry) => readString(entry.name)?.toLowerCase() === mode);
  if (!preset) {
    throw makeReadableModeError(mode, "preset not found");
  }

  const model = readString(preset.model) ?? fallbackModel ?? null;
  if (!model) {
    throw makeReadableModeError(mode, "preset missing model");
  }

  const reasoningEffort = readString(preset.reasoning_effort);
  const developerInstructions =
    preset.developer_instructions === null
      ? null
      : readString(preset.developer_instructions);

  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: developerInstructions ?? null,
    },
  };
}

async function resolveCollaborationModeWithFallback(
  mode: "plan" | "default" | undefined,
  fallbackModel: string | undefined,
  warnings: string[],
): Promise<
  | {
      mode: "plan" | "default";
      settings: {
        model: string;
        reasoning_effort: string | null;
        developer_instructions: string | null;
      };
    }
  | undefined
> {
  if (!mode) {
    return undefined;
  }

  try {
    return await resolveCollaborationMode(mode, fallbackModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "plan" && isCollaborationModeListUnsupported(message)) {
      warnings.push("plan_mode_fallback");
      return undefined;
    }
    throw error;
  }
}

async function listEnabledSkills(cwd?: string): Promise<Map<string, { name: string; path: string }>> {
  const skillsByToken = new Map<string, { name: string; path: string }>();
  const params =
    cwd && cwd !== "unknown"
      ? {
          cwds: [cwd],
        }
      : {};
  const result = (await appServer.request("skills/list", params)) as RawSkillsListResult;

  for (const entry of result.data ?? []) {
    for (const skill of entry.skills ?? []) {
      const name = readString(skill.name);
      const path = readString(skill.path);
      const enabled =
        typeof skill.enabled === "boolean" ? skill.enabled : true;
      if (!name || !path || !enabled) {
        continue;
      }
      const token = name.toLowerCase();
      if (!skillsByToken.has(token)) {
        skillsByToken.set(token, { name, path });
      }
    }
  }

  return skillsByToken;
}

async function listAppsForMentions(threadId: string): Promise<Map<string, { id: string; name: string }>> {
  const appsByToken = new Map<string, { id: string; name: string }>();
  let cursor: string | null = null;

  for (let i = 0; i < 20; i += 1) {
    const result = (await appServer.request("app/list", {
      cursor,
      limit: 100,
      threadId,
      forceRefetch: false,
    })) as RawAppListResult;

    for (const appEntry of result.data ?? []) {
      const id = readString(appEntry.id);
      const name = readString(appEntry.name);
      const isAccessible = appEntry.isAccessible === true;
      const isEnabled = appEntry.isEnabled === true;
      if (!id || !name || !isAccessible || !isEnabled) {
        continue;
      }
      const token = id.toLowerCase();
      if (!appsByToken.has(token)) {
        appsByToken.set(token, { id, name });
      }
    }

    cursor = result.nextCursor ?? null;
    if (!cursor) {
      break;
    }
  }

  return appsByToken;
}

async function appendInjectedSkillAndMentionItems(
  threadId: string,
  input: CreateTurnRequest["input"],
  cwd?: string,
): Promise<CreateTurnRequest["input"]> {
  const tokens = findSlashTokens(input);
  if (tokens.length === 0) {
    return input;
  }

  const dedupeKeys = new Set<string>();
  for (const item of input) {
    if (item.type === "skill" || item.type === "mention") {
      dedupeKeys.add(dedupeInputItemKey(item));
    }
  }

  const [skillsResult, appsResult] = await Promise.allSettled([
    listEnabledSkills(cwd),
    listAppsForMentions(threadId),
  ]);

  const skillsByToken =
    skillsResult.status === "fulfilled"
      ? skillsResult.value
      : new Map<string, { name: string; path: string }>();
  const appsByToken =
    appsResult.status === "fulfilled"
      ? appsResult.value
      : new Map<string, { id: string; name: string }>();

  if (skillsResult.status === "rejected") {
    app.log.warn(
      { err: skillsResult.reason },
      "skills/list failed, skipping skill auto-injection",
    );
  }
  if (appsResult.status === "rejected") {
    app.log.warn(
      { err: appsResult.reason },
      "app/list failed, skipping app mention auto-injection",
    );
  }

  const additions: CreateTurnRequest["input"] = [];
  for (const token of tokens) {
    const skill = skillsByToken.get(token);
    if (skill) {
      const next = {
        type: "skill" as const,
        name: skill.name,
        path: skill.path,
      };
      const key = dedupeInputItemKey(next);
      if (!dedupeKeys.has(key)) {
        dedupeKeys.add(key);
        additions.push(next);
      }
      continue;
    }

    const appEntry = appsByToken.get(token);
    if (!appEntry) {
      continue;
    }
    const next = {
      type: "mention" as const,
      name: appEntry.name,
      path: `app://${appEntry.id}`,
    };
    const key = dedupeInputItemKey(next);
    if (!dedupeKeys.has(key)) {
      dedupeKeys.add(key);
      additions.push(next);
    }
  }

  if (additions.length === 0) {
    return input;
  }
  return [...input, ...additions];
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

function readInteractionAnswers(
  raw: InteractionRespondRequest["answers"],
): Record<string, { answers: string[] }> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const normalized: Record<string, { answers: string[] }> = {};
  let questionCount = 0;
  for (const [questionId, value] of Object.entries(raw)) {
    if (questionId.trim().length === 0) {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const candidate = value as { answers?: unknown };
    if (!Array.isArray(candidate.answers)) {
      return null;
    }
    const answers = candidate.answers
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (answers.length === 0) {
      return null;
    }
    normalized[questionId] = { answers };
    questionCount += 1;
  }
  return questionCount > 0 ? normalized : null;
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

    if (!isResumeNeeded(message)) {
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

app.get(
  "/api/threads/:id/interactions/pending",
  async (request): Promise<PendingInteractionsResponse> => {
    const params = request.params as { id: string };
    return {
      data: db.listPendingInteractionsByThread(params.id),
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

  const projected = db.getProjectedThread(params.id);
  const inferredCwd =
    body.options?.cwd ??
    (projected?.projectKey && projected.projectKey !== "unknown"
      ? projected.projectKey
      : undefined);
  const input = await appendInjectedSkillAndMentionItems(
    params.id,
    body.input,
    inferredCwd,
  );
  const warnings: string[] = [];
  const collaborationMode = await resolveCollaborationModeWithFallback(
    body.options?.collaborationMode,
    body.options?.model,
    warnings,
  );

  lastTurnInputByThread.set(params.id, {
    input,
    options: body.options,
  });

  const startTurn = async (): Promise<{ turn?: RawTurn }> =>
    (await appServer.request("turn/start", {
      threadId: params.id,
      input,
      ...(body.options?.model ? { model: body.options.model } : {}),
      ...(body.options?.effort ? { effort: body.options.effort } : {}),
      ...(body.options?.cwd ? { cwd: body.options.cwd } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
      ...permissionModeToTurnStartParams(body.options?.permissionMode),
    })) as { turn?: RawTurn };

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

  return warnings.length > 0 ? { turnId, warnings } : { turnId };
});

app.post("/api/threads/:id/review", async (request): Promise<CreateReviewResponse> => {
  const params = request.params as { id: string };
  const body = (request.body ?? {}) as CreateReviewRequest;
  const instructions =
    typeof body.instructions === "string" ? body.instructions.trim() : "";

  const target =
    instructions.length > 0
      ? {
          type: "custom" as const,
          instructions,
        }
      : body.target ?? { type: "uncommittedChanges" as const };
  const delivery = body.delivery ?? "inline";

  const startReview = async (): Promise<{
    turn?: RawTurn;
    reviewThreadId?: unknown;
  }> =>
    (await appServer.request("review/start", {
      threadId: params.id,
      delivery,
      target,
    })) as {
      turn?: RawTurn;
      reviewThreadId?: unknown;
    };

  let result: {
    turn?: RawTurn;
    reviewThreadId?: unknown;
  };
  try {
    result = await startReview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isResumeNeeded(message)) {
      throw error;
    }
    await appServer.request("thread/resume", { threadId: params.id });
    result = await startReview();
  }

  const turnId = result.turn?.id;
  if (!turnId) {
    throw new Error("review/start response missing turn.id");
  }

  return {
    turnId,
    reviewThreadId: readString(result.reviewThreadId) ?? params.id,
  };
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

app.post(
  "/api/threads/:id/interactions/:interactionId/respond",
  async (request): Promise<InteractionRespondResponse> => {
    const params = request.params as { id: string; interactionId: string };
    const body = request.body as InteractionRespondRequest;
    const answers = readInteractionAnswers(body?.answers);
    if (!answers) {
      const error = new Error("invalid answers") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const pending = pendingInteractions.get(params.interactionId);
    const interaction = db.getInteractionById(params.interactionId);
    if (!pending && !interaction) {
      const error = new Error("interaction not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const ownerThreadId = interaction?.threadId ?? pending?.threadId ?? null;
    if (ownerThreadId && ownerThreadId !== params.id) {
      const error = new Error("interaction not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    const fallbackRpcId: string | number = /^\d+$/.test(params.interactionId)
      ? Number(params.interactionId)
      : params.interactionId;
    const rpcId = pending?.rpcId ?? fallbackRpcId;
    const threadId = ownerThreadId ?? params.id;
    const turnId = pending?.turnId ?? interaction?.turnId ?? null;

    appServer.respond(rpcId, {
      answers,
    });

    const resolvedAt = new Date().toISOString();
    const responsePayloadJson = JSON.stringify({ answers });
    db.respondInteractionRequest(
      params.interactionId,
      "responded",
      responsePayloadJson,
      resolvedAt,
    );

    pendingInteractions.delete(params.interactionId);
    db.insertAuditLog({
      ts: resolvedAt,
      actor: "user",
      action: "interaction.responded",
      threadId,
      turnId,
      metadata: {
        interactionId: params.interactionId,
      },
    });

    const eventBase: Omit<GatewayEvent, "seq"> = {
      serverTs: resolvedAt,
      threadId,
      turnId,
      kind: "interaction",
      name: "interaction/responded",
      payload: {
        interactionId: params.interactionId,
      },
    };
    const seq = db.insertGatewayEvent(eventBase);
    broadcast({ ...eventBase, seq });

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

    const collaborationMode = await resolveCollaborationModeWithFallback(
      previous.options?.collaborationMode,
      previous.options?.model,
      [],
    );

    const startTurn = async (): Promise<{ turn?: RawTurn }> =>
      (await appServer.request("turn/start", {
        threadId: params.id,
        input: previous.input,
        ...(previous.options?.model ? { model: previous.options.model } : {}),
        ...(previous.options?.effort ? { effort: previous.options.effort } : {}),
        ...(previous.options?.cwd ? { cwd: previous.options.cwd } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        ...permissionModeToTurnStartParams(previous.options?.permissionMode),
      })) as { turn?: RawTurn };

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
    if (!isResumeNeeded(message)) {
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
