import cors from "@fastify/cors";
import Fastify from "fastify";
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalType,
  CreateTurnRequest,
  CreateTurnResponse,
  GatewayEvent,
  HealthResponse,
  PendingApprovalsResponse,
  ThreadDetailResponse,
  ThreadControlRequest,
  ThreadControlResponse,
  ThreadListItem,
  ThreadListResponse,
  ThreadMeta,
  ThreadStatus,
  TurnView,
} from "@lcwa/shared-types";
import { AppServerClient } from "./appServerClient.js";
import {
  getApprovalById,
  getProjectedThread,
  insertGatewayEvent,
  insertAuditLog,
  listPendingApprovalsByThread,
  listGatewayEventsSince,
  listProjectedThreads,
  resolveApprovalRequest,
  upsertApprovalRequest,
  upsertThreads,
  type ApprovalProjection,
  type ThreadProjection,
} from "./db.js";

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

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const defaultWebOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
const corsAllowlist = (process.env.CORS_ALLOWLIST ?? defaultWebOrigin)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 1024 * 1024,
  disableRequestLogging: true,
});

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || corsAllowlist.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
});

const appServer = new AppServerClient();
const subscribers = new Map<string, Set<(event: GatewayEvent) => void>>();
const activeTurnByThread = new Map<string, string>();
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

function toThreadListItem(raw: RawThread): ThreadListItem {
  const status = statusFromRaw(raw.status);
  const title = raw.name ?? raw.preview?.slice(0, 80) ?? raw.id;
  const preview = raw.preview ?? "";
  const lastActiveAt = unixSecondsToIso(raw.updatedAt ?? raw.createdAt);

  return {
    id: raw.id,
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

function kindFromMethod(method: string): GatewayEvent["kind"] {
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

    upsertApprovalRequest(projection);
    pendingApprovals.set(approvalId, {
      rpcId: raw.id,
      threadId,
      turnId,
      type: approvalType,
    });

    insertAuditLog({
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

  const seq = insertGatewayEvent(eventBase);
  broadcast({ ...eventBase, seq });
});

try {
  await appServer.start();
} catch (error) {
  app.log.error({ err: error }, "Failed to start app-server on boot");
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

    const items = (result.data ?? []).map(toThreadListItem);

    const rows: ThreadProjection[] = items.map((item) => ({
      thread_id: item.id,
      title: item.title,
      preview: item.preview,
      status: item.status,
      archived: item.archived ? 1 : 0,
      updated_at: item.lastActiveAt,
      last_error: item.errorCount > 0 ? "systemError" : null,
    }));

    upsertThreads(rows);

    return {
      data: applyFilters(items, query),
      nextCursor: result.nextCursor ?? null,
    };
  } catch (error) {
    app.log.error({ err: error }, "thread/list failed, fallback to projection cache");

    return {
      data: applyFilters(listProjectedThreads(limit), query),
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
    const result = (await appServer.request("thread/fork", {
      threadId: body.fromThreadId,
    })) as {
      thread?: RawThread;
    };
    const thread = result.thread;
    if (!thread?.id) {
      throw new Error("thread/fork response missing thread.id");
    }

    const item = toThreadListItem(thread);
    upsertThreads([
      {
        thread_id: item.id,
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

  const item = toThreadListItem(thread);
  upsertThreads([
    {
      thread_id: item.id,
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
    const projected = getProjectedThread(params.id);
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

app.get("/api/threads/:id/events", async (request, reply) => {
  const params = request.params as { id: string };
  const query = request.query as { since?: string };
  const since = Number(query.since ?? "0") || 0;
  const origin =
    typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const allowOrigin = origin && corsAllowlist.includes(origin) ? origin : corsAllowlist[0];

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

  const replay = listGatewayEventsSince(params.id, since, 1000);
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
      data: listPendingApprovalsByThread(params.id),
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
    const approval = getApprovalById(params.approvalId);
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
    resolveApprovalRequest(
      params.approvalId,
      status,
      body.decision,
      body.note ?? null,
      resolvedAt,
    );

    pendingApprovals.delete(params.approvalId);

    insertAuditLog({
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

    const seq = insertGatewayEvent(decisionEventBase);
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

await app.listen({ host, port });
