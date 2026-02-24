"use client";

import { useEffect, useMemo, useState } from "react";
import type { GatewayEvent, ThreadDetailResponse } from "@lcwa/shared-types";

type ConnectionState = "connecting" | "connected" | "reconnecting";

type Props = {
  params: Promise<{ id: string }>;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";

export default function ThreadPage({ params }: Props) {
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");

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
        const res = await fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`);
        if (!res.ok) {
          throw new Error(`thread detail http ${res.status}`);
        }

        const data = (await res.json()) as ThreadDetailResponse;
        if (!cancelled) {
          setDetail(data);
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

  return (
    <main>
      <section className="panel">
        <h1 data-testid="thread-title">Thread {threadId || "..."}</h1>
        <p className="muted">
          Slice 2: timeline + SSE
        </p>
        <div className="status">
          <span className={`badge ${connectionState === "connected" ? "ok" : "down"}`}>
            {connectionText}
          </span>
          <span data-testid="event-cursor">Last Seq: {lastSeq}</span>
        </div>

        {loading ? <p className="muted">Loading thread...</p> : null}
        {error ? <p className="muted">{error}</p> : null}

        <div data-testid="timeline" style={{ marginTop: 20, display: "grid", gap: 12 }}>
          {detail?.turns?.map((turn) => (
            <article
              key={`turn-${turn.id}`}
              style={{
                border: "1px solid rgba(148, 163, 184, 0.2)",
                borderRadius: 10,
                padding: 10,
                background: "rgba(15,23,42,0.5)",
              }}
            >
              <strong>Turn {turn.id}</strong>
              <p className="muted" style={{ margin: "6px 0 0" }}>
                status={turn.status}
              </p>
            </article>
          ))}

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
      </section>
    </main>
  );
}
