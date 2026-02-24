"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ApprovalDecisionRequest,
  ApprovalView,
  GatewayEvent,
  PendingApprovalsResponse,
  ThreadControlRequest,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadTimelineItem,
  ThreadTimelineResponse,
  TurnPermissionMode,
} from "@lcwa/shared-types";
import { groupThreadsByProject, pickDefaultProjectKey, projectLabelFromKey } from "../../lib/projects";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "lagging";
type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";

type Props = {
  params: Promise<{ id: string }>;
};

type PendingApprovalCard = ApprovalView;

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8787";
const SIDEBAR_SCROLL_STORAGE_KEY = "lcwa.sidebar.scroll.v1";
const PERMISSION_MODE_STORAGE_KEY = "lcwa.permission.mode.v1";
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

function timelineTypeLabel(type: ThreadTimelineItem["type"]): string {
  if (type === "assistantMessage") return "Assistant";
  if (type === "userMessage") return "User";
  if (type === "reasoning") return "Thinking";
  if (type === "toolCall") return "Tool call";
  if (type === "toolResult") return "Tool output";
  return "Status";
}

function timelineTypeClass(type: ThreadTimelineItem["type"]): string {
  if (type === "assistantMessage" || type === "toolResult") return "is-online";
  if (type === "reasoning" || type === "toolCall") return "is-pending";
  if (type === "status") return "is-offline";
  return "";
}

function stringifyUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timelineItemFromGatewayEvent(event: GatewayEvent): ThreadTimelineItem | null {
  const payload = asRecord(event.payload);
  const item = asRecord(payload?.item);
  const eventId = `live-${event.seq}`;

  if (event.name === "turn/started") {
    return {
      id: `${eventId}-turn-started`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Turn started",
      text: event.turnId ? `turn ${event.turnId}` : null,
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "turn/completed") {
    const turn = asRecord(payload?.turn);
    const status = readString(turn, "status");
    return {
      id: `${eventId}-turn-completed`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Turn completed",
      text: normalizeText(status ? `status: ${status}` : null),
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "approval/decision") {
    const decision = readString(payload, "decision");
    return {
      id: `${eventId}-approval-decision`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Approval decision",
      text: decision ? `decision: ${decision}` : null,
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name.includes("requestApproval")) {
    const reason = readString(payload, "reason");
    const command = readString(payload, "command");
    const grantRoot = readString(payload, "grantRoot");
    const lines = [reason, command ? `command: ${command}` : null, grantRoot ? `path: ${grantRoot}` : null]
      .filter((line): line is string => Boolean(line));
    return {
      id: `${eventId}-approval-request`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Approval requested",
      text: normalizeText(lines.join("\n")),
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "item/agentMessage/delta") {
    return null;
  }

  if ((event.name === "item/started" || event.name === "item/completed") && item) {
    const itemType = readString(item, "type");
    const callId = readString(item, "call_id") ?? readString(item, "callId");
    const itemTurnId = readString(item, "turn_id") ?? readString(item, "turnId") ?? event.turnId;

    if (itemType === "userMessage") {
      const text = extractUserMessageText(item);
      return text
        ? {
            id: `${eventId}-user`,
            ts: event.serverTs,
            turnId: itemTurnId,
            type: "userMessage",
            title: "User",
            text,
            rawType: itemType,
            toolName: null,
            callId,
          }
        : null;
    }

    if (itemType === "agentMessage") {
      const text = normalizeText(readString(item, "text"));
      return text
        ? {
            id: `${eventId}-assistant`,
            ts: event.serverTs,
            turnId: itemTurnId,
            type: "assistantMessage",
            title: "Assistant",
            text,
            rawType: itemType,
            toolName: null,
            callId,
          }
        : null;
    }

    if (itemType === "reasoning") {
      const summary = item.summary;
      const summaryText = Array.isArray(summary)
        ? summary
            .map((entry) => {
              if (typeof entry === "string") {
                return entry;
              }
              const entryRecord = asRecord(entry);
              return readString(entryRecord, "text");
            })
            .filter((entry): entry is string => Boolean(entry))
            .join("\n")
        : null;
      const text = normalizeText(summaryText ?? readString(item, "text"));
      return text
        ? {
            id: `${eventId}-reasoning`,
            ts: event.serverTs,
            turnId: itemTurnId,
            type: "reasoning",
            title: "Thinking",
            text,
            rawType: itemType,
            toolName: null,
            callId,
          }
        : null;
    }

    if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "web_search_call") {
      const toolName = readString(item, "name") ?? (itemType === "web_search_call" ? "web_search" : "tool");
      const text = normalizeText(
        readString(item, "arguments") ?? stringifyUnknown(item.arguments ?? item.input ?? item.query),
      );
      return {
        id: `${eventId}-tool-call`,
        ts: event.serverTs,
        turnId: itemTurnId,
        type: "toolCall",
        title: `Tool call: ${toolName}`,
        text,
        rawType: itemType,
        toolName,
        callId,
      };
    }

    if (
      itemType === "function_call_output" ||
      itemType === "custom_tool_call_output" ||
      itemType === "web_search_call_output"
    ) {
      const text = normalizeText(readString(item, "output") ?? stringifyUnknown(item.output ?? item.result));
      return {
        id: `${eventId}-tool-output`,
        ts: event.serverTs,
        turnId: itemTurnId,
        type: "toolResult",
        title: "Tool output",
        text,
        rawType: itemType,
        toolName: null,
        callId,
      };
    }
  }

  return null;
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
  const timelineInitializedRef = useRef(false);
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
  const [prompt, setPrompt] = useState("");
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
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);

  useEffect(() => {
    params.then((value) => setThreadId(value.id));
  }, [params]);

  useEffect(() => {
    const saved = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (saved === "local" || saved === "full-access") {
      setPermissionMode(saved);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode);
  }, [permissionMode]);

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

  const visibleEvents = useMemo(() => events.slice(-120), [events]);
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
  const hiddenTimelineCount = Math.max(0, allTimelineItems.length - 200);
  const visibleTimelineItems = showAllTurns ? allTimelineItems : allTimelineItems.slice(-200);

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
    visibleTimelineItems,
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
      const options: {
        cwd?: string;
        permissionMode: TurnPermissionMode;
      } = {
        permissionMode,
      };
      if (activeProjectKey !== "unknown") {
        options.cwd = activeProjectKey;
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
        throw new Error(`turn submit http ${res.status}`);
      }

      await res.json();
      setPrompt("");
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
            {hiddenTimelineCount > 0 && !showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(true)}
              >
                {hiddenTimelineCount} previous events
              </button>
            ) : null}

            {hiddenTimelineCount > 0 && showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(false)}
              >
                Show fewer events
              </button>
            ) : null}

            {visibleTimelineItems.length === 0 ? (
              <p className="cdx-helper">No timeline events yet.</p>
            ) : (
              visibleTimelineItems.map((item) => (
                <article className={`cdx-turn-card cdx-turn-card--event cdx-turn-card--${item.type}`} key={item.id}>
                  <div className="cdx-turn-head">
                    <strong>{item.title}</strong>
                    <span className={`cdx-status ${timelineTypeClass(item.type)}`}>
                      {timelineTypeLabel(item.type)}
                    </span>
                  </div>
                  <p className="cdx-turn-meta">
                    {formatTimestamp(item.ts)} · turn {item.turnId ?? "-"}
                  </p>
                  {item.toolName ? <p className="cdx-turn-meta">tool: {item.toolName}</p> : null}
                  {item.text ? (
                    <pre className="cdx-turn-body">{truncateText(item.text, 9000)}</pre>
                  ) : (
                    <p className="cdx-helper">(no text)</p>
                  )}
                  {item.text ? (
                    <button
                      type="button"
                      className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                      onClick={() => void copyMessage(item.text ?? "")}
                    >
                      Copy
                    </button>
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
                <label className="cdx-permission-select" htmlFor="permission-mode">
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
