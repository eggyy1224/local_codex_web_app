import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ApprovalType,
  CreateReviewRequest,
  CreateReviewResponse,
  InteractionType,
  CreateTurnRequest,
  CreateTurnResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  GatewayEvent,
  InterruptTurnRequest,
  InterruptTurnResponse,
  RollbackThreadRequest,
  RollbackThreadResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  ThreadControlRequest,
  ThreadControlResponse,
  ThreadStatus,
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
  asRecord,
  isResumeNeeded,
  isUserInputRequestMethod,
  kindFromMethod,
  permissionModeToTurnStartParams,
  readString,
  statusFromRaw,
  toModelOption,
  toThreadListItem,
  type RawModel,
  type RawThread,
  type RawTurn,
} from "./gatewayHelpers.js";
import { TerminalManager } from "./terminalManager.js";
import { parseTimelineItemsFromLines } from "./timelineParser.js";
import { ThreadContextResolver, normalizeProjectKey } from "./threadContext.js";
import { registerApprovalInteractionRoutes } from "./routes/approvalInteractionRoutes.js";
import { registerConfigRoutes } from "./routes/configRoutes.js";
import { registerMiscRoutes } from "./routes/miscRoutes.js";
import { registerTerminalRoutes } from "./routes/terminalRoutes.js";
import { registerThreadsRoutes } from "./routes/threadsRoutes.js";


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
  let collaborationModeListSupported: boolean | null = null;
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


registerConfigRoutes(app, { appServer });

app.post("/api/threads/:id/steer", async (request): Promise<SteerTurnResponse> => {
  const params = request.params as { id: string };
  const body = (request.body ?? {}) as SteerTurnRequest;

  if (typeof body.expectedTurnId !== "string" || body.expectedTurnId.length === 0) {
    const err = new Error("expectedTurnId required") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    const err = new Error("input is required") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const result = (await appServer.request("turn/steer", {
    threadId: params.id,
    expectedTurnId: body.expectedTurnId,
    input: body.input,
  })) as { turnId?: unknown };

  const turnId = readString(result.turnId);
  if (!turnId) {
    const err = new Error("turn/steer response missing turnId") as Error & {
      statusCode?: number;
    };
    err.statusCode = 502;
    throw err;
  }
  return { turnId };
});

app.post(
  "/api/threads/:id/interrupt",
  async (request): Promise<InterruptTurnResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as InterruptTurnRequest;

    if (typeof body.turnId !== "string" || body.turnId.length === 0) {
      const err = new Error("turnId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    await appServer.request("turn/interrupt", {
      threadId: params.id,
      turnId: body.turnId,
    });

    return { ok: true };
  },
);

app.post("/api/threads/:id/fork", async (request): Promise<ForkThreadResponse> => {
  const params = request.params as { id: string };
  const body = (request.body ?? {}) as ForkThreadRequest;

  const rpcParams: Record<string, unknown> = { threadId: params.id };
  if (typeof body.model === "string") {
    rpcParams.model = body.model;
  }
  if (body.serviceTier === "fast" || body.serviceTier === "flex" || body.serviceTier === null) {
    rpcParams.serviceTier = body.serviceTier;
  }
  if (typeof body.approvalPolicy === "string") {
    rpcParams.approvalPolicy = body.approvalPolicy;
  }
  if (typeof body.cwd === "string") {
    rpcParams.cwd = body.cwd;
  }

  const result = (await appServer.request("thread/fork", rpcParams)) as {
    thread?: { id?: unknown };
  };
  const threadId = readString(result.thread?.id);
  if (!threadId) {
    const err = new Error("thread/fork response missing thread.id") as Error & {
      statusCode?: number;
    };
    err.statusCode = 502;
    throw err;
  }
  return { threadId };
});

app.post(
  "/api/threads/:id/rollback",
  async (request): Promise<RollbackThreadResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as RollbackThreadRequest;

    if (
      typeof body.numTurns !== "number" ||
      !Number.isFinite(body.numTurns) ||
      !Number.isInteger(body.numTurns) ||
      body.numTurns < 1
    ) {
      const err = new Error("numTurns must be an integer >= 1") as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    const result = (await appServer.request("thread/rollback", {
      threadId: params.id,
      numTurns: body.numTurns,
    })) as { thread?: { id?: unknown } };
    const threadId = readString(result.thread?.id);
    if (!threadId) {
      const err = new Error("thread/rollback response missing thread.id") as Error & {
        statusCode?: number;
      };
      err.statusCode = 502;
      throw err;
    }
    return { threadId };
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
  terminalManager?.destroy();
});
  return app;
}
