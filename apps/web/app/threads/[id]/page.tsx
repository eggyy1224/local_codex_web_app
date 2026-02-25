"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  AccountRateLimitsResponse,
  ApprovalDecisionRequest,
  ApprovalView,
  CreateReviewRequest,
  CreateReviewResponse,
  GatewayEvent,
  ModelOption,
  ModelsResponse,
  PendingApprovalsResponse,
  ThreadControlRequest,
  ThreadDetailResponse,
  ThreadContextResponse,
  ThreadListItem,
  ThreadTimelineItem,
  ThreadTimelineResponse,
  TurnPermissionMode,
} from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "../../lib/projects";
import {
  buildConversationTurns,
  formatEffortLabel,
  statusClass,
  statusLabel,
  timelineItemFromGatewayEvent,
  truncateText,
} from "../../lib/thread-logic";
import {
  applySlashSuggestion,
  getSlashSuggestions,
  parseSlashCommand,
  type KnownSlashCommand,
} from "../../lib/slash-commands";
import TerminalDock from "./TerminalDock";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "lagging";

type Props = {
  params: Promise<{ id: string }>;
};

type PendingApprovalCard = ApprovalView;
type CollaborationModeKind = "plan" | "default";
type ThreadTokenUsageSummary = {
  threadId: string;
  turnId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  modelContextWindow: number | null;
  updatedAt: string;
};
type StatusBanner = {
  generatedAt: string;
  lines: string[];
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";
const SIDEBAR_SCROLL_STORAGE_KEY = "lcwa.sidebar.scroll.v1";
const PERMISSION_MODE_STORAGE_KEY = "lcwa.permission.mode.v1";
const MODEL_STORAGE_KEY = "lcwa.model.v1";
const THINKING_EFFORT_STORAGE_KEY = "lcwa.thinking.effort.v1";
const THREAD_MODE_STORAGE_KEY_PREFIX = "lcwa.thread.mode.v1";
const TIMELINE_STICKY_THRESHOLD_PX = 56;
const ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX = 24;
const TERMINAL_WIDTH_STORAGE_KEY = "lcwa.terminal.width.v1";
const TERMINAL_MIN_WIDTH = 320;
const TERMINAL_MAX_WIDTH = 720;

const FALLBACK_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5-codex", label: "GPT-5-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
];
const FALLBACK_THINKING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"];

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

function maxTerminalWidthForViewport(): number {
  if (typeof window === "undefined") {
    return TERMINAL_MAX_WIDTH;
  }
  return Math.min(TERMINAL_MAX_WIDTH, Math.floor(window.innerWidth * 0.6));
}

function clampTerminalWidth(width: number): number {
  const max = Math.max(TERMINAL_MIN_WIDTH, maxTerminalWidthForViewport());
  return Math.min(max, Math.max(TERMINAL_MIN_WIDTH, Math.round(width)));
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
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

function isCollaborationModeKind(value: string | null): value is CollaborationModeKind {
  return value === "plan" || value === "default";
}

function threadModeStorageKey(threadId: string): string {
  return `${THREAD_MODE_STORAGE_KEY_PREFIX}.${threadId}`;
}

function tokenUsageFromEvent(event: GatewayEvent): ThreadTokenUsageSummary | null {
  if (event.name !== "thread/tokenUsage/updated") {
    return null;
  }
  const payload = asRecord(event.payload);
  const tokenUsage = asRecord(payload?.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  const totalTokens = total?.totalTokens;
  const inputTokens = total?.inputTokens;
  const outputTokens = total?.outputTokens;
  if (
    typeof totalTokens !== "number" ||
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return null;
  }
  const turnId = readString(payload, "turnId") ?? readString(payload, "turn_id");
  const modelContextWindow =
    typeof tokenUsage?.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
  return {
    threadId: event.threadId,
    turnId,
    totalTokens,
    inputTokens,
    outputTokens,
    modelContextWindow,
    updatedAt: event.serverTs,
  };
}

function formatRateLimitStatus(response: AccountRateLimitsResponse): string {
  if (response.error || !response.rateLimits) {
    return "rate limits: unavailable";
  }
  const primary = response.rateLimits.primary;
  if (!primary) {
    return "rate limits: unavailable";
  }
  const limitName = response.rateLimits.limitName ?? response.rateLimits.limitId ?? "default";
  const resetAt = new Date(primary.resetsAt * 1000);
  const resetLabel = Number.isNaN(resetAt.getTime()) ? String(primary.resetsAt) : resetAt.toLocaleTimeString();
  return `rate limits: ${limitName} ${primary.usedPercent}% (reset ${resetLabel})`;
}

export default function ThreadPage({ params }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineStickyRef = useRef(true);
  const timelineInitializedRef = useRef(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const activeThreadCardRef = useRef<HTMLElement | null>(null);
  const modeInitializedRef = useRef(false);
  const statusQueryHandledRef = useRef(false);
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [lastEventAtMs, setLastEventAtMs] = useState<number>(Date.now());
  const [prompt, setPrompt] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(FALLBACK_MODEL_OPTIONS[0]?.value ?? "gpt-5.3-codex");
  const [thinkingEffort, setThinkingEffort] = useState<string>("high");
  const [collaborationMode, setCollaborationMode] = useState<CollaborationModeKind>("default");
  const [permissionMode, setPermissionMode] = useState<TurnPermissionMode>("local");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApprovalCard>>({});
  const [timelineItems, setTimelineItems] = useState<ThreadTimelineItem[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<ThreadControlRequest["action"] | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [threadList, setThreadList] = useState<ThreadListItem[]>([]);
  const [threadListLoading, setThreadListLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [threadContext, setThreadContext] = useState<ThreadContextResponse | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(420);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [latestTokenUsage, setLatestTokenUsage] = useState<ThreadTokenUsageSummary | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const slashSuggestions = useMemo(
    () => (slashMenuDismissed ? [] : getSlashSuggestions(prompt)),
    [prompt, slashMenuDismissed],
  );
  const slashMenuOpen = slashSuggestions.length > 0;

  useEffect(() => {
    if (!slashMenuOpen) {
      setActiveSlashIndex(0);
      return;
    }
    setActiveSlashIndex((prev) => Math.min(prev, slashSuggestions.length - 1));
  }, [slashMenuOpen, slashSuggestions.length]);

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
    () =>
      modelCatalog.find((entry) => entry.model === model || entry.id === model) ?? null,
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

  const replaceWithoutQueryParams = useCallback(
    (keys: string[]) => {
      const current = new URLSearchParams(searchParams.toString());
      let changed = false;
      for (const key of keys) {
        if (current.has(key)) {
          current.delete(key);
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      const query = current.toString();
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const applyCollaborationMode = useCallback(
    (nextMode: CollaborationModeKind) => {
      setCollaborationMode(nextMode);
      if (threadId) {
        window.localStorage.setItem(threadModeStorageKey(threadId), nextMode);
      }
      return nextMode;
    },
    [threadId],
  );

  useEffect(() => {
    params.then((value) => setThreadId(value.id));
  }, [params]);

  useEffect(() => {
    modeInitializedRef.current = false;
    statusQueryHandledRef.current = false;
    setLatestTokenUsage(null);
    setStatusBanner(null);
  }, [threadId]);

  useEffect(() => {
    if (!threadId || modeInitializedRef.current) {
      return;
    }

    const modeFromQuery = searchParams.get("mode");
    const nextModeFromQuery = isCollaborationModeKind(modeFromQuery) ? modeFromQuery : null;
    const savedMode = window.localStorage.getItem(threadModeStorageKey(threadId));
    const nextModeFromStorage = isCollaborationModeKind(savedMode) ? savedMode : null;
    const nextMode = nextModeFromQuery ?? nextModeFromStorage ?? "default";

    applyCollaborationMode(nextMode);
    modeInitializedRef.current = true;

    if (nextModeFromQuery) {
      replaceWithoutQueryParams(["mode"]);
    }
  }, [applyCollaborationMode, replaceWithoutQueryParams, searchParams, threadId]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1024px)");
    const syncViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
    };
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (isMobileViewport) {
      setTerminalOpen(false);
      return;
    }
    const savedWidth = window.localStorage.getItem(TERMINAL_WIDTH_STORAGE_KEY);
    if (savedWidth) {
      const parsed = Number.parseFloat(savedWidth);
      if (Number.isFinite(parsed)) {
        setTerminalWidth(clampTerminalWidth(parsed));
      }
    }
  }, [isMobileViewport]);

  const handleTerminalResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobileViewport) {
        return;
      }
      event.preventDefault();
      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampTerminalWidth(window.innerWidth - moveEvent.clientX);
        setTerminalWidth(nextWidth);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [isMobileViewport],
  );

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
    window.localStorage.setItem(TERMINAL_WIDTH_STORAGE_KEY, String(terminalWidth));
  }, [isMobileViewport, terminalWidth]);

  useEffect(() => {
    if (isMobileViewport) {
      setIsCompactViewport(false);
      return;
    }
    const syncCompact = () => {
      const reserved = terminalOpen ? terminalWidth : 0;
      const availableMainWidth = window.innerWidth - reserved;
      setIsCompactViewport(availableMainWidth <= 1024);
    };
    syncCompact();
    window.addEventListener("resize", syncCompact);
    return () => {
      window.removeEventListener("resize", syncCompact);
    };
  }, [isMobileViewport, terminalOpen, terminalWidth]);

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
    const onResize = () => {
      setTerminalWidth((prev) => clampTerminalWidth(prev));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [isMobileViewport]);

  useEffect(() => {
    const saved = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (saved === "local" || saved === "full-access") {
      setPermissionMode(saved);
    }
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
          setModelCatalogError(
            catalogError instanceof Error ? catalogError.message : "model list unavailable",
          );
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

    const preferredDefault =
      modelOptions.find((option) => option.isDefault)?.value ?? modelOptions[0]?.value;
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
    window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, [model]);

  useEffect(() => {
    window.localStorage.setItem(THINKING_EFFORT_STORAGE_KEY, thinkingEffort);
  }, [thinkingEffort]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [detailRes, approvalsRes, threadsRes, timelineRes, contextRes] = await Promise.all([
          fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/approvals/pending`),
          fetch(`${gatewayUrl}/api/threads?limit=200`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/timeline?limit=600`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/context`),
        ]);

        if (!detailRes.ok) {
          throw new Error(`thread detail http ${detailRes.status}`);
        }
        if (!approvalsRes.ok) {
          throw new Error(`approvals http ${approvalsRes.status}`);
        }
        if (!threadsRes.ok) {
          throw new Error(`thread list http ${threadsRes.status}`);
        }
        if (!timelineRes.ok) {
          throw new Error(`timeline http ${timelineRes.status}`);
        }
        if (!contextRes.ok) {
          throw new Error(`thread context http ${contextRes.status}`);
        }

        const data = (await detailRes.json()) as ThreadDetailResponse;
        const pending = (await approvalsRes.json()) as PendingApprovalsResponse;
        const threadListResult = (await threadsRes.json()) as { data: ThreadListItem[] };
        const timeline = (await timelineRes.json()) as ThreadTimelineResponse;
        const context = (await contextRes.json()) as ThreadContextResponse;

        if (!cancelled) {
          setDetail(data);
          setThreadListLoading(false);
          setThreadList(threadListResult.data);
          setThreadContext(context);
          setPendingApprovals(() =>
            Object.fromEntries(pending.data.map((item) => [item.approvalId, item])),
          );
          setTimelineItems(timeline.data);
          setLoading(false);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setThreadListLoading(false);
          setLoading(false);
          setThreadContext(null);
          setError(loadError instanceof Error ? loadError.message : "unknown error");
        }
      }
    }

    void load();
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
    let reconnectAttempt = 0;

    const scheduleReconnect = () => {
      if (stopped) {
        return;
      }
      const delay = Math.min(10_000, 800 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      retryTimer = setTimeout(() => connect(true), delay);
    };

    const connect = (isRetry: boolean) => {
      if (stopped) {
        return;
      }
      setConnectionState(isRetry ? "reconnecting" : "connecting");

      es = new EventSource(`${gatewayUrl}/api/threads/${threadId}/events?since=${currentSince}`);

      es.addEventListener("gateway", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as GatewayEvent;
        if (payload.seq <= currentSince) {
          return;
        }
        currentSince = payload.seq;
        setEvents((prev) => [...prev, payload].slice(-600));
        setLastSeq((prev) => Math.max(prev, payload.seq));
        setLastEventAtMs(Date.now());
        reconnectAttempt = 0;
        setConnectionState("connected");
        const tokenUsage = tokenUsageFromEvent(payload);
        if (tokenUsage) {
          setLatestTokenUsage(tokenUsage);
        }

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
          setLastEventAtMs(Date.now());
          reconnectAttempt = 0;
          setConnectionState("connected");
        }
      });

      es.onerror = () => {
        if (stopped) {
          return;
        }
        setConnectionState("reconnecting");
        es?.close();
        scheduleReconnect();
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

  useEffect(() => {
    if (connectionState === "reconnecting" || connectionState === "connecting") {
      return;
    }

    const timer = setInterval(() => {
      const ageMs = Date.now() - lastEventAtMs;
      if (ageMs > 20_000) {
        setConnectionState("lagging");
      } else if (connectionState === "lagging") {
        setConnectionState("connected");
      }
    }, 4_000);

    return () => {
      clearInterval(timer);
    };
  }, [connectionState, lastEventAtMs]);

  const connectionText = useMemo(() => {
    if (connectionState === "connected") return "Connected";
    if (connectionState === "reconnecting") return "Reconnecting";
    if (connectionState === "lagging") return "Lagging";
    return "Connecting";
  }, [connectionState]);

  const liveTimelineItems = useMemo(
    () =>
      events
        .map((event) => timelineItemFromGatewayEvent(event))
        .filter((item): item is ThreadTimelineItem => item !== null),
    [events],
  );
  const allTimelineItems = useMemo(() => {
    const dedupe = new Set<string>();
    const merged = [...timelineItems, ...liveTimelineItems]
      .sort((a, b) => {
        if (a.ts !== b.ts) {
          return a.ts.localeCompare(b.ts);
        }
        return a.id.localeCompare(b.id);
      })
      .filter((item) => {
        const signature = [
          item.ts,
          item.turnId ?? "",
          item.type,
          item.rawType,
          item.callId ?? "",
          item.text ?? "",
        ].join("|");
        if (dedupe.has(signature)) {
          return false;
        }
        dedupe.add(signature);
        return true;
      });
    return merged;
  }, [timelineItems, liveTimelineItems]);
  const allConversationTurns = useMemo(
    () => buildConversationTurns(allTimelineItems),
    [allTimelineItems],
  );
  const hiddenTimelineCount = Math.max(0, allConversationTurns.length - 120);
  const visibleConversationTurns = showAllTurns
    ? allConversationTurns
    : allConversationTurns.slice(-120);

  const activeThread = threadList.find((thread) => thread.id === threadId);
  const groupedThreads = useMemo(() => groupThreadsByProject(threadList), [threadList]);
  const activeProjectKey = useMemo(() => {
    if (activeThread?.projectKey) {
      return activeThread.projectKey;
    }
    return pickDefaultProjectKey(groupedThreads);
  }, [activeThread, groupedThreads]);

  const activeApproval = useMemo(
    () =>
      Object.values(pendingApprovals).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0] ?? null,
    [pendingApprovals],
  );

  const syncTimelineStickyState = useCallback(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const distanceFromBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    timelineStickyRef.current = distanceFromBottom <= TIMELINE_STICKY_THRESHOLD_PX;
  }, []);

  const handleTimelineScroll = useCallback(() => {
    syncTimelineStickyState();
  }, [syncTimelineStickyState]);

  const registerActiveThreadCard = useCallback((node: HTMLElement | null) => {
    activeThreadCardRef.current = node;
  }, []);

  useEffect(() => {
    timelineStickyRef.current = true;
    timelineInitializedRef.current = false;
  }, [threadId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    if (!timelineInitializedRef.current) {
      const rafId = window.requestAnimationFrame(() => {
        timeline.scrollTop = timeline.scrollHeight;
        timelineInitializedRef.current = true;
        syncTimelineStickyState();
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }
    if (!timelineStickyRef.current) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
      syncTimelineStickyState();
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    threadId,
    showAllTurns,
    hiddenTimelineCount,
    visibleConversationTurns,
    activeApproval?.approvalId,
    syncTimelineStickyState,
  ]);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }

    const savedScrollTop = window.sessionStorage.getItem(SIDEBAR_SCROLL_STORAGE_KEY);
    if (savedScrollTop !== null) {
      const parsed = Number.parseFloat(savedScrollTop);
      if (Number.isFinite(parsed)) {
        sidebar.scrollTop = parsed;
      }
    }

    const onSidebarScroll = () => {
      window.sessionStorage.setItem(
        SIDEBAR_SCROLL_STORAGE_KEY,
        String(sidebar.scrollTop),
      );
    };

    sidebar.addEventListener("scroll", onSidebarScroll, { passive: true });
    return () => {
      sidebar.removeEventListener("scroll", onSidebarScroll);
    };
  }, [sidebarOpen, threadId, threadList.length]);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }
    const sidebar = sidebarRef.current;
    const activeCard = activeThreadCardRef.current;
    if (!sidebar || !activeCard) {
      return;
    }
    if (sidebar.scrollTop > ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      activeCard.scrollIntoView({ block: "nearest" });
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [threadId, threadList.length, sidebarOpen]);

  async function createThread(): Promise<void> {
    try {
      const body = activeProjectKey !== "unknown" ? { cwd: activeProjectKey } : {};
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
      router.push(`/threads/${payload.threadId}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "create thread failed");
    }
  }

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

  const sendControl = useCallback(async (action: ThreadControlRequest["action"]): Promise<void> => {
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
    } catch (controlErr) {
      setControlError(controlErr instanceof Error ? controlErr.message : "control failed");
    } finally {
      setControlBusy(null);
    }
  }, [controlBusy, threadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "SELECT") {
        return;
      }
      event.preventDefault();
      void sendControl("stop");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sendControl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMobileViewport) {
        return;
      }
      if (event.isComposing || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || key !== "j") {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "SELECT") {
        return;
      }
      event.preventDefault();
      setTerminalOpen((value) => !value);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMobileViewport]);

  const toggleCollaborationMode = useCallback((): CollaborationModeKind => {
    const nextMode: CollaborationModeKind = collaborationMode === "plan" ? "default" : "plan";
    applyCollaborationMode(nextMode);
    return nextMode;
  }, [applyCollaborationMode, collaborationMode]);

  const submitTurnText = useCallback(
    async (
      rawText: string,
      modeOverride?: CollaborationModeKind,
    ): Promise<boolean> => {
      const text = rawText.trim();
      if (!text || !threadId || submitting) {
        return false;
      }

      setSubmitting(true);
      setSubmitError(null);

      try {
        const modeForTurn = modeOverride ?? collaborationMode;
        const options: {
          cwd?: string;
          model: string;
          effort: string;
          permissionMode: TurnPermissionMode;
          collaborationMode?: "plan";
        } = {
          model,
          effort: thinkingEffort,
          permissionMode,
        };
        if (activeProjectKey !== "unknown") {
          options.cwd = activeProjectKey;
        }
        if (modeForTurn === "plan") {
          options.collaborationMode = "plan";
        }

        const res = await fetch(`${gatewayUrl}/api/threads/${threadId}/turns`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text }],
            options,
          }),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(payload?.message ?? `turn submit http ${res.status}`);
        }

        await res.json();
        return true;
      } catch (submitErr) {
        setSubmitError(submitErr instanceof Error ? submitErr.message : "submit failed");
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [activeProjectKey, collaborationMode, model, permissionMode, thinkingEffort, submitting, threadId],
  );

  const startReview = useCallback(
    async (instructions?: string): Promise<boolean> => {
      if (!threadId || submitting) {
        return false;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const payload: CreateReviewRequest =
          instructions && instructions.trim().length > 0
            ? { instructions: instructions.trim() }
            : {};
        const res = await fetch(`${gatewayUrl}/api/threads/${threadId}/review`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `review http ${res.status}`);
        }
        await res.json() as CreateReviewResponse;
        return true;
      } catch (reviewErr) {
        setSubmitError(reviewErr instanceof Error ? reviewErr.message : "review failed");
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, threadId],
  );

  const runStatusCommand = useCallback(async (): Promise<boolean> => {
    if (!threadId) {
      return false;
    }
    setSubmitError(null);
    try {
      const rateLimitRes = await fetch(`${gatewayUrl}/api/account/rate-limits`);
      if (!rateLimitRes.ok) {
        throw new Error(`rate-limits http ${rateLimitRes.status}`);
      }
      const rateLimitPayload = (await rateLimitRes.json()) as AccountRateLimitsResponse;
      const usageLine = latestTokenUsage
        ? `context: total ${latestTokenUsage.totalTokens}, input ${latestTokenUsage.inputTokens}, output ${latestTokenUsage.outputTokens}${
            latestTokenUsage.modelContextWindow !== null
              ? `, window ${latestTokenUsage.modelContextWindow}`
              : ""
          }`
        : "context: n/a";
      const banner: StatusBanner = {
        generatedAt: new Date().toISOString(),
        lines: [
          `thread: ${threadId}`,
          usageLine,
          formatRateLimitStatus(rateLimitPayload),
        ],
      };
      setStatusBanner(banner);
      return true;
    } catch (statusErr) {
      setSubmitError(statusErr instanceof Error ? statusErr.message : "status failed");
      return false;
    }
  }, [latestTokenUsage, threadId]);

  const applyPromptSlash = useCallback((command: KnownSlashCommand) => {
    setPrompt((previous) => applySlashSuggestion(previous, command));
    setSlashMenuDismissed(false);
    setActiveSlashIndex(0);
  }, []);

  const handleSlashCommand = useCallback(
    async (rawText: string): Promise<boolean> => {
      const parsed = parseSlashCommand(rawText);
      if (parsed.type !== "known") {
        return false;
      }

      if (parsed.command === "plan" || parsed.command === "plan-mode") {
        const nextMode = toggleCollaborationMode();
        if (parsed.args.length > 0) {
          const sent = await submitTurnText(parsed.args, nextMode);
          if (sent) {
            setPrompt("");
          }
          return true;
        }
        setPrompt("");
        return true;
      }

      if (parsed.command === "review") {
        const ok = await startReview(parsed.args);
        if (ok) {
          setPrompt("");
        }
        return true;
      }

      if (parsed.command === "status") {
        const ok = await runStatusCommand();
        if (ok) {
          setPrompt("");
        }
        return true;
      }

      return false;
    },
    [runStatusCommand, startReview, submitTurnText, toggleCollaborationMode],
  );

  async function sendTurn(): Promise<void> {
    const text = prompt.trim();
    if (!text || !threadId || submitting) {
      return;
    }

    const handled = await handleSlashCommand(text);
    if (handled) {
      return;
    }

    const sent = await submitTurnText(text);
    if (sent) {
      setPrompt("");
    }
  }

  useEffect(() => {
    if (!threadId || statusQueryHandledRef.current) {
      return;
    }
    if (searchParams.get("status") !== "1") {
      return;
    }

    statusQueryHandledRef.current = true;
    void (async () => {
      await runStatusCommand();
      replaceWithoutQueryParams(["status"]);
    })();
  }, [replaceWithoutQueryParams, runStatusCommand, searchParams, threadId]);

  async function copyMessage(text: string): Promise<void> {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard errors in unsupported environments.
    }
  }

  const terminalEnabled = !isMobileViewport && terminalOpen;
  const sidebarVisible = sidebarOpen && !isCompactViewport;
  const workspaceStyle = terminalEnabled
    ? ({
        "--cdx-terminal-width": `${terminalWidth}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div className={`cdx-app ${sidebarVisible ? "" : "cdx-app--sidebar-collapsed"}`}>
      <header className={`cdx-topbar ${isCompactViewport ? "cdx-topbar--compact" : ""}`}>
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
            onClick={() => void createThread()}
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
          {!isMobileViewport ? (
            <button
              type="button"
              className="cdx-toolbar-btn cdx-toolbar-btn--icon"
              aria-label="Toggle terminal"
              title="Toggle terminal (Cmd+J)"
              onClick={() => setTerminalOpen((v) => !v)}
            >
              ▦
            </button>
          ) : null}
          <button type="button" className="cdx-toolbar-btn" disabled>
            Pop out
          </button>
        </div>
      </header>

      {statusBanner ? (
        <div className="cdx-status-banner" data-testid="status-banner">
          <span>{statusBanner.lines[0]}</span>
          <span>{statusBanner.lines[1]}</span>
          <span>{statusBanner.lines[2]}</span>
        </div>
      ) : null}

      <div
        className={`cdx-workspace cdx-workspace--thread ${
          terminalEnabled ? "cdx-workspace--with-terminal" : ""
        }`}
        style={workspaceStyle}
      >
        {sidebarVisible ? (
          <aside className="cdx-sidebar" ref={sidebarRef}>
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
            <div className="cdx-project-tree">
              {groupedThreads.map((group) => (
                <section key={group.key} className="cdx-project-group">
                  <div className="cdx-project-title">
                    <span>{group.label}</span>
                    <span className="cdx-helper">{group.threads.length}</span>
                  </div>
                  <div className="cdx-thread-list">
                    {group.threads.map((thread) => (
                      <Link
                        href={`/threads/${thread.id}`}
                        key={thread.id}
                        data-testid={`thread-link-${thread.id}`}
                      >
                        <article
                          ref={thread.id === threadId ? registerActiveThreadCard : null}
                          className={`cdx-thread-item ${thread.id === threadId ? "is-active" : ""}`}
                        >
                          <h3 title={thread.title}>{thread.title}</h3>
                          <p>{thread.preview || "(empty preview)"}</p>
                          <span>{thread.lastActiveAt}</span>
                        </article>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
              {threadListLoading ? <p className="cdx-helper">Loading thread list...</p> : null}
            </div>
          </aside>
        ) : null}

        <main className={`cdx-main ${isCompactViewport ? "cdx-main--compact" : ""}`}>
          <section className="cdx-hero cdx-hero--thread">
            <div className="cdx-hero-row">
              <h1 data-testid="thread-title">Let&apos;s build</h1>
              <button type="button" className="cdx-project-chip">
                {projectLabelFromKey(activeProjectKey)}
              </button>
            </div>
            <p className="cdx-helper">
              {detail?.thread.title ?? threadId} · seq{" "}
              <span data-testid="event-cursor">{lastSeq}</span>
            </p>
            <div className="cdx-status-row">
              <span className={`cdx-status ${statusClass(connectionState === "connected" ? "completed" : "unknown")}`}>
                {connectionText}
              </span>
              <span
                data-testid="collaboration-mode"
                className={`cdx-status ${
                  collaborationMode === "plan" ? "is-pending" : "is-online"
                }`}
              >
                mode: {collaborationMode}
              </span>
              <span className="cdx-status is-pending">
                Pending approval: {Object.keys(pendingApprovals).length}
              </span>
              <span
                className={`cdx-status ${
                  threadContext?.isFallback ? "is-offline" : "is-online"
                }`}
              >
                {threadContext?.isFallback
                  ? "cwd unknown"
                  : `cwd: ${threadContext?.resolvedCwd ?? "-"}`}
              </span>
              <Link href="/">
                <button type="button" className="cdx-toolbar-btn">
                  Home
                </button>
              </Link>
            </div>
            {loading ? <p className="cdx-helper">Loading thread...</p> : null}
            {error ? <p className="cdx-error">{error}</p> : null}
            {submitError ? <p className="cdx-error">{submitError}</p> : null}
            {approvalError ? <p className="cdx-error">{approvalError}</p> : null}
            {controlError ? <p className="cdx-error">{controlError}</p> : null}
            {modelCatalogError ? (
              <p className="cdx-helper">Model catalog unavailable ({modelCatalogError}); using fallback list.</p>
            ) : null}
          </section>

          <section
            className="cdx-timeline"
            data-testid="timeline"
            ref={timelineRef}
            onScroll={handleTimelineScroll}
          >
            {hiddenTimelineCount > 0 && !showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(true)}
              >
                {hiddenTimelineCount} previous turns
              </button>
            ) : null}

            {hiddenTimelineCount > 0 && showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(false)}
              >
                Show fewer turns
              </button>
            ) : null}

            {visibleConversationTurns.length === 0 ? (
              <p className="cdx-helper">No conversation yet.</p>
            ) : (
              visibleConversationTurns.map((turn) => (
                <article
                  className={`cdx-turn-card cdx-turn-card--conversation ${
                    turn.isStreaming ? "cdx-turn-card--streaming" : ""
                  }`}
                  key={turn.turnId}
                >
                  <div className="cdx-turn-head">
                    <strong>Turn</strong>
                    <div className="cdx-turn-state">
                      {turn.isStreaming ? (
                        <span className="cdx-stream-indicator" aria-live="polite">
                          <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                          Responding
                        </span>
                      ) : null}
                      <span className={`cdx-status ${statusClass(turn.status)}`}>
                        {statusLabel(turn.status)}
                      </span>
                    </div>
                  </div>
                  <p className="cdx-turn-meta">
                    {formatTimestamp(turn.startedAt)} · turn {turn.turnId}
                  </p>
                  {turn.userText ? (
                    <section className="cdx-message cdx-message--user">
                      <div className="cdx-message-meta">
                        <strong className="cdx-message-role">You</strong>
                      </div>
                      <pre className="cdx-turn-body">{truncateText(turn.userText, 9000)}</pre>
                    </section>
                  ) : null}
                  {turn.assistantText ? (
                    <section
                      className={`cdx-message cdx-message--assistant ${
                        turn.isStreaming ? "cdx-message--assistant-streaming" : ""
                      }`}
                    >
                      <div className="cdx-message-meta">
                        <strong className="cdx-message-role">Codex</strong>
                        <button
                          type="button"
                          className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                          onClick={() => void copyMessage(turn.assistantText ?? "")}
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="cdx-turn-body">
                        {truncateText(turn.assistantText, 9000)}
                        {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                      </pre>
                    </section>
                  ) : (
                    <p className={`cdx-helper ${turn.isStreaming ? "cdx-helper--streaming" : ""}`}>
                      {turn.isStreaming ? "Codex is responding..." : "Waiting for response..."}
                    </p>
                  )}
                  {turn.thinkingText || turn.toolCalls.length > 0 || turn.toolResults.length > 0 ? (
                    <details className="cdx-message-collapsible">
                      <summary>
                        Thinking & tools (
                        {(turn.thinkingText ? 1 : 0) + turn.toolCalls.length + turn.toolResults.length})
                      </summary>
                      <div className="cdx-message-stack cdx-message-stack--details">
                        {turn.thinkingText ? (
                          <section className="cdx-message cdx-message--detail">
                            <div className="cdx-message-meta">
                              <strong className="cdx-message-role">Thinking</strong>
                            </div>
                            <pre className="cdx-turn-body">{truncateText(turn.thinkingText, 6000)}</pre>
                          </section>
                        ) : null}
                        {turn.toolCalls.map((call, index) => (
                          <section
                            className="cdx-message cdx-message--tool"
                            key={`${turn.turnId}-tool-call-${index}-${call.toolName}`}
                          >
                            <div className="cdx-message-meta">
                              <strong className="cdx-message-role">Tool call: {call.toolName}</strong>
                            </div>
                            {call.text ? <pre className="cdx-turn-body">{truncateText(call.text, 4500)}</pre> : null}
                          </section>
                        ))}
                        {turn.toolResults.map((result, index) => (
                          <section
                            className="cdx-message cdx-message--detail"
                            key={`${turn.turnId}-tool-result-${index}`}
                          >
                            <div className="cdx-message-meta">
                              <strong className="cdx-message-role">Tool output</strong>
                            </div>
                            <pre className="cdx-turn-body">{truncateText(result, 4500)}</pre>
                          </section>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </article>
              ))
            )}
          </section>

          {activeApproval ? (
            <aside data-testid="approval-drawer" className="cdx-approval-dock">
              <div className="cdx-turn-head">
                <strong>Approval Required</strong>
                <span className="cdx-status is-pending">{activeApproval.type}</span>
              </div>
              <p>{activeApproval.reason ?? "This action requires your decision."}</p>
              {activeApproval.commandPreview ? (
                <pre className="cdx-turn-body">{activeApproval.commandPreview}</pre>
              ) : null}
              {activeApproval.fileChangePreview ? <p>target: {activeApproval.fileChangePreview}</p> : null}
              <div className="cdx-inline-actions">
                <button
                  type="button"
                  data-testid="approval-allow"
                  className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                  disabled={approvalBusy === activeApproval.approvalId}
                  onClick={() => void decideApproval(activeApproval.approvalId, "allow")}
                >
                  Allow
                </button>
                <button
                  type="button"
                  data-testid="approval-deny"
                  className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                  disabled={approvalBusy === activeApproval.approvalId}
                  onClick={() => void decideApproval(activeApproval.approvalId, "deny")}
                >
                  Deny
                </button>
                <button
                  type="button"
                  data-testid="approval-cancel"
                  className="cdx-toolbar-btn"
                  disabled={approvalBusy === activeApproval.approvalId}
                  onClick={() => void decideApproval(activeApproval.approvalId, "cancel")}
                >
                  Cancel
                </button>
              </div>
            </aside>
          ) : null}

          <section className="cdx-composer">
            <textarea
              id="turn-input"
              data-testid="turn-input"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setSlashMenuDismissed(false);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Tab" &&
                  event.shiftKey &&
                  !event.defaultPrevented &&
                  !event.nativeEvent.isComposing &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  toggleCollaborationMode();
                  return;
                }
                if (slashMenuOpen && event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveSlashIndex((prev) => (prev + 1) % slashSuggestions.length);
                  return;
                }
                if (slashMenuOpen && event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveSlashIndex(
                    (prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length,
                  );
                  return;
                }
                if (
                  slashMenuOpen &&
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.defaultPrevented &&
                  !event.nativeEvent.isComposing &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  const selected = slashSuggestions[activeSlashIndex] ?? slashSuggestions[0];
                  if (selected) {
                    applyPromptSlash(selected.command);
                  }
                  return;
                }
                if (
                  slashMenuOpen &&
                  event.key === "Tab" &&
                  !event.shiftKey &&
                  !event.defaultPrevented &&
                  !event.nativeEvent.isComposing &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  const selected = slashSuggestions[activeSlashIndex] ?? slashSuggestions[0];
                  if (selected) {
                    applyPromptSlash(selected.command);
                  }
                  return;
                }
                if (slashMenuOpen && event.key === "Escape") {
                  event.preventDefault();
                  setSlashMenuDismissed(true);
                  return;
                }
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
                void sendTurn();
              }}
              placeholder="Ask Codex anything, @ to add files, / for commands"
              rows={3}
            />
            {slashMenuOpen ? (
              <div className="cdx-slash-menu" role="listbox" aria-label="Slash command suggestions" data-testid="thread-slash-menu">
                {slashSuggestions.map((item, index) => {
                  const active = index === activeSlashIndex;
                  return (
                    <button
                      key={item.command}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`cdx-slash-item ${active ? "is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyPromptSlash(item.command);
                      }}
                    >
                      <span className="cdx-slash-item-command">{item.title}</span>
                      <span className="cdx-slash-item-desc">{item.description}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <p className="cdx-helper">
              Mode: {collaborationMode} · Shift+Tab toggle · /plan /review /status
            </p>
            <div className="cdx-composer-row">
              <div className="cdx-inline-actions">
                <button
                  type="button"
                  data-testid="control-stop"
                  className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                  disabled={controlBusy !== null}
                  onClick={() => void sendControl("stop")}
                >
                  {controlBusy === "stop" ? "Stopping..." : "Stop"}
                </button>
                <button
                  type="button"
                  data-testid="control-retry"
                  className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                  disabled={controlBusy !== null}
                  onClick={() => void sendControl("retry")}
                >
                  {controlBusy === "retry" ? "Retrying..." : "Retry"}
                </button>
                <button
                  type="button"
                  data-testid="control-cancel"
                  className="cdx-toolbar-btn"
                  disabled={controlBusy !== null}
                  onClick={() => void sendControl("cancel")}
                >
                  {controlBusy === "cancel" ? "Cancelling..." : "Cancel"}
                </button>
              </div>
              <div className="cdx-composer-right">
                <label className="cdx-composer-select" htmlFor="model">
                  <span>Model</span>
                  <select
                    id="model"
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                    }}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cdx-composer-select" htmlFor="thinking-effort">
                  <span>Thinking</span>
                  <select
                    id="thinking-effort"
                    value={thinkingEffort}
                    onChange={(event) => {
                      setThinkingEffort(event.target.value);
                    }}
                  >
                    {thinkingEffortOptions.map((effort) => (
                      <option key={effort} value={effort}>
                        {formatEffortLabel(effort)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cdx-composer-select" htmlFor="permission-mode">
                  <span>Permission</span>
                  <select
                    id="permission-mode"
                    value={permissionMode}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next === "local" || next === "full-access") {
                        setPermissionMode(next);
                      }
                    }}
                  >
                    <option value="local">Local (on-request)</option>
                    <option value="full-access">Full access (never)</option>
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="turn-submit"
                  className="cdx-send-btn"
                  onClick={() => void sendTurn()}
                  disabled={submitting || prompt.trim().length === 0}
                >
                  {submitting ? "Working..." : "Send"}
                </button>
              </div>
            </div>
          </section>
        </main>

        {terminalEnabled ? (
          <TerminalDock
            gatewayUrl={gatewayUrl}
            threadId={threadId}
            width={terminalWidth}
            context={threadContext}
            onResizeStart={handleTerminalResizeStart}
            onClose={() => setTerminalOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
