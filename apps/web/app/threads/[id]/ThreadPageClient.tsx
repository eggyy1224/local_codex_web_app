"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  AccountRateLimitsResponse,
  ApprovalDecisionRequest,
  CreateTurnResponse,
  CreateReviewRequest,
  CreateReviewResponse,
  GatewayEvent,
  InteractionRespondRequest,
  ModelOption,
  ModelsResponse,
  PendingApprovalsResponse,
  PendingInteractionsResponse,
  ThreadControlRequest,
  ThreadDetailResponse,
  ThreadContextResponse,
  ThreadListItem,
  ThreadTimelineResponse,
  TurnPermissionMode,
  UserInputItem,
} from "@lcwa/shared-types";
import { uploadAttachments, UploadClientError } from "../../lib/upload-client";
import { type PendingAttachment } from "./AttachmentStrip";
import { resolveGatewayUrl } from "../../lib/gateway-url";
import { useGatewayConfig } from "../../lib/use-gateway-config";
import { applyFileMention, useFileMentionSearch } from "../../lib/use-file-mention-search";
import { useComposerKeyboard } from "../../lib/use-composer-keyboard";
import {
  DEFAULT_MODEL,
  FALLBACK_MODEL_OPTIONS,
  MODEL_DEFAULT_MIGRATION_STORAGE_KEY,
  MODEL_STORAGE_KEY,
  preferredModelOption,
  shouldRestoreSavedModel,
  type ModelSelectOption,
} from "../../lib/model-options";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "../../lib/projects";
import {
  formatEffortLabel,
  proposedPlanFromText,
  statusLabel,
  truncateText,
  type ConversationTurn,
} from "../../lib/thread-logic";
import {
  createThreadEventStoreState,
  selectConversationTurns,
  selectThreadTimelineItems,
  threadEventStoreReducer,
} from "../../lib/thread-event-store";
import {
  applySlashSuggestion,
  getSlashSuggestions,
  parseSlashCommand,
  type KnownSlashCommand,
} from "../../lib/slash-commands";
import { type ThreadViewMode } from "./MobileChatTopBar";
import MobileThreadShell from "./MobileThreadShell";
import DesktopThreadShell from "./DesktopThreadShell";
import {
  type MobileThreadSwitcherGroup,
} from "./MobileThreadSwitcherOverlay";
import {
  answersForInteractionQuestions,
  updateInteractionQuestionDrafts,
  type InteractionQuestionDrafts,
} from "./InteractionQuestionForm";
import { useThreadViewportShell } from "./use-thread-viewport-shell";
import { useThreadSidebarFilterController } from "./use-thread-sidebar-filter-controller";
import { fetchThreadSnapshot, type ThreadSnapshot } from "./thread-page-api";
import {
  approvalFromEvent,
  asRecord,
  contextUsageSummary,
  contextWindowPercentRemaining,
  formatRateLimitStatus,
  formatTimestamp,
  implementPlanPrompt,
  interactionFromEvent,
  isCollaborationModeKind,
  isImplementPlanPromptForPlan,
  isStoredPlanAction,
  planActionStorageKey,
  readString,
  THREAD_MODE_STORAGE_KEY_PREFIX,
  threadModeStorageKey,
  threadListItemFromGatewayEvent,
  tokenUsageFromEvent,
  type CollaborationModeKind,
  type PlanActionState,
  type PendingApprovalCard,
  type PendingInteractionCard,
  type ThreadTokenUsageSummary,
} from "./thread-page-helpers";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "lagging";

type Props = {
  params: Promise<{ id: string }>;
};

type ControlSheetSection = "pending" | "advanced";
type ControlSheetSnap = "half" | "full";
type StatusBanner = {
  generatedAt: string;
  lines: string[];
};
type MobileMessageDetails = {
  turnId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  streaming: boolean;
  toolCalls: number;
  toolResults: number;
  hasThinking: boolean;
};

const gatewayUrl = resolveGatewayUrl();
const SIDEBAR_SCROLL_STORAGE_KEY = "lcwa.sidebar.scroll.v1";
const PERMISSION_MODE_STORAGE_KEY = "lcwa.permission.mode.v1";
const THINKING_EFFORT_STORAGE_KEY = "lcwa.thinking.effort.v1";
const MOBILE_CANVAS_URL_STORAGE_KEY = "lcwa.mobile.canvas.url.v1";
const TIMELINE_STICKY_THRESHOLD_PX = 56;
const ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX = 24;
const FALLBACK_THINKING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"];

export default function ThreadPageClient({ params }: Props) {
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
  const initialThreadReadyRef = useRef(false);
  const previousThreadIdRef = useRef("");
  const activeThreadIdRef = useRef("");
  const snapshotSyncInFlightThreadRef = useRef<string | null>(null);
  // Highest events_log seq known from the latest applied snapshot. The SSE
  // resumes from here and sidebar status is only mutated by events past it, so
  // the historical backlog replay can't re-flip a settled row to "Running".
  const snapshotHeadSeqRef = useRef(0);
  // Until the first authoritative snapshot lands, SSE events still feed the
  // event store (so early pre-snapshot turns aren't lost) but must NOT touch
  // the sidebar — applyThreadSnapshot rebuilds it from the authoritative list.
  const firstSnapshotAppliedRef = useRef(false);
  const forceEventSourceReconnectRef = useRef<(() => void) | null>(null);
  const resolvedApprovalIdsRef = useRef<Set<string>>(new Set());
  const resolvedInteractionIdsRef = useRef<Set<string>>(new Set());
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [threadEventStore, dispatchThreadEventStore] = useReducer(
    threadEventStoreReducer,
    createThreadEventStoreState(),
  );
  const threadEventStoreRef = useRef(threadEventStore);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [lastEventAtMs, setLastEventAtMs] = useState<number>(Date.now());
  const [prompt, setPrompt] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [thinkingEffort, setThinkingEffort] = useState<string>("high");
  const [collaborationMode, setCollaborationMode] = useState<CollaborationModeKind>("default");
  const [permissionMode, setPermissionMode] = useState<TurnPermissionMode>(() => {
    if (typeof window === "undefined") return "auto";
    const saved = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (saved === "local" || saved === "auto" || saved === "full-access") return saved;
    return "auto";
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Optimistic in-flight turn: from the moment the user hits send until the
  // server's turn/started + user_message events arrive over SSE. Without this
  // the mobile UI sat blank for 0.5–3s with no feedback.
  const [pendingNewTurn, setPendingNewTurn] = useState<{
    id: string;
    userText: string;
    startedAt: string;
  } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApprovalCard>>({});
  const [pendingInteractions, setPendingInteractions] = useState<
    Record<string, PendingInteractionCard>
  >({});
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [interactionBusy, setInteractionBusy] = useState<string | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<ThreadControlRequest["action"] | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [compactBusy, setCompactBusy] = useState(false);
  const [threadList, setThreadList] = useState<ThreadListItem[]>([]);
  const [threadListLoading, setThreadListLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isThreadSwitcherOpen, setIsThreadSwitcherOpen] = useState(false);
  const [switcherCollapsedGroups, setSwitcherCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [isControlSheetOpen, setIsControlSheetOpen] = useState(false);
  const [controlSheetSection, setControlSheetSection] = useState<ControlSheetSection>("advanced");
  const [controlSheetSnap, setControlSheetSnap] = useState<ControlSheetSnap>("half");
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);
  const [sheetDragOffsetY, setSheetDragOffsetY] = useState(0);
  const [isMessageDetailsOpen, setIsMessageDetailsOpen] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  // Shared between mobile + desktop. Toggling Views on one viewport stays
  // sticky for the same thread session if the user resizes the window.
  const [viewMode, setViewMode] = useState<ThreadViewMode>("normal");
  const [desktopViewMenuOpen, setDesktopViewMenuOpen] = useState(false);
  const desktopViewMenuRef = useRef<HTMLDivElement | null>(null);
  const desktopFileInputRef = useRef<HTMLInputElement | null>(null);
  const [threadContext, setThreadContext] = useState<ThreadContextResponse | null>(null);
  const gatewayConfig = useGatewayConfig();
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [latestTokenUsage, setLatestTokenUsage] = useState<ThreadTokenUsageSummary | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);

  useEffect(() => {
    threadEventStoreRef.current = threadEventStore;
  }, [threadEventStore]);
  const [planActionByStorageKey, setPlanActionByStorageKey] = useState<
    Record<string, PlanActionState>
  >({});
  const [planActionStorageReadyKey, setPlanActionStorageReadyKey] = useState("");
  const [desktopDockTab, setDesktopDockTab] = useState<"questions" | "approvals">("questions");
  const [desktopQuestionDrafts, setDesktopQuestionDrafts] = useState<InteractionQuestionDrafts>(
    {},
  );
  const [canvasOpenRequestKey, setCanvasOpenRequestKey] = useState(0);
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
  const [implementDraft, setImplementDraft] = useState("");
  const [implementTargetTurnId, setImplementTargetTurnId] = useState<string | null>(null);
  const [implementTargetPlanText, setImplementTargetPlanText] = useState<string | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const slashSuggestions = useMemo(
    () => (slashMenuDismissed ? [] : getSlashSuggestions(prompt)),
    [prompt, slashMenuDismissed],
  );
  const slashMenuOpen = slashSuggestions.length > 0;
  const [fileMentionDismissed, setFileMentionDismissed] = useState(false);
  const fileMentionSearch = useFileMentionSearch(
    prompt,
    threadContext?.resolvedCwd ?? null,
    fileMentionDismissed || slashMenuOpen,
  );
  const fileMentionOpen = fileMentionSearch.trigger !== null && !slashMenuOpen;

  const handleEnterMobileViewport = useCallback(() => {
    setIsThreadSwitcherOpen(false);
    setIsMessageDetailsOpen(false);
  }, []);
  const handleExitMobileViewport = useCallback(() => {
    setIsThreadSwitcherOpen(false);
    setIsControlSheetOpen(false);
    setIsMessageDetailsOpen(false);
  }, []);
  const {
    isMobileViewport,
    isCompactViewport,
    terminalOpen,
    setTerminalOpen,
    terminalWidth,
    terminalEnabled,
    sidebarVisible,
    workspaceStyle,
    handleTerminalResizeStart,
  } = useThreadViewportShell({
    sidebarOpen,
    onEnterMobile: handleEnterMobileViewport,
    onExitMobile: handleExitMobileViewport,
  });

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
    const options: ModelSelectOption[] = [];
    for (const entry of modelCatalog) {
      const value = entry.model || entry.id;
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      options.push({
        value,
        label: entry.displayName ?? value,
        isDefault: value === DEFAULT_MODEL || entry.isDefault === true,
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
    let cancelled = false;
    params.then((value) => {
      if (!cancelled) {
        setThreadId(value.id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    activeThreadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    if (!initialThreadReadyRef.current) {
      initialThreadReadyRef.current = true;
      previousThreadIdRef.current = threadId;
      snapshotHeadSeqRef.current = 0;
      firstSnapshotAppliedRef.current = false;
      dispatchThreadEventStore({ type: "reset", threadId });
      return;
    }

    if (threadId === previousThreadIdRef.current) {
      return;
    }

    previousThreadIdRef.current = threadId;
    resolvedApprovalIdsRef.current = new Set();
    resolvedInteractionIdsRef.current = new Set();
    modeInitializedRef.current = false;
    statusQueryHandledRef.current = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    // Drop the previous thread's resolved cwd as soon as the route changes,
    // UNLESS we already seeded the context for this thread (e.g. createThread
    // optimistically set the cwd it just asked the gateway for). Without the
    // reset, the new thread's first turn picks up the OLD thread's cwd via
    // submitTurnText's threadContext fallback and the turn fires in the
    // wrong project. The optimistic seed protects against the inverse race —
    // /context is slower than the user's first keystroke after creating
    // a thread in another project.
    setThreadContext((prev) => (prev?.threadId === threadId ? prev : null));
    snapshotHeadSeqRef.current = 0;
    firstSnapshotAppliedRef.current = false;
    dispatchThreadEventStore({ type: "reset", threadId });
    setConnectionState("connecting");
    setLastEventAtMs(Date.now());
    setLatestTokenUsage(null);
    setStatusBanner(null);
    setIsControlSheetOpen(false);
    setIsDraggingSheet(false);
    setSheetDragOffsetY(0);
    setIsMessageDetailsOpen(false);
    setActiveMessageId(null);
    setPendingApprovals({});
    setPendingInteractions({});
    setApprovalBusy(null);
    setApprovalError(null);
    setInteractionBusy(null);
    setInteractionError(null);
    setControlBusy(null);
    setControlError(null);
    setSubmitError(null);
    setSubmitting(false);
    setPendingNewTurn(null);
    setDesktopDockTab("questions");
    setDesktopQuestionDrafts({});
    setPlanActionByStorageKey({});
    setPlanActionStorageReadyKey("");
    setImplementDialogOpen(false);
    setImplementDraft("");
    setImplementTargetTurnId(null);
    setImplementTargetPlanText(null);
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
    const savedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
    const defaultMigration = window.localStorage.getItem(MODEL_DEFAULT_MIGRATION_STORAGE_KEY);
    if (shouldRestoreSavedModel(savedModel, defaultMigration)) {
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

    const preferredDefault = preferredModelOption(modelOptions);
    if (preferredDefault) {
      setModel(preferredDefault.value);
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
    window.localStorage.setItem(MODEL_DEFAULT_MIGRATION_STORAGE_KEY, DEFAULT_MODEL);
  }, [model]);

  useEffect(() => {
    window.localStorage.setItem(THINKING_EFFORT_STORAGE_KEY, thinkingEffort);
  }, [thinkingEffort]);

  const applyThreadSnapshot = useCallback((requestThreadId: string, snapshot: ThreadSnapshot) => {
    if (activeThreadIdRef.current !== requestThreadId) {
      return;
    }

    const headSeq = snapshot.timeline.lastSeq ?? 0;
    snapshotHeadSeqRef.current = headSeq;

    setDetail(snapshot.data);
    setThreadListLoading(false);
    setThreadList(() => {
      // The snapshot list is authoritative as of headSeq. Only fold in
      // genuinely-newer live events (seq > headSeq): everything up to headSeq
      // is already reflected, and replaying the historical backlog here is
      // exactly what used to strand a completed thread on "Running".
      const liveEventsAfterSnapshot =
        threadEventStoreRef.current.liveThreadListEvents.filter(
          (event) => event.seq > headSeq,
        );
      return liveEventsAfterSnapshot.reduce(
        (items, event) =>
          items.map((item) => threadListItemFromGatewayEvent(item, event)),
        snapshot.threadListResult.data,
      );
    });
    setThreadContext(snapshot.context);
    setPendingApprovals((prev) => {
      const next: Record<string, PendingApprovalCard> = {};
      for (const item of snapshot.pending.data) {
        if (!resolvedApprovalIdsRef.current.has(item.approvalId)) {
          next[item.approvalId] = item;
        }
      }
      for (const [approvalId, item] of Object.entries(prev)) {
        if (!resolvedApprovalIdsRef.current.has(approvalId)) {
          next[approvalId] = item;
        }
      }
      return next;
    });
    setPendingInteractions((prev) => {
      const next: Record<string, PendingInteractionCard> = {};
      for (const item of snapshot.pendingInteractionsResult.data) {
        if (!resolvedInteractionIdsRef.current.has(item.interactionId)) {
          next[item.interactionId] = item;
        }
      }
      for (const [interactionId, item] of Object.entries(prev)) {
        if (!resolvedInteractionIdsRef.current.has(interactionId)) {
          next[interactionId] = item;
        }
      }
      return next;
    });
    dispatchThreadEventStore({
      type: "hydrateTimeline",
      threadId: requestThreadId,
      items: snapshot.timeline.data,
      lastSeq: headSeq,
    });
    setLoading(false);
    setError(null);
    firstSnapshotAppliedRef.current = true;
  }, []);

  const syncThreadSnapshot = useCallback(async () => {
    if (!threadId || snapshotSyncInFlightThreadRef.current === threadId) {
      return;
    }

    const requestThreadId = threadId;
    snapshotSyncInFlightThreadRef.current = requestThreadId;
    try {
      const snapshot = await fetchThreadSnapshot(gatewayUrl, requestThreadId);
      applyThreadSnapshot(requestThreadId, snapshot);
    } catch {
      if (activeThreadIdRef.current === requestThreadId) {
        setConnectionState("lagging");
      }
    } finally {
      if (snapshotSyncInFlightThreadRef.current === requestThreadId) {
        snapshotSyncInFlightThreadRef.current = null;
      }
    }
  }, [applyThreadSnapshot, threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const snapshot = await fetchThreadSnapshot(gatewayUrl, threadId);
        if (!cancelled) {
          applyThreadSnapshot(threadId, snapshot);
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
  }, [applyThreadSnapshot, threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let currentSince = 0;
    let es: EventSource | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const closeEventSource = () => {
      es?.close();
      es = null;
    };

    const scheduleReconnect = () => {
      if (stopped) {
        return;
      }
      clearRetryTimer();
      const delay = Math.min(10_000, 800 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      retryTimer = setTimeout(() => connect(true), delay);
    };

    const connect = (isRetry: boolean) => {
      if (stopped) {
        return;
      }
      closeEventSource();
      setConnectionState(isRetry ? "reconnecting" : "connecting");

      // Resume from the snapshot head once it is known so the gateway never
      // replays the historical backlog. Forward-only: a live event already
      // consumed must not be re-requested.
      currentSince = Math.max(currentSince, snapshotHeadSeqRef.current);
      es = new EventSource(`${gatewayUrl}/api/threads/${threadId}/events?since=${currentSince}`);

      es.addEventListener("gateway", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as GatewayEvent;
        if (stopped || payload.threadId !== threadId) {
          return;
        }
        if (payload.seq <= currentSince) {
          return;
        }
        currentSince = payload.seq;
        dispatchThreadEventStore({ type: "appendGatewayEvent", event: payload });
        // Only genuinely-live events (past the snapshot head, and only once
        // the authoritative snapshot has rebuilt the list) may move a sidebar
        // row's status. Race-proof against a since=0 connection that beat the
        // snapshot: backlog events stay <= head and pre-snapshot events are
        // held back entirely.
        if (firstSnapshotAppliedRef.current && payload.seq > snapshotHeadSeqRef.current) {
          setThreadList((prev) =>
            prev.map((item) => threadListItemFromGatewayEvent(item, payload)),
          );
        }
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
            resolvedApprovalIdsRef.current.add(approvalId);
            setPendingApprovals((prev) => {
              if (!prev[approvalId]) {
                return prev;
              }
              const next = { ...prev };
              delete next[approvalId];
              return next;
            });
          }
        } else if (
          payload.name === "interaction/responded" ||
          payload.name === "interaction/cancelled"
        ) {
          const interactionPayload = asRecord(payload.payload);
          const interactionId = readString(interactionPayload, "interactionId");
          if (interactionId) {
            resolvedInteractionIdsRef.current.add(interactionId);
            setPendingInteractions((prev) => {
              if (!prev[interactionId]) {
                return prev;
              }
              const next = { ...prev };
              delete next[interactionId];
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
        } else if (payload.kind === "interaction") {
          const interaction = interactionFromEvent(payload);
          if (interaction) {
            setPendingInteractions((prev) => ({
              ...prev,
              [interaction.interactionId]: interaction,
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
        closeEventSource();
        scheduleReconnect();
      };
    };

    const reconnectNow = () => {
      if (stopped) {
        return;
      }
      clearRetryTimer();
      reconnectAttempt = 0;
      setConnectionState("reconnecting");
      closeEventSource();
      connect(true);
    };

    forceEventSourceReconnectRef.current = reconnectNow;
    connect(false);

    return () => {
      stopped = true;
      clearRetryTimer();
      if (forceEventSourceReconnectRef.current === reconnectNow) {
        forceEventSourceReconnectRef.current = null;
      }
      closeEventSource();
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
        forceEventSourceReconnectRef.current?.();
        void syncThreadSnapshot();
      } else if (connectionState === "lagging") {
        setConnectionState("connected");
      }
    }, 4_000);

    return () => {
      clearInterval(timer);
    };
  }, [connectionState, lastEventAtMs, syncThreadSnapshot]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let lastVisibleRecoveryAt = 0;
    const syncWhenVisible = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      if (now - lastVisibleRecoveryAt < 1_000) {
        return;
      }
      lastVisibleRecoveryAt = now;
      void syncThreadSnapshot();
      forceEventSourceReconnectRef.current?.();
    };

    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("focus", syncWhenVisible);
    window.addEventListener("online", syncWhenVisible);

    return () => {
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("focus", syncWhenVisible);
      window.removeEventListener("online", syncWhenVisible);
    };
  }, [syncThreadSnapshot, threadId]);

  const connectionText = useMemo(() => {
    if (connectionState === "connected") return "Connected";
    if (connectionState === "reconnecting") return "Reconnecting";
    if (connectionState === "lagging") return "Lagging";
    return "Connecting";
  }, [connectionState]);

  const lastSeq = threadEventStore.lastSeq;
  const allTimelineItems = useMemo(
    () => selectThreadTimelineItems(threadEventStore),
    [threadEventStore],
  );
  const allConversationTurns = useMemo(
    () => selectConversationTurns(threadEventStore, detail?.turns ?? []),
    [detail?.turns, threadEventStore],
  );
  const reviewSlashCommandByTurnId = useMemo(() => {
    const commandByTurnId = new Map<string, string>();
    for (const item of allTimelineItems) {
      const normalizedRawType = item.rawType.replace(/_/g, "").toLowerCase();
      if (!item.turnId || normalizedRawType !== "enteredreviewmode") {
        continue;
      }
      const reviewArgs = item.text?.trim() ?? "";
      commandByTurnId.set(item.turnId, reviewArgs.length > 0 ? `/review ${reviewArgs}` : "/review");
    }
    return commandByTurnId;
  }, [allTimelineItems]);
  const activeThread = threadList.find((thread) => thread.id === threadId);
  const groupedThreads = useMemo(() => groupThreadsByProject(threadList), [threadList]);
  const mobileThreadSwitcherGroups = useMemo<MobileThreadSwitcherGroup[]>(
    () =>
      groupedThreads.map((group) => ({
        key: group.key,
        label: group.label,
        items: group.threads.map((thread) => ({
          id: thread.id,
          title: thread.title || "(untitled thread)",
          lastActiveAt: thread.lastActiveAt,
          isActive: thread.id === threadId,
          status: thread.status,
          waitingApprovalCount: thread.waitingApprovalCount,
          errorCount: thread.errorCount,
        })),
      })),
    [groupedThreads, threadId],
  );
  // Desktop sidebar reuses the same switcher group shape as the mobile drawer
  // but keeps preview text alongside so the row body looks the same as before.
  // Stored as Map<projectKey, Map<threadId, preview>> so the JSX can look up
  // the preview without re-traversing groupedThreads inside each map().
  const threadPreviewById = useMemo<Map<string, Map<string, string>>>(() => {
    const result = new Map<string, Map<string, string>>();
    for (const group of groupedThreads) {
      const inner = new Map<string, string>();
      for (const thread of group.threads) {
        inner.set(thread.id, thread.preview ?? "");
      }
      result.set(group.key, inner);
    }
    return result;
  }, [groupedThreads]);
  const {
    sidebarSearchQuery,
    setSidebarSearchQuery,
    sidebarStatusFilter,
    setSidebarStatusFilter,
    sidebarFilteredGroups,
    sidebarListIsEmpty,
    sidebarEmptyMessage,
  } = useThreadSidebarFilterController({
    switcherGroups: mobileThreadSwitcherGroups,
  });
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
  const activeInteraction = useMemo(
    () =>
      Object.values(pendingInteractions).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0] ?? null,
    [pendingInteractions],
  );
  const pendingApprovalList = useMemo(
    () =>
      Object.values(pendingApprovals)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((item) => ({
          approvalId: item.approvalId,
          type: item.type,
          reason: item.reason,
          commandPreview: item.commandPreview,
          fileChangePreview: item.fileChangePreview,
        })),
    [pendingApprovals],
  );
  const pendingInteractionList = useMemo(
    () =>
      Object.values(pendingInteractions)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((item) => ({
          interactionId: item.interactionId,
          questions: item.questions,
        })),
    [pendingInteractions],
  );
  const planReadyByTurnId = useMemo(() => {
    // ONLY a real <proposed_plan> tag (in the assistant message or thinking)
    // means "I'm proposing a plan, please approve to implement". The
    // turn/plan/updated event is Codex's own in-flight todo tracking — it
    // belongs in turnProgressByTurnId, NOT here. Treating progress as a
    // proposal means clicking "Implement this plan" steers the conversation
    // with "Implement this plan: [completed] step1, [inProgress] step2 …"
    // which asks Codex to redo work it's currently doing.
    const result: Record<string, string> = {};
    for (const turn of allConversationTurns) {
      const plan =
        proposedPlanFromText(turn.assistantText) ??
        proposedPlanFromText(turn.thinkingText) ??
        null;
      if (!plan) {
        continue;
      }
      result[turn.turnId] = plan;
    }
    return result;
  }, [allConversationTurns]);

  const implementedPlanReadyByTurnId = useMemo(() => {
    const result: Record<string, boolean> = {};
    const turnIndexById = new Map(
      allConversationTurns.map((turn, index) => [turn.turnId, index] as const),
    );
    for (const [turnId, planText] of Object.entries(planReadyByTurnId)) {
      const planTurnIndex = turnIndexById.get(turnId);
      if (planTurnIndex === undefined) {
        continue;
      }
      const wasImplemented = allConversationTurns
        .slice(planTurnIndex + 1)
        .some((turn) => isImplementPlanPromptForPlan(turn.userText, planText));
      if (wasImplemented) {
        result[turnId] = true;
      }
    }
    return result;
  }, [allConversationTurns, planReadyByTurnId]);

  const planActionStorageReadinessKey = useMemo(() => {
    if (!threadId) {
      return "";
    }
    return Object.entries(planReadyByTurnId)
      .sort(([leftTurnId], [rightTurnId]) => leftTurnId.localeCompare(rightTurnId))
      .map(([turnId, planText]) => planActionStorageKey(threadId, turnId, planText))
      .join("|");
  }, [planReadyByTurnId, threadId]);

  useEffect(() => {
    if (!threadId) {
      setPlanActionStorageReadyKey("");
      return;
    }

    setPlanActionByStorageKey((previous) => {
      const next: Record<string, PlanActionState> = {};
      for (const [turnId, planText] of Object.entries(planReadyByTurnId)) {
        const key = planActionStorageKey(threadId, turnId, planText);
        let stored: string | null = null;
        try {
          stored = window.localStorage.getItem(key);
        } catch {
          stored = null;
        }
        if (isStoredPlanAction(stored)) {
          next[key] = stored;
        } else if (previous[key]) {
          next[key] = previous[key];
        }
      }
      return next;
    });
    setPlanActionStorageReadyKey(planActionStorageReadinessKey);
  }, [planActionStorageReadinessKey, threadId, planReadyByTurnId]);

  const actionablePlanByTurnId = useMemo(() => {
    const result: Record<string, string> = {};
    const storageReady = !threadId || planActionStorageReadyKey === planActionStorageReadinessKey;
    for (const [turnId, planText] of Object.entries(planReadyByTurnId)) {
      if (implementedPlanReadyByTurnId[turnId]) {
        continue;
      }
      if (!storageReady) {
        continue;
      }
      const storageKey = threadId ? planActionStorageKey(threadId, turnId, planText) : turnId;
      if (planActionByStorageKey[storageKey]) {
        continue;
      }
      result[turnId] = planText;
    }
    return result;
  }, [
    implementedPlanReadyByTurnId,
    planActionByStorageKey,
    planActionStorageReadyKey,
    planActionStorageReadinessKey,
    planReadyByTurnId,
    threadId,
  ]);

  // Per-turn in-flight task checklist (latest snapshot of turn/plan/updated).
  // Rendered as a non-actionable progress box — distinct from a Plan-ready
  // CTA. Updated live as Codex marks items completed.
  const turnProgressByTurnId = useMemo(() => {
    const result: Record<string, string> = {};
    for (const item of allTimelineItems) {
      if (item.rawType !== "turn/plan/updated" || !item.turnId || !item.text) {
        continue;
      }
      // Latest update wins (allTimelineItems is ts-sorted).
      result[item.turnId] = item.text;
    }
    return result;
  }, [allTimelineItems]);
  const visibleConversationTurns = useMemo(() => {
    const latestTurns = showAllTurns ? allConversationTurns : allConversationTurns.slice(-120);
    const base = showAllTurns
      ? latestTurns
      : [
          ...allConversationTurns.filter(
            (turn) =>
              Boolean(actionablePlanByTurnId[turn.turnId]) &&
              !latestTurns.some((candidate) => candidate.turnId === turn.turnId),
          ),
          ...latestTurns,
        ];

    if (!pendingNewTurn) {
      return base;
    }
    // Drop the optimistic bubble once the gateway's user_message item lands
    // — the real turn now carries the same text and we don't want a duplicate.
    const pendingMatchesReal = base.some(
      (turn) =>
        (turn.isStreaming && turn.userText === pendingNewTurn.userText) ||
        (!pendingNewTurn.id.startsWith("pending-") && turn.turnId === pendingNewTurn.id),
    );
    if (pendingMatchesReal) {
      return base;
    }
    const optimisticTurn: ConversationTurn = {
      turnId: pendingNewTurn.id,
      startedAt: pendingNewTurn.startedAt,
      completedAt: null,
      status: "inProgress",
      isStreaming: true,
      userText: pendingNewTurn.userText,
      assistantText: null,
      thinkingText: null,
      toolCalls: [],
      toolResults: [],
      details: [],
      segments: [
        {
          kind: "user",
          ts: pendingNewTurn.startedAt,
          text: pendingNewTurn.userText,
          isSteer: false,
        },
      ],
    };
    return [...base, optimisticTurn];
  }, [actionablePlanByTurnId, allConversationTurns, pendingNewTurn, showAllTurns]);

  // Clear the optimistic turn as soon as the real SSE stream confirms the
  // same turn. A user_message with matching text is the full replacement; any
  // event for the POST-confirmed turn id is enough to hand the running state
  // to the live timeline and avoid a duplicate placeholder.
  useEffect(() => {
    if (!pendingNewTurn) return;
    const matched = allTimelineItems.some(
      (item) =>
        (item.type === "userMessage" &&
          item.text === pendingNewTurn.userText &&
          item.ts > pendingNewTurn.startedAt) ||
        (!pendingNewTurn.id.startsWith("pending-") && item.turnId === pendingNewTurn.id),
    );
    if (matched) {
      setPendingNewTurn(null);
    }
  }, [allTimelineItems, pendingNewTurn]);

  // Defensive timeout — if the SSE event never arrives (network, gateway
  // hiccup), clear after 30s so the bubble doesn't ghost.
  useEffect(() => {
    if (!pendingNewTurn) return;
    const handle = setTimeout(() => {
      setPendingNewTurn((prev) => (prev?.id === pendingNewTurn.id ? null : prev));
    }, 30000);
    return () => clearTimeout(handle);
  }, [pendingNewTurn]);
  const hiddenTimelineCount = Math.max(0, allConversationTurns.length - visibleConversationTurns.length);
  const pendingActionCount = pendingApprovalList.length + pendingInteractionList.length;
  const canvasBlocked =
    pendingActionCount > 0 ||
    isControlSheetOpen ||
    isMessageDetailsOpen ||
    implementDialogOpen;

  // Pending approval / interaction is the most-foreground UI on mobile.
  // While the action layer is now stacked above the drawer in CSS, we still
  // collapse the drawer when something pending arrives so the user lands
  // straight on the Allow/Deny/Answer affordance instead of having to
  // dismiss the drawer first.
  useEffect(() => {
    if (pendingActionCount > 0) {
      setIsThreadSwitcherOpen(false);
    }
  }, [pendingActionCount]);
  const latestStreamingTurn = useMemo(() => {
    for (let index = visibleConversationTurns.length - 1; index >= 0; index -= 1) {
      const candidate = visibleConversationTurns[index];
      // The optimistic pending turn flags itself as streaming so the bubble
      // renders, but it isn't a real running turn — exclude it so steer /
      // interrupt / Stop button only fire against real SSE-confirmed turns.
      if (candidate?.isStreaming && !candidate.turnId.startsWith("pending-")) {
        return candidate;
      }
    }
    return null;
  }, [visibleConversationTurns]);
  const streamingTurnCount = useMemo(
    () =>
      visibleConversationTurns.filter(
        (turn) => turn.isStreaming && !turn.turnId.startsWith("pending-"),
      ).length,
    [visibleConversationTurns],
  );
  const isThinkingActive = submitting || streamingTurnCount > 0;
  const runningTurnId = latestStreamingTurn?.turnId ?? null;
  const selectedModelLabel = useMemo(
    () => modelOptions.find((option) => option.value === model)?.label ?? model,
    [model, modelOptions],
  );
  const permissionModeLabel =
    permissionMode === "local"
      ? "Local"
      : permissionMode === "full-access"
        ? "Full access"
        : "Auto review";
  const shortCwdLabel = useMemo(() => {
    const resolved = threadContext?.resolvedCwd;
    if (!resolved || threadContext?.isFallback) {
      return "cwd unknown";
    }
    const parts = resolved.split("/").filter(Boolean);
    if (parts.length <= 2) {
      return resolved;
    }
    return `.../${parts.slice(-2).join("/")}`;
  }, [threadContext]);

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
    activeInteraction?.interactionId,
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

  useEffect(() => {
    if (pendingInteractionList.length > 0) {
      setDesktopDockTab("questions");
      return;
    }
    if (pendingApprovalList.length > 0) {
      setDesktopDockTab("approvals");
    }
  }, [pendingApprovalList.length, pendingInteractionList.length]);

  const updateDesktopQuestionDraft = useCallback(
    (
      interactionId: string,
      questionId: string,
      updater: Parameters<typeof updateInteractionQuestionDrafts>[3],
    ) => {
      setDesktopQuestionDrafts((prev) =>
        updateInteractionQuestionDrafts(prev, interactionId, questionId, updater),
      );
    },
    [],
  );

  const answersForDesktopInteraction = useCallback(
    (
      interaction: PendingInteractionCard,
    ): InteractionRespondRequest["answers"] | null => {
      return answersForInteractionQuestions(
        desktopQuestionDrafts,
        interaction.interactionId,
        interaction.questions,
      );
    },
    [desktopQuestionDrafts],
  );

  // Shared by the mobile switcher overlay and the desktop sidebar so a project
  // folder collapsed on one viewport stays collapsed on the other (collapse is
  // never reset, unlike search/filter which are intentionally per-viewport).
  const handleToggleSwitcherGroup = useCallback((groupKey: string) => {
    setSwitcherCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  // Desktop has no persistent context indicator (mobile shows a ring in the
  // composer); surface the same numbers in the desktop status row.
  const desktopContextUsage = useMemo(
    () =>
      contextUsageSummary(
        latestTokenUsage
          ? {
              totalTokens: latestTokenUsage.totalTokens,
              lastTokens: latestTokenUsage.lastTokens,
              modelContextWindow: latestTokenUsage.modelContextWindow,
            }
          : null,
      ),
    [latestTokenUsage],
  );

  async function createThread(targetProjectKey?: string): Promise<void> {
    const projectKey = targetProjectKey ?? activeProjectKey;
    try {
      const body = projectKey && projectKey !== "unknown" ? { cwd: projectKey } : {};
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
      // Seed threadContext for the new thread synchronously so that the
      // user's first turn submit before /context comes back still carries the
      // right cwd. The reset effect on threadId change keeps this seed
      // because prev.threadId matches the new route.
      if (projectKey && projectKey !== "unknown") {
        setThreadContext({
          threadId: payload.threadId,
          cwd: projectKey,
          resolvedCwd: projectKey,
          isFallback: false,
          source: "projection",
        });
      }
      router.push(`/threads/${payload.threadId}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "create thread failed");
    }
  }

  const openImplementDialog = useCallback((turnId: string, planText: string) => {
    setImplementTargetTurnId(turnId);
    setImplementTargetPlanText(planText);
    setImplementDraft(implementPlanPrompt(planText));
    setImplementDialogOpen(true);
  }, []);

  async function decideApproval(
    approvalId: string,
    decision: ApprovalDecisionRequest["decision"],
  ): Promise<void> {
    if (!threadId || approvalBusy) {
      return;
    }

    const requestThreadId = threadId;
    setApprovalBusy(approvalId);
    setApprovalError(null);

    try {
      const res = await fetch(
        `${gatewayUrl}/api/threads/${requestThreadId}/approvals/${approvalId}`,
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

      if (activeThreadIdRef.current !== requestThreadId) {
        return;
      }

      resolvedApprovalIdsRef.current.add(approvalId);
      setPendingApprovals((prev) => {
        if (!prev[approvalId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
    } catch (approvalErr) {
      if (activeThreadIdRef.current === requestThreadId) {
        setApprovalError(
          approvalErr instanceof Error ? approvalErr.message : "approval failed",
        );
      }
    } finally {
      if (activeThreadIdRef.current === requestThreadId) {
        setApprovalBusy(null);
      }
    }
  }

  async function respondInteraction(
    interactionId: string,
    answers: InteractionRespondRequest["answers"],
  ): Promise<void> {
    if (!threadId || interactionBusy) {
      return;
    }

    const requestThreadId = threadId;
    setInteractionBusy(interactionId);
    setInteractionError(null);
    try {
      const res = await fetch(
        `${gatewayUrl}/api/threads/${requestThreadId}/interactions/${interactionId}/respond`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            answers,
          } satisfies InteractionRespondRequest),
        },
      );
      if (!res.ok) {
        throw new Error(`interaction http ${res.status}`);
      }
      if (activeThreadIdRef.current !== requestThreadId) {
        return;
      }
      resolvedInteractionIdsRef.current.add(interactionId);
      setPendingInteractions((prev) => {
        if (!prev[interactionId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[interactionId];
        return next;
      });
    } catch (interactionErr) {
      if (activeThreadIdRef.current === requestThreadId) {
        setInteractionError(
          interactionErr instanceof Error ? interactionErr.message : "interaction failed",
        );
      }
    } finally {
      if (activeThreadIdRef.current === requestThreadId) {
        setInteractionBusy(null);
      }
    }
  }

  const steerRunningTurn = useCallback(
    async (expectedTurnId: string, text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!threadId || !expectedTurnId || trimmed.length === 0 || submitting) {
        return false;
      }
      const requestThreadId = threadId;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await fetch(
          `${gatewayUrl}/api/threads/${requestThreadId}/steer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedTurnId,
              input: [{ type: "text", text: trimmed }],
            }),
          },
        );
        if (!res.ok) {
          throw new Error(`steer http ${res.status}`);
        }
        return true;
      } catch (err) {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitError(err instanceof Error ? err.message : "steer failed");
        }
        return false;
      } finally {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitting(false);
        }
      }
    },
    [submitting, threadId],
  );

  const interruptRunningTurn = useCallback(async (turnId: string): Promise<void> => {
    if (!threadId || !turnId || controlBusy) {
      return;
    }
    const requestThreadId = threadId;
    setControlBusy("stop");
    setControlError(null);
    try {
      const res = await fetch(`${gatewayUrl}/api/threads/${requestThreadId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      if (!res.ok) {
        throw new Error(`interrupt http ${res.status}`);
      }
    } catch (err) {
      if (activeThreadIdRef.current === requestThreadId) {
        setControlError(err instanceof Error ? err.message : "interrupt failed");
      }
    } finally {
      if (activeThreadIdRef.current === requestThreadId) {
        setControlBusy(null);
      }
    }
  }, [controlBusy, threadId]);

  const sendControl = useCallback(async (action: ThreadControlRequest["action"]): Promise<void> => {
    if (!threadId || controlBusy) {
      return;
    }

    const requestThreadId = threadId;
    setControlBusy(action);
    setControlError(null);

    try {
      const res = await fetch(`${gatewayUrl}/api/threads/${requestThreadId}/control`, {
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
      if (activeThreadIdRef.current === requestThreadId) {
        setControlError(controlErr instanceof Error ? controlErr.message : "control failed");
      }
    } finally {
      if (activeThreadIdRef.current === requestThreadId) {
        setControlBusy(null);
      }
    }
  }, [controlBusy, threadId]);

  const compactThread = useCallback(async (): Promise<void> => {
    if (!threadId || compactBusy) {
      return;
    }

    const requestThreadId = threadId;
    setCompactBusy(true);
    setControlError(null);

    try {
      // Send an explicit {} body (not no body): the application/json header
      // keeps this mutating POST a non-simple request, so the browser must
      // preflight it and the gateway's CORS origin allowlist still gates the
      // side effect. An empty body under that header would trip Fastify's
      // JSON parser ("Body cannot be empty..."), so {} is the minimum that
      // satisfies the parser without weakening the origin boundary.
      const res = await fetch(`${gatewayUrl}/api/threads/${requestThreadId}/compact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `compact http ${res.status}`);
      }
    } catch (compactErr) {
      if (activeThreadIdRef.current === requestThreadId) {
        setControlError(compactErr instanceof Error ? compactErr.message : "compact failed");
      }
    } finally {
      if (activeThreadIdRef.current === requestThreadId) {
        setCompactBusy(false);
      }
    }
  }, [compactBusy, threadId]);

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
      if (isMessageDetailsOpen) {
        event.preventDefault();
        setIsMessageDetailsOpen(false);
        setActiveMessageId(null);
        return;
      }
      if (implementDialogOpen) {
        event.preventDefault();
        setImplementDialogOpen(false);
        return;
      }
      if (isControlSheetOpen) {
        event.preventDefault();
        setSheetDragOffsetY(0);
        setIsDraggingSheet(false);
        setIsControlSheetOpen(false);
        return;
      }
      if (isThreadSwitcherOpen) {
        event.preventDefault();
        setIsThreadSwitcherOpen(false);
        return;
      }
      event.preventDefault();
      void sendControl("stop");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    isControlSheetOpen,
    implementDialogOpen,
    isMessageDetailsOpen,
    isThreadSwitcherOpen,
    sendControl,
  ]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobileViewport) {
      setIsThreadSwitcherOpen((value) => !value);
      return;
    }
    setSidebarOpen((value) => !value);
  }, [isMobileViewport]);

  // Close the desktop Views menu when the user clicks anywhere outside of
  // it. Mirrors the mobile MobileChatTopBar behaviour so the menu doesn't
  // linger after the user has moved on.
  useEffect(() => {
    if (!desktopViewMenuOpen) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (!desktopViewMenuRef.current) return;
      if (!desktopViewMenuRef.current.contains(event.target as Node)) {
        setDesktopViewMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [desktopViewMenuOpen]);

  const selectThreadFromMobileSwitcher = useCallback(
    (nextThreadId: string) => {
      setIsThreadSwitcherOpen(false);
      if (nextThreadId === threadId) {
        return;
      }
      router.push(`/threads/${nextThreadId}`);
    },
    [router, threadId],
  );

  const toggleCollaborationMode = useCallback((): CollaborationModeKind => {
    const nextMode: CollaborationModeKind = collaborationMode === "plan" ? "default" : "plan";
    applyCollaborationMode(nextMode);
    return nextMode;
  }, [applyCollaborationMode, collaborationMode]);

  const handlePickFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      const queued: Array<Extract<PendingAttachment, { status: "uploading" }>> = files.map((file) => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`,
        status: "uploading",
        previewUrl: URL.createObjectURL(file),
        file,
      }));
      setPendingAttachments((prev) => [...prev, ...queued]);

      try {
        const results = await uploadAttachments(gatewayUrl, files);
        setPendingAttachments((prev) =>
          prev.map((att) => {
            const idx = queued.findIndex((q) => q.id === att.id);
            if (idx === -1) return att;
            const result = results[idx];
            if (!result) {
              return {
                id: att.id,
                status: "error",
                previewUrl: att.previewUrl,
                reason: "upload response missing entry",
              };
            }
            return {
              id: att.id,
              status: "ready",
              previewUrl: att.previewUrl,
              gatewayPath: result.path,
              mimeType: result.mimeType,
              originalName: result.originalName,
            };
          }),
        );
      } catch (err) {
        const reason =
          err instanceof UploadClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "upload failed";
        setPendingAttachments((prev) =>
          prev.map((att) =>
            queued.some((q) => q.id === att.id)
              ? {
                  id: att.id,
                  status: "error",
                  previewUrl: att.previewUrl,
                  reason,
                }
              : att,
          ),
        );
      }
    },
    [],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Desktop composer counterparts to MobileComposerDock's file-input + paste
  // handlers. Same shape — the mobile component owns its own ref so it can't
  // be shared.
  const handleDesktopFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      if (!list || list.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < list.length; i += 1) {
        const file = list[i];
        if (file) files.push(file);
      }
      if (files.length > 0) {
        void handlePickFiles(files);
      }
      event.target.value = "";
    },
    [handlePickFiles],
  );

  const handleDesktopTextareaPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item && item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        void handlePickFiles(files);
      }
    },
    [handlePickFiles],
  );

  const [isComposerDragOver, setIsComposerDragOver] = useState(false);

  const handleComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // Only react to file drags — text-only drags (selection from textarea)
      // should keep their default behavior so users can still rearrange text.
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleComposerDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      setIsComposerDragOver(true);
    },
    [],
  );

  const handleComposerDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // dragenter/leave fire repeatedly as the cursor crosses child elements;
      // only clear the highlight when the drag actually exits the composer.
      const next = event.relatedTarget as Node | null;
      if (!next || !event.currentTarget.contains(next)) {
        setIsComposerDragOver(false);
      }
    },
    [],
  );

  const handleComposerDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      setIsComposerDragOver(false);
      // Steer mode is text-only; drop with no effect (same rule as the
      // Add image button).
      if (runningTurnId !== null) return;
      const dropped = event.dataTransfer.files;
      if (!dropped || dropped.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < dropped.length; i += 1) {
        const file = dropped[i];
        if (file && file.type.startsWith("image/")) files.push(file);
      }
      if (files.length > 0) void handlePickFiles(files);
    },
    [handlePickFiles, runningTurnId],
  );

  const submitTurnText = useCallback(
    async (
      rawText: string,
      modeOverride?: CollaborationModeKind,
    ): Promise<boolean> => {
      const text = rawText.trim();
      const readyAttachments = pendingAttachments.filter(
        (a): a is Extract<PendingAttachment, { status: "ready" }> => a.status === "ready",
      );
      if ((!text && readyAttachments.length === 0) || !threadId || submitting) {
        return false;
      }
      if (pendingAttachments.some((a) => a.status === "uploading")) {
        setSubmitError("Wait for image upload to finish before sending.");
        return false;
      }

      const requestThreadId = threadId;
      setSubmitting(true);
      setSubmitError(null);
      // Optimistic: render the user bubble + topbar working beacon
      // synchronously, without waiting for the POST round-trip and SSE.
      const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticText = text
        || `[${readyAttachments.length} image${readyAttachments.length === 1 ? "" : "s"}]`;
      setPendingNewTurn({
        id: pendingId,
        userText: optimisticText,
        startedAt: new Date().toISOString(),
      });

      try {
        const modeForTurn = modeOverride ?? collaborationMode;
        const options: {
          cwd?: string;
          model: string;
          effort: string;
          permissionMode: TurnPermissionMode;
          collaborationMode?: "plan" | "default";
        } = {
          model,
          effort: thinkingEffort,
          permissionMode,
        };
        // Prefer the cwd the gateway resolved for THIS thread (from its
        // session metadata) over the inferred activeProjectKey. When a thread
        // was just created in a project that hasn't propagated into the global
        // threadList yet, activeProjectKey falls back to whatever the most-
        // recently-active project happens to be — which means the very first
        // turn used to fire in the wrong cwd and Codex would chdir to the
        // wrong project. threadContext.resolvedCwd is per-thread truth and
        // doesn't suffer that race.
        const turnCwd = threadContext?.resolvedCwd && !threadContext.isFallback
          ? threadContext.resolvedCwd
          : activeProjectKey !== "unknown"
            ? activeProjectKey
            : null;
        if (turnCwd) {
          options.cwd = turnCwd;
        }
        // Collaboration mode is SESSION-STICKY on the codex app-server: a turn
        // that omits `collaborationMode` inherits whatever mode the session
        // last committed (see apps/gateway protocol notes). Once a "plan" turn
        // commits Plan into the session, only a turn that explicitly carries
        // "default" can take it back out — omitting the field keeps Plan
        // forever. So send the explicit resolved mode on EVERY turn (it is
        // idempotent; the gateway caches collaborationMode/list support).
        options.collaborationMode = modeForTurn === "plan" ? "plan" : "default";

        const input: UserInputItem[] = [
          ...readyAttachments.map((a) => ({ type: "localImage" as const, path: a.gatewayPath })),
          ...(text ? [{ type: "text" as const, text }] : []),
        ];

        const res = await fetch(`${gatewayUrl}/api/threads/${requestThreadId}/turns`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input,
            options,
          }),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(payload?.message ?? `turn submit http ${res.status}`);
        }

        const payload = (await res.json()) as CreateTurnResponse;
        if (activeThreadIdRef.current !== requestThreadId) {
          return false;
        }
        // The POST response already gives us a real turn id, even if the SSE
        // stream has not delivered turn/started or user_message yet. Promote
        // the optimistic bubble so controls that need a real turn id (steer,
        // stop / running affordances flip from "sending/waiting" to running
        // immediately after the gateway accepts the turn.
        setPendingNewTurn((prev) =>
          prev?.id === pendingId ? { ...prev, id: payload.turnId } : prev,
        );
        if (payload.warnings?.includes("plan_mode_fallback")) {
          setSubmitError("Plan mode unavailable on this app-server; sent in default mode.");
        }
        // Clear ONLY the attachments that were actually sent. Without this
        // narrowing, an attachment the user picks during the POST round-trip
        // gets wiped along with the sent ones — caught by Codex in review.
        const sentAttachmentIds = new Set(readyAttachments.map((a) => a.id));
        setPendingAttachments((current) => {
          const next: PendingAttachment[] = [];
          for (const att of current) {
            if (sentAttachmentIds.has(att.id)) {
              URL.revokeObjectURL(att.previewUrl);
            } else {
              next.push(att);
            }
          }
          return next;
        });
        return true;
      } catch (submitErr) {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitError(submitErr instanceof Error ? submitErr.message : "submit failed");
        }
        // On submit failure, drop the optimistic bubble — otherwise it would
        // sit there forever pretending the turn is in flight.
        setPendingNewTurn((prev) => (prev?.id === pendingId ? null : prev));
        return false;
      } finally {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitting(false);
        }
      }
    },
    [activeProjectKey, collaborationMode, model, pendingAttachments, permissionMode, thinkingEffort, submitting, threadId, threadContext],
  );

  const startReview = useCallback(
    async (instructions?: string): Promise<boolean> => {
      if (!threadId || submitting) {
        return false;
      }
      const requestThreadId = threadId;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const payload: CreateReviewRequest =
          instructions && instructions.trim().length > 0
            ? { instructions: instructions.trim() }
            : {};
        const res = await fetch(`${gatewayUrl}/api/threads/${requestThreadId}/review`, {
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
        if (activeThreadIdRef.current !== requestThreadId) {
          return false;
        }
        return true;
      } catch (reviewErr) {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitError(reviewErr instanceof Error ? reviewErr.message : "review failed");
        }
        return false;
      } finally {
        if (activeThreadIdRef.current === requestThreadId) {
          setSubmitting(false);
        }
      }
    },
    [submitting, threadId],
  );

  const runStatusCommand = useCallback(async (): Promise<boolean> => {
    if (!threadId) {
      return false;
    }
    const requestThreadId = threadId;
    setSubmitError(null);
    try {
      const rateLimitRes = await fetch(`${gatewayUrl}/api/account/rate-limits`);
      if (!rateLimitRes.ok) {
        throw new Error(`rate-limits http ${rateLimitRes.status}`);
      }
      const rateLimitPayload = (await rateLimitRes.json()) as AccountRateLimitsResponse;
      let usageLine = "context: n/a";
      if (latestTokenUsage) {
        const { lastTokens, modelContextWindow, totalTokens, inputTokens, outputTokens } =
          latestTokenUsage;
        const sessionTotal = `session total ${totalTokens} (in ${inputTokens}, out ${outputTokens})`;
        if (lastTokens !== null && modelContextWindow !== null) {
          const remaining = contextWindowPercentRemaining(lastTokens, modelContextWindow);
          usageLine = `context: ${100 - remaining}% used, ${remaining}% left (last ${lastTokens}/${modelContextWindow}) · ${sessionTotal}`;
        } else {
          usageLine = `context: last ${lastTokens ?? "n/a"}, window ${
            modelContextWindow ?? "n/a"
          } · ${sessionTotal}`;
        }
      }
      const banner: StatusBanner = {
        generatedAt: new Date().toISOString(),
        lines: [
          `thread: ${threadId}`,
          usageLine,
          formatRateLimitStatus(rateLimitPayload),
        ],
      };
      if (activeThreadIdRef.current !== requestThreadId) {
        return false;
      }
      setStatusBanner(banner);
      return true;
    } catch (statusErr) {
      if (activeThreadIdRef.current === requestThreadId) {
        setSubmitError(statusErr instanceof Error ? statusErr.message : "status failed");
      }
      return false;
    }
  }, [latestTokenUsage, threadId]);

  const markPlanAction = useCallback(
    (turnId: string, planText: string, action: PlanActionState) => {
      if (!threadId || !planText) {
        return;
      }
      const key = planActionStorageKey(threadId, turnId, planText);
      setPlanActionByStorageKey((prev) => ({
        ...prev,
        [key]: action,
      }));
      try {
        window.localStorage.setItem(key, action);
      } catch {
        // localStorage can be unavailable in private/restricted contexts; the
        // in-memory state still keeps this page from immediately re-showing it.
      }
    },
    [threadId],
  );

  const keepPlanning = useCallback(
    (turnId: string, planText?: string) => {
      const targetPlanText = planText ?? planReadyByTurnId[turnId];
      if (!targetPlanText) {
        return;
      }
      markPlanAction(turnId, targetPlanText, "dismissed");
    },
    [markPlanAction, planReadyByTurnId],
  );

  const confirmImplementPlan = useCallback(async (): Promise<void> => {
    if (!implementDraft.trim()) {
      return;
    }
    const sent = await submitTurnText(implementDraft, "default");
    if (!sent) {
      return;
    }
    applyCollaborationMode("default");
    if (implementTargetTurnId && implementTargetPlanText) {
      markPlanAction(implementTargetTurnId, implementTargetPlanText, "implemented");
    }
    setImplementDialogOpen(false);
    setImplementTargetTurnId(null);
    setImplementTargetPlanText(null);
    setImplementDraft("");
    setPrompt("");
  }, [
    applyCollaborationMode,
    implementDraft,
    implementTargetPlanText,
    implementTargetTurnId,
    markPlanAction,
    submitTurnText,
  ]);

  const applyPromptSlash = useCallback((command: KnownSlashCommand) => {
    setPrompt((previous) => applySlashSuggestion(previous, command));
    setSlashMenuDismissed(false);
    setActiveSlashIndex(0);
  }, []);

  const openControlSheet = useCallback(
    (section: ControlSheetSection = "advanced", snap: ControlSheetSnap = "half") => {
      setControlSheetSection(section);
      setControlSheetSnap(snap);
      setSheetDragOffsetY(0);
      setIsDraggingSheet(false);
      setIsControlSheetOpen(true);
    },
    [],
  );

  const closeControlSheet = useCallback(() => {
    setSheetDragOffsetY(0);
    setIsDraggingSheet(false);
    setIsControlSheetOpen(false);
  }, []);

  const openMessageDetails = useCallback((turnId: string) => {
    setActiveMessageId(turnId);
    setIsMessageDetailsOpen(true);
  }, []);

  const closeMessageDetails = useCallback(() => {
    setIsMessageDetailsOpen(false);
    setActiveMessageId(null);
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
    const hasReadyAttachments = pendingAttachments.some((a) => a.status === "ready");
    if ((!text && !hasReadyAttachments) || !threadId || submitting) {
      return;
    }

    if (text) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        return;
      }
    }

    const sent = await submitTurnText(text);
    if (sent) {
      setPrompt("");
    }
  }

  const submitComposer = useCallback((): void => {
    const trimmed = prompt.trim();
    const hasReadyAttachments = pendingAttachments.some((a) => a.status === "ready");
    if (trimmed.length === 0 && !hasReadyAttachments) {
      return;
    }
    if (runningTurnId) {
      // Steer is text-only; attachments stay queued for the next idle turn.
      if (trimmed.length === 0) {
        return;
      }
      void (async () => {
        const ok = await steerRunningTurn(runningTurnId, trimmed);
        if (ok) {
          setPrompt("");
        }
      })();
      return;
    }
    void sendTurn();
  }, [pendingAttachments, prompt, runningTurnId, sendTurn, steerRunningTurn]);

  const handlePromptKeyDown = useComposerKeyboard({
    activeSlashIndex,
    isMobileViewport,
    slashMenuOpen,
    slashSuggestions,
    setActiveSlashIndex,
    onAcceptSlash: applyPromptSlash,
    onDismissSlash: () => setSlashMenuDismissed(true),
    onSubmit: submitComposer,
    secondaryEscapeOpen: fileMentionOpen,
    onSecondaryEscape: () => setFileMentionDismissed(true),
    onShiftTab: toggleCollaborationMode,
  });

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

  const activeProjectLabel = projectLabelFromKey(activeProjectKey);
  const activeThreadTitle =
    detail?.thread.title?.trim() || activeThread?.title?.trim() || "(untitled thread)";
  const activeMessageDetails = useMemo<MobileMessageDetails | null>(() => {
    if (!activeMessageId) {
      return null;
    }
    const turn = allConversationTurns.find((item) => item.turnId === activeMessageId);
    if (!turn) {
      return null;
    }
    return {
      turnId: turn.turnId,
      startedAt: formatTimestamp(turn.startedAt),
      completedAt: formatTimestamp(turn.completedAt),
      status: statusLabel(turn.status),
      streaming: turn.isStreaming,
      toolCalls: turn.toolCalls.length,
      toolResults: turn.toolResults.length,
      hasThinking: Boolean(turn.thinkingText),
    };
  }, [activeMessageId, allConversationTurns]);
  // (moved above the callback definitions so submitComposer can read runningTurnId)
  const thinkingBannerText = submitting
    ? "Preparing request..."
    : latestStreamingTurn?.thinkingText
      ? "Reasoning in progress..."
      : "Thinking in progress...";

  if (isMobileViewport) {
    return (
      <MobileThreadShell
        activeProjectLabel={activeProjectLabel}
        activeThreadTitle={activeThreadTitle}
        collaborationMode={collaborationMode}
        gatewayConfig={gatewayConfig}
        pendingActionCount={pendingActionCount}
        isThinkingActive={isThinkingActive}
        thinkingBannerText={thinkingBannerText}
        runningTurnId={runningTurnId}
        controlBusy={controlBusy}
        viewMode={viewMode}
        canvasBlocked={canvasBlocked}
        setViewMode={setViewMode}
        interruptRunningTurn={interruptRunningTurn}
        setIsThreadSwitcherOpen={setIsThreadSwitcherOpen}
        canvasOpenRequestKey={canvasOpenRequestKey}
        setCanvasOpenRequestKey={setCanvasOpenRequestKey}
        openControlSheet={openControlSheet}
        pendingInteractionList={pendingInteractionList}
        pendingApprovalList={pendingApprovalList}
        statusBanner={statusBanner}
        setStatusBanner={setStatusBanner}
        error={error}
        submitError={submitError}
        approvalError={approvalError}
        interactionError={interactionError}
        controlError={controlError}
        modelCatalogError={modelCatalogError}
        visibleConversationTurns={visibleConversationTurns}
        hiddenTimelineCount={hiddenTimelineCount}
        showAllTurns={showAllTurns}
        setShowAllTurns={setShowAllTurns}
        timelineRef={timelineRef}
        handleTimelineScroll={handleTimelineScroll}
        formatTimestamp={formatTimestamp}
        reviewSlashCommandByTurnId={reviewSlashCommandByTurnId}
        copyMessage={copyMessage}
        openMessageDetails={openMessageDetails}
        gatewayUrl={gatewayUrl}
        actionablePlanByTurnId={actionablePlanByTurnId}
        turnProgressByTurnId={turnProgressByTurnId}
        truncateText={truncateText}
        openImplementDialog={openImplementDialog}
        keepPlanning={keepPlanning}
        searchParams={searchParams}
        MOBILE_CANVAS_URL_STORAGE_KEY={MOBILE_CANVAS_URL_STORAGE_KEY}
        isControlSheetOpen={isControlSheetOpen}
        isMessageDetailsOpen={isMessageDetailsOpen}
        implementDialogOpen={implementDialogOpen}
        approvalBusy={approvalBusy}
        decideApproval={decideApproval}
        prompt={prompt}
        submitting={submitting}
        pendingAttachments={pendingAttachments}
        handlePickFiles={handlePickFiles}
        handleRemoveAttachment={handleRemoveAttachment}
        slashMenuOpen={slashMenuOpen}
        slashSuggestions={slashSuggestions}
        activeSlashIndex={activeSlashIndex}
        fileMentionOpen={fileMentionOpen}
        fileMentionSearch={fileMentionSearch}
        thinkingEffort={thinkingEffort}
        latestTokenUsage={latestTokenUsage}
        setPrompt={setPrompt}
        setSlashMenuDismissed={setSlashMenuDismissed}
        setFileMentionDismissed={setFileMentionDismissed}
        handlePromptKeyDown={handlePromptKeyDown}
        applyPromptSlash={applyPromptSlash}
        applyFileMention={applyFileMention}
        submitComposer={submitComposer}
        controlSheetSection={controlSheetSection}
        controlSheetSnap={controlSheetSnap}
        isDraggingSheet={isDraggingSheet}
        sheetDragOffsetY={sheetDragOffsetY}
        interactionBusy={interactionBusy}
        compactBusy={compactBusy}
        model={model}
        modelOptions={modelOptions}
        thinkingEffortOptions={thinkingEffortOptions}
        permissionMode={permissionMode}
        setControlSheetSection={setControlSheetSection}
        setControlSheetSnap={setControlSheetSnap}
        closeControlSheet={closeControlSheet}
        setIsDraggingSheet={setIsDraggingSheet}
        setSheetDragOffsetY={setSheetDragOffsetY}
        sendControl={sendControl}
        compactThread={compactThread}
        respondInteraction={respondInteraction}
        setModel={setModel}
        setThinkingEffort={setThinkingEffort}
        setPermissionMode={setPermissionMode}
        formatEffortLabel={formatEffortLabel}
        implementDraft={implementDraft}
        setImplementDialogOpen={setImplementDialogOpen}
        setImplementDraft={setImplementDraft}
        confirmImplementPlan={confirmImplementPlan}
        implementTargetTurnId={implementTargetTurnId}
        implementTargetPlanText={implementTargetPlanText}
        setImplementTargetTurnId={setImplementTargetTurnId}
        setImplementTargetPlanText={setImplementTargetPlanText}
        activeMessageDetails={activeMessageDetails}
        closeMessageDetails={closeMessageDetails}
        isThreadSwitcherOpen={isThreadSwitcherOpen}
        mobileThreadSwitcherGroups={mobileThreadSwitcherGroups}
        switcherCollapsedGroups={switcherCollapsedGroups}
        threadListLoading={threadListLoading}
        activeProjectKey={activeProjectKey}
        selectThreadFromMobileSwitcher={selectThreadFromMobileSwitcher}
        handleToggleSwitcherGroup={handleToggleSwitcherGroup}
        createThread={createThread}
      />
    );
  }

  return (
    <DesktopThreadShell
      sidebarVisible={sidebarVisible}
      isThinkingActive={isThinkingActive}
      isCompactViewport={isCompactViewport}
      isMobileViewport={isMobileViewport}
      isThreadSwitcherOpen={isThreadSwitcherOpen}
      sidebarOpen={sidebarOpen}
      handleSidebarToggle={handleSidebarToggle}
      createThread={createThread}
      desktopViewMenuRef={desktopViewMenuRef}
      desktopViewMenuOpen={desktopViewMenuOpen}
      setDesktopViewMenuOpen={setDesktopViewMenuOpen}
      viewMode={viewMode}
      setViewMode={setViewMode}
      setTerminalOpen={setTerminalOpen}
      statusBanner={statusBanner}
      setStatusBanner={setStatusBanner}
      terminalEnabled={terminalEnabled}
      workspaceStyle={workspaceStyle}
      sidebarRef={sidebarRef}
      sidebarSearchQuery={sidebarSearchQuery}
      setSidebarSearchQuery={setSidebarSearchQuery}
      sidebarStatusFilter={sidebarStatusFilter}
      setSidebarStatusFilter={setSidebarStatusFilter}
      sidebarFilteredGroups={sidebarFilteredGroups}
      threadPreviewById={threadPreviewById}
      switcherCollapsedGroups={switcherCollapsedGroups}
      handleToggleSwitcherGroup={handleToggleSwitcherGroup}
      threadId={threadId}
      registerActiveThreadCard={registerActiveThreadCard}
      threadListLoading={threadListLoading}
      sidebarListIsEmpty={sidebarListIsEmpty}
      sidebarEmptyMessage={sidebarEmptyMessage}
      activeThreadTitle={activeThreadTitle}
      threadContext={threadContext}
      shortCwdLabel={shortCwdLabel}
      thinkingBannerText={thinkingBannerText}
      connectionState={connectionState}
      connectionText={connectionText}
      desktopContextUsage={desktopContextUsage}
      activeProjectLabel={activeProjectLabel}
      lastSeq={lastSeq}
      collaborationMode={collaborationMode}
      pendingApprovalList={pendingApprovalList}
      pendingInteractionList={pendingInteractionList}
      streamingTurnCount={streamingTurnCount}
      loading={loading}
      error={error}
      submitError={submitError}
      approvalError={approvalError}
      interactionError={interactionError}
      controlError={controlError}
      modelCatalogError={modelCatalogError}
      visibleConversationTurns={visibleConversationTurns}
      hiddenTimelineCount={hiddenTimelineCount}
      showAllTurns={showAllTurns}
      setShowAllTurns={setShowAllTurns}
      timelineRef={timelineRef}
      handleTimelineScroll={handleTimelineScroll}
      reviewSlashCommandByTurnId={reviewSlashCommandByTurnId}
      formatTimestamp={formatTimestamp}
      truncateText={truncateText}
      gatewayUrl={gatewayUrl}
      copyMessage={copyMessage}
      turnProgressByTurnId={turnProgressByTurnId}
      actionablePlanByTurnId={actionablePlanByTurnId}
      openImplementDialog={openImplementDialog}
      keepPlanning={keepPlanning}
      activeApproval={activeApproval}
      activeInteraction={activeInteraction}
      desktopDockTab={desktopDockTab}
      setDesktopDockTab={setDesktopDockTab}
      desktopQuestionDrafts={desktopQuestionDrafts}
      updateDesktopQuestionDraft={updateDesktopQuestionDraft}
      answersForDesktopInteraction={answersForDesktopInteraction}
      interactionBusy={interactionBusy}
      respondInteraction={respondInteraction}
      approvalBusy={approvalBusy}
      decideApproval={decideApproval}
      isComposerDragOver={isComposerDragOver}
      handleComposerDragOver={handleComposerDragOver}
      handleComposerDragEnter={handleComposerDragEnter}
      handleComposerDragLeave={handleComposerDragLeave}
      handleComposerDrop={handleComposerDrop}
      desktopFileInputRef={desktopFileInputRef}
      handleDesktopFileInputChange={handleDesktopFileInputChange}
      runningTurnId={runningTurnId}
      pendingAttachments={pendingAttachments}
      handleRemoveAttachment={handleRemoveAttachment}
      prompt={prompt}
      setPrompt={setPrompt}
      setSlashMenuDismissed={setSlashMenuDismissed}
      handlePromptKeyDown={handlePromptKeyDown}
      handleDesktopTextareaPaste={handleDesktopTextareaPaste}
      slashMenuOpen={slashMenuOpen}
      slashSuggestions={slashSuggestions}
      activeSlashIndex={activeSlashIndex}
      applyPromptSlash={applyPromptSlash}
      controlBusy={controlBusy}
      sendControl={sendControl}
      compactBusy={compactBusy}
      compactThread={compactThread}
      selectedModelLabel={selectedModelLabel}
      formatEffortLabel={formatEffortLabel}
      thinkingEffort={thinkingEffort}
      permissionModeLabel={permissionModeLabel}
      model={model}
      setModel={setModel}
      modelOptions={modelOptions}
      thinkingEffortOptions={thinkingEffortOptions}
      setThinkingEffort={setThinkingEffort}
      permissionMode={permissionMode}
      setPermissionMode={setPermissionMode}
      sendTurn={sendTurn}
      submitting={submitting}
      terminalWidth={terminalWidth}
      handleTerminalResizeStart={handleTerminalResizeStart}
      implementDialogOpen={implementDialogOpen}
      setImplementDialogOpen={setImplementDialogOpen}
      implementDraft={implementDraft}
      setImplementDraft={setImplementDraft}
      confirmImplementPlan={confirmImplementPlan}
      implementTargetTurnId={implementTargetTurnId}
      implementTargetPlanText={implementTargetPlanText}
      setImplementTargetTurnId={setImplementTargetTurnId}
      setImplementTargetPlanText={setImplementTargetPlanText}
    />
  );
}
