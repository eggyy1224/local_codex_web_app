"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ApprovalDecisionRequest,
  ApprovalView,
  GatewayEvent,
  ModelOption,
  ModelsResponse,
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
const MODEL_STORAGE_KEY = "lcwa.model.v1";
const THINKING_EFFORT_STORAGE_KEY = "lcwa.thinking.effort.v1";
const TIMELINE_STICKY_THRESHOLD_PX = 56;
const ACTIVE_THREAD_SCROLL_SNAP_THRESHOLD_PX = 24;

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

function statusClass(status: TurnStatus): string {
  if (status === "completed") return "is-online";
  if (status === "inProgress") return "is-pending";
  return "is-offline";
}

function statusLabel(status: TurnStatus): string {
  if (status === "completed") return "Completed";
  if (status === "inProgress") return "In progress";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Unknown";
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

function formatEffortLabel(effort: string): string {
  return effort
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
    const text = normalizeText(readString(payload, "delta") ?? readString(payload, "text"));
    if (!text) {
      return null;
    }
    const itemTurnId = readString(payload, "turn_id") ?? readString(payload, "turnId") ?? event.turnId;
    const callId = readString(payload, "itemId") ?? readString(payload, "item_id");
    return {
      id: `${eventId}-assistant-delta`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "assistantMessage",
      title: "Assistant",
      text,
      rawType: event.name,
      toolName: null,
      callId,
    };
  }

  if (event.name === "item/reasoning/summaryTextDelta" || event.name === "item/reasoning/textDelta") {
    const text = normalizeText(readString(payload, "delta") ?? readString(payload, "text"));
    if (!text) {
      return null;
    }
    const itemTurnId = readString(payload, "turn_id") ?? readString(payload, "turnId") ?? event.turnId;
    const callId = readString(payload, "itemId") ?? readString(payload, "item_id");
    return {
      id: `${eventId}-reasoning-delta`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "reasoning",
      title: "Thinking",
      text,
      rawType: event.name,
      toolName: null,
      callId,
    };
  }

  if (event.name === "item/commandExecution/outputDelta" || event.name === "item/fileChange/outputDelta") {
    const text = normalizeText(readString(payload, "delta") ?? readString(payload, "output"));
    if (!text) {
      return null;
    }
    const itemTurnId = readString(payload, "turn_id") ?? readString(payload, "turnId") ?? event.turnId;
    const callId = readString(payload, "itemId") ?? readString(payload, "item_id");
    return {
      id: `${eventId}-tool-output-delta`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "toolResult",
      title: "Tool output",
      text,
      rawType: event.name,
      toolName: event.name.includes("commandExecution") ? "command" : "apply_patch",
      callId,
    };
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

type ConversationToolCall = {
  toolName: string;
  text: string | null;
};

type ConversationTurn = {
  turnId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TurnStatus;
  userText: string | null;
  assistantText: string | null;
  thinkingText: string | null;
  toolCalls: ConversationToolCall[];
  toolResults: string[];
};

type MutableConversationTurn = {
  turnId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TurnStatus;
  userTexts: string[];
  assistantTexts: string[];
  thinkingTexts: string[];
  assistantDelta: string;
  thinkingDelta: string;
  toolCalls: ConversationToolCall[];
  toolResults: string[];
  toolCallSeen: Set<string>;
  toolResultSeen: Set<string>;
  userSeen: Set<string>;
  assistantSeen: Set<string>;
  thinkingSeen: Set<string>;
};

function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function appendUniqueText(target: string[], seen: Set<string>, text: string): void {
  const key = comparableText(text);
  if (!key || seen.has(key)) {
    return;
  }
  seen.add(key);
  target.push(text);
}

function parseTurnStatus(item: ThreadTimelineItem): TurnStatus | null {
  if (item.rawType === "turn/started") {
    return "inProgress";
  }
  if (item.rawType === "turn/completed") {
    const text = (item.text ?? "").toLowerCase();
    if (text.includes("failed")) return "failed";
    if (text.includes("interrupted")) return "interrupted";
    if (text.includes("completed")) return "completed";
    return "completed";
  }
  return null;
}

function mergeStreamedText(fullText: string | null, streamedText: string): string {
  if (!fullText) {
    return streamedText;
  }
  if (fullText.includes(streamedText)) {
    return fullText;
  }
  if (streamedText.includes(fullText)) {
    return streamedText;
  }
  if (fullText.length >= streamedText.length) {
    return fullText;
  }
  return streamedText;
}

function buildConversationTurns(items: ThreadTimelineItem[]): ConversationTurn[] {
  const byTurnId = new Map<string, MutableConversationTurn>();

  const sortedItems = [...items].sort((a, b) => {
    if (a.ts !== b.ts) {
      return a.ts.localeCompare(b.ts);
    }
    return a.id.localeCompare(b.id);
  });

  for (const item of sortedItems) {
    if (!item.turnId) {
      continue;
    }

    const turnId = item.turnId;
    const existing = byTurnId.get(turnId);
    const turn: MutableConversationTurn =
      existing ??
      {
        turnId,
        startedAt: null,
        completedAt: null,
        status: "unknown",
        userTexts: [],
        assistantTexts: [],
        thinkingTexts: [],
        assistantDelta: "",
        thinkingDelta: "",
        toolCalls: [],
        toolResults: [],
        toolCallSeen: new Set<string>(),
        toolResultSeen: new Set<string>(),
        userSeen: new Set<string>(),
        assistantSeen: new Set<string>(),
        thinkingSeen: new Set<string>(),
      };

    if (!existing) {
      byTurnId.set(turnId, turn);
    }

    if (!turn.startedAt || item.ts < turn.startedAt) {
      turn.startedAt = item.ts;
    }
    if (!turn.completedAt || item.ts > turn.completedAt) {
      turn.completedAt = item.ts;
    }

    const nextStatus = parseTurnStatus(item);
    if (nextStatus) {
      turn.status = nextStatus;
    }

    if (!item.text) {
      continue;
    }

    if (item.type === "userMessage") {
      appendUniqueText(turn.userTexts, turn.userSeen, item.text);
      continue;
    }

    if (item.type === "assistantMessage") {
      if (item.rawType === "item/agentMessage/delta") {
        turn.assistantDelta += item.text;
        if (turn.status === "unknown") {
          turn.status = "inProgress";
        }
      } else {
        appendUniqueText(turn.assistantTexts, turn.assistantSeen, item.text);
      }
      continue;
    }

    if (item.type === "reasoning") {
      if (item.rawType.includes("delta")) {
        turn.thinkingDelta += item.text;
      } else {
        appendUniqueText(turn.thinkingTexts, turn.thinkingSeen, item.text);
      }
      continue;
    }

    if (item.type === "toolCall") {
      const toolName = item.toolName ?? "tool";
      const key = `${toolName}|${comparableText(item.text)}`;
      if (!turn.toolCallSeen.has(key)) {
        turn.toolCallSeen.add(key);
        turn.toolCalls.push({ toolName, text: item.text });
      }
      continue;
    }

    if (item.type === "toolResult") {
      const key = comparableText(item.text);
      if (!turn.toolResultSeen.has(key)) {
        turn.toolResultSeen.add(key);
        turn.toolResults.push(item.text);
      }
    }
  }

  return Array.from(byTurnId.values())
    .map((turn) => {
      const bestUserText =
        turn.userTexts.sort((a, b) => b.length - a.length)[0] ?? null;
      const assistantBase =
        turn.assistantTexts.sort((a, b) => b.length - a.length)[0] ?? null;
      const assistantText =
        turn.assistantDelta.length > 0
          ? mergeStreamedText(assistantBase, turn.assistantDelta)
          : assistantBase;
      const thinkingBase = turn.thinkingTexts.join("\n\n");
      const thinkingText =
        turn.thinkingDelta.length > 0
          ? mergeStreamedText(thinkingBase || null, turn.thinkingDelta)
          : thinkingBase || null;

      return {
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        status: turn.status,
        userText: bestUserText,
        assistantText,
        thinkingText,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
      };
    })
    .filter(
      (turn) =>
        Boolean(turn.userText) ||
        Boolean(turn.assistantText) ||
        Boolean(turn.thinkingText) ||
        turn.toolCalls.length > 0 ||
        turn.toolResults.length > 0,
    );
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
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(FALLBACK_MODEL_OPTIONS[0]?.value ?? "gpt-5.3-codex");
  const [thinkingEffort, setThinkingEffort] = useState<string>("high");
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

  useEffect(() => {
    params.then((value) => setThreadId(value.id));
  }, [params]);

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
        model: string;
        effort: string;
        permissionMode: TurnPermissionMode;
      } = {
        model,
        effort: thinkingEffort,
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
                <article className="cdx-turn-card cdx-turn-card--conversation" key={turn.turnId}>
                  <div className="cdx-turn-head">
                    <strong>Turn</strong>
                    <span className={`cdx-status ${statusClass(turn.status)}`}>
                      {statusLabel(turn.status)}
                    </span>
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
                    <section className="cdx-message cdx-message--assistant">
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
                      <pre className="cdx-turn-body">{truncateText(turn.assistantText, 9000)}</pre>
                    </section>
                  ) : (
                    <p className="cdx-helper">Waiting for response...</p>
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
              onChange={(event) => setPrompt(event.target.value)}
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
                void sendTurn();
              }}
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
