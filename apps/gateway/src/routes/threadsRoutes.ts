import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { FastifyInstance } from "fastify";
import type {
  GatewayEvent,
  ThreadContextResponse,
  ThreadDetailResponse,
  ThreadListResponse,
  ThreadTimelineItem,
  ThreadTimelineResponse,
} from "@lcwa/shared-types";
import type { ApprovalType } from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";
import type { GatewayDbPort, ThreadProjection } from "../db.js";

export type PendingApprovalEntry = {
  rpcId: string | number;
  threadId: string;
  turnId: string | null;
  type: ApprovalType;
};
import {
  applyFilters,
  isResumeNeeded,
  toThreadListItem,
  toThreadMeta,
  toTurnView,
  type RawThread,
} from "../gatewayHelpers.js";
import { parseTimelineItemsFromLines } from "../timelineParser.js";
import { ThreadContextResolver, normalizeProjectKey } from "../threadContext.js";

export type ThreadsRoutesDeps = {
  appServer: GatewayAppServerPort;
  db: GatewayDbPort;
  threadContextResolver: ThreadContextResolver;
  pendingApprovals: Map<string, PendingApprovalEntry>;
  subscribe: (
    threadId: string,
    fn: (event: GatewayEvent) => void,
  ) => () => void;
  corsAllowlist: ReadonlyArray<string>;
};

async function loadThreadTimelineFromSession(
  threadContextResolver: ThreadContextResolver,
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

export function registerThreadsRoutes(
  app: FastifyInstance,
  {
    appServer,
    db,
    threadContextResolver,
    pendingApprovals,
    subscribe,
    corsAllowlist,
  }: ThreadsRoutesDeps,
): void {
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

      const approvalCountByThread = new Map<string, number>();
      for (const pending of pendingApprovals.values()) {
        approvalCountByThread.set(
          pending.threadId,
          (approvalCountByThread.get(pending.threadId) ?? 0) + 1,
        );
      }

      const items = await Promise.all(
        (result.data ?? []).map(async (thread) => {
          const projected = db.getProjectedThread(thread.id);
          let projectKey = projected?.projectKey ?? "unknown";
          if (projectKey === "unknown") {
            projectKey = await threadContextResolver.resolveProjectKey(
              thread.id,
              projected?.projectKey,
            );
            if (projectKey !== "unknown") {
              db.updateThreadProjectKey(thread.id, projectKey);
              threadContextResolver.invalidate(thread.id);
            }
          }
          return toThreadListItem(thread, projectKey, approvalCountByThread.get(thread.id) ?? 0);
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
      const approvalCountByThread = new Map<string, number>();
      for (const pending of pendingApprovals.values()) {
        approvalCountByThread.set(
          pending.threadId,
          (approvalCountByThread.get(pending.threadId) ?? 0) + 1,
        );
      }

      const hydrated = await Promise.all(
        projected.map(async (thread) => {
          const waitingApprovalCount = approvalCountByThread.get(thread.id) ?? 0;
          if (thread.projectKey !== "unknown") {
            return { ...thread, waitingApprovalCount };
          }
          const projectKey = await threadContextResolver.resolveProjectKey(
            thread.id,
            thread.projectKey,
          );
          if (projectKey !== "unknown") {
            db.updateThreadProjectKey(thread.id, projectKey);
            threadContextResolver.invalidate(thread.id);
          }
          return {
            ...thread,
            projectKey,
            waitingApprovalCount,
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

    const data = await loadThreadTimelineFromSession(threadContextResolver, params.id, limit);
    return { data };
  });

  app.get("/api/threads/:id/events", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { since?: string };
    const since = Number(query.since ?? "0") || 0;
    const origin =
      typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const allowOrigin =
      origin && corsAllowlist.includes(origin) ? origin : corsAllowlist[0];

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

    const writeHeartbeat = (): void => {
      reply.raw.write("event: heartbeat\n");
      reply.raw.write(`data: {"ts":"${new Date().toISOString()}"}\n\n`);
    };

    writeHeartbeat();

    const heartbeat = setInterval(writeHeartbeat, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });
}
