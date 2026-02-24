import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { FastifyBaseLogger } from "fastify";
import type {
  TerminalServerMessage,
  ThreadContextResponse,
  ThreadContextSource,
} from "@lcwa/shared-types";

type TerminalClient = {
  send: (message: TerminalServerMessage) => void;
};

type TerminalSession = {
  id: string;
  threadId: string;
  process: pty.IPty;
  clients: Set<TerminalClient>;
  cwd: string;
  source: ThreadContextSource;
  isFallback: boolean;
  lastActivityAt: number;
  createdAt: number;
};

type TerminalManagerOptions = {
  maxSessions: number;
  ttlMs: number;
  logger?: FastifyBaseLogger;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const PRUNE_INTERVAL_MS = 60_000;

function resolveShell(): string {
  const candidates = [
    process.env.SHELL,
    process.platform === "darwin" ? "/bin/zsh" : null,
    "/bin/bash",
    "/bin/sh",
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "/bin/sh";
}

function escapeShellSingleQuoted(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function buildSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  return env;
}

function ensureSpawnHelperExecutable(logger?: FastifyBaseLogger): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("node-pty/package.json");
    const helperPath = path.join(
      path.dirname(packageJsonPath),
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );
    if (!existsSync(helperPath)) {
      return;
    }
    chmodSync(helperPath, 0o755);
  } catch (error) {
    logger?.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "failed to set node-pty spawn-helper permissions",
    );
  }
}

export class TerminalManager {
  private readonly sessionsByThreadId = new Map<string, TerminalSession>();
  private readonly threadByClient = new Map<TerminalClient, string>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly logger?: FastifyBaseLogger;
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(options: TerminalManagerOptions) {
    this.maxSessions = options.maxSessions;
    this.ttlMs = options.ttlMs;
    this.logger = options.logger;
    ensureSpawnHelperExecutable(this.logger);
    this.pruneTimer = setInterval(() => {
      this.pruneSessions();
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    const threadIds = Array.from(this.sessionsByThreadId.keys());
    for (const threadId of threadIds) {
      this.killSession(threadId, "terminal manager destroyed");
    }
  }

  openClient(client: TerminalClient, threadId: string, context: ThreadContextResponse): TerminalSession {
    this.detachClient(client);
    const session = this.getOrCreateSession(threadId, context);
    session.clients.add(client);
    session.lastActivityAt = Date.now();
    this.threadByClient.set(client, threadId);
    this.sendMessage(client, {
      type: "terminal/ready",
      sessionId: session.id,
      threadId,
    });
    this.sendStatus(session, client);
    return session;
  }

  closeClient(client: TerminalClient): void {
    this.detachClient(client);
  }

  onClientDisconnect(client: TerminalClient): void {
    this.detachClient(client);
  }

  writeInput(client: TerminalClient, data: string): boolean {
    const session = this.getSessionByClient(client);
    if (!session) {
      return false;
    }
    session.process.write(data);
    session.lastActivityAt = Date.now();
    return true;
  }

  resize(client: TerminalClient, cols: number, rows: number): boolean {
    const session = this.getSessionByClient(client);
    if (!session) {
      return false;
    }
    session.process.resize(cols, rows);
    session.lastActivityAt = Date.now();
    return true;
  }

  setCwd(client: TerminalClient, cwd: string): boolean {
    const session = this.getSessionByClient(client);
    if (!session) {
      return false;
    }
    const escaped = escapeShellSingleQuoted(cwd);
    session.process.write(`cd '${escaped}'\n`);
    session.cwd = cwd;
    session.isFallback = false;
    session.lastActivityAt = Date.now();
    this.sendStatus(session);
    return true;
  }

  private getSessionByClient(client: TerminalClient): TerminalSession | null {
    const threadId = this.threadByClient.get(client);
    if (!threadId) {
      return null;
    }
    return this.sessionsByThreadId.get(threadId) ?? null;
  }

  private detachClient(client: TerminalClient): void {
    const threadId = this.threadByClient.get(client);
    if (!threadId) {
      return;
    }
    this.threadByClient.delete(client);
    const session = this.sessionsByThreadId.get(threadId);
    if (!session) {
      return;
    }
    session.clients.delete(client);
    session.lastActivityAt = Date.now();
  }

  private getOrCreateSession(threadId: string, context: ThreadContextResponse): TerminalSession {
    const existing = this.sessionsByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created = this.createSession(threadId, context);
    this.sessionsByThreadId.set(threadId, created);
    this.pruneSessions();
    return created;
  }

  private createSession(threadId: string, context: ThreadContextResponse): TerminalSession {
    const shell = resolveShell();
    const cwd = context.resolvedCwd || os.homedir();
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: buildSpawnEnv(),
    });

    const session: TerminalSession = {
      id: `${threadId}-${Date.now().toString(36)}`,
      threadId,
      process: ptyProcess,
      clients: new Set(),
      cwd,
      source: context.source,
      isFallback: context.isFallback,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    ptyProcess.onData((data: string) => {
      session.lastActivityAt = Date.now();
      this.broadcast(session, {
        type: "terminal/output",
        data,
        stream: "stdout",
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.broadcast(session, {
        type: "terminal/error",
        message: `terminal exited (code=${exitCode}, signal=${signal})`,
        code: "TERMINAL_EXIT",
      });
      this.broadcast(session, {
        type: "terminal/status",
        connected: false,
        cwd: session.cwd,
        pid: null,
        isFallback: session.isFallback,
        source: session.source,
      });

      for (const client of session.clients) {
        this.threadByClient.delete(client);
      }
      this.sessionsByThreadId.delete(threadId);
      session.clients.clear();
    });

    this.logger?.info({ threadId, shell, cwd }, "terminal session created");
    return session;
  }

  private broadcast(session: TerminalSession, message: TerminalServerMessage): void {
    for (const client of session.clients) {
      this.sendMessage(client, message);
    }
  }

  private sendStatus(session: TerminalSession, client?: TerminalClient): void {
    const message: TerminalServerMessage = {
      type: "terminal/status",
      connected: true,
      cwd: session.cwd,
      pid: session.process.pid,
      isFallback: session.isFallback,
      source: session.source,
    };
    if (client) {
      this.sendMessage(client, message);
      return;
    }
    this.broadcast(session, message);
  }

  private sendMessage(client: TerminalClient, message: TerminalServerMessage): void {
    try {
      client.send(message);
    } catch {
      // Ignore send errors from stale sockets.
    }
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [threadId, session] of this.sessionsByThreadId) {
      if (session.clients.size > 0) {
        continue;
      }
      if (now - session.lastActivityAt < this.ttlMs) {
        continue;
      }
      this.killSession(threadId, "terminal session expired");
    }

    if (this.sessionsByThreadId.size <= this.maxSessions) {
      return;
    }

    const sessions = Array.from(this.sessionsByThreadId.values()).sort((a, b) => {
      if (a.clients.size === 0 && b.clients.size > 0) {
        return -1;
      }
      if (b.clients.size === 0 && a.clients.size > 0) {
        return 1;
      }
      return a.lastActivityAt - b.lastActivityAt;
    });

    while (this.sessionsByThreadId.size > this.maxSessions && sessions.length > 0) {
      const victim = sessions.shift();
      if (!victim) {
        break;
      }
      this.killSession(victim.threadId, "terminal session evicted");
    }
  }

  private killSession(threadId: string, reason: string): void {
    const session = this.sessionsByThreadId.get(threadId);
    if (!session) {
      return;
    }

    this.sessionsByThreadId.delete(threadId);
    for (const client of session.clients) {
      this.threadByClient.delete(client);
      this.sendMessage(client, {
        type: "terminal/error",
        message: reason,
        code: "TERMINAL_SESSION_CLOSED",
      });
      this.sendMessage(client, {
        type: "terminal/status",
        connected: false,
        cwd: session.cwd,
        pid: null,
        isFallback: session.isFallback,
        source: session.source,
      });
    }

    session.clients.clear();
    session.process.kill();
    this.logger?.info({ threadId, reason }, "terminal session killed");
  }
}
