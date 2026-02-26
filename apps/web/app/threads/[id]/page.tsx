"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  AccountRateLimitsResponse,
  ApprovalDecisionRequest,
  ApprovalView,
  CreateTurnResponse,
  CreateReviewRequest,
  CreateReviewResponse,
  GatewayEvent,
  InteractionRespondRequest,
  InteractionView,
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
import MobileChatTopBar from "./MobileChatTopBar";
import MobileComposerDock from "./MobileComposerDock";
import MobileControlSheet from "./MobileControlSheet";
import MobileMessageDetailsSheet from "./MobileMessageDetailsSheet";
import MobileMessageStream from "./MobileMessageStream";
import MobileThreadSwitcherOverlay, {
  type MobileThreadSwitcherItem,
} from "./MobileThreadSwitcherOverlay";
import TerminalDock from "./TerminalDock";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "lagging";

type Props = {
  params: Promise<{ id: string }>;
};

type PendingApprovalCard = ApprovalView;
type PendingInteractionCard = InteractionView;
type CollaborationModeKind = "plan" | "default";
type ControlSheetSection = "controls" | "settings" | "questions" | "approvals";
type ControlSheetSnap = "half" | "full";
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
  return "fileChange";
}

function approvalFromEvent(event: GatewayEvent): PendingApprovalCard | null {
  const payload = asRecord(event.payload);
  const approvalId = readString(payload, "approvalId");
  if (!approvalId) {
    return null;
  }

  const approvalType = readString(payload, "approvalType");
  const type =
    approvalType === "commandExecution" || approvalType === "fileChange"
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

function interactionFromEvent(event: GatewayEvent): PendingInteractionCard | null {
  const payload = asRecord(event.payload);
  const interactionId = readString(payload, "interactionId");
  if (!interactionId) {
    return null;
  }
  const questionsRaw = payload?.questions;
  if (!Array.isArray(questionsRaw)) {
    return null;
  }
  const questions = questionsRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const question = entry as Record<string, unknown>;
      const id = readString(question, "id");
      const header = readString(question, "header");
      const body = readString(question, "question");
      if (!id || !header || !body) {
        return null;
      }
      const options = Array.isArray(question.options)
        ? question.options
            .map((option) => {
              if (!option || typeof option !== "object") {
                return null;
              }
              const candidate = option as Record<string, unknown>;
              const label = readString(candidate, "label");
              const description = readString(candidate, "description");
              if (!label || !description) {
                return null;
              }
              return { label, description };
            })
            .filter((option): option is NonNullable<typeof option> => option !== null)
        : null;

      return {
        id,
        header,
        question: body,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options,
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null);

  return {
    interactionId,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: readString(payload, "itemId"),
    type: "userInput",
    status: "pending",
    questions,
    createdAt: event.serverTs,
    resolvedAt: null,
  };
}

function proposedPlanFromText(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/i);
  if (!match) {
    const hasPlanKeyword = /proposed[\s_-]*plan|implementation plan|plan ready|計劃|計畫|規劃/i.test(
      normalized,
    );
    if (!hasPlanKeyword) {
      return null;
    }

    const listLines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(\d+\.|[-*])\s+\S+/.test(line));
    if (listLines.length < 2) {
      return null;
    }
    return listLines.join("\n");
  }
  const body = match[1]?.trim();
  return body && body.length > 0 ? body : null;
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
  const initialThreadReadyRef = useRef(false);
  const previousThreadIdRef = useRef("");
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
  const [isThreadSwitcherOpen, setIsThreadSwitcherOpen] = useState(false);
  const [isControlSheetOpen, setIsControlSheetOpen] = useState(false);
  const [controlSheetSection, setControlSheetSection] = useState<ControlSheetSection>("controls");
  const [controlSheetSnap, setControlSheetSnap] = useState<ControlSheetSnap>("half");
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);
  const [sheetDragOffsetY, setSheetDragOffsetY] = useState(0);
  const [isMessageDetailsOpen, setIsMessageDetailsOpen] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [threadContext, setThreadContext] = useState<ThreadContextResponse | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(420);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [latestTokenUsage, setLatestTokenUsage] = useState<ThreadTokenUsageSummary | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [dismissedPlanReadyByTurn, setDismissedPlanReadyByTurn] = useState<
    Record<string, boolean>
  >({});
  const [desktopDockTab, setDesktopDockTab] = useState<"questions" | "approvals">("questions");
  const [desktopQuestionDrafts, setDesktopQuestionDrafts] = useState<
    Record<string, Record<string, { selected: string | null; other: string; freeform: string }>>
  >({});
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
  const [implementDraft, setImplementDraft] = useState("");
  const [implementTargetTurnId, setImplementTargetTurnId] = useState<string | null>(null);
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
    modeInitializedRef.current = false;
    statusQueryHandledRef.current = false;
    setLatestTokenUsage(null);
    setStatusBanner(null);
    setIsControlSheetOpen(false);
    setIsDraggingSheet(false);
    setSheetDragOffsetY(0);
    setIsMessageDetailsOpen(false);
    setActiveMessageId(null);
    setPendingInteractions({});
    setInteractionError(null);
    setDesktopDockTab("questions");
    setDesktopQuestionDrafts({});
    setDismissedPlanReadyByTurn({});
    setImplementDialogOpen(false);
    setImplementDraft("");
    setImplementTargetTurnId(null);
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
      setIsThreadSwitcherOpen(false);
      setIsMessageDetailsOpen(false);
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

  useEffect(() => {
    if (!isMobileViewport) {
      setIsThreadSwitcherOpen(false);
      setIsControlSheetOpen(false);
      setIsMessageDetailsOpen(false);
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
          setPendingApprovals(() =>
            Object.fromEntries(pending.data.map((item) => [item.approvalId, item])),
          );
          setPendingInteractions(() =>
            Object.fromEntries(
              pendingInteractionsResult.data.map((item) => [item.interactionId, item]),
            ),
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
        } else if (payload.name === "interaction/responded") {
          const interactionPayload = asRecord(payload.payload);
          const interactionId = readString(interactionPayload, "interactionId");
          if (interactionId) {
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
  const allConversationTurns = useMemo(
    () => buildConversationTurns(allTimelineItems),
    [allTimelineItems],
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
  const mobileThreadSwitcherItems = useMemo<MobileThreadSwitcherItem[]>(
    () =>
      [...threadList]
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
        .map((thread) => ({
          id: thread.id,
          title: thread.title || "(untitled thread)",
          projectLabel: projectLabelFromKey(thread.projectKey || "unknown"),
          lastActiveAt: thread.lastActiveAt,
          isActive: thread.id === threadId,
        })),
    [threadId, threadList],
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
    const planUpdatedByTurnId = new Map<string, string>();
    for (const item of allTimelineItems) {
      if (item.rawType !== "turn/plan/updated" || !item.turnId || !item.text) {
        continue;
      }
      planUpdatedByTurnId.set(item.turnId, item.text);
    }

    const result: Record<string, string> = {};
    for (const turn of allConversationTurns) {
      const plan =
        proposedPlanFromText(turn.assistantText) ??
        proposedPlanFromText(turn.thinkingText) ??
        planUpdatedByTurnId.get(turn.turnId) ??
        null;
      if (!plan) {
        continue;
      }
      result[turn.turnId] = plan;
    }
    return result;
  }, [allConversationTurns, allTimelineItems]);
  const visibleConversationTurns = useMemo(() => {
    const latestTurns = showAllTurns ? allConversationTurns : allConversationTurns.slice(-120);
    if (showAllTurns) {
      return latestTurns;
    }

    const pinnedTurns = allConversationTurns.filter(
      (turn) =>
        Boolean(planReadyByTurnId[turn.turnId]) &&
        !dismissedPlanReadyByTurn[turn.turnId] &&
        !latestTurns.some((candidate) => candidate.turnId === turn.turnId),
    );
    return [...pinnedTurns, ...latestTurns];
  }, [allConversationTurns, dismissedPlanReadyByTurn, planReadyByTurnId, showAllTurns]);
  const hiddenTimelineCount = Math.max(0, allConversationTurns.length - visibleConversationTurns.length);
  const pendingActionCount = pendingApprovalList.length + pendingInteractionList.length;
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
      updater: (prev: { selected: string | null; other: string; freeform: string }) => {
        selected: string | null;
        other: string;
        freeform: string;
      },
    ) => {
      setDesktopQuestionDrafts((prev) => {
        const interaction = prev[interactionId] ?? {};
        const current = interaction[questionId] ?? { selected: null, other: "", freeform: "" };
        const nextQuestion = updater(current);
        return {
          ...prev,
          [interactionId]: {
            ...interaction,
            [questionId]: nextQuestion,
          },
        };
      });
    },
    [],
  );

  const answersForDesktopInteraction = useCallback(
    (
      interaction: PendingInteractionCard,
    ): InteractionRespondRequest["answers"] | null => {
      const draft = desktopQuestionDrafts[interaction.interactionId] ?? {};
      const result: InteractionRespondRequest["answers"] = {};
      for (const question of interaction.questions) {
        const questionDraft = draft[question.id] ?? { selected: null, other: "", freeform: "" };
        const answers: string[] = [];
        if (question.options && question.options.length > 0) {
          if (questionDraft.selected && questionDraft.selected.trim().length > 0) {
            answers.push(questionDraft.selected.trim());
          }
        } else if (questionDraft.freeform.trim().length > 0) {
          answers.push(questionDraft.freeform.trim());
        }
        if (question.isOther && questionDraft.other.trim().length > 0) {
          answers.push(questionDraft.other.trim());
        }
        if (answers.length === 0) {
          return null;
        }
        result[question.id] = { answers };
      }
      return result;
    },
    [desktopQuestionDrafts],
  );

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

  const openImplementDialog = useCallback((turnId: string, planText: string) => {
    setImplementTargetTurnId(turnId);
    setImplementDraft(`Implement this plan:\n\n${planText}`);
    setImplementDialogOpen(true);
  }, []);

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

  async function respondInteraction(
    interactionId: string,
    answers: InteractionRespondRequest["answers"],
  ): Promise<void> {
    if (!threadId || interactionBusy) {
      return;
    }

    setInteractionBusy(interactionId);
    setInteractionError(null);
    try {
      const res = await fetch(
        `${gatewayUrl}/api/threads/${threadId}/interactions/${interactionId}/respond`,
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
      setPendingInteractions((prev) => {
        if (!prev[interactionId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[interactionId];
        return next;
      });
    } catch (interactionErr) {
      setInteractionError(
        interactionErr instanceof Error ? interactionErr.message : "interaction failed",
      );
    } finally {
      setInteractionBusy(null);
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

        const payload = (await res.json()) as CreateTurnResponse;
        if (payload.warnings?.includes("plan_mode_fallback")) {
          setSubmitError("Plan mode unavailable on this app-server; sent in default mode.");
        }
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

  const keepPlanning = useCallback((turnId: string) => {
    setDismissedPlanReadyByTurn((prev) => ({
      ...prev,
      [turnId]: true,
    }));
  }, []);

  const confirmImplementPlan = useCallback(async (): Promise<void> => {
    if (!implementDraft.trim()) {
      return;
    }
    const sent = await submitTurnText(implementDraft, "default");
    if (!sent) {
      return;
    }
    applyCollaborationMode("default");
    if (implementTargetTurnId) {
      setDismissedPlanReadyByTurn((prev) => ({
        ...prev,
        [implementTargetTurnId]: true,
      }));
    }
    setImplementDialogOpen(false);
    setImplementTargetTurnId(null);
    setImplementDraft("");
    setPrompt("");
  }, [applyCollaborationMode, implementDraft, implementTargetTurnId, submitTurnText]);

  const applyPromptSlash = useCallback((command: KnownSlashCommand) => {
    setPrompt((previous) => applySlashSuggestion(previous, command));
    setSlashMenuDismissed(false);
    setActiveSlashIndex(0);
  }, []);

  const openControlSheet = useCallback(
    (section: ControlSheetSection = "controls", snap: ControlSheetSnap = "half") => {
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

  const handlePromptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [
    activeSlashIndex,
    applyPromptSlash,
    sendTurn,
    slashMenuOpen,
    slashSuggestions,
    toggleCollaborationMode,
  ]);

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
  const sidebarVisible = !isMobileViewport && sidebarOpen && !isCompactViewport;
  const activeProjectLabel = projectLabelFromKey(activeProjectKey);
  const activeThreadTitle =
    detail?.thread.title?.trim() || activeThread?.title?.trim() || "(untitled thread)";
  const workspaceStyle = terminalEnabled
    ? ({
        "--cdx-terminal-width": `${terminalWidth}px`,
      } as CSSProperties)
    : undefined;
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

  if (isMobileViewport) {
    return (
      <div className="cdx-mobile-thread-page">
        <MobileChatTopBar
          threadTitle={activeThreadTitle}
          modelLabel={selectedModelLabel}
          pendingActionCount={pendingActionCount}
          onOpenThreads={() => setIsThreadSwitcherOpen(true)}
          onOpenControls={() =>
            openControlSheet(
              pendingInteractionList.length > 0
                ? "questions"
                : pendingApprovalList.length > 0
                  ? "approvals"
                  : "controls",
              "half",
            )
          }
        />

        <main className="cdx-mobile-thread-main">
          {statusBanner ? (
            <div className="cdx-mobile-status-banner" data-testid="status-banner">
              <span>{statusBanner.lines[0]}</span>
              <span>{statusBanner.lines[1]}</span>
              <span>{statusBanner.lines[2]}</span>
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
            renderTurnActions={(turnId) => {
              const planText = planReadyByTurnId[turnId];
              if (!planText || dismissedPlanReadyByTurn[turnId]) {
                return null;
              }
              return (
                <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                  <div className="cdx-message-meta">
                    <strong className="cdx-message-role">Plan ready</strong>
                  </div>
                  <pre className="cdx-turn-body cdx-turn-body--plan">{truncateText(planText, 4000)}</pre>
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
                      onClick={() => keepPlanning(turnId)}
                    >
                      Keep planning
                    </button>
                  </div>
                </section>
              );
            }}
          />
        </main>

        <MobileComposerDock
          prompt={prompt}
          submitting={submitting}
          canSend={prompt.trim().length > 0}
          collaborationMode={collaborationMode}
          slashMenuOpen={slashMenuOpen}
          slashSuggestions={slashSuggestions}
          activeSlashIndex={activeSlashIndex}
          onPromptChange={(value) => {
            setPrompt(value);
            setSlashMenuDismissed(false);
          }}
          onPromptKeyDown={handlePromptKeyDown}
          onApplySlash={applyPromptSlash}
          onSend={() => void sendTurn()}
          onOpenControls={() => openControlSheet("settings", "half")}
          onSwipeOpenControls={() => openControlSheet("controls", "full")}
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
          onSectionChange={setControlSheetSection}
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
                  if (implementTargetTurnId) {
                    keepPlanning(implementTargetTurnId);
                  }
                  setImplementDialogOpen(false);
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
          items={mobileThreadSwitcherItems}
          loading={threadListLoading}
          onClose={() => setIsThreadSwitcherOpen(false)}
          onSelect={selectThreadFromMobileSwitcher}
        />
      </div>
    );
  }

  return (
    <div className={`cdx-app ${sidebarVisible ? "" : "cdx-app--sidebar-collapsed"}`}>
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
                {activeProjectLabel}
              </button>
            </div>
            <p className="cdx-helper cdx-thread-seq">
              {detail?.thread.title ?? threadId} · seq <span data-testid="event-cursor">{lastSeq}</span>
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
                const userDisplayText = reviewSlashCommand ?? turn.userText;
                return (
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
                    {userDisplayText ? (
                      <section className="cdx-message cdx-message--user">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">You</strong>
                          {reviewSlashCommand ? <span className="cdx-status is-pending">slash command</span> : null}
                        </div>
                        <pre className="cdx-turn-body">{truncateText(userDisplayText, 9000)}</pre>
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
                    {planReadyByTurnId[turn.turnId] && !dismissedPlanReadyByTurn[turn.turnId] ? (
                      <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Plan ready</strong>
                        </div>
                        <pre className="cdx-turn-body cdx-turn-body--plan">
                          {truncateText(planReadyByTurnId[turn.turnId], 4000)}
                        </pre>
                        <div className="cdx-inline-actions">
                          <button
                            type="button"
                            className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                            onClick={() => openImplementDialog(turn.turnId, planReadyByTurnId[turn.turnId])}
                          >
                            Implement this plan
                          </button>
                          <button
                            type="button"
                            className="cdx-toolbar-btn"
                            onClick={() => keepPlanning(turn.turnId)}
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
                    <div className="cdx-mobile-sheet-form">
                      {activeInteraction.questions.map((question) => {
                        const current =
                          desktopQuestionDrafts[activeInteraction.interactionId]?.[question.id] ?? {
                            selected: null,
                            other: "",
                            freeform: "",
                          };
                        return (
                          <div key={`${activeInteraction.interactionId}-${question.id}`} className="cdx-mobile-sheet-field">
                            <span>{question.header}</span>
                            <p className="cdx-helper">{question.question}</p>
                            {question.options ? (
                              <div className="cdx-mobile-sheet-block">
                                {question.options.map((option) => (
                                  <label key={option.label} className="cdx-option-row">
                                    <input
                                      type="radio"
                                      name={`desktop-question-${activeInteraction.interactionId}-${question.id}`}
                                      aria-label={`${option.label} - ${option.description}`}
                                      checked={current.selected === option.label}
                                      onChange={(event) => {
                                        updateDesktopQuestionDraft(
                                          activeInteraction.interactionId,
                                          question.id,
                                          (prev) => ({
                                            ...prev,
                                            selected: event.target.checked ? option.label : null,
                                          }),
                                        );
                                      }}
                                    />
                                    <span className="cdx-option-text">
                                      <span className="cdx-option-title">{option.label}</span>
                                      <span className="cdx-option-desc">{option.description}</span>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <input
                                type={question.isSecret ? "password" : "text"}
                                value={current.freeform}
                                onChange={(event) => {
                                  updateDesktopQuestionDraft(
                                    activeInteraction.interactionId,
                                    question.id,
                                    (prev) => ({ ...prev, freeform: event.target.value }),
                                  );
                                }}
                              />
                            )}
                            {question.isOther ? (
                              <input
                                type={question.isSecret ? "password" : "text"}
                                value={current.other}
                                placeholder="Other"
                                onChange={(event) => {
                                  updateDesktopQuestionDraft(
                                    activeInteraction.interactionId,
                                    question.id,
                                    (prev) => ({ ...prev, other: event.target.value }),
                                  );
                                }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
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
              Mode: {collaborationMode} · Pending questions: {pendingInteractionList.length} · Shift+Tab toggle · /plan /review /status
            </p>
            <div className={`cdx-composer-row ${isMobileViewport ? "cdx-composer-row--mobile" : ""}`}>
              <div className={`cdx-inline-actions ${isMobileViewport ? "cdx-inline-actions--mobile" : ""}`}>
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
                  if (implementTargetTurnId) {
                    keepPlanning(implementTargetTurnId);
                  }
                  setImplementDialogOpen(false);
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
