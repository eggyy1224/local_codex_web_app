import type { FastifyInstance } from "fastify";
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalType,
  GatewayEvent,
  InteractionRespondRequest,
  InteractionRespondResponse,
  InteractionType,
  PendingApprovalsResponse,
  PendingInteractionsResponse,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";
import type { GatewayDbPort } from "../db.js";

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

export type ApprovalInteractionRoutesDeps = {
  appServer: GatewayAppServerPort;
  db: GatewayDbPort;
  pendingApprovals: Map<string, PendingApprovalEntry>;
  pendingInteractions: Map<string, PendingInteractionEntry>;
  broadcast: (event: GatewayEvent) => void;
};

function readInteractionAnswers(
  raw: InteractionRespondRequest["answers"],
): Record<string, { answers: string[] }> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const normalized: Record<string, { answers: string[] }> = {};
  let questionCount = 0;
  for (const [questionId, value] of Object.entries(raw)) {
    if (questionId.trim().length === 0) {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const candidate = value as { answers?: unknown };
    if (!Array.isArray(candidate.answers)) {
      return null;
    }
    const answers = candidate.answers
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (answers.length === 0) {
      return null;
    }
    normalized[questionId] = { answers };
    questionCount += 1;
  }
  return questionCount > 0 ? normalized : null;
}

export function registerApprovalInteractionRoutes(
  app: FastifyInstance,
  {
    appServer,
    db,
    pendingApprovals,
    pendingInteractions,
    broadcast,
  }: ApprovalInteractionRoutesDeps,
): void {
  app.get(
    "/api/threads/:id/approvals/pending",
    async (request): Promise<PendingApprovalsResponse> => {
      const params = request.params as { id: string };
      return {
        data: db.listPendingApprovalsByThread(params.id),
      };
    },
  );

  app.get(
    "/api/threads/:id/interactions/pending",
    async (request): Promise<PendingInteractionsResponse> => {
      const params = request.params as { id: string };
      return {
        data: db.listPendingInteractionsByThread(params.id),
      };
    },
  );

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
      const approval = db.getApprovalById(params.approvalId);
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
      const status =
        body.decision === "allow"
          ? "approved"
          : body.decision === "deny"
            ? "denied"
            : "cancelled";
      db.resolveApprovalRequest(
        params.approvalId,
        status,
        body.decision,
        body.note ?? null,
        resolvedAt,
      );

      pendingApprovals.delete(params.approvalId);

      db.insertAuditLog({
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

      const seq = db.insertGatewayEvent(decisionEventBase);
      broadcast({ ...decisionEventBase, seq });

      return { ok: true };
    },
  );

  app.post(
    "/api/threads/:id/interactions/:interactionId/respond",
    async (request): Promise<InteractionRespondResponse> => {
      const params = request.params as { id: string; interactionId: string };
      const body = request.body as InteractionRespondRequest;
      const answers = readInteractionAnswers(body?.answers);
      if (!answers) {
        const error = new Error("invalid answers") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }

      const interaction = db.getInteractionById(params.interactionId);
      if (!interaction) {
        const error = new Error("interaction not found") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }
      if (interaction.threadId !== params.id) {
        const error = new Error("interaction not found") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }
      if (interaction.status !== "pending") {
        const error = new Error("interaction is no longer pending") as Error & {
          statusCode?: number;
        };
        error.statusCode = 409;
        throw error;
      }
      const pending = pendingInteractions.get(params.interactionId);
      if (!pending) {
        const error = new Error("interaction is no longer active") as Error & {
          statusCode?: number;
        };
        error.statusCode = 409;
        throw error;
      }
      if (pending.threadId !== params.id) {
        const error = new Error("interaction not found") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }

      appServer.respond(pending.rpcId, {
        answers,
      });

      const resolvedAt = new Date().toISOString();
      const responsePayloadJson = JSON.stringify({ answers });
      db.respondInteractionRequest(
        params.interactionId,
        "responded",
        responsePayloadJson,
        resolvedAt,
      );

      pendingInteractions.delete(params.interactionId);
      db.insertAuditLog({
        ts: resolvedAt,
        actor: "user",
        action: "interaction.responded",
        threadId: interaction.threadId,
        turnId: interaction.turnId,
        metadata: {
          interactionId: params.interactionId,
        },
      });

      const eventBase: Omit<GatewayEvent, "seq"> = {
        serverTs: resolvedAt,
        threadId: interaction.threadId,
        turnId: interaction.turnId,
        kind: "interaction",
        name: "interaction/responded",
        payload: {
          interactionId: params.interactionId,
        },
      };
      const seq = db.insertGatewayEvent(eventBase);
      broadcast({ ...eventBase, seq });

      return { ok: true };
    },
  );
}
