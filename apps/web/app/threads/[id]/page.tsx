"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalDecisionRequest,
  ApprovalView,
  CreateTurnResponse,
  GatewayEvent,
  PendingApprovalsResponse,
  ThreadControlRequest,
  ThreadControlResponse,
  ThreadDetailResponse,
} from "@lcwa/shared-types";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";

type Props = {
  params: Promise<{ id: string }>;
};

type TurnCard = {
  id: string;
  status: TurnStatus;
  startedAt: string | null;
  completedAt: string | null;
  agentText: string;
  error: string | null;
};

type PendingApprovalCard = ApprovalView;

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function extractTurnId(payload: unknown): string | null {
  const p = asRecord(payload);
  if (!p) return null;
  if (typeof p.turnId === "string") return p.turnId;
  if (typeof p.turn_id === "string") return p.turn_id;
  const turn = asRecord(p.turn);
  if (turn && typeof turn.id === "string") {
    return turn.id;
  }
  return null;
}

function normalizeTurnStatus(status: unknown): TurnStatus {
  if (status === "inProgress") return "inProgress";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "unknown";
}

function statusClass(status: TurnStatus): string {
  if (status === "completed") return "ok";
  if (status === "inProgress") return "pending";
  return "down";
}

function approvalTypeFromEventName(eventName: string): PendingApprovalCard["type"] {
  if (eventName === "item/commandExecution/requestApproval") return "commandExecution";
  if (eventName === "item/fileChange/requestApproval") return "fileChange";
  return "userInput";
}

function approvalFromEvent(event: GatewayEvent): PendingApprovalCard | null {
  const payload = asRecord(event.payload);
  const approvalId = readString(payload, "approvalId");
  if (!approvalId) {
    return null;
  }

  const approvalType = readString(payload, "approvalType");
  const type =
    approvalType === "commandExecution" || approvalType === "fileChange" || approvalType === "userInput"
      ? approvalType
      : approvalTypeFromEventName(event.name);

  return {
    approvalId,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: readString(payload, "itemId"),
    type,
    status: "pending",
    reason: readString(payload, "reason"),
    commandPreview: readString(payload, "command"),
    fileChangePreview: readString(payload, "grantRoot"),
    createdAt: event.serverTs,
    resolvedAt: null,
  };
}

export default function ThreadPage({ params }: Props) {
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [turnCards, setTurnCards] = useState<Record<string, TurnCard>>({});
  const [prompt, setPrompt] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApprovalCard>>({});
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<ThreadControlRequest["action"] | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  useEffect(() => {
    params.then((value) => setThreadId(value.id));
  }, [params]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [detailRes, approvalsRes] = await Promise.all([
          fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/approvals/pending`),
        ]);
        if (!detailRes.ok) {
          throw new Error(`thread detail http ${detailRes.status}`);
        }
        if (!approvalsRes.ok) {
          throw new Error(`approvals http ${approvalsRes.status}`);
        }

        const data = (await detailRes.json()) as ThreadDetailResponse;
        const pending = (await approvalsRes.json()) as PendingApprovalsResponse;
        if (!cancelled) {
          setDetail(data);
          setTurnCards(() => {
            const next: Record<string, TurnCard> = {};
            for (const turn of data.turns) {
              next[turn.id] = {
                id: turn.id,
                status: normalizeTurnStatus(turn.status),
                startedAt: turn.startedAt,
                completedAt: turn.completedAt,
                agentText: "",
                error: turn.error ? JSON.stringify(turn.error) : null,
              };
            }
            return next;
          });
          setPendingApprovals(() =>
            Object.fromEntries(pending.data.map((item) => [item.approvalId, item])),
          );
          setLoading(false);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setLoading(false);
          setError(loadError instanceof Error ? loadError.message : "unknown error");
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let currentSince = lastSeq;
    let es: EventSource | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (isRetry: boolean) => {
      if (stopped) {
        return;
      }
      setConnectionState(isRetry ? "reconnecting" : "connecting");

      es = new EventSource(`${gatewayUrl}/api/threads/${threadId}/events?since=${currentSince}`);

      es.addEventListener("gateway", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as GatewayEvent;
        currentSince = payload.seq;
        setEvents((prev) => [...prev, payload]);
        setLastSeq(payload.seq);
        setConnectionState("connected");

        const payloadRecord = asRecord(payload.payload);
        const turnFromPayload = asRecord(payloadRecord?.turn);
        const itemFromPayload = asRecord(payloadRecord?.item);
        const resolvedTurnId =
          payload.turnId ?? extractTurnId(payload.payload) ?? readString(payloadRecord, "turnId");

        setTurnCards((prev) => {
          const next = { ...prev };

          const ensureTurn = (turnId: string): TurnCard => {
            const existing = next[turnId];
            if (existing) return existing;
            const created: TurnCard = {
              id: turnId,
              status: "inProgress",
              startedAt: null,
              completedAt: null,
              agentText: "",
              error: null,
            };
            next[turnId] = created;
            return created;
          };

          if (payload.name === "turn/started") {
            const turnId = readString(turnFromPayload, "id") ?? resolvedTurnId;
            if (turnId) {
              const turn = ensureTurn(turnId);
              turn.status = normalizeTurnStatus(readString(turnFromPayload, "status"));
              turn.startedAt = turn.startedAt ?? new Date(payload.serverTs).toISOString();
              turn.error = null;
            }
          }

          if (payload.name === "turn/completed") {
            const turnId = readString(turnFromPayload, "id") ?? resolvedTurnId;
            if (turnId) {
              const turn = ensureTurn(turnId);
              turn.status = normalizeTurnStatus(readString(turnFromPayload, "status"));
              turn.completedAt = new Date(payload.serverTs).toISOString();
              const err = turnFromPayload?.error;
              turn.error = err ? JSON.stringify(err) : null;
            }
          }

          if (payload.name === "item/agentMessage/delta" && resolvedTurnId) {
            const turn = ensureTurn(resolvedTurnId);
            const delta =
              readString(payloadRecord, "delta") ??
              readString(payloadRecord, "textDelta") ??
              readString(payloadRecord, "text");
            if (delta) {
              turn.agentText += delta;
            }
          }

          if ((payload.name === "item/started" || payload.name === "item/completed") && itemFromPayload) {
            const turnId = resolvedTurnId;
            if (turnId && readString(itemFromPayload, "type") === "agentMessage") {
              const turn = ensureTurn(turnId);
              const fullText = readString(itemFromPayload, "text");
              if (fullText !== null) {
                turn.agentText = fullText;
              }
            }
          }

          return next;
        });

        if (payload.name === "approval/decision") {
          const decisionPayload = asRecord(payload.payload);
          const approvalId = readString(decisionPayload, "approvalId");
          if (approvalId) {
            setPendingApprovals((prev) => {
              if (!prev[approvalId]) {
                return prev;
              }
              const next = { ...prev };
              delete next[approvalId];
              return next;
            });
          }
        } else if (payload.kind === "approval") {
          const approval = approvalFromEvent(payload);
          if (approval) {
            setPendingApprovals((prev) => ({
              ...prev,
              [approval.approvalId]: approval,
            }));
          }
        }
      });

      es.addEventListener("heartbeat", () => {
        if (!stopped) {
          setConnectionState("connected");
        }
      });

      es.onerror = () => {
        if (stopped) {
          return;
        }
        setConnectionState("reconnecting");
        es?.close();
        retryTimer = setTimeout(() => connect(true), 1200);
      };
    };

    connect(false);

    return () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      es?.close();
    };
  }, [threadId]);

  const connectionText = useMemo(() => {
    if (connectionState === "connected") return "CONNECTED";
    if (connectionState === "reconnecting") return "RECONNECTING";
    return "CONNECTING";
  }, [connectionState]);

  const orderedTurns = useMemo(
    () =>
      Object.values(turnCards).sort((a, b) => {
        const left = a.startedAt ?? "";
        const right = b.startedAt ?? "";
        if (left !== right) {
          return left.localeCompare(right);
        }
        return a.id.localeCompare(b.id);
      }),
    [turnCards],
  );

  const activeApproval = useMemo(
    () =>
      Object.values(pendingApprovals).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0] ?? null,
    [pendingApprovals],
  );

  async function decideApproval(
    approvalId: string,
    decision: ApprovalDecisionRequest["decision"],
  ): Promise<void> {
    if (!threadId || approvalBusy) {
      return;
    }

    setApprovalBusy(approvalId);
    setApprovalError(null);

    try {
      const res = await fetch(
        `${gatewayUrl}/api/threads/${threadId}/approvals/${approvalId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            decision,
          } satisfies ApprovalDecisionRequest),
        },
      );

      if (!res.ok) {
        throw new Error(`approval http ${res.status}`);
      }

      setPendingApprovals((prev) => {
        if (!prev[approvalId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
    } catch (approvalErr) {
      setApprovalError(
        approvalErr instanceof Error ? approvalErr.message : "approval failed",
      );
    } finally {
      setApprovalBusy(null);
    }
  }

  async function sendControl(action: ThreadControlRequest["action"]): Promise<void> {
    if (!threadId || controlBusy) {
      return;
    }

    setControlBusy(action);
    setControlError(null);

    try {
      const res = await fetch(`${gatewayUrl}/api/threads/${threadId}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
        } satisfies ThreadControlRequest),
      });

      if (!res.ok) {
        throw new Error(`control http ${res.status}`);
      }

      const payload = (await res.json()) as ThreadControlResponse;
      const appliedTurnId = payload.appliedToTurnId;
      if (appliedTurnId && action === "retry") {
        setTurnCards((prev) => {
          if (prev[appliedTurnId]) {
            return prev;
          }
          return {
            ...prev,
            [appliedTurnId]: {
              id: appliedTurnId,
              status: "inProgress",
              startedAt: new Date().toISOString(),
              completedAt: null,
              agentText: "",
              error: null,
            },
          };
        });
      }
    } catch (controlErr) {
      setControlError(controlErr instanceof Error ? controlErr.message : "control failed");
    } finally {
      setControlBusy(null);
    }
  }

  async function sendTurn(): Promise<void> {
    const text = prompt.trim();
    if (!text || !threadId || submitting) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch(`${gatewayUrl}/api/threads/${threadId}/turns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: [{ type: "text", text }],
        }),
      });

      if (!res.ok) {
        throw new Error(`turn submit http ${res.status}`);
      }

      const payload = (await res.json()) as CreateTurnResponse;
      setPrompt("");
      setTurnCards((prev) => {
        const existing = prev[payload.turnId];
        if (existing) {
          return prev;
        }
        return {
          ...prev,
          [payload.turnId]: {
            id: payload.turnId,
            status: "inProgress",
            startedAt: new Date().toISOString(),
            completedAt: null,
            agentText: "",
            error: null,
          },
        };
      });
    } catch (submitErr) {
      setSubmitError(submitErr instanceof Error ? submitErr.message : "submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <section className="panel">
        <h1 data-testid="thread-title">Thread {threadId || "..."}</h1>
        <p className="muted">Slice 5: approval + control actions</p>
        <div className="status">
          <span className={`badge ${connectionState === "connected" ? "ok" : "down"}`}>
            {connectionText}
          </span>
          <span data-testid="event-cursor">Last Seq: {lastSeq}</span>
          <span data-testid="approval-count">Pending Approval: {Object.keys(pendingApprovals).length}</span>
        </div>

        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          <button
            type="button"
            data-testid="control-stop"
            disabled={controlBusy !== null}
            onClick={() => void sendControl("stop")}
            style={{
              border: "none",
              borderRadius: 10,
              background: "#b91c1c",
              color: "white",
              padding: "8px 10px",
              fontWeight: 700,
              cursor: controlBusy ? "not-allowed" : "pointer",
            }}
          >
            {controlBusy === "stop" ? "Stopping..." : "Stop"}
          </button>
          <button
            type="button"
            data-testid="control-retry"
            disabled={controlBusy !== null}
            onClick={() => void sendControl("retry")}
            style={{
              border: "none",
              borderRadius: 10,
              background: "#0f766e",
              color: "white",
              padding: "8px 10px",
              fontWeight: 700,
              cursor: controlBusy ? "not-allowed" : "pointer",
            }}
          >
            {controlBusy === "retry" ? "Retrying..." : "Retry"}
          </button>
          <button
            type="button"
            data-testid="control-cancel"
            disabled={controlBusy !== null}
            onClick={() => void sendControl("cancel")}
            style={{
              border: "none",
              borderRadius: 10,
              background: "#334155",
              color: "white",
              padding: "8px 10px",
              fontWeight: 700,
              cursor: controlBusy ? "not-allowed" : "pointer",
            }}
          >
            {controlBusy === "cancel" ? "Cancelling..." : "Cancel"}
          </button>
        </div>

        {loading ? <p className="muted">Loading thread...</p> : null}
        {error ? <p className="muted">{error}</p> : null}
        {submitError ? <p className="muted">{submitError}</p> : null}
        {approvalError ? <p className="muted">{approvalError}</p> : null}
        {controlError ? <p className="muted">{controlError}</p> : null}

        <div
          style={{
            display: "grid",
            gap: 10,
            marginTop: 16,
            padding: 12,
            border: "1px solid rgba(148, 163, 184, 0.2)",
            borderRadius: 12,
            background: "rgba(2, 6, 23, 0.35)",
          }}
        >
          <label htmlFor="turn-input" style={{ fontSize: 13, fontWeight: 600 }}>
            New Turn
          </label>
          <textarea
            id="turn-input"
            data-testid="turn-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="輸入給 Codex 的指令..."
            rows={3}
            style={{
              width: "100%",
              borderRadius: 10,
              border: "1px solid rgba(148,163,184,0.35)",
              background: "rgba(15, 23, 42, 0.8)",
              color: "#e2e8f0",
              padding: "10px 12px",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              data-testid="turn-submit"
              onClick={() => void sendTurn()}
              disabled={submitting || prompt.trim().length === 0}
              style={{
                border: "none",
                borderRadius: 10,
                background: submitting ? "#475569" : "#16a34a",
                color: "white",
                padding: "8px 14px",
                fontWeight: 700,
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "送出中..." : "送出"}
            </button>
          </div>
        </div>

        <div data-testid="timeline" style={{ marginTop: 20, display: "grid", gap: 12 }}>
          {orderedTurns.map((turn) => (
            <article
              key={`turn-${turn.id}`}
              data-testid={`turn-card-${turn.id}`}
              style={{
                border: "1px solid rgba(148, 163, 184, 0.2)",
                borderRadius: 10,
                padding: 10,
                background: "rgba(15,23,42,0.5)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <strong>Turn {turn.id}</strong>
                <span className={`badge ${statusClass(turn.status)}`} data-testid={`turn-status-${turn.id}`}>
                  {turn.status}
                </span>
              </div>
              <pre
                data-testid={`turn-agent-${turn.id}`}
                style={{
                  marginTop: 10,
                  marginBottom: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#e2e8f0",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                }}
              >
                {turn.agentText || "(waiting for output...)"}
              </pre>
              {turn.error ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  error: {turn.error}
                </p>
              ) : null}
            </article>
          ))}

          <div style={{ borderTop: "1px dashed rgba(148,163,184,0.2)", paddingTop: 10 }}>
            <strong style={{ fontSize: 13 }}>Raw Events</strong>
          </div>
          {events.map((event) => (
            <article
              key={`event-${event.seq}`}
              data-testid={`event-${event.seq}`}
              style={{
                border: "1px solid rgba(148, 163, 184, 0.2)",
                borderRadius: 10,
                padding: 10,
                background: "rgba(2,6,23,0.35)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{event.name}</strong>
                <span className="muted">#{event.seq}</span>
              </div>
              <p className="muted" style={{ marginTop: 6 }}>
                kind={event.kind} turn={event.turnId ?? "-"}
              </p>
            </article>
          ))}
        </div>

        {activeApproval ? (
          <aside
            data-testid="approval-drawer"
            style={{
              marginTop: 18,
              border: "1px solid rgba(251,191,36,0.55)",
              borderRadius: 12,
              padding: 14,
              background: "rgba(120,53,15,0.15)",
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>Approval Required</strong>
              <span className="badge pending">{activeApproval.type}</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {activeApproval.reason ?? "此操作需要你決策後才會繼續。"}
            </p>
            {activeApproval.commandPreview ? (
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  borderRadius: 8,
                  background: "rgba(15,23,42,0.7)",
                  color: "#fde68a",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                }}
              >
                {activeApproval.commandPreview}
              </pre>
            ) : null}
            {activeApproval.fileChangePreview ? (
              <p className="muted" style={{ margin: 0 }}>
                target: {activeApproval.fileChangePreview}
              </p>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <button
                type="button"
                data-testid="approval-allow"
                disabled={approvalBusy === activeApproval.approvalId}
                onClick={() => void decideApproval(activeApproval.approvalId, "allow")}
                style={{
                  border: "none",
                  borderRadius: 10,
                  background: "#15803d",
                  color: "white",
                  padding: "9px 10px",
                  fontWeight: 700,
                  cursor: approvalBusy ? "not-allowed" : "pointer",
                }}
              >
                Allow
              </button>
              <button
                type="button"
                data-testid="approval-deny"
                disabled={approvalBusy === activeApproval.approvalId}
                onClick={() => void decideApproval(activeApproval.approvalId, "deny")}
                style={{
                  border: "none",
                  borderRadius: 10,
                  background: "#b91c1c",
                  color: "white",
                  padding: "9px 10px",
                  fontWeight: 700,
                  cursor: approvalBusy ? "not-allowed" : "pointer",
                }}
              >
                Deny
              </button>
              <button
                type="button"
                data-testid="approval-cancel"
                disabled={approvalBusy === activeApproval.approvalId}
                onClick={() => void decideApproval(activeApproval.approvalId, "cancel")}
                style={{
                  border: "none",
                  borderRadius: 10,
                  background: "#334155",
                  color: "white",
                  padding: "9px 10px",
                  fontWeight: 700,
                  cursor: approvalBusy ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
