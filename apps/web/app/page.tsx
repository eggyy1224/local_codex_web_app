"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { HealthResponse, ThreadListResponse } from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "./lib/projects";

type UiState = {
  loading: boolean;
  health: HealthResponse | null;
  threads: ThreadListResponse["data"];
  error: string | null;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";

const quickPrompts = [
  "Build a classic Snake game in this repo.",
  "Create a one-page $pdf that summarizes this app.",
  "Create a plan to migrate this UI to a reusable shell.",
];

export default function HomePage() {
  const router = useRouter();
  const [state, setState] = useState<UiState>({
    loading: true,
    health: null,
    threads: [],
    error: null,
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [healthRes, threadsRes] = await Promise.all([
          fetch(`${gatewayUrl}/health`),
          fetch(`${gatewayUrl}/api/threads?limit=200`),
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

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => groupThreadsByProject(state.threads), [state.threads]);
  const activeProjectKey = useMemo(() => pickDefaultProjectKey(groups), [groups]);

  const online = Boolean(state.health && !state.error);
  const statusText = state.loading
    ? "Checking gateway"
    : online
      ? "Gateway connected"
      : "Gateway unavailable";

  async function createThread(projectKey: string): Promise<string> {
    const body = projectKey !== "unknown" ? { cwd: projectKey } : {};
    const res = await fetch(`${gatewayUrl}/api/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`create thread http ${res.status}`);
    }
    const payload = (await res.json()) as { threadId: string };
    return payload.threadId;
  }

  async function onNewThread(): Promise<void> {
    try {
      const threadId = await createThread(activeProjectKey);
      router.push(`/threads/${threadId}`);
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : "create thread failed",
      }));
    }
  }

  async function onSubmitComposer(): Promise<void> {
    if (submitting) {
      return;
    }

    const text = composerText.trim();
    setSubmitting(true);

    try {
      const threadId = await createThread(activeProjectKey);
      if (text.length > 0) {
        const turnRes = await fetch(`${gatewayUrl}/api/threads/${threadId}/turns`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text }],
            options: activeProjectKey !== "unknown" ? { cwd: activeProjectKey } : undefined,
          }),
        });
        if (!turnRes.ok) {
          throw new Error(`turn submit http ${turnRes.status}`);
        }
      }
      router.push(`/threads/${threadId}`);
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : "submit failed",
      }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`cdx-app ${sidebarOpen ? "" : "cdx-app--sidebar-collapsed"}`}>
      <header className="cdx-topbar">
        <div className="cdx-topbar-group">
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--icon"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ≡
          </button>
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--solid cdx-toolbar-btn--thread"
            onClick={() => void onNewThread()}
          >
            New thread
          </button>
        </div>
        <div className="cdx-topbar-group cdx-topbar-group--right">
          <div className="cdx-toolbar-segment">
            <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--segment-start">
              Open
            </button>
            <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--segment-end" aria-label="Secondary action">
              ▾
            </button>
          </div>
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--icon"
            aria-label="Toggle terminal"
            title="Toggle terminal"
            onClick={() => setBottomPanelOpen((v) => !v)}
          >
            ▦
          </button>
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--icon"
            aria-label="Toggle diff panel"
            title="Toggle diff panel"
            onClick={() => setBottomPanelOpen((v) => !v)}
          >
            ≋
          </button>
          <button type="button" className="cdx-toolbar-btn" disabled>
            Pop out
          </button>
        </div>
      </header>

      <div className="cdx-workspace">
        {sidebarOpen ? (
          <aside className="cdx-sidebar">
            <div className="cdx-sidebar-actions">
              <button type="button" className="cdx-sidebar-action cdx-sidebar-action--active">
                New thread
              </button>
              <button type="button" className="cdx-sidebar-action" disabled>
                Automations
              </button>
              <button type="button" className="cdx-sidebar-action" disabled>
                Skills & Apps
              </button>
            </div>

            <div className="cdx-sidebar-label">Threads</div>
            <div className="cdx-project-tree" data-testid="thread-list">
              {groups.map((group) => (
                <section key={group.key} className="cdx-project-group">
                  <div className="cdx-project-title">
                    <span>{group.label}</span>
                    <button
                      type="button"
                      className="cdx-mini-btn"
                      onClick={() => void onNewThread()}
                      title={`Start new thread in ${group.label}`}
                    >
                      +
                    </button>
                  </div>
                  <div className="cdx-thread-list">
                    {group.threads.map((thread) => (
                      <Link key={thread.id} href={`/threads/${thread.id}`} data-testid={`thread-link-${thread.id}`}>
                        <article className="cdx-thread-item">
                          <h3 title={thread.title}>{thread.title}</h3>
                          <p>{thread.preview || "(empty preview)"}</p>
                          <span>{thread.lastActiveAt}</span>
                        </article>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
              {state.loading ? <p className="cdx-helper">Loading threads...</p> : null}
              {!state.loading && groups.length === 0 ? <p className="cdx-helper">No threads yet.</p> : null}
            </div>
          </aside>
        ) : null}

        <main className="cdx-main">
          <section className="cdx-hero cdx-hero--home">
            <div className="cdx-hero-row cdx-hero-row--home">
              <h1>Let&apos;s build</h1>
              <button type="button" className="cdx-project-chip">
                {projectLabelFromKey(activeProjectKey)}
              </button>
            </div>
            <p className={`cdx-status ${online ? "is-online" : "is-offline"}`}>{statusText}</p>
            <div className="cdx-explore-head">
              <button type="button" className="cdx-toolbar-btn">
                Explore more
              </button>
            </div>
            <div className="cdx-explore-grid">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="cdx-explore-card"
                  onClick={() => setComposerText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            {state.error ? <p className="cdx-error">{state.error}</p> : null}
          </section>

          <section className="cdx-composer">
            <textarea
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              placeholder="Ask Codex anything, @ to add files, / for commands"
              rows={3}
            />
            <div className="cdx-composer-row">
              <button type="button" className="cdx-toolbar-btn" disabled>
                Add files and more
              </button>
              <div className="cdx-composer-right">
                <button type="button" className="cdx-toolbar-btn" disabled>
                  GPT-5.3-Codex-Spark
                </button>
                <button type="button" className="cdx-send-btn" onClick={() => void onSubmitComposer()}>
                  {submitting ? "Working..." : "Send"}
                </button>
              </div>
            </div>
          </section>
        </main>
      </div>

      {bottomPanelOpen ? (
        <section className="cdx-bottom-panel">
          <div className="cdx-bottom-header">
            <span>Terminal</span>
            <span>Error</span>
          </div>
          <div className="cdx-bottom-body">
            {state.error ? <p className="cdx-error">{state.error}</p> : <p className="cdx-helper">No active errors.</p>}
          </div>
        </section>
      ) : null}
    </div>
  );
}
