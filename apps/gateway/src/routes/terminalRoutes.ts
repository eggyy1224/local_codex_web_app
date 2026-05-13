import type { FastifyInstance } from "fastify";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@lcwa/shared-types";
import type { GatewayDbPort } from "../db.js";
import { TerminalManager } from "../terminalManager.js";
import { ThreadContextResolver, normalizeProjectKey } from "../threadContext.js";

export type TerminalRoutesDeps = {
  db: GatewayDbPort;
  threadContextResolver: ThreadContextResolver;
  terminalManager: TerminalManager | null;
  terminalEnabled: boolean;
  corsAllowlist: ReadonlyArray<string>;
};

function isAllowedWsOrigin(
  origin: string | undefined,
  corsAllowlist: ReadonlyArray<string>,
): boolean {
  if (!origin) {
    return true;
  }
  return corsAllowlist.includes(origin);
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

export function registerTerminalRoutes(
  app: FastifyInstance,
  {
    db,
    threadContextResolver,
    terminalManager,
    terminalEnabled,
    corsAllowlist,
  }: TerminalRoutesDeps,
): void {
  const auditTerminalEvent = (
    action: string,
    threadId: string | null,
    metadata: Record<string, unknown>,
  ): void => {
    db.insertAuditLog({
      ts: new Date().toISOString(),
      actor: "user",
      action,
      threadId,
      turnId: null,
      metadata,
    });
  };

  app.get("/api/terminal/ws", { websocket: true }, (ws, request) => {
    const origin =
      typeof request.headers.origin === "string" ? request.headers.origin : undefined;

    const send = (message: TerminalServerMessage): void => {
      if (ws.readyState !== 1) {
        return;
      }
      ws.send(JSON.stringify(message));
    };

    const sendAndClose = (
      message: TerminalServerMessage,
      closeCode: number,
      closeReason: string,
    ): void => {
      // Handler may run before the WebSocket upgrade has fully completed on the
      // client side (e.g. fastify's injectWS test transport). Defer send until
      // the next tick so the client can attach listeners, and defer close again
      // so the framed message is flushed before the close handshake begins.
      setImmediate(() => {
        send(message);
        setImmediate(() => {
          ws.close(closeCode, closeReason);
        });
      });
    };

    if (!isAllowedWsOrigin(origin, corsAllowlist)) {
      auditTerminalEvent("terminal.origin_denied", null, { origin: origin ?? null });
      sendAndClose(
        terminalError("origin not allowed", "TERMINAL_WS_ORIGIN_DENIED"),
        1008,
        "origin not allowed",
      );
      return;
    }

    if (!terminalEnabled || !terminalManager) {
      auditTerminalEvent("terminal.disabled", null, { origin: origin ?? null });
      sendAndClose(
        terminalError("terminal dock is disabled", "TERMINAL_WS_DISABLED"),
        1008,
        "terminal disabled",
      );
      return;
    }

    const client = { send };
    let openedThreadId: string | null = null;
    let openedMetadata: Record<string, unknown> | null = null;
    let closeAudited = false;

    const auditClose = (reason: string): void => {
      if (!openedThreadId || closeAudited) {
        return;
      }
      closeAudited = true;
      auditTerminalEvent("terminal.closed", openedThreadId, {
        ...(openedMetadata ?? {}),
        reason,
      });
    };

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
              auditClose("reopened");
              const projected = db.getProjectedThread(message.threadId);
              const context = await threadContextResolver.resolveThreadContext(
                message.threadId,
                projected?.projectKey,
              );
              terminalManager.openClient(client, message.threadId, context);
              openedThreadId = message.threadId;
              openedMetadata = {
                origin: origin ?? null,
                cwd: context.resolvedCwd,
                source: context.source,
                isFallback: context.isFallback,
              };
              closeAudited = false;
              auditTerminalEvent("terminal.opened", message.threadId, openedMetadata);
              if (!context.isFallback && context.cwd) {
                db.updateThreadProjectKey(message.threadId, normalizeProjectKey(context.cwd));
                threadContextResolver.invalidate(message.threadId);
              }
            } catch (error) {
              auditTerminalEvent("terminal.open_failed", message.threadId, {
                origin: origin ?? null,
                error: error instanceof Error ? error.message : String(error),
              });
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
          auditClose("client_message");
        }
      },
    );

    ws.on("close", () => {
      terminalManager.onClientDisconnect(client);
      auditClose("socket_closed");
    });
  });
}
