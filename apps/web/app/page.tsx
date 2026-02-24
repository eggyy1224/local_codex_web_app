"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { HealthResponse, ThreadListItem, ThreadListResponse } from "@lcwa/shared-types";

type UiState = {
  loading: boolean;
  health: HealthResponse | null;
  threads: ThreadListItem[];
  error: string | null;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";

export default function HomePage() {
  const [state, setState] = useState<UiState>({
    loading: true,
    health: null,
    threads: [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [healthRes, threadsRes] = await Promise.all([
          fetch(`${gatewayUrl}/health`),
          fetch(`${gatewayUrl}/api/threads?limit=25`),
        ]);

        if (!healthRes.ok) {
          throw new Error(`health http ${healthRes.status}`);
        }
        if (!threadsRes.ok) {
          throw new Error(`threads http ${threadsRes.status}`);
        }

        const health = (await healthRes.json()) as HealthResponse;
        const threadResult = (await threadsRes.json()) as ThreadListResponse;

        if (!cancelled) {
          setState({
            loading: false,
            health,
            threads: threadResult.data,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            health: null,
            threads: [],
            error: error instanceof Error ? error.message : "unknown error",
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const ok = Boolean(state.health && !state.error);

  return (
    <main>
      <section className="panel">
        <h1>Local Codex Web App</h1>
        <p className="muted">Slice 1: thread list from gateway/app-server</p>
        <div className="status" data-testid="home-status">
          <span className={`badge ${ok ? "ok" : "down"}`}>
            {state.loading ? "CHECKING" : ok ? "ONLINE" : "OFFLINE"}
          </span>
          <span>
            {state.loading
              ? "Connecting to gateway..."
              : ok
                ? `Gateway connected (${state.health?.timestamp})`
                : `Gateway unavailable: ${state.error}`}
          </span>
        </div>

        <h2 style={{ marginTop: 24 }}>Threads</h2>
        <div data-testid="thread-list">
          {state.loading ? (
            <p className="muted">Loading threads...</p>
          ) : state.threads.length === 0 ? (
            <p className="muted">No threads yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
              {state.threads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    href={`/threads/${thread.id}`}
                    data-testid={`thread-link-${thread.id}`}
                    style={{
                      display: "block",
                      textDecoration: "none",
                      color: "inherit",
                      border: "1px solid rgba(148, 163, 184, 0.2)",
                      borderRadius: 12,
                      padding: 12,
                      background: "rgba(2,6,23,0.35)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {thread.title}
                      </strong>
                      <span className="muted">{thread.status}</span>
                    </div>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {thread.preview || "(empty preview)"}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
