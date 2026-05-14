"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
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
  ThreadTimelineItem,
  ThreadTimelineResponse,
  TurnPermissionMode,
  UserInputItem,
} from "@lcwa/shared-types";
import { uploadAttachments, UploadClientError } from "../../lib/upload-client";
import type { PendingAttachment } from "./AttachmentStrip";
import { MarkdownText } from "../../lib/MarkdownText";
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
  buildConversationTurns,
  formatEffortLabel,
  proposedPlanFromText,
  statusClass,
  statusLabel,
  summarizeToolAction,
  timelineItemFromGatewayEvent,
  truncateText,
  type ConversationTurn,
} from "../../lib/thread-logic";
import {
  applySlashSuggestion,
  getSlashSuggestions,
  parseSlashCommand,
  type KnownSlashCommand,
} from "../../lib/slash-commands";
import MobileActionLayer from "./MobileActionLayer";
import MobileChatTopBar, {
  type ThreadViewMode,
  VIEW_MODE_OPTIONS,
} from "./MobileChatTopBar";
import MobileComposerDock from "./MobileComposerDock";
import MobileControlSheet from "./MobileControlSheet";
import MobileMessageDetailsSheet from "./MobileMessageDetailsSheet";
import MobileMessageStream from "./MobileMessageStream";
import MobileThreadSwitcherOverlay, {
  type MobileThreadSwitcherGroup,
} from "./MobileThreadSwitcherOverlay";
import {
  THREAD_SWITCHER_FILTERS,
  badgeForThreadItem,
  emptyStateMessage,
  filterThreadSwitcherGroups,
  type ThreadSwitcherFilter,
  type ThreadSwitcherGroup,
} from "./thread-switcher-shared";
import TerminalDock from "./TerminalDock";
import InteractionQuestionForm, {
  answersForInteractionQuestions,
  updateInteractionQuestionDrafts,
  type InteractionQuestionDrafts,
} from "./InteractionQuestionForm";
import { useThreadViewportShell } from "./use-thread-viewport-shell";
import {
  approvalFromEvent,
  asRecord,
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
const TIMELINE_STICKY_THRESHOLD_PX = 56;
const ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX = 24;
const FALLBACK_THINKING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"];

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
  const initialThreadReadyRef = useRef(false);
  const previousThreadIdRef = useRef("");
  const activeThreadIdRef = useRef("");
  const resolvedApprovalIdsRef = useRef<Set<string>>(new Set());
  const resolvedInteractionIdsRef = useRef<Set<string>>(new Set());
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
  const [timelineItems, setTimelineItems] = useState<ThreadTimelineItem[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [interactionBusy, setInteractionBusy] = useState<string | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<ThreadControlRequest["action"] | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [threadList, setThreadList] = useState<ThreadListItem[]>([]);
  const [threadListLoading, setThreadListLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Desktop sidebar — own copies of search + filter state so the mobile drawer
  // resetting on close doesn't blow away what the user typed on desktop, and
  // vice versa.
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [sidebarStatusFilter, setSidebarStatusFilter] = useState<ThreadSwitcherFilter>("all");
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
  const [threadContext, setThreadContext] = useState<ThreadContextResponse | null>(null);
  const gatewayConfig = useGatewayConfig();
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [latestTokenUsage, setLatestTokenUsage] = useState<ThreadTokenUsageSummary | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [planActionByStorageKey, setPlanActionByStorageKey] = useState<
    Record<string, PlanActionState>
  >({});
  const [planActionStorageReadyKey, setPlanActionStorageReadyKey] = useState("");
  const [desktopDockTab, setDesktopDockTab] = useState<"questions" | "approvals">("questions");
  const [desktopQuestionDrafts, setDesktopQuestionDrafts] = useState<InteractionQuestionDrafts>(
    {},
  );
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
    setEvents([]);
    setLastSeq(0);
    setTimelineItems([]);
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

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [detailRes, approvalsRes, interactionsRes, threadsRes, timelineRes, contextRes] = await Promise.all([
          fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/approvals/pending`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/interactions/pending`),
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
        if (!interactionsRes.ok) {
          throw new Error(`interactions http ${interactionsRes.status}`);
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
        const pendingInteractionsResult =
          (await interactionsRes.json()) as PendingInteractionsResponse;
        const threadListResult = (await threadsRes.json()) as { data: ThreadListItem[] };
        const timeline = (await timelineRes.json()) as ThreadTimelineResponse;
        const context = (await contextRes.json()) as ThreadContextResponse;

        if (!cancelled) {
          setDetail(data);
          setThreadListLoading(false);
          setThreadList(threadListResult.data);
          setThreadContext(context);
          setPendingApprovals((prev) => {
            const next: Record<string, PendingApprovalCard> = {};
            for (const item of pending.data) {
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
            for (const item of pendingInteractionsResult.data) {
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

    let currentSince = 0;
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
        if (stopped || payload.threadId !== threadId) {
          return;
        }
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
  const allConversationTurns = useMemo(() => {
    const built = buildConversationTurns(allTimelineItems);
    // Server is the source of truth for turn status. If detail.turns reports a
    // terminal status (interrupted/failed/completed) and there is no live
    // turn/started or turn/completed in the post-detail event stream contradicting
    // it, override the timeline-derived status so we don't keep showing
    // "Responding" on a turn the gateway already knows ended.
    const serverStatusByTurnId = new Map<string, string>();
    for (const turn of detail?.turns ?? []) {
      if (typeof turn.status === "string" && turn.status.length > 0) {
        serverStatusByTurnId.set(turn.id, turn.status);
      }
    }
    if (serverStatusByTurnId.size === 0) {
      return built;
    }
    return built.map((turn) => {
      if (!turn.isStreaming) return turn;
      const serverStatus = serverStatusByTurnId.get(turn.turnId);
      // Codex returns turn status as a snake-cased string ("in_progress"),
      // but older internal status enums used camelCase ("inProgress"). Treat
      // both as "still active" so refresh during a live turn keeps the
      // streaming indicator on instead of flipping it off the moment the
      // detail response lands.
      if (
        !serverStatus ||
        serverStatus === "in_progress" ||
        serverStatus === "inProgress" ||
        serverStatus === "active"
      ) {
        return turn;
      }
      return {
        ...turn,
        status: serverStatus as typeof turn.status,
        isStreaming: false,
      };
    });
  }, [allTimelineItems, detail]);
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
  const sidebarFilteredGroups = useMemo<ThreadSwitcherGroup[]>(
    () =>
      filterThreadSwitcherGroups(
        mobileThreadSwitcherGroups,
        sidebarStatusFilter,
        sidebarSearchQuery,
      ),
    [mobileThreadSwitcherGroups, sidebarStatusFilter, sidebarSearchQuery],
  );
  const sidebarListIsEmpty = useMemo(
    () => sidebarFilteredGroups.every((group) => group.items.length === 0),
    [sidebarFilteredGroups],
  );
  const sidebarEmptyMessage = useMemo(
    () =>
      emptyStateMessage(
        mobileThreadSwitcherGroups,
        sidebarStatusFilter,
        sidebarSearchQuery,
      ),
    [mobileThreadSwitcherGroups, sidebarStatusFilter, sidebarSearchQuery],
  );
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
      (turn) => turn.isStreaming && turn.userText === pendingNewTurn.userText,
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

  // Clear the optimistic turn as soon as a real SSE user_message with the
  // same text arrives for this thread.
  useEffect(() => {
    if (!pendingNewTurn) return;
    const matched = allTimelineItems.some(
      (item) =>
        item.type === "userMessage" &&
        item.text === pendingNewTurn.userText &&
        item.ts > pendingNewTurn.startedAt,
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
      // Optimistic: render the user bubble + "Codex is working…" indicator
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
          collaborationMode?: "plan";
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
        if (modeForTurn === "plan") {
          options.collaborationMode = "plan";
        }

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
        if (payload.warnings?.includes("plan_mode_fallback")) {
          setSubmitError("Plan mode unavailable on this app-server; sent in default mode.");
        }
        // Clear the just-sent attachments + revoke their blob URLs.
        for (const att of pendingAttachments) {
          URL.revokeObjectURL(att.previewUrl);
        }
        setPendingAttachments([]);
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
      <div className="cdx-mobile-thread-page">
        <MobileChatTopBar
          projectLabel={activeProjectLabel}
          threadTitle={activeThreadTitle}
          collaborationMode={collaborationMode}
          serviceTier={gatewayConfig.config?.serviceTier ?? null}
          pendingActionCount={pendingActionCount}
          runningTurnId={runningTurnId}
          stopBusy={controlBusy === "stop"}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onStop={(turnId) => void interruptRunningTurn(turnId)}
          onOpenThreads={() => setIsThreadSwitcherOpen(true)}
          onOpenControls={() =>
            openControlSheet(
              pendingInteractionList.length > 0 || pendingApprovalList.length > 0
                ? "pending"
                : "advanced",
              "half",
            )
          }
        />

        <main className="cdx-mobile-thread-main">
          {statusBanner ? (
            <div className="cdx-mobile-status-banner" data-testid="status-banner">
              <div className="cdx-mobile-status-banner-lines">
                <span>{statusBanner.lines[0]}</span>
                <span>{statusBanner.lines[1]}</span>
                <span>{statusBanner.lines[2]}</span>
              </div>
              <button
                type="button"
                className="cdx-mobile-status-banner-close"
                data-testid="status-banner-close"
                aria-label="Dismiss status"
                onClick={() => setStatusBanner(null)}
              >
                ×
              </button>
            </div>
          ) : null}
          {error ? <p className="cdx-error">{error}</p> : null}
          {submitError ? <p className="cdx-error">{submitError}</p> : null}
          {approvalError ? <p className="cdx-error">{approvalError}</p> : null}
          {interactionError ? <p className="cdx-error">{interactionError}</p> : null}
          {controlError ? <p className="cdx-error">{controlError}</p> : null}
          {modelCatalogError ? (
            <p className="cdx-helper">Model catalog unavailable ({modelCatalogError}); using fallback list.</p>
          ) : null}

          <MobileMessageStream
            turns={visibleConversationTurns}
            hiddenCount={hiddenTimelineCount}
            showAllTurns={showAllTurns}
            onToggleShowAll={setShowAllTurns}
            timelineRef={timelineRef}
            onTimelineScroll={handleTimelineScroll}
            formatTimestamp={formatTimestamp}
            reviewSlashCommandByTurnId={reviewSlashCommandByTurnId}
            onCopyMessage={(text) => void copyMessage(text)}
            onOpenMessageDetails={openMessageDetails}
            viewMode={viewMode}
            renderTurnActions={(turnId) => {
              const planText = actionablePlanByTurnId[turnId];
              const progressText = turnProgressByTurnId[turnId];
              const showPlan = Boolean(planText);
              return (
                <>
                  {progressText ? (
                    <section
                      className="cdx-message cdx-message--detail cdx-turn-progress-card"
                      data-testid="turn-progress-card"
                    >
                      <div className="cdx-message-meta">
                        <strong className="cdx-message-role">Codex tasks</strong>
                      </div>
                      <pre className="cdx-turn-body cdx-turn-body--plan">
                        {truncateText(progressText, 4000)}
                      </pre>
                    </section>
                  ) : null}
                  {showPlan ? (
                    <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                      <div className="cdx-message-meta">
                        <strong className="cdx-message-role">Plan ready</strong>
                      </div>
                      <pre className="cdx-turn-body cdx-turn-body--plan">
                        {truncateText(planText, 4000)}
                      </pre>
                      <div className="cdx-inline-actions">
                        <button
                          type="button"
                          className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                          onClick={() => openImplementDialog(turnId, planText)}
                        >
                          Implement this plan
                        </button>
                        <button
                          type="button"
                          className="cdx-toolbar-btn"
                          onClick={() => keepPlanning(turnId, planText)}
                        >
                          Keep planning
                        </button>
                      </div>
                    </section>
                  ) : null}
                </>
              );
            }}
          />
        </main>

        {runningTurnId || pendingNewTurn || submitting ? (
          <div
            className="cdx-mobile-running-indicator"
            data-testid="mobile-running-indicator"
            role="status"
            aria-live="polite"
          >
            <span className="cdx-mobile-running-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="cdx-mobile-running-label">Codex is working…</span>
          </div>
        ) : null}

        {/* The control sheet, the message details sheet, and the implement
            dialog are themselves the canonical "answer / approve" surface
            once they open — keep the floating action layer hidden while any
            of them is up so it can't intercept clicks on the actual form
            underneath (the action layer now sits at a higher z-index than
            the sheet backdrop). */}
        {isControlSheetOpen || isMessageDetailsOpen || implementDialogOpen ? null : (
          <MobileActionLayer
            pendingApprovals={pendingApprovalList}
            pendingInteractions={pendingInteractionList}
            approvalBusy={approvalBusy}
            onDecision={(approvalId, decision) => void decideApproval(approvalId, decision)}
            onOpenQuestion={() => openControlSheet("pending", "full")}
          />
        )}

        <MobileComposerDock
          prompt={prompt}
          submitting={submitting}
          canSend={
            runningTurnId !== null
              ? prompt.trim().length > 0
              : (prompt.trim().length > 0 ||
                  pendingAttachments.some((a) => a.status === "ready")) &&
                !pendingAttachments.some((a) => a.status === "uploading")
          }
          attachments={pendingAttachments}
          onPickFiles={runningTurnId === null ? handlePickFiles : undefined}
          onRemoveAttachment={handleRemoveAttachment}
          slashMenuOpen={slashMenuOpen}
          slashSuggestions={slashSuggestions}
          activeSlashIndex={activeSlashIndex}
          steerActive={runningTurnId !== null}
          fileMentionOpen={fileMentionOpen}
          fileMentionResults={fileMentionSearch.results}
          fileMentionLoading={fileMentionSearch.isLoading}
          strip={{
            model: model || null,
            effortLabel: thinkingEffort ? formatEffortLabel(thinkingEffort) : null,
            permissionLabel: permissionMode ? permissionMode : null,
            pendingCount: pendingActionCount,
          }}
          onPromptChange={(value) => {
            setPrompt(value);
            setSlashMenuDismissed(false);
            setFileMentionDismissed(false);
          }}
          onPromptKeyDown={handlePromptKeyDown}
          onApplySlash={applyPromptSlash}
          onApplyFileMention={(path) => {
            if (!fileMentionSearch.trigger) return;
            setPrompt(applyFileMention(prompt, fileMentionSearch.trigger, path));
            setFileMentionDismissed(true);
          }}
          onSend={submitComposer}
          onInsertFileMentionTrigger={() => {
            setPrompt((current) => (current.length === 0 || current.endsWith(" ") ? `${current}@` : `${current} @`));
            setSlashMenuDismissed(false);
            setFileMentionDismissed(false);
          }}
          onInsertSlashTrigger={() => {
            setPrompt((current) => (current.length === 0 ? "/" : `${current} /`));
            setSlashMenuDismissed(false);
            setFileMentionDismissed(false);
          }}
          onOpenControls={() =>
            openControlSheet(
              pendingInteractionList.length > 0 || pendingApprovalList.length > 0
                ? "pending"
                : "advanced",
              "half",
            )
          }
          onOpenAdvancedControls={() => openControlSheet("advanced", "half")}
          onSwipeOpenControls={() =>
            openControlSheet(
              pendingInteractionList.length > 0 || pendingApprovalList.length > 0
                ? "pending"
                : "advanced",
              "full",
            )
          }
        />

        <MobileControlSheet
          open={isControlSheetOpen}
          section={controlSheetSection}
          snap={controlSheetSnap}
          isDragging={isDraggingSheet}
          dragOffsetY={sheetDragOffsetY}
          approvalBusy={approvalBusy}
          interactionBusy={interactionBusy}
          controlBusy={controlBusy}
          pendingApprovals={pendingApprovalList}
          pendingInteractions={pendingInteractionList}
          model={model}
          modelOptions={modelOptions.map((option) => ({ value: option.value, label: option.label }))}
          thinkingEffort={thinkingEffort}
          thinkingEffortOptions={thinkingEffortOptions}
          permissionMode={permissionMode}
          serviceTier={gatewayConfig.config?.serviceTier ?? null}
          serviceTierBusy={gatewayConfig.status === "writing"}
          onServiceTierChange={(tier) => {
            void gatewayConfig.writeValue({ keyPath: "service_tier", value: tier });
          }}
          onSectionChange={(section) => {
            setControlSheetSection(section);
            // Advanced tab pins controls (Stop/Retry/Cancel) at the bottom of
            // the form — at half-snap they fall below the viewport and become
            // unreachable. Auto-expand to full when the user switches in.
            if (section === "advanced") {
              setControlSheetSnap("full");
            }
          }}
          onSnapChange={setControlSheetSnap}
          onClose={closeControlSheet}
          onDraggingChange={setIsDraggingSheet}
          onDragOffsetChange={setSheetDragOffsetY}
          onControl={(action) => void sendControl(action)}
          onDecision={(approvalId, decision) => void decideApproval(approvalId, decision)}
          onRespondInteraction={(interactionId, answers) => void respondInteraction(interactionId, answers)}
          onModelChange={setModel}
          onThinkingEffortChange={setThinkingEffort}
          onPermissionModeChange={setPermissionMode}
          formatEffortLabel={formatEffortLabel}
        />

        {implementDialogOpen ? (
          <section className="cdx-mobile-implement-sheet" data-testid="mobile-implement-sheet">
            <div className="cdx-turn-head">
              <strong>Implement plan</strong>
              <button
                type="button"
                className="cdx-mobile-inline-btn"
                onClick={() => setImplementDialogOpen(false)}
              >
                Close
              </button>
            </div>
            <textarea
              data-testid="implement-draft-input"
              value={implementDraft}
              onChange={(event) => setImplementDraft(event.target.value)}
              rows={8}
            />
            <div className="cdx-inline-actions">
              <button
                type="button"
                className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                onClick={() => void confirmImplementPlan()}
                disabled={submitting || implementDraft.trim().length === 0}
              >
                Implement this plan
              </button>
              <button
                type="button"
                className="cdx-toolbar-btn"
                onClick={() => {
                  if (implementTargetTurnId && implementTargetPlanText) {
                    keepPlanning(implementTargetTurnId, implementTargetPlanText);
                  }
                  setImplementDialogOpen(false);
                  setImplementTargetTurnId(null);
                  setImplementTargetPlanText(null);
                }}
              >
                Keep planning
              </button>
            </div>
          </section>
        ) : null}

        <MobileMessageDetailsSheet
          open={isMessageDetailsOpen}
          details={activeMessageDetails}
          onClose={closeMessageDetails}
        />

        <MobileThreadSwitcherOverlay
          open={isThreadSwitcherOpen}
          groups={mobileThreadSwitcherGroups}
          collapsedGroups={switcherCollapsedGroups}
          loading={threadListLoading}
          defaultProjectKey={activeProjectKey}
          onClose={() => setIsThreadSwitcherOpen(false)}
          onSelect={selectThreadFromMobileSwitcher}
          onToggleGroup={(key) =>
            setSwitcherCollapsedGroups((prev) => {
              const next = new Set(prev);
              if (next.has(key)) {
                next.delete(key);
              } else {
                next.add(key);
              }
              return next;
            })
          }
          onCreateThread={(projectKey) => {
            setIsThreadSwitcherOpen(false);
            void createThread(projectKey);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`cdx-app ${sidebarVisible ? "" : "cdx-app--sidebar-collapsed"} ${
        isThinkingActive ? "cdx-app--thinking" : ""
      }`}
    >
      <header
        className={`cdx-topbar ${isCompactViewport ? "cdx-topbar--compact" : ""} ${
          isMobileViewport ? "cdx-topbar--mobile" : ""
        }`}
      >
        <div className="cdx-topbar-group">
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--icon"
            title={
              isMobileViewport
                ? isThreadSwitcherOpen
                  ? "Hide thread switcher"
                  : "Show thread switcher"
                : sidebarOpen
                  ? "Hide sidebar"
                  : "Show sidebar"
            }
            onClick={handleSidebarToggle}
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
          {!isMobileViewport ? (
            <>
              <div
                className="cdx-topbar-view-menu-anchor"
                ref={desktopViewMenuRef}
              >
                <button
                  type="button"
                  className="cdx-toolbar-btn"
                  data-testid="desktop-topbar-views-toggle"
                  aria-haspopup="menu"
                  aria-expanded={desktopViewMenuOpen}
                  aria-label="Switch view mode"
                  onClick={() => setDesktopViewMenuOpen((value) => !value)}
                >
                  Views: {viewMode === "normal" ? "Normal" : viewMode === "thinking" ? "Thinking" : "Verbose"}
                  <span aria-hidden="true" style={{ marginLeft: 6, opacity: 0.6 }}>▾</span>
                </button>
                {desktopViewMenuOpen ? (
                  <div
                    className="cdx-topbar-view-menu"
                    role="menu"
                    data-testid="desktop-topbar-views-menu"
                  >
                    {VIEW_MODE_OPTIONS.map((option) => {
                      const active = option.value === viewMode;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={`cdx-topbar-view-menu-item ${active ? "is-active" : ""}`}
                          data-testid={`desktop-topbar-views-${option.value}`}
                          onClick={() => {
                            setViewMode(option.value);
                            setDesktopViewMenuOpen(false);
                          }}
                        >
                          <span className="cdx-topbar-view-menu-item-label">{option.label}</span>
                          <span className="cdx-topbar-view-menu-item-desc">{option.description}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
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
                title="Toggle terminal (Cmd+J)"
                onClick={() => setTerminalOpen((v) => !v)}
              >
                ▦
              </button>
              <button type="button" className="cdx-toolbar-btn" disabled>
                Pop out
              </button>
            </>
          ) : null}
        </div>
      </header>

      {statusBanner ? (
        <div className="cdx-status-banner" data-testid="status-banner">
          <span>{statusBanner.lines[0]}</span>
          <span>{statusBanner.lines[1]}</span>
          <span>{statusBanner.lines[2]}</span>
          <button
            type="button"
            className="cdx-status-banner-close"
            data-testid="status-banner-close"
            aria-label="Dismiss status"
            onClick={() => setStatusBanner(null)}
          >
            ×
          </button>
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
              <button
                type="button"
                className="cdx-sidebar-action cdx-sidebar-action--active"
                data-testid="desktop-sidebar-new-thread"
                onClick={() => void createThread()}
              >
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
            <div className="cdx-sidebar-search">
              <input
                type="search"
                className="cdx-sidebar-search-input"
                data-testid="desktop-thread-search"
                placeholder="Search threads"
                value={sidebarSearchQuery}
                onChange={(event) => setSidebarSearchQuery(event.target.value)}
                aria-label="Search threads"
              />
            </div>
            <div
              className="cdx-sidebar-filters"
              role="tablist"
              aria-label="Filter threads by status"
            >
              {THREAD_SWITCHER_FILTERS.map((option) => {
                const active = option.value === sidebarStatusFilter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`cdx-sidebar-filter ${active ? "is-active" : ""}`}
                    data-testid={`desktop-thread-filter-${option.value}`}
                    onClick={() => setSidebarStatusFilter(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="cdx-project-tree">
              {sidebarFilteredGroups.map((group) => {
                if (group.items.length === 0) {
                  // Hide entirely-empty groups so collapsed/filtered project
                  // headers don't pile up under the search bar.
                  return null;
                }
                const previewByThreadId = threadPreviewById.get(group.key) ?? new Map<string, string>();
                return (
                  <section key={group.key} className="cdx-project-group">
                    <div className="cdx-project-title">
                      <span>{group.label}</span>
                      <span className="cdx-project-title-actions">
                        <span className="cdx-helper">{group.items.length}</span>
                        <button
                          type="button"
                          className="cdx-mini-btn"
                          data-testid={`desktop-thread-group-new-${group.key}`}
                          aria-label={`New thread in ${group.label}`}
                          title={`New thread in ${group.label}`}
                          onClick={() => void createThread(group.key)}
                        >
                          +
                        </button>
                      </span>
                    </div>
                    <div className="cdx-thread-list">
                      {group.items.map((item) => {
                        const badge = badgeForThreadItem(item);
                        const preview = previewByThreadId.get(item.id) ?? "";
                        return (
                          <Link
                            href={`/threads/${item.id}`}
                            key={item.id}
                            data-testid={`thread-link-${item.id}`}
                          >
                            <article
                              ref={item.id === threadId ? registerActiveThreadCard : null}
                              className={`cdx-thread-item ${item.isActive ? "is-active" : ""}`}
                              data-status={badge.kind}
                              data-testid={`thread-status-${item.id}`}
                            >
                              <div className="cdx-thread-item-head">
                                <h3 title={item.title}>{item.title}</h3>
                                <span
                                  className={`cdx-thread-item-badge cdx-thread-item-badge--${badge.kind}`}
                                  data-testid={`thread-status-badge-${item.id}`}
                                >
                                  {badge.label}
                                </span>
                              </div>
                              <p>{preview || "(empty preview)"}</p>
                              <span>{item.lastActiveAt}</span>
                            </article>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              {threadListLoading ? <p className="cdx-helper">Loading thread list...</p> : null}
              {!threadListLoading && sidebarListIsEmpty ? (
                <p className="cdx-helper" data-testid="desktop-thread-empty">
                  {sidebarEmptyMessage}
                </p>
              ) : null}
            </div>
          </aside>
        ) : null}

        <main className={`cdx-main ${isCompactViewport ? "cdx-main--compact" : ""}`}>
          <section className="cdx-hero cdx-hero--thread">
            <div className="cdx-hero-row">
              <div className="cdx-hero-identity">
                <h1 data-testid="thread-title">{activeThreadTitle}</h1>
                <p className="cdx-helper cdx-thread-seq">
                  thread {threadId} · seq <span data-testid="event-cursor">{lastSeq}</span>
                </p>
              </div>
              <div className="cdx-hero-row-end">
                {isThinkingActive ? (
                  <span className="cdx-thinking-pill" aria-live="polite" data-testid="desktop-thinking-pill">
                    <span className="cdx-thinking-pill-dot" aria-hidden="true" />
                    {thinkingBannerText}
                  </span>
                ) : null}
                <button type="button" className="cdx-project-chip">
                  {activeProjectLabel}
                </button>
              </div>
            </div>
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
              <span className="cdx-status is-pending">Pending approval: {pendingApprovalList.length}</span>
              <span className="cdx-status is-pending">
                Pending questions: {pendingInteractionList.length}
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
            {isThinkingActive ? (
              <p className="cdx-helper cdx-helper--thinking">
                Live activity: {streamingTurnCount > 0 ? `${streamingTurnCount} turn(s) streaming` : "awaiting first tokens"}
              </p>
            ) : null}
            {loading ? <p className="cdx-helper">Loading thread...</p> : null}
            {error ? <p className="cdx-error">{error}</p> : null}
            {submitError ? <p className="cdx-error">{submitError}</p> : null}
            {approvalError ? <p className="cdx-error">{approvalError}</p> : null}
            {interactionError ? <p className="cdx-error">{interactionError}</p> : null}
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
            {isThinkingActive &&
            visibleConversationTurns.filter(
              (turn) => !turn.turnId.startsWith("pending-"),
            ).length === 0 ? (
              <section
                className="cdx-thinking-placeholder cdx-thinking-placeholder--global"
                aria-live="polite"
                data-testid="desktop-thinking-placeholder"
              >
                <header className="cdx-thinking-placeholder-head">
                  <span className="cdx-stream-indicator">
                    <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                    Codex is thinking
                  </span>
                </header>
                <div className="cdx-thinking-placeholder-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </section>
            ) : null}
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
              visibleConversationTurns.map((turn) => {
                const reviewSlashCommand = reviewSlashCommandByTurnId.get(turn.turnId) ?? null;
                const segments = turn.segments;
                // Mirror the mobile MobileMessageStream pattern: when the
                // segment narrative has produced no entries yet (very early
                // in a stream) we fall back to the aggregated user/assistant
                // text so the user still sees the most recent output. When
                // segments exist we walk them in chronological order, so
                // multi-segment assistant turns (commentary → tools → final)
                // render each agent_message as its own card instead of
                // collapsing to the longest one.
                const fallbackUserDisplayText =
                  segments.length === 0 ? reviewSlashCommand ?? turn.userText : null;
                const lastAssistantIndex = (() => {
                  for (let i = segments.length - 1; i >= 0; i -= 1) {
                    if (segments[i].kind === "assistant") return i;
                  }
                  return -1;
                })();
                const hasAssistantSegment = lastAssistantIndex !== -1;
                const fallbackAssistantText =
                  !hasAssistantSegment && turn.assistantText ? turn.assistantText : null;
                // Live reasoning deltas only land in `turn.thinkingText`;
                // segments don't get a `thinking` entry until a completed
                // reasoning item arrives. Without this fallback the
                // Thinking/Verbose view modes look empty during the most
                // valuable window of the stream. Render a card styled like
                // a thinking segment off of the live buffer until a real
                // segment shows up.
                const hasThinkingSegment = segments.some((s) => s.kind === "thinking");
                const shouldShowStreamingThinkingFallback =
                  viewMode !== "normal" &&
                  turn.isStreaming &&
                  !hasThinkingSegment &&
                  Boolean(turn.thinkingText);
                return (
                  <article
                    className={`cdx-turn-card cdx-turn-card--conversation ${
                      turn.isStreaming ? "cdx-turn-card--streaming" : ""
                    } ${turn.thinkingText ? "cdx-turn-card--has-thinking" : ""}`}
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
                    {fallbackUserDisplayText ? (
                      <section className="cdx-message cdx-message--user">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">You</strong>
                          {reviewSlashCommand ? <span className="cdx-status is-pending">slash command</span> : null}
                        </div>
                        <pre className="cdx-turn-body">{truncateText(fallbackUserDisplayText, 9000)}</pre>
                      </section>
                    ) : null}
                    {/*
                      Chronological segment loop. Mirrors the mobile
                      MobileMessageStream layout: every assistant segment
                      renders its own bubble, tool batches always surface a
                      semantic pill summary, raw call/output only renders in
                      Verbose, thinking rows hide in Normal. The desktop
                      `Echo:` smoke test still finds the text because each
                      assistant segment renders its markdown inside the
                      timeline element.
                    */}
                    {segments.length > 0 ? (
                      <div
                        className="cdx-message-stack cdx-message-stack--details"
                        data-testid="desktop-turn-segments"
                        data-view-mode={viewMode}
                      >
                        {segments.map((segment, index) => {
                          const key = `${turn.turnId}-desktop-seg-${index}`;
                          if (segment.kind === "user") {
                            const isFirstUser =
                              segments.findIndex((s) => s.kind === "user") === index;
                            const displayText =
                              isFirstUser && reviewSlashCommand
                                ? reviewSlashCommand
                                : segment.text;
                            return (
                              <section
                                key={key}
                                className={`cdx-message cdx-message--user ${segment.isSteer ? "is-steer" : ""}`}
                                data-testid={segment.isSteer ? "desktop-user-steer" : "desktop-user-message"}
                              >
                                <div className="cdx-message-meta">
                                  <strong className="cdx-message-role">
                                    {segment.isSteer ? "You · steered" : "You"}
                                  </strong>
                                  {isFirstUser && reviewSlashCommand ? (
                                    <span className="cdx-status is-pending">slash command</span>
                                  ) : null}
                                </div>
                                <pre className="cdx-turn-body">
                                  {truncateText(displayText, 9000)}
                                </pre>
                              </section>
                            );
                          }
                          if (segment.kind === "assistant") {
                            const isLastAssistant = index === lastAssistantIndex;
                            return (
                              <section
                                key={key}
                                className={`cdx-message cdx-message--assistant ${
                                  turn.isStreaming && isLastAssistant ? "cdx-message--assistant-streaming" : ""
                                }`}
                                data-testid="desktop-assistant-segment"
                              >
                                {turn.isStreaming && isLastAssistant ? (
                                  <span className="cdx-message-live-rail" aria-hidden="true" />
                                ) : null}
                                <div className="cdx-message-meta">
                                  <strong className="cdx-message-role">Codex</strong>
                                  <button
                                    type="button"
                                    className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                                    onClick={() => void copyMessage(segment.text)}
                                  >
                                    Copy
                                  </button>
                                </div>
                                <div className="cdx-turn-body cdx-turn-body--md">
                                  <MarkdownText text={truncateText(segment.text, 9000)} />
                                  {turn.isStreaming && isLastAssistant ? (
                                    <span className="cdx-stream-cursor" aria-hidden="true" />
                                  ) : null}
                                </div>
                              </section>
                            );
                          }
                          if (segment.kind === "thinking") {
                            if (viewMode === "normal") return null;
                            return (
                              <details
                                key={key}
                                className="cdx-message cdx-message--detail cdx-desktop-thinking"
                                data-testid="desktop-thinking-segment"
                              >
                                <summary className="cdx-message-meta">
                                  <strong className="cdx-message-role">Thinking</strong>
                                </summary>
                                <div className="cdx-turn-body cdx-turn-body--md">
                                  <MarkdownText text={truncateText(segment.text, 6000)} />
                                </div>
                              </details>
                            );
                          }
                          if (segment.kind === "toolBatch") {
                            const actionRows = segment.items
                              .map((item, itemIndex) => ({
                                item,
                                itemIndex,
                                action: summarizeToolAction(item),
                              }))
                              .filter((row) => row.action !== null);
                            const showRawDetail = viewMode === "verbose";
                            return (
                              <section
                                key={key}
                                className="cdx-message cdx-message--detail cdx-desktop-tool-batch"
                                data-testid="desktop-tool-batch"
                                data-view-mode={viewMode}
                              >
                                <div className="cdx-desktop-tool-batch-summary">
                                  <span className="cdx-desktop-tool-batch-icon" aria-hidden="true">⚙</span>
                                  <span className="cdx-desktop-tool-batch-text">{segment.summary}</span>
                                </div>
                                <ul
                                  className="cdx-desktop-tool-action-list"
                                  data-testid="desktop-tool-action-list"
                                >
                                  {actionRows.map(({ action, itemIndex }) => {
                                    if (!action) return null;
                                    return (
                                      <li
                                        key={`${key}-action-${itemIndex}`}
                                        className={`cdx-desktop-tool-action cdx-desktop-tool-action--${action.kind}`}
                                        data-testid="desktop-tool-action"
                                        data-kind={action.kind}
                                      >
                                        <span className="cdx-desktop-tool-action-label">{action.label}</span>
                                      </li>
                                    );
                                  })}
                                </ul>
                                {showRawDetail ? (
                                  <details
                                    className="cdx-desktop-tool-batch-raw"
                                    data-testid="desktop-tool-batch-raw"
                                    open
                                  >
                                    <summary className="cdx-desktop-tool-batch-raw-summary">
                                      Raw call/output
                                    </summary>
                                    <div className="cdx-desktop-tool-batch-body">
                                      {segment.items.map((item, itemIndex) => {
                                        const itemKey = `${key}-raw-${itemIndex}`;
                                        if (item.kind === "toolCall") {
                                          return (
                                            <section
                                              key={itemKey}
                                              className="cdx-message cdx-message--tool"
                                              data-testid="desktop-tool-raw-call"
                                            >
                                              <div className="cdx-message-meta">
                                                <strong className="cdx-message-role">
                                                  Tool call: {item.toolName}
                                                </strong>
                                              </div>
                                              {item.text ? (
                                                <pre className="cdx-turn-body">
                                                  {truncateText(item.text, 4500)}
                                                </pre>
                                              ) : null}
                                            </section>
                                          );
                                        }
                                        if (item.kind === "toolResult") {
                                          return (
                                            <section
                                              key={itemKey}
                                              className="cdx-message cdx-message--detail"
                                              data-testid="desktop-tool-raw-output"
                                            >
                                              <div className="cdx-message-meta">
                                                <strong className="cdx-message-role">Tool output</strong>
                                              </div>
                                              <pre className="cdx-turn-body">
                                                {truncateText(item.text, 4500)}
                                              </pre>
                                            </section>
                                          );
                                        }
                                        return null;
                                      })}
                                    </div>
                                  </details>
                                ) : null}
                              </section>
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : null}
                    {shouldShowStreamingThinkingFallback ? (
                      <details
                        className="cdx-message cdx-message--detail cdx-desktop-thinking"
                        data-testid="desktop-thinking-streaming-fallback"
                        open
                      >
                        <summary className="cdx-message-meta">
                          <strong className="cdx-message-role">Thinking</strong>
                          <span className="cdx-stream-indicator" aria-live="polite">
                            <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                            Live
                          </span>
                        </summary>
                        <div className="cdx-turn-body cdx-turn-body--md">
                          <MarkdownText text={truncateText(turn.thinkingText ?? "", 6000)} />
                          <span className="cdx-stream-cursor" aria-hidden="true" />
                        </div>
                      </details>
                    ) : null}
                    {fallbackAssistantText ? (
                      <section
                        className={`cdx-message cdx-message--assistant ${
                          turn.isStreaming ? "cdx-message--assistant-streaming" : ""
                        }`}
                        data-testid="desktop-assistant-fallback"
                      >
                        {turn.isStreaming ? (
                          <span className="cdx-message-live-rail" aria-hidden="true" />
                        ) : null}
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Codex</strong>
                          <button
                            type="button"
                            className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                            onClick={() => void copyMessage(fallbackAssistantText)}
                          >
                            Copy
                          </button>
                        </div>
                        <div className="cdx-turn-body cdx-turn-body--md">
                          <MarkdownText text={truncateText(fallbackAssistantText, 9000)} />
                          {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                        </div>
                      </section>
                    ) : !hasAssistantSegment && turn.isStreaming ? (
                      <section className="cdx-thinking-placeholder" aria-live="polite">
                        <header className="cdx-thinking-placeholder-head">
                          <span className="cdx-stream-indicator">
                            <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                            Codex is responding
                          </span>
                        </header>
                        <div className="cdx-thinking-placeholder-bars" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </div>
                        <p className="cdx-helper cdx-helper--streaming">Codex is responding...</p>
                      </section>
                    ) : !hasAssistantSegment ? (
                      <p className={`cdx-helper ${turn.isStreaming ? "cdx-helper--streaming" : ""}`}>
                        {turn.isStreaming ? "Codex is responding..." : "Waiting for response..."}
                      </p>
                    ) : null}
                    {turnProgressByTurnId[turn.turnId] ? (
                      <section
                        className="cdx-message cdx-message--detail cdx-turn-progress-card"
                        data-testid="turn-progress-card"
                      >
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Codex tasks</strong>
                        </div>
                        <pre className="cdx-turn-body cdx-turn-body--plan">
                          {truncateText(turnProgressByTurnId[turn.turnId], 4000)}
                        </pre>
                      </section>
                    ) : null}
                    {actionablePlanByTurnId[turn.turnId] ? (
                      <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Plan ready</strong>
                        </div>
                        <pre className="cdx-turn-body cdx-turn-body--plan">
                          {truncateText(actionablePlanByTurnId[turn.turnId], 4000)}
                        </pre>
                        <div className="cdx-inline-actions">
                          <button
                            type="button"
                            className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                            onClick={() => openImplementDialog(turn.turnId, actionablePlanByTurnId[turn.turnId])}
                          >
                            Implement this plan
                          </button>
                          <button
                            type="button"
                            className="cdx-toolbar-btn"
                            onClick={() => keepPlanning(turn.turnId, actionablePlanByTurnId[turn.turnId])}
                          >
                            Keep planning
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>

          {activeApproval || activeInteraction ? (
            <aside data-testid="approval-drawer" className="cdx-approval-dock">
              <div className="cdx-inline-actions">
                <button
                  type="button"
                  className={`cdx-toolbar-btn ${desktopDockTab === "questions" ? "cdx-toolbar-btn--solid" : ""}`}
                  onClick={() => setDesktopDockTab("questions")}
                >
                  Questions ({pendingInteractionList.length})
                </button>
                <button
                  type="button"
                  className={`cdx-toolbar-btn ${desktopDockTab === "approvals" ? "cdx-toolbar-btn--solid" : ""}`}
                  onClick={() => setDesktopDockTab("approvals")}
                >
                  Approvals ({pendingApprovalList.length})
                </button>
              </div>
              {desktopDockTab === "questions" ? (
                activeInteraction ? (
                  <>
                    <div className="cdx-turn-head">
                      <strong>Questions Required</strong>
                      <span className="cdx-status is-pending">pending</span>
                    </div>
                    <InteractionQuestionForm
                      interactionId={activeInteraction.interactionId}
                      namePrefix="desktop"
                      questions={activeInteraction.questions}
                      drafts={desktopQuestionDrafts}
                      onDraftChange={updateDesktopQuestionDraft}
                    />
                    <button
                      type="button"
                      data-testid="interaction-submit"
                      className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                      disabled={
                        interactionBusy !== null ||
                        !answersForDesktopInteraction(activeInteraction)
                      }
                      onClick={() => {
                        const answers = answersForDesktopInteraction(activeInteraction);
                        if (!answers) {
                          return;
                        }
                        void respondInteraction(activeInteraction.interactionId, answers);
                      }}
                    >
                      Submit answers
                    </button>
                  </>
                ) : (
                  <p className="cdx-helper">No pending questions.</p>
                )
              ) : activeApproval ? (
                <>
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
                </>
              ) : (
                <p className="cdx-helper">No pending approvals.</p>
              )}
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
              onKeyDown={handlePromptKeyDown}
              placeholder="Ask Codex anything, / for commands"
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
              Mode: {collaborationMode} · Pending questions: {pendingInteractionList.length} · Shift+Tab toggle · /plan /review /status
            </p>
            <div className={`cdx-composer-row ${isMobileViewport ? "cdx-composer-row--mobile" : ""}`}>
              {isMobileViewport ? null : (
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
              )}
              <div className={`cdx-composer-right ${isMobileViewport ? "cdx-composer-right--mobile" : ""}`}>
                <label
                  className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                  htmlFor="model"
                >
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
                <label
                  className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                  htmlFor="thinking-effort"
                >
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
                <label
                  className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                  htmlFor="permission-mode"
                >
                  <span>Permission</span>
                  <select
                    id="permission-mode"
                    value={permissionMode}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next === "local" || next === "auto" || next === "full-access") {
                        setPermissionMode(next);
                      }
                    }}
                  >
                    <option value="local">Local (on-request)</option>
                    <option value="auto">Auto review</option>
                    <option value="full-access">Full access (never)</option>
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="turn-submit"
                  className={`cdx-send-btn ${isMobileViewport ? "cdx-send-btn--mobile" : ""}`}
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

      {implementDialogOpen ? (
        <div
          className="cdx-implement-overlay"
          data-testid="implement-dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setImplementDialogOpen(false);
            }
          }}
        >
          <section className="cdx-implement-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="cdx-turn-head">
              <strong>Implement plan</strong>
            </div>
            <textarea
              data-testid="implement-draft-input"
              value={implementDraft}
              onChange={(event) => setImplementDraft(event.target.value)}
              rows={12}
            />
            <div className="cdx-inline-actions">
              <button
                type="button"
                className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                onClick={() => void confirmImplementPlan()}
                disabled={submitting || implementDraft.trim().length === 0}
              >
                Implement this plan
              </button>
              <button
                type="button"
                className="cdx-toolbar-btn"
                onClick={() => {
                  if (implementTargetTurnId && implementTargetPlanText) {
                    keepPlanning(implementTargetTurnId, implementTargetPlanText);
                  }
                  setImplementDialogOpen(false);
                  setImplementTargetTurnId(null);
                  setImplementTargetPlanText(null);
                }}
              >
                Keep planning
              </button>
            </div>
          </section>
        </div>
      ) : null}

    </div>
  );
}
