"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ApprovalDecisionRequest,
  ApprovalView,
  CreateTurnResponse,
  GatewayEvent,
  PendingApprovalsResponse,
  ThreadControlRequest,
  ThreadControlResponse,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadTimelineItem,
  ThreadTimelineResponse,
} from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "../../lib/projects";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "lagging";
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

type TurnMessageKind = "user" | "assistant" | "thinking" | "plan" | "status";

type TurnMessage = {
  id: string;
  kind: TurnMessageKind;
  text: string;
};

type TurnSection = {
  id: string;
  status: TurnStatus;
  startedAt: string | null;
  completedAt: string | null;
  messages: TurnMessage[];
};

type ToolActivity = {
  id: string;
  turnId: string | null;
  ts: string;
  toolName: string;
  input: string | null;
  output: string | null;
};

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";
const SIDEBAR_SCROLL_STORAGE_KEY = "lcwa.sidebar.scroll.v1";
const TIMELINE_STICKY_THRESHOLD_PX = 56;
const ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX = 24;

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
  if (status === "completed") return "is-online";
  if (status === "inProgress") return "is-pending";
  return "is-offline";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractUserMessageText(item: Record<string, unknown>): string | null {
  const content = item.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const text = readString(part as Record<string, unknown>, "text");
    if (text) {
      parts.push(text);
    }
  }
  return normalizeText(parts.join("\n"));
}

function parseTurnMessages(items: unknown[]): TurnMessage[] {
  const parsed: TurnMessage[] = [];

  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const type = readString(record, "type");
    const itemId = readString(record, "id") ?? `item-${parsed.length + 1}`;

    if (type === "userMessage") {
      const text = extractUserMessageText(record);
      if (text) {
        parsed.push({ id: itemId, kind: "user", text });
      }
      continue;
    }

    if (type === "agentMessage") {
      const text = normalizeText(readString(record, "text"));
      if (text) {
        parsed.push({ id: itemId, kind: "assistant", text });
      }
      continue;
    }

    if (type === "reasoning") {
      const summary = record.summary;
      const lines =
        Array.isArray(summary)
          ? summary
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];
      const text = normalizeText(lines.join("\n"));
      if (text) {
        parsed.push({ id: itemId, kind: "thinking", text });
      }
      continue;
    }

    if (type === "plan") {
      const text = normalizeText(readString(record, "text"));
      if (text) {
        parsed.push({ id: itemId, kind: "plan", text });
      }
      continue;
    }

    if (type === "enteredReviewMode") {
      const review = normalizeText(readString(record, "review"));
      parsed.push({
        id: itemId,
        kind: "status",
        text: review ? `Entered review mode: ${review}` : "Entered review mode",
      });
      continue;
    }

    if (type === "exitedReviewMode") {
      parsed.push({
        id: itemId,
        kind: "status",
        text: "Exited review mode",
      });
      continue;
    }

    if (type === "contextCompaction") {
      parsed.push({
        id: itemId,
        kind: "status",
        text: "Context compacted",
      });
    }
  }

  return parsed;
}

function messageRoleLabel(kind: TurnMessageKind): string {
  if (kind === "user") return "User";
  if (kind === "assistant") return "Assistant";
  if (kind === "thinking") return "Thinking";
  if (kind === "plan") return "Plan";
  return "Status";
}

function messageRoleClass(kind: TurnMessageKind): string {
  if (kind === "assistant") return "is-online";
  if (kind === "thinking" || kind === "plan") return "is-pending";
  if (kind === "status") return "is-offline";
  return "";
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

export default function ThreadPage({ params }: Props) {
  const router = useRouter();
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineStickyRef = useRef(true);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const activeThreadCardRef = useRef<HTMLElement | null>(null);
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [lastEventAtMs, setLastEventAtMs] = useState<number>(Date.now());
  const [turnCards, setTurnCards] = useState<Record<string, TurnCard>>({});
  const [prompt, setPrompt] = useState("");
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
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);

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
        const [detailRes, approvalsRes, threadsRes, timelineRes] = await Promise.all([
          fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/approvals/pending`),
          fetch(`${gatewayUrl}/api/threads?limit=200`),
          fetch(`${gatewayUrl}/api/threads/${threadId}/timeline?limit=600`),
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

        const data = (await detailRes.json()) as ThreadDetailResponse;
        const pending = (await approvalsRes.json()) as PendingApprovalsResponse;
        const threadListResult = (await threadsRes.json()) as { data: ThreadListItem[] };
        const timeline = (await timelineRes.json()) as ThreadTimelineResponse;

        if (!cancelled) {
          setDetail(data);
          setThreadListLoading(false);
          setThreadList(threadListResult.data);
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
          setTimelineItems(timeline.data);
          setLoading(false);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setThreadListLoading(false);
          setLoading(false);
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

        const payloadRecord = asRecord(payload.payload);
        const turnFromPayload = asRecord(payloadRecord?.turn);
        const itemFromPayload = asRecord(payloadRecord?.item);
        const resolvedTurnId =
          payload.turnId ?? extractTurnId(payload.payload) ?? readString(payloadRecord, "turnId");

        setTurnCards((prev) => {
          const next = { ...prev };

          const ensureTurn = (turnIdValue: string): TurnCard => {
            const existing = next[turnIdValue];
            if (existing) return existing;
            const created: TurnCard = {
              id: turnIdValue,
              status: "inProgress",
              startedAt: null,
              completedAt: null,
              agentText: "",
              error: null,
            };
            next[turnIdValue] = created;
            return created;
          };

          if (payload.name === "turn/started") {
            const turnIdValue = readString(turnFromPayload, "id") ?? resolvedTurnId;
            if (turnIdValue) {
              const turn = ensureTurn(turnIdValue);
              turn.status = normalizeTurnStatus(readString(turnFromPayload, "status"));
              turn.startedAt = turn.startedAt ?? new Date(payload.serverTs).toISOString();
              turn.error = null;
            }
          }

          if (payload.name === "turn/completed") {
            const turnIdValue = readString(turnFromPayload, "id") ?? resolvedTurnId;
            if (turnIdValue) {
              const turn = ensureTurn(turnIdValue);
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
            const turnIdValue = resolvedTurnId;
            if (turnIdValue && readString(itemFromPayload, "type") === "agentMessage") {
              const turn = ensureTurn(turnIdValue);
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

  const turnSections = useMemo(() => {
    const sections = new Map<string, TurnSection>();

    for (const turn of detail?.turns ?? []) {
      const parsedItems = Array.isArray(turn.items) ? turn.items : [];
      sections.set(turn.id, {
        id: turn.id,
        status: normalizeTurnStatus(turn.status),
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        messages: parseTurnMessages(parsedItems),
      });
    }

    for (const liveTurn of orderedTurns) {
      const existing = sections.get(liveTurn.id);
      const liveText = normalizeText(liveTurn.agentText);

      if (!existing) {
        sections.set(liveTurn.id, {
          id: liveTurn.id,
          status: liveTurn.status,
          startedAt: liveTurn.startedAt,
          completedAt: liveTurn.completedAt,
          messages: liveText
            ? [{ id: `live-${liveTurn.id}`, kind: "assistant", text: liveText }]
            : liveTurn.status === "inProgress"
              ? [{ id: `live-wait-${liveTurn.id}`, kind: "status", text: "Generating response..." }]
              : [],
        });
        continue;
      }

      existing.status = liveTurn.status;
      existing.startedAt = existing.startedAt ?? liveTurn.startedAt;
      existing.completedAt = existing.completedAt ?? liveTurn.completedAt;

      if (liveTurn.status === "inProgress" && liveText) {
        const hasSame = existing.messages.some(
          (message) => message.kind === "assistant" && message.text === liveText,
        );
        if (!hasSame) {
          existing.messages = [
            ...existing.messages,
            { id: `live-${liveTurn.id}`, kind: "assistant", text: liveText },
          ];
        }
      }
    }

    return [...sections.values()].sort((a, b) => {
      const left = a.startedAt ?? a.completedAt ?? "";
      const right = b.startedAt ?? b.completedAt ?? "";
      if (left !== right) {
        return left.localeCompare(right);
      }
      return a.id.localeCompare(b.id);
    });
  }, [detail?.turns, orderedTurns]);

  const toolActivitiesByTurn = useMemo(() => {
    const sortedTimeline = [...timelineItems].sort((a, b) => {
      if (a.ts !== b.ts) {
        return a.ts.localeCompare(b.ts);
      }
      return a.id.localeCompare(b.id);
    });

    const activityByCallId = new Map<string, ToolActivity>();
    const activitiesByTurn = new Map<string, ToolActivity[]>();

    const addToTurn = (turnId: string, activity: ToolActivity): void => {
      const list = activitiesByTurn.get(turnId) ?? [];
      if (!list.find((entry) => entry.id === activity.id)) {
        list.push(activity);
        activitiesByTurn.set(turnId, list);
      }
    };

    for (const item of sortedTimeline) {
      if (item.type !== "toolCall" && item.type !== "toolResult") {
        continue;
      }

      const key = item.callId ?? item.id;
      const turnKey = item.turnId ?? "__unknown";

      if (item.type === "toolCall") {
        const activity: ToolActivity = {
          id: key,
          turnId: item.turnId,
          ts: item.ts,
          toolName: item.toolName ?? item.title ?? "tool",
          input: normalizeText(item.text ?? null),
          output: null,
        };
        activityByCallId.set(key, activity);
        addToTurn(turnKey, activity);
        continue;
      }

      const existing = activityByCallId.get(key);
      if (existing) {
        existing.output = normalizeText(item.text ?? null);
        continue;
      }

      const fallback: ToolActivity = {
        id: key,
        turnId: item.turnId,
        ts: item.ts,
        toolName: item.toolName ?? "tool",
        input: null,
        output: normalizeText(item.text ?? null),
      };
      activityByCallId.set(key, fallback);
      addToTurn(turnKey, fallback);
    }

    return activitiesByTurn;
  }, [timelineItems]);

  const hiddenTurnCount = Math.max(0, turnSections.length - 6);
  const visibleTurnSections = showAllTurns ? turnSections : turnSections.slice(-6);
  const visibleEvents = useMemo(() => events.slice(-120), [events]);
  const unknownToolActivities = toolActivitiesByTurn.get("__unknown") ?? [];
  const turnTimelineCards = useMemo(
    () =>
      visibleTurnSections.map((section) => {
        const userMessages = section.messages.filter((message) => message.kind === "user");
        const nonUserMessages = section.messages.filter((message) => message.kind !== "user");
        const visibleMessage =
          [...nonUserMessages].reverse().find((message) => message.kind === "assistant") ??
          nonUserMessages.at(-1) ??
          null;
        const hiddenMessages = visibleMessage
          ? nonUserMessages.filter((message) => message.id !== visibleMessage.id)
          : nonUserMessages;

        return {
          ...section,
          userMessages,
          visibleMessage,
          hiddenMessages,
          toolActivities: toolActivitiesByTurn.get(section.id) ?? [],
        };
      }),
    [visibleTurnSections, toolActivitiesByTurn],
  );

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
  }, [threadId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !timelineStickyRef.current) {
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
    hiddenTurnCount,
    turnTimelineCards,
    unknownToolActivities.length,
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
          options: activeProjectKey !== "unknown" ? { cwd: activeProjectKey } : undefined,
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

        <main className="cdx-main">
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
              <span className="cdx-status is-pending">
                Pending approval: {Object.keys(pendingApprovals).length}
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
          </section>

          <section
            className="cdx-timeline"
            data-testid="timeline"
            ref={timelineRef}
            onScroll={handleTimelineScroll}
          >
            {hiddenTurnCount > 0 && !showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(true)}
              >
                {hiddenTurnCount} previous messages
              </button>
            ) : null}

            {hiddenTurnCount > 0 && showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(false)}
              >
                Show fewer turns
              </button>
            ) : null}

            {turnTimelineCards.length === 0 ? (
              orderedTurns.map((turn) => (
                <article className="cdx-turn-card" key={`turn-${turn.id}`} data-testid={`turn-card-${turn.id}`}>
                  <div className="cdx-turn-head">
                    <strong>Turn {turn.id}</strong>
                    <span className={`cdx-status ${statusClass(turn.status)}`} data-testid={`turn-status-${turn.id}`}>
                      {turn.status}
                    </span>
                  </div>
                  <pre className="cdx-turn-body" data-testid={`turn-agent-${turn.id}`}>
                    {turn.agentText || "(waiting for output...)"}
                  </pre>
                  {turn.error ? <p className="cdx-error">error: {turn.error}</p> : null}
                </article>
              ))
            ) : (
              turnTimelineCards.map((turn) => {
                const previousMessageCount = turn.hiddenMessages.length + turn.toolActivities.length;

                return (
                  <article className="cdx-turn-card cdx-turn-card--conversation" key={turn.id}>
                    <div className="cdx-message-stack">
                      {turn.userMessages.map((message) => (
                        <article className="cdx-message cdx-message--user" key={`${turn.id}-${message.id}`}>
                          <div className="cdx-message-meta">
                            <span className="cdx-message-role">{messageRoleLabel(message.kind)}</span>
                            <button
                              type="button"
                              className="cdx-toolbar-btn cdx-toolbar-btn--small"
                              onClick={() => void copyMessage(message.text)}
                            >
                              Copy message
                            </button>
                          </div>
                          <pre className="cdx-turn-body">{message.text}</pre>
                        </article>
                      ))}

                      {previousMessageCount > 0 ? (
                        <details className="cdx-message-collapsible">
                          <summary>{previousMessageCount} previous messages</summary>
                          <div className="cdx-message-stack cdx-message-stack--details">
                            {turn.hiddenMessages.map((message) => (
                              <article className="cdx-message cdx-message--detail" key={`${turn.id}-${message.id}`}>
                                <div className="cdx-message-meta">
                                  <span className={`cdx-status ${messageRoleClass(message.kind)}`}>
                                    {messageRoleLabel(message.kind)}
                                  </span>
                                </div>
                                <pre className="cdx-turn-body">{message.text}</pre>
                              </article>
                            ))}

                            {turn.toolActivities.map((activity) => (
                              <article className="cdx-message cdx-message--tool" key={`${turn.id}-tool-${activity.id}`}>
                                <div className="cdx-message-meta">
                                  <span className="cdx-status is-pending">Tool call</span>
                                  <span className="cdx-helper">{activity.toolName}</span>
                                </div>
                                {activity.input ? (
                                  <pre className="cdx-turn-body">{truncateText(activity.input, 1800)}</pre>
                                ) : null}
                                {activity.output ? (
                                  <pre className="cdx-turn-body">{truncateText(activity.output, 1800)}</pre>
                                ) : null}
                              </article>
                            ))}
                          </div>
                        </details>
                      ) : null}

                      {turn.visibleMessage ? (
                        <article className="cdx-message cdx-message--assistant">
                          <div className="cdx-message-meta">
                            <span className={`cdx-status ${messageRoleClass(turn.visibleMessage.kind)}`}>
                              {messageRoleLabel(turn.visibleMessage.kind)}
                            </span>
                            <button
                              type="button"
                              className="cdx-toolbar-btn cdx-toolbar-btn--small"
                              onClick={() => void copyMessage(turn.visibleMessage?.text ?? "")}
                            >
                              Copy message
                            </button>
                          </div>
                          <pre className="cdx-turn-body">{turn.visibleMessage.text}</pre>
                        </article>
                      ) : (
                        <p className="cdx-helper">(waiting for output...)</p>
                      )}
                    </div>
                  </article>
                );
              })
            )}

            {unknownToolActivities.length > 0 ? (
              <article className="cdx-turn-card cdx-turn-card--timeline">
                <div className="cdx-turn-head">
                  <strong>Thread tool activity</strong>
                  <span className="cdx-status is-pending">{unknownToolActivities.length}</span>
                </div>
                <details className="cdx-message-collapsible">
                  <summary>Show thread-level tool activity</summary>
                  <div className="cdx-message-stack cdx-message-stack--details">
                    {unknownToolActivities.map((activity) => (
                      <article className="cdx-message cdx-message--tool" key={`thread-tool-${activity.id}`}>
                        <div className="cdx-message-meta">
                          <span className="cdx-status is-pending">{activity.toolName}</span>
                          <span className="cdx-helper">{formatTimestamp(activity.ts)}</span>
                        </div>
                        {activity.input ? (
                          <pre className="cdx-turn-body">{truncateText(activity.input, 1800)}</pre>
                        ) : null}
                        {activity.output ? (
                          <pre className="cdx-turn-body">{truncateText(activity.output, 1800)}</pre>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </details>
              </article>
            ) : null}
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
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask Codex anything, @ to add files, / for commands"
              rows={3}
            />
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
                <button type="button" className="cdx-toolbar-btn" disabled>
                  GPT-5.3-Codex-Spark
                </button>
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
      </div>

      {bottomPanelOpen ? (
        <section className="cdx-bottom-panel">
          <div className="cdx-bottom-header">
            <span>Terminal</span>
            <span>{showRawEvents ? "Raw Events" : "Event summary"}</span>
            <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--small" onClick={() => setShowRawEvents((v) => !v)}>
              {showRawEvents ? "Hide" : "Show"}
            </button>
          </div>
          <div className="cdx-bottom-body">
            {showRawEvents ? (
              <div className="cdx-event-list">
                {visibleEvents.map((event) => (
                  <article key={`event-${event.seq}`} data-testid={`event-${event.seq}`} className="cdx-event-row">
                    <div>
                      <strong>{event.name}</strong>
                      <p>
                        kind={event.kind} turn={event.turnId ?? "-"}
                      </p>
                    </div>
                    <span>#{event.seq}</span>
                  </article>
                ))}
                {visibleEvents.length === 0 ? <p className="cdx-helper">No events yet.</p> : null}
              </div>
            ) : (
              <p className="cdx-helper">Seq #{lastSeq}. Connection: {connectionText}.</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
