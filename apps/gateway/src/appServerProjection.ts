import type { FastifyBaseLogger } from "fastify";
import type {
  ApprovalType,
  GatewayEvent,
  InteractionType,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "./appServerPort.js";
import type {
  ApprovalProjection,
  GatewayDbPort,
  InteractionProjection,
} from "./db.js";
import {
  approvalTypeFromMethod,
  isUserInputRequestMethod,
  kindFromMethod,
} from "./gatewayHelpers.js";

export type PendingApprovalEntry = {
  rpcId: string | number;
  threadId: string;
  turnId: string | null;
  type: ApprovalType;
};

export type PendingInteractionEntry = {
  rpcId: string | number;
  threadId: string;
  turnId: string | null;
  type: InteractionType;
};

export type InteractionCancelReason = "turn_completed" | "gateway_restarted";

export type AppServerProjectionDeps = {
  appServer: GatewayAppServerPort;
  db: GatewayDbPort;
  logger: FastifyBaseLogger;
  pendingApprovals: Map<string, PendingApprovalEntry>;
  pendingInteractions: Map<string, PendingInteractionEntry>;
  activeTurnByThread: Map<string, string>;
};

export type AppServerProjection = {
  subscribe(threadId: string, fn: (event: GatewayEvent) => void): () => void;
  broadcast(event: GatewayEvent): void;
  reconcilePendingInteractionsOnStartup(): void;
};

export function extractThreadId(params: unknown): string | null {
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

export function extractTurnId(params: unknown): string | null {
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

export function attachAppServerProjection({
  appServer,
  db,
  logger,
  pendingApprovals,
  pendingInteractions,
  activeTurnByThread,
}: AppServerProjectionDeps): AppServerProjection {
  const subscribers = new Map<string, Set<(event: GatewayEvent) => void>>();

  function subscribe(
    threadId: string,
    fn: (event: GatewayEvent) => void,
  ): () => void {
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

  appServer.on("stderr", (line) => {
    logger.warn({ appServerStderr: line.trim() }, "app-server stderr");
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

  return {
    subscribe,
    broadcast,
    reconcilePendingInteractionsOnStartup,
  };
}
