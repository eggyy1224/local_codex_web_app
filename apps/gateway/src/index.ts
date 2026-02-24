import cors from "@fastify/cors";
import Fastify from "fastify";
import type { HealthResponse, ThreadListItem, ThreadListResponse, ThreadStatus } from "@lcwa/shared-types";
import { AppServerClient } from "./appServerClient.js";
import { listProjectedThreads, upsertThreads, type ThreadProjection } from "./db.js";

type RawThread = {
  id: string;
  preview?: string;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
};

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const defaultWebOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
const corsAllowlist = (process.env.CORS_ALLOWLIST ?? defaultWebOrigin)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
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

try {
  await appServer.start();
} catch (error) {
  app.log.error({ err: error }, "Failed to start app-server on boot");
}

appServer.on("stderr", (line) => {
  app.log.warn({ appServerStderr: line.trim() }, "app-server stderr");
});

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

await app.listen({ host, port });
