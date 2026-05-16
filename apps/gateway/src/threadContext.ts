import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { FastifyBaseLogger } from "fastify";
import type { ThreadContextResponse } from "@lcwa/shared-types";

const threadIdFromSessionFilePattern =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || value;
}

export function normalizeProjectKey(cwd?: string | null): string {
  if (!cwd) {
    return "unknown";
  }
  const normalized = normalizePath(cwd);
  return normalized || "unknown";
}

function projectKeyToCwd(projectKey?: string | null): string | null {
  if (!projectKey || projectKey === "unknown") {
    return null;
  }
  return normalizePath(projectKey);
}

type ResolverOptions = {
  codexSessionsDir?: string;
  fallbackCwd?: string;
  logger?: FastifyBaseLogger;
};

/**
 * Originator written by THIS gateway into the Codex session JSONL
 * `session_meta.payload.originator`. Threads with this value were opened
 * through this gateway; everything else (codex-tui, Claude Code, codex_exec,
 * Codex Desktop, …) was opened by some other Codex client on this machine.
 */
export const GATEWAY_ORIGINATOR = "local_codex_web_app";

export class ThreadContextResolver {
  private readonly codexSessionsDir: string;
  private readonly fallbackCwd: string;
  private readonly logger?: FastifyBaseLogger;
  private readonly sessionFileByThreadId = new Map<string, string>();
  private readonly contextByThreadId = new Map<string, ThreadContextResponse>();
  private readonly originatorByThreadId = new Map<string, string | null>();
  private readonly lookupInFlight = new Map<string, Promise<ThreadContextResponse>>();
  private sessionIndexPromise: Promise<void> | null = null;
  private sessionIndexRefreshPromise: Promise<void> | null = null;
  private sessionIndexReady = false;

  constructor(options: ResolverOptions = {}) {
    this.codexSessionsDir =
      options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
    this.fallbackCwd = options.fallbackCwd ?? os.homedir();
    this.logger = options.logger;
  }

  async getSessionFilePath(threadId: string): Promise<string | null> {
    await this.ensureSessionFileIndex();
    const existing = this.sessionFileByThreadId.get(threadId);
    if (existing) {
      return existing;
    }

    await this.refreshSessionFileIndex();
    return this.sessionFileByThreadId.get(threadId) ?? null;
  }

  invalidate(threadId: string): void {
    this.contextByThreadId.delete(threadId);
    this.originatorByThreadId.delete(threadId);
  }

  /** Indexed session-file count for the /api/gateway/status endpoint. */
  sessionIndexSize(): number {
    return this.sessionFileByThreadId.size;
  }

  /**
   * True once the initial rollout-session index build has resolved. Disambiguates
   * `sessionIndexSize() === 0` between "still indexing" and "no sessions on disk".
   */
  isSessionIndexReady(): boolean {
    return this.sessionIndexReady;
  }

  /**
   * Best-effort lookup of the Codex `session_meta.payload.originator` for a
   * thread. Returns `null` when there is no session file yet, the
   * `session_meta` line is missing/malformed, or the field is absent — callers
   * must treat `null` as "unknown", never as "not gateway-owned".
   *
   * Memoisation only caches a *definitive* outcome:
   *   - a concrete string originator (immutable once written), or
   *   - a `session_meta` record that was found but carries no string
   *     `originator` (also immutable — Codex never adds the field later).
   * A *transient* miss (no session file yet, no `session_meta` line seen, file
   * unreadable/empty/being written) is NOT memoised, so a session that later
   * gains a concrete non-gateway originator is re-read instead of staying
   * cached as `null` and leaking an external thread into the default scope.
   * Pass `invalidate(threadId)` to force a re-read. Never throws.
   */
  async resolveOriginator(threadId: string): Promise<string | null> {
    if (this.originatorByThreadId.has(threadId)) {
      return this.originatorByThreadId.get(threadId) ?? null;
    }

    const sessionFilePath = await this.getSessionFilePath(threadId);
    if (!sessionFilePath) {
      // Do not memoise a missing-file miss: the session file may appear later
      // (mirrors how getSessionFilePath itself stays re-resolvable).
      return null;
    }

    const result = await readOriginatorFromSessionMeta(sessionFilePath);
    if (result.outcome === "resolved") {
      // session_meta was definitively read; its originator (string or null)
      // is immutable for this session — safe to memoise.
      this.originatorByThreadId.set(threadId, result.originator);
      return result.originator;
    }
    // outcome === "unreadable": transient (empty/partial/being-written file,
    // I/O error, or no session_meta within the leading-line window). Return
    // null WITHOUT memoising so a later call re-reads.
    return null;
  }

  async resolveProjectKey(threadId: string, projectedProjectKey?: string): Promise<string> {
    const context = await this.resolveThreadContext(threadId, projectedProjectKey);
    if (context.isFallback || !context.cwd) {
      return "unknown";
    }
    return normalizeProjectKey(context.cwd);
  }

  async resolveThreadContext(
    threadId: string,
    projectedProjectKey?: string,
  ): Promise<ThreadContextResponse> {
    const cached = this.contextByThreadId.get(threadId);
    if (cached) {
      const projectedCwd = projectKeyToCwd(projectedProjectKey);
      if (projectedCwd && cached.isFallback) {
        const fromProjection: ThreadContextResponse = {
          threadId,
          cwd: projectedCwd,
          resolvedCwd: projectedCwd,
          isFallback: false,
          source: "projection",
        };
        this.contextByThreadId.set(threadId, fromProjection);
        return fromProjection;
      }
      if (!cached.isFallback) {
        return cached;
      }
    }

    const inFlight = this.lookupInFlight.get(threadId);
    if (inFlight) {
      return inFlight;
    }

    const lookup = (async () => {
      const context = await this.resolveThreadContextUncached(threadId, projectedProjectKey);
      this.contextByThreadId.set(threadId, context);
      return context;
    })();
    this.lookupInFlight.set(threadId, lookup);

    try {
      return await lookup;
    } finally {
      this.lookupInFlight.delete(threadId);
    }
  }

  private async resolveThreadContextUncached(
    threadId: string,
    projectedProjectKey?: string,
  ): Promise<ThreadContextResponse> {
    const sessionFilePath = await this.getSessionFilePath(threadId);
    if (sessionFilePath) {
      const cwdFromMeta = await readCwdFromSessionMeta(sessionFilePath);
      if (cwdFromMeta) {
        const normalizedCwd = normalizePath(cwdFromMeta);
        return {
          threadId,
          cwd: normalizedCwd,
          resolvedCwd: normalizedCwd,
          isFallback: false,
          source: "session_meta",
        };
      }

      const cwdFromTurnContext = await readLatestCwdFromTurnContext(sessionFilePath);
      if (cwdFromTurnContext) {
        const normalizedCwd = normalizePath(cwdFromTurnContext);
        return {
          threadId,
          cwd: normalizedCwd,
          resolvedCwd: normalizedCwd,
          isFallback: false,
          source: "turn_context",
        };
      }
    }

    const cwdFromProjection = projectKeyToCwd(projectedProjectKey);
    if (cwdFromProjection) {
      return {
        threadId,
        cwd: cwdFromProjection,
        resolvedCwd: cwdFromProjection,
        isFallback: false,
        source: "projection",
      };
    }

    return {
      threadId,
      cwd: null,
      resolvedCwd: this.fallbackCwd,
      isFallback: true,
      source: "fallback",
    };
  }

  private async ensureSessionFileIndex(): Promise<void> {
    if (this.sessionIndexPromise) {
      return this.sessionIndexPromise;
    }

    this.sessionIndexPromise = (async () => {
      await this.buildSessionFileIndex(this.codexSessionsDir);
      this.sessionIndexReady = true;
      this.logger?.info(
        { indexed: this.sessionFileByThreadId.size },
        "thread context session file index ready",
      );
    })();
    return this.sessionIndexPromise;
  }

  private async refreshSessionFileIndex(): Promise<void> {
    if (this.sessionIndexRefreshPromise) {
      return this.sessionIndexRefreshPromise;
    }

    this.sessionIndexRefreshPromise = (async () => {
      await this.buildSessionFileIndex(this.codexSessionsDir);
      this.logger?.info(
        { indexed: this.sessionFileByThreadId.size },
        "thread context session file index refreshed",
      );
    })();

    try {
      return await this.sessionIndexRefreshPromise;
    } finally {
      this.sessionIndexRefreshPromise = null;
    }
  }

  private async buildSessionFileIndex(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, {
      encoding: "utf8",
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this.buildSessionFileIndex(fullPath);
          return;
        }
        if (!entry.isFile()) {
          return;
        }

        const match = entry.name.match(threadIdFromSessionFilePattern);
        if (!match) {
          return;
        }
        this.sessionFileByThreadId.set(match[1], fullPath);
      }),
    );
  }
}

async function readCwdFromSessionMeta(sessionFilePath: string): Promise<string | null> {
  const stream = createReadStream(sessionFilePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      if (!line) {
        break;
      }
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          payload?: { cwd?: unknown };
        };
        if (parsed.type === "session_meta" && typeof parsed.payload?.cwd === "string") {
          return parsed.payload.cwd;
        }
      } catch {
        return null;
      }
      break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return null;
}

/**
 * Outcome of reading `session_meta` from a session JSONL.
 *
 * - `resolved`: a `session_meta` record was definitively parsed. `originator`
 *   is its string value, or `null` when the field is absent/non-string. Both
 *   are immutable for the session, so the caller may memoise.
 * - `unreadable`: no `session_meta` was found within the scan window, the file
 *   was empty/partial/being written, hit an I/O error, or tripped the size
 *   guard. The caller must NOT memoise — a re-read may succeed later.
 */
type OriginatorReadResult =
  | { outcome: "resolved"; originator: string | null }
  | { outcome: "unreadable" };

/**
 * Read `session_meta.payload.originator` from a Codex session JSONL.
 *
 * Streams the file in chunks and splits on newlines ourselves (instead of
 * `readline`, which buffers an entire no-newline file before yielding) so a
 * huge / no-newline / binary local file CANNOT buffer unbounded. Real
 * `session_meta` lines on this machine are ~22 KB, far past the 16 KB
 * fixed-window truncation bug seen elsewhere, so the per-line ceiling
 * (`maxLineBytes`) is set very wide; never reintroduce a fixed small byte
 * read here. The `session_meta` record is normally the first line, but some
 * older rollouts begin with a bare `{id,timestamp}` line, so scan a small
 * bounded number of leading lines for it instead of bailing on line one.
 *
 * I/O safety: a partial line is bounded by `maxLineBytes` and the total bytes
 * consumed by `maxScanBytes`; tripping either aborts the stream immediately
 * and reports `unreadable` (treated as "unknown", never memoised).
 *
 * Never throws: every failure path returns `{ outcome: "unreadable" }` except
 * a definitively-parsed `session_meta` which returns `{ outcome: "resolved" }`.
 */
async function readOriginatorFromSessionMeta(
  sessionFilePath: string,
): Promise<OriginatorReadResult> {
  const maxLeadingLinesToScan = 8;
  // Real session_meta lines are ~22 KB; 1 MB is a very wide ceiling that still
  // guards against a corrupt/binary/no-newline file buffering unbounded.
  const maxLineBytes = 1024 * 1024;
  // Hard cap on total bytes consumed before we give up scanning for the
  // session_meta record (covers the leading-lines window plus slack).
  const maxScanBytes = 8 * 1024 * 1024;
  let stream: ReturnType<typeof createReadStream> | null = null;

  const parseLine = (line: string): OriginatorReadResult | null => {
    if (!line) {
      return null;
    }
    let parsed: { type?: string; payload?: { originator?: unknown } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      // Skip a malformed leading line; the session_meta record may follow.
      return null;
    }
    if (parsed.type !== "session_meta") {
      return null;
    }
    const originator = parsed.payload?.originator;
    return {
      outcome: "resolved",
      originator:
        typeof originator === "string" && originator.length > 0
          ? originator
          : null,
    };
  };

  try {
    stream = createReadStream(sessionFilePath, { encoding: "utf8" });

    let buffer = "";
    let bytesSeen = 0;
    let scanned = 0;

    for await (const chunk of stream as AsyncIterable<string>) {
      bytesSeen += Buffer.byteLength(chunk, "utf8");
      if (bytesSeen > maxScanBytes) {
        return { outcome: "unreadable" };
      }
      buffer += chunk;

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        scanned += 1;
        if (scanned > maxLeadingLinesToScan) {
          return { outcome: "unreadable" };
        }
        const result = parseLine(line);
        if (result) {
          return result;
        }
        newlineIndex = buffer.indexOf("\n");
      }

      // Unflushed partial line cannot grow without bound (no-newline file).
      if (buffer.length > maxLineBytes) {
        return { outcome: "unreadable" };
      }
    }

    // Trailing line with no final newline (the session_meta may be it).
    if (buffer.length > 0 && scanned < maxLeadingLinesToScan) {
      const result = parseLine(buffer);
      if (result) {
        return result;
      }
    }
  } catch {
    return { outcome: "unreadable" };
  } finally {
    stream?.destroy();
  }

  // Ran out of bytes / hit the scan window without a session_meta record:
  // transient (file may still be being written). Do not memoise.
  return { outcome: "unreadable" };
}

async function readLatestCwdFromTurnContext(sessionFilePath: string): Promise<string | null> {
  let latestCwd: string | null = null;
  const stream = createReadStream(sessionFilePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      if (!line.includes('"type":"turn_context"')) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          payload?: { cwd?: unknown };
        };
        if (parsed.type === "turn_context" && typeof parsed.payload?.cwd === "string") {
          latestCwd = parsed.payload.cwd;
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return latestCwd;
}
