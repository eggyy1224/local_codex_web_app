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

export class ThreadContextResolver {
  private readonly codexSessionsDir: string;
  private readonly fallbackCwd: string;
  private readonly logger?: FastifyBaseLogger;
  private readonly sessionFileByThreadId = new Map<string, string>();
  private readonly contextByThreadId = new Map<string, ThreadContextResponse>();
  private readonly lookupInFlight = new Map<string, Promise<ThreadContextResponse>>();
  private sessionIndexPromise: Promise<void> | null = null;

  constructor(options: ResolverOptions = {}) {
    this.codexSessionsDir =
      options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
    this.fallbackCwd = options.fallbackCwd ?? os.homedir();
    this.logger = options.logger;
  }

  async getSessionFilePath(threadId: string): Promise<string | null> {
    await this.ensureSessionFileIndex();
    return this.sessionFileByThreadId.get(threadId) ?? null;
  }

  invalidate(threadId: string): void {
    this.contextByThreadId.delete(threadId);
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
      return cached;
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
      this.logger?.info(
        { indexed: this.sessionFileByThreadId.size },
        "thread context session file index ready",
      );
    })();
    return this.sessionIndexPromise;
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
