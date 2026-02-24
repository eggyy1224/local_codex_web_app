"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { HealthResponse, ModelOption, ModelsResponse, ThreadListResponse } from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "./lib/projects";

type UiState = {
  loading: boolean;
  health: HealthResponse | null;
  threads: ThreadListResponse["data"];
  error: string | null;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";
const MODEL_STORAGE_KEY = "lcwa.model.v1";
const THINKING_EFFORT_STORAGE_KEY = "lcwa.thinking.effort.v1";

const FALLBACK_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5-codex", label: "GPT-5-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
];
const FALLBACK_THINKING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"];

const quickPrompts = [
  "Build a classic Snake game in this repo.",
  "Create a one-page $pdf that summarizes this app.",
  "Create a plan to migrate this UI to a reusable shell.",
];

function formatEffortLabel(effort: string): string {
  return effort
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function HomePage() {
  const router = useRouter();
  const [state, setState] = useState<UiState>({
    loading: true,
    health: null,
    threads: [],
    error: null,
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(FALLBACK_MODEL_OPTIONS[0]?.value ?? "gpt-5.3-codex");
  const [thinkingEffort, setThinkingEffort] = useState<string>("high");

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
  const modelOptions = useMemo(() => {
    if (modelCatalog.length === 0) {
      return FALLBACK_MODEL_OPTIONS.map((option, index) => ({
        value: option.value,
        label: option.label,
        isDefault: index === 0,
      }));
    }

    const seen = new Set<string>();
    const options: Array<{ value: string; label: string; isDefault: boolean }> = [];
    for (const entry of modelCatalog) {
      const value = entry.model || entry.id;
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      options.push({
        value,
        label: entry.displayName ?? value,
        isDefault: entry.isDefault === true,
      });
    }
    return options.length > 0
      ? options
      : FALLBACK_MODEL_OPTIONS.map((option, index) => ({
          value: option.value,
          label: option.label,
          isDefault: index === 0,
        }));
  }, [modelCatalog]);
  const selectedModelCatalog = useMemo(
    () => modelCatalog.find((entry) => entry.model === model || entry.id === model) ?? null,
    [modelCatalog, model],
  );
  const thinkingEffortOptions = useMemo(() => {
    const supported = Array.isArray(selectedModelCatalog?.reasoningEffort)
      ? Array.from(
          new Set(
            selectedModelCatalog.reasoningEffort
              .map((option) => option.effort)
              .filter((effort): effort is string => Boolean(effort)),
          ),
        )
      : [];
    if (supported.length > 0) {
      return supported;
    }
    if (selectedModelCatalog?.defaultReasoningEffort) {
      return [selectedModelCatalog.defaultReasoningEffort];
    }
    return FALLBACK_THINKING_EFFORT_OPTIONS;
  }, [selectedModelCatalog]);

  const online = Boolean(state.health && !state.error);
  const statusText = state.loading
    ? "Checking gateway"
    : online
      ? "Gateway connected"
      : "Gateway unavailable";

  useEffect(() => {
    const savedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (savedModel) {
      setModel(savedModel);
    }
    const savedEffort = window.localStorage.getItem(THINKING_EFFORT_STORAGE_KEY);
    if (savedEffort) {
      setThinkingEffort(savedEffort);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModelCatalog() {
      try {
        const res = await fetch(`${gatewayUrl}/api/models?includeHidden=true`);
        if (!res.ok) {
          throw new Error(`model list http ${res.status}`);
        }
        const payload = (await res.json()) as ModelsResponse;
        if (!cancelled) {
          setModelCatalog(Array.isArray(payload.data) ? payload.data : []);
          setModelCatalogError(null);
        }
      } catch (catalogError) {
        if (!cancelled) {
          setModelCatalog([]);
          setModelCatalogError(catalogError instanceof Error ? catalogError.message : "model list unavailable");
        }
      }
    }

    void loadModelCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (modelOptions.length === 0) {
      return;
    }
    if (modelOptions.some((option) => option.value === model)) {
      return;
    }
    const preferredDefault = modelOptions.find((option) => option.isDefault)?.value ?? modelOptions[0]?.value;
    if (preferredDefault) {
      setModel(preferredDefault);
    }
  }, [model, modelOptions]);

  useEffect(() => {
    if (thinkingEffortOptions.length === 0) {
      return;
    }
    if (thinkingEffortOptions.includes(thinkingEffort)) {
      return;
    }
    const preferredDefault = selectedModelCatalog?.defaultReasoningEffort;
    if (preferredDefault && thinkingEffortOptions.includes(preferredDefault)) {
      setThinkingEffort(preferredDefault);
      return;
    }
    setThinkingEffort(thinkingEffortOptions[0]);
  }, [selectedModelCatalog, thinkingEffort, thinkingEffortOptions]);

  useEffect(() => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, [model]);

  useEffect(() => {
    window.localStorage.setItem(THINKING_EFFORT_STORAGE_KEY, thinkingEffort);
  }, [thinkingEffort]);

  async function createThread(projectKey: string, selectedModel: string): Promise<string> {
    const body: {
      cwd?: string;
      model?: string;
    } = {};
    if (projectKey !== "unknown") {
      body.cwd = projectKey;
    }
    if (selectedModel) {
      body.model = selectedModel;
    }
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
      const threadId = await createThread(activeProjectKey, model);
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
      const threadId = await createThread(activeProjectKey, model);
      if (text.length > 0) {
        const options: {
          cwd?: string;
          model: string;
          effort: string;
        } = {
          model,
          effort: thinkingEffort,
        };
        if (activeProjectKey !== "unknown") {
          options.cwd = activeProjectKey;
        }

        const turnRes = await fetch(`${gatewayUrl}/api/threads/${threadId}/turns`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text }],
            options,
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
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) {
                  return;
                }
                if (
                  event.defaultPrevented ||
                  event.nativeEvent.isComposing ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                void onSubmitComposer();
              }}
              placeholder="Ask Codex anything, @ to add files, / for commands"
              rows={3}
            />
            <div className="cdx-composer-row">
              <button type="button" className="cdx-toolbar-btn" disabled>
                Add files and more
              </button>
              <div className="cdx-composer-right">
                <label className="cdx-composer-select" htmlFor="home-model">
                  <span>Model</span>
                  <select
                    id="home-model"
                    data-testid="home-model-select"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cdx-composer-select" htmlFor="home-thinking-effort">
                  <span>Thinking</span>
                  <select
                    id="home-thinking-effort"
                    data-testid="home-thinking-select"
                    value={thinkingEffort}
                    onChange={(event) => setThinkingEffort(event.target.value)}
                  >
                    {thinkingEffortOptions.map((effort) => (
                      <option key={effort} value={effort}>
                        {formatEffortLabel(effort)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="cdx-send-btn" onClick={() => void onSubmitComposer()}>
                  {submitting ? "Working..." : "Send"}
                </button>
              </div>
            </div>
            {modelCatalogError ? (
              <p className="cdx-helper">Model catalog unavailable ({modelCatalogError}); using fallback list.</p>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}
