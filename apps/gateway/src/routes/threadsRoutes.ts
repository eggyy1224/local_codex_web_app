import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { FastifyInstance } from "fastify";
import type {
  GatewayEvent,
  ThreadContextResponse,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadListResponse,
  ThreadTimelineItem,
  ThreadTimelineResponse,
} from "@lcwa/shared-types";
import type { PendingApprovalEntry } from "../appServerProjection.js";
import type { GatewayAppServerPort } from "../appServerPort.js";
import type { GatewayDbPort, ThreadProjection } from "../db.js";
import {
  applyFilters,
  isResumeNeeded,
  toThreadListItem,
  toThreadMeta,
  toTurnView,
  type RawThread,
} from "../gatewayHelpers.js";
import { parseTimelineItemsFromLines } from "../timelineParser.js";
import {
  GATEWAY_ORIGINATOR,
  ThreadContextResolver,
  normalizeProjectKey,
} from "../threadContext.js";

/**
 * Default scope hides Codex threads opened by other clients on this machine
 * (codex-tui, Claude Code, Codex Desktop, …). `?scope=all` is the escape hatch
 * that returns everything — nothing is deleted, only filtered by default.
 */
type ThreadListScope = "gateway" | "all";

function parseThreadListScope(scope: string | undefined): ThreadListScope {
  return scope === "all" ? "all" : "gateway";
}

/**
 * Default-scope resume cursor.
 *
 * The default scope walks several raw `thread/list` pages and scope-filters
 * each, so the response is sliced to `limit` SCOPED rows — which can land in
 * the MIDDLE of the raw page that straddled the boundary. Returning the bare
 * upstream raw cursor would then SKIP the scoped rows we sliced off that
 * straddling page (silent data loss). So the cursor is a composite of:
 *   - `raw`: the upstream raw cursor that RE-FETCHES the straddling page
 *            (i.e. the cursor that was used to request it), so the next
 *            request can re-scope it and continue, OR the upstream nextCursor
 *            when the boundary fell exactly on a raw-page edge.
 *   - `seenIds`: the thread ids of the SCOPED rows of that straddling page
 *            that were already delivered. On resume the page is re-fetched and
 *            re-scoped, and any row whose id is in `seenIds` is dropped — by
 *            IDENTITY, not by numeric count.
 *
 * Why an id SET and not a numeric `skip`: the `raw:null` case re-fetches the
 * upstream HEAD page. If a new thread arrived at the head between the request
 * that minted the cursor and the resume request, the head page SHIFTED, so a
 * count-based skip would drop the wrong rows (dropping a never-seen thread, or
 * re-delivering an already-seen one). Skipping by id set is position-stable:
 * already-delivered rows are dropped wherever they now sit, and a brand-new
 * head thread (id not in the set) is delivered exactly once. Non-null `raw`
 * (Codex keyset/timestamp-anchored, stable) is handled by the same path with
 * no behaviour change. `seenIds` is bounded by `limit` (≤100) since a page
 * never delivers more than `limit` rows — a few KB of base64 at worst, fine
 * for this single-user local app.
 *
 * Degrade: if NONE of `seenIds` are present in the re-fetched scoped page
 * (rare: every anchor thread was deleted), nothing is dropped and the page is
 * re-emitted from its top — best-effort (may re-deliver a row once), but never
 * a 500 and never an infinite loop (the upstream cursor still advances past
 * the straddling page on the next iteration).
 *
 * Encoding: `g1:` + base64(JSON({raw,seenIds})). The `g1:` sentinel keeps it
 * distinguishable from a bare upstream cursor; a bare string (old client / no
 * prior gateway cursor) decodes as `{raw: <string>, seenIds: []}`; a corrupt
 * `g1:` payload decodes as `{raw: null, seenIds: []}` (restart from head, no
 * loop). `scope=all` never uses this — its cursor stays the raw upstream
 * cursor, unchanged.
 */
type GatewayListCursor = { raw: string | null; seenIds: string[] };

const GATEWAY_CURSOR_PREFIX = "g1:";

function decodeGatewayCursor(cursor: string | undefined): GatewayListCursor {
  if (!cursor) {
    return { raw: null, seenIds: [] };
  }
  if (cursor.startsWith(GATEWAY_CURSOR_PREFIX)) {
    try {
      const json = Buffer.from(
        cursor.slice(GATEWAY_CURSOR_PREFIX.length),
        "base64",
      ).toString("utf8");
      const parsed = JSON.parse(json) as {
        raw?: unknown;
        seenIds?: unknown;
      };
      const raw = typeof parsed.raw === "string" ? parsed.raw : null;
      const seenIds = Array.isArray(parsed.seenIds)
        ? parsed.seenIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      return { raw, seenIds };
    } catch {
      // Corrupt cursor → restart from the head rather than 500.
      return { raw: null, seenIds: [] };
    }
  }
  // Bare upstream cursor (old client, or first gateway-scoped page request).
  return { raw: cursor, seenIds: [] };
}

function encodeGatewayCursor(value: GatewayListCursor): string {
  return (
    GATEWAY_CURSOR_PREFIX +
    Buffer.from(JSON.stringify(value), "utf8").toString("base64")
  );
}

/**
 * Bounded-concurrency async map. Used to cap the number of concurrent
 * per-thread `resolveOriginator()` JSONL reads when scoping a page (the High
 * fix walks several raw pages, so an unbounded `Promise.all` over every row
 * could open hundreds of file descriptors at once on a local disk).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Max concurrent session-JSONL reads during a single list request. */
const ORIGINATOR_READ_CONCURRENCY = 8;

/**
 * Whether a single thread is visible under the default ("gateway") scope.
 *
 * NULL-originator policy: a thread whose originator we cannot positively
 * resolve is KEPT, never hidden — we only drop a thread once we have read a
 * concrete non-gateway originator from its Codex session JSONL. Missing
 * originators are lazily read once and persisted (best-effort, no full
 * re-scan), so the projection converges without a migration backfill.
 */
async function isThreadInGatewayScope(
  threadId: string,
  deps: {
    db: GatewayDbPort;
    threadContextResolver: ThreadContextResolver;
  },
): Promise<boolean> {
  let originator = deps.db.getThreadOriginator(threadId);
  if (originator === null) {
    // Lazy, best-effort backfill: read session_meta.payload.originator and
    // persist it so later list calls are a cheap DB read.
    originator = await deps.threadContextResolver.resolveOriginator(threadId);
    if (originator !== null) {
      deps.db.updateThreadOriginator(threadId, originator);
    }
  }
  if (originator === null) {
    // Unknown → bias to NOT hiding a possibly gateway-owned thread.
    return true;
  }
  return originator === GATEWAY_ORIGINATOR;
}

/**
 * Filter a thread list to gateway-owned threads for the default scope, with a
 * bounded number of concurrent session-JSONL reads. `scope === "all"` bypasses
 * all filtering and returns the input untouched (no behaviour change).
 */
async function filterThreadsByScope(
  items: ThreadListItem[],
  scope: ThreadListScope,
  deps: {
    db: GatewayDbPort;
    threadContextResolver: ThreadContextResolver;
  },
): Promise<ThreadListItem[]> {
  if (scope === "all") {
    return items;
  }

  const keep = await mapWithConcurrency(
    items,
    ORIGINATOR_READ_CONCURRENCY,
    (item) => isThreadInGatewayScope(item.id, deps),
  );

  return items.filter((_, index) => keep[index]);
}

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
      scope?: string;
    };

    const limit = Math.min(Math.max(Number(query.limit ?? "25") || 25, 1), 100);
    const scope = parseThreadListScope(query.scope);

    const approvalCountByThread = new Map<string, number>();
    for (const pending of pendingApprovals.values()) {
      approvalCountByThread.set(
        pending.threadId,
        (approvalCountByThread.get(pending.threadId) ?? 0) + 1,
      );
    }

    // Project + persist one raw thread/list page, resolving project keys and
    // upserting the projection (originator stays NULL here; it is backfilled
    // lazily by the scope predicate, and the upsert COALESCEs so NULL never
    // wipes an already-resolved value).
    const projectAndPersistRawPage = async (
      rawThreads: RawThread[],
    ): Promise<ThreadListItem[]> => {
      const items = await Promise.all(
        rawThreads.map(async (thread) => {
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
          return toThreadListItem(
            thread,
            projectKey,
            approvalCountByThread.get(thread.id) ?? 0,
          );
        }),
      );

      db.upsertThreads(
        items.map((item) => ({
          thread_id: item.id,
          project_key: item.projectKey,
          title: item.title,
          preview: item.preview,
          status: item.status,
          archived: item.archived ? 1 : 0,
          updated_at: item.lastActiveAt,
          last_error: item.errorCount > 0 ? "systemError" : null,
          originator: null,
        })),
      );

      return items;
    };

    try {
      // scope=all: single raw page, upstream cursor passthrough — the escape
      // hatch returns everything with no scope filtering and no extra paging.
      if (scope === "all") {
        const result = (await appServer.request("thread/list", {
          cursor: query.cursor ?? null,
          limit,
          archived: query.archived === "true",
        })) as {
          data?: RawThread[];
          nextCursor?: string | null;
        };
        const items = await projectAndPersistRawPage(result.data ?? []);
        return {
          data: applyFilters(items, query),
          nextCursor: result.nextCursor ?? null,
        };
      }

      // Default scope: the scope filter must run BEFORE pagination, so walk
      // successive raw pages via the upstream cursor, accumulating SCOPED rows
      // until we have `limit` of them or the upstream cursor is exhausted.
      // Every raw row is still upserted (projection completeness). A pathological
      // all-external history is bounded by MAX_RAW_PAGES_PER_REQUEST: at most
      // that many upstream pages are walked per request; if the bound is hit
      // with the upstream cursor still live we return a cursor so a follow-up
      // request resumes the scan instead of looping unboundedly.
      const MAX_RAW_PAGES_PER_REQUEST = 20;
      const decoded = decodeGatewayCursor(query.cursor);
      const scopedAccumulator: ThreadListItem[] = [];
      let cursor: string | null = decoded.raw;
      // Ids of the scoped rows of the FIRST re-fetched page already delivered
      // by the request that produced this cursor. Dropped again by IDENTITY
      // (head-insertion stable), never by numeric position.
      const initialSeenIds = new Set(decoded.seenIds);
      let pagesWalked = 0;
      let nextCursor: string | null = null;

      while (pagesWalked < MAX_RAW_PAGES_PER_REQUEST) {
        // The cursor that produced THIS page; the composite cursor points back
        // here so a mid-page boundary can be resumed without skips.
        const cursorUsedForPage: string | null = cursor;
        const result = (await appServer.request("thread/list", {
          cursor: cursorUsedForPage,
          limit,
          archived: query.archived === "true",
        })) as {
          data?: RawThread[];
          nextCursor?: string | null;
        };
        pagesWalked += 1;

        const items = await projectAndPersistRawPage(result.data ?? []);
        let scopedPage = await filterThreadsByScope(items, scope, {
          db,
          threadContextResolver,
        });
        // First re-fetched page: drop the scoped rows a prior request already
        // returned from it, matched by thread id (NOT by count) so a head
        // insert between the two requests can neither skip nor duplicate. If
        // none match (all anchors deleted) nothing is dropped → safe degrade.
        if (pagesWalked === 1 && initialSeenIds.size > 0) {
          scopedPage = scopedPage.filter(
            (item) => !initialSeenIds.has(item.id),
          );
        }

        const pageStartIndex = scopedAccumulator.length;
        scopedAccumulator.push(...scopedPage);

        const upstreamCursor = result.nextCursor ?? null;
        if (scopedAccumulator.length >= limit) {
          // We have a full page of scoped rows. The straddling raw page is THIS
          // one; the first `scopedFromThisPageReturned` of its (post-filter)
          // scoped rows are in the sliced response, the rest are sliced off and
          // must be resumed — NOT skipped.
          const scopedFromThisPageReturned = limit - pageStartIndex;
          const remainingInThisPage =
            scopedPage.length - scopedFromThisPageReturned;
          if (remainingInThisPage > 0) {
            // Re-fetch this same page next time. The anchor is the SET of ids
            // already delivered from it: everything previously seen from this
            // page (still hidden by id) PLUS what we just returned. Resume
            // drops by id, so a new head thread is delivered once and seen
            // rows are skipped wherever they land.
            const deliveredIdsFromThisPage = scopedPage
              .slice(0, scopedFromThisPageReturned)
              .map((item) => item.id);
            const seenIds =
              pagesWalked === 1
                ? [...initialSeenIds, ...deliveredIdsFromThisPage]
                : deliveredIdsFromThisPage;
            nextCursor = encodeGatewayCursor({
              raw: cursorUsedForPage,
              seenIds,
            });
          } else if (upstreamCursor) {
            // Boundary fell exactly on this raw page's edge — resume cleanly at
            // the next raw page (no per-page anchor needed).
            nextCursor = encodeGatewayCursor({
              raw: upstreamCursor,
              seenIds: [],
            });
          } else {
            nextCursor = null;
          }
          break;
        }
        if (!upstreamCursor) {
          // Upstream history fully consumed — nothing more to scan.
          nextCursor = null;
          break;
        }
        cursor = upstreamCursor;
        if (pagesWalked >= MAX_RAW_PAGES_PER_REQUEST) {
          // Hit the safety bound with the upstream cursor still live: stop
          // scanning this request but let the client resume from here.
          nextCursor = encodeGatewayCursor({
            raw: upstreamCursor,
            seenIds: [],
          });
          break;
        }
      }

      return {
        data: applyFilters(scopedAccumulator.slice(0, limit), query),
        nextCursor,
      };
    } catch (error) {
      app.log.error({ err: error }, "thread/list failed, fallback to projection cache");

      const hydrate = async (
        thread: ThreadListItem,
      ): Promise<ThreadListItem> => {
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
        return { ...thread, projectKey, waitingApprovalCount };
      };

      // scope=all: single projection page, unfiltered (unchanged behaviour).
      if (scope === "all") {
        const hydrated = await Promise.all(
          db.listProjectedThreads(limit).map(hydrate),
        );
        return {
          data: applyFilters(hydrated, query),
          nextCursor: null,
        };
      }

      // Default scope. The SQL scope predicate (`originator = ? OR originator
      // IS NULL`) runs BEFORE the LIMIT, but on a freshly-migrated cache EVERY
      // row is `originator IS NULL`, so the predicate is a no-op: the newest
      // `limit` rows (mostly external, still NULL) fill one page and the
      // post-SQL lazy disk resolve drops the external ones, hiding older real
      // gateway rows entirely. So WALK successive keyset pages — lazily
      // resolving+persisting originator via the scope filter — until we have
      // `limit` scoped rows, the projection is exhausted, or a page-walk bound
      // is hit. Mirrors the live path's bounded raw-page walk. The
      // projection-cache fallback is a degraded mode (app-server down): a
      // single non-paginated screenful is returned (nextCursor: null), just a
      // CORRECT screenful now.
      const MAX_SQL_PAGES_PER_REQUEST = 20;
      const scopedAccumulator: ThreadListItem[] = [];
      let after: { updatedAt: string; threadId: string } | null = null;
      let sqlPagesWalked = 0;

      while (sqlPagesWalked < MAX_SQL_PAGES_PER_REQUEST) {
        const pageRows = db.listProjectedThreadsScopedPage(
          limit,
          GATEWAY_ORIGINATOR,
          after,
        );
        sqlPagesWalked += 1;
        if (pageRows.length === 0) {
          break;
        }

        const hydrated = await Promise.all(
          pageRows.map((row) =>
            hydrate({
              id: row.thread_id,
              projectKey: row.project_key || "unknown",
              title: row.title,
              preview: row.preview,
              status: row.status,
              lastActiveAt: row.updated_at,
              archived: row.archived === 1,
              waitingApprovalCount: 0,
              errorCount: row.last_error ? 1 : 0,
            }),
          ),
        );
        const scopedPage = await filterThreadsByScope(hydrated, scope, {
          db,
          threadContextResolver,
        });
        scopedAccumulator.push(...scopedPage);

        if (scopedAccumulator.length >= limit) {
          break;
        }
        if (pageRows.length < limit) {
          // Last SQL page (scoped predicate exhausted).
          break;
        }
        const lastRow = pageRows[pageRows.length - 1];
        after = { updatedAt: lastRow.updated_at, threadId: lastRow.thread_id };
      }

      return {
        data: applyFilters(scopedAccumulator.slice(0, limit), query),
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
          // Forked through THIS gateway → definitively gateway-owned. Record it
          // eagerly so the new thread is correctly scoped without a JSONL read.
          originator: GATEWAY_ORIGINATOR,
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
        // Started through THIS gateway → definitively gateway-owned.
        originator: GATEWAY_ORIGINATOR,
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

    // Read the SSE resume cursor BEFORE building the snapshot. The timeline
    // comes from the rollout/session file while lastSeq comes from events_log —
    // two non-atomic stores. If we measured lastSeq after the (non-atomic)
    // timeline read, an event inserted during the read could be missing from
    // `data` yet covered by lastSeq, so the client would treat it as already
    // reflected and never replay it (lost until a later resync). Measuring
    // first makes lastSeq a safe lower bound: any later event is still replayed
    // over SSE (at worst a deduped duplicate, never a gap).
    const lastSeq = db.getMaxGatewayEventSeq(params.id);
    const data = await loadThreadTimelineFromSession(threadContextResolver, params.id, limit);
    return { data, lastSeq };
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
