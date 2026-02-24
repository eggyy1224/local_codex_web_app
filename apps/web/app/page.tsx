"use client";

import { useEffect, useState } from "react";
import type { HealthResponse } from "@lcwa/shared-types";

type UiState = {
  loading: boolean;
  data: HealthResponse | null;
  error: string | null;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";

export default function HomePage() {
  const [state, setState] = useState<UiState>({
    loading: true,
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`${gatewayUrl}/health`);
        if (!res.ok) {
          throw new Error(`gateway http ${res.status}`);
        }
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setState({ loading: false, data, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            data: null,
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

  const ok = Boolean(state.data && !state.error);

  return (
    <main>
      <section className="panel">
        <h1>Local Codex Web App</h1>
        <p className="muted">Slice 0: gateway health + web bootstrapped</p>
        <div className="status" data-testid="home-status">
          <span className={`badge ${ok ? "ok" : "down"}`}>
            {state.loading ? "CHECKING" : ok ? "ONLINE" : "OFFLINE"}
          </span>
          <span>
            {state.loading
              ? "Connecting to gateway..."
              : ok
                ? `Gateway connected (${state.data?.timestamp})`
                : `Gateway unavailable: ${state.error}`}
          </span>
        </div>
      </section>
    </main>
  );
}
