import type { GatewayEvent, ThreadTimelineItem } from "@lcwa/shared-types";

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";

export type ConversationToolCall = {
  toolName: string;
  text: string | null;
};

export type ConversationTurn = {
  turnId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TurnStatus;
  isStreaming: boolean;
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

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatTokenUsageStatus(payload: Record<string, unknown> | null): string | null {
  const tokenUsage = asRecord(payload?.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  const modelContextWindow = tokenUsage?.modelContextWindow;
  const totalTokens = typeof total?.totalTokens === "number" ? total.totalTokens : null;
  const inputTokens = typeof total?.inputTokens === "number" ? total.inputTokens : null;
  const outputTokens = typeof total?.outputTokens === "number" ? total.outputTokens : null;
  const contextWindow = typeof modelContextWindow === "number" ? modelContextWindow : null;
  const parts = [
    totalTokens !== null ? `total ${totalTokens}` : null,
    inputTokens !== null ? `input ${inputTokens}` : null,
    outputTokens !== null ? `output ${outputTokens}` : null,
    contextWindow !== null ? `window ${contextWindow}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
}

function formatPlanUpdateStatus(payload: Record<string, unknown> | null): string | null {
  const lines: string[] = [];
  const explanation = readString(payload, "explanation");
  if (explanation) {
    lines.push(explanation);
  }
  if (Array.isArray(payload?.plan)) {
    for (const entry of payload.plan) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const step = readString(entry as Record<string, unknown>, "step");
      const status = readString(entry as Record<string, unknown>, "status");
      if (!step || !status) {
        continue;
      }
      lines.push(`[${status}] ${step}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
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

export function statusClass(status: TurnStatus): string {
  if (status === "completed") return "is-online";
  if (status === "inProgress") return "is-pending";
  return "is-offline";
}

export function statusLabel(status: TurnStatus): string {
  if (status === "completed") return "Completed";
  if (status === "inProgress") return "In progress";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Unknown";
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

export function formatEffortLabel(effort: string): string {
  return effort
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function timelineItemFromGatewayEvent(event: GatewayEvent): ThreadTimelineItem | null {
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

  if (event.name === "thread/tokenUsage/updated") {
    const itemTurnId = readString(payload, "turnId") ?? readString(payload, "turn_id") ?? event.turnId;
    return {
      id: `${eventId}-token-usage`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "status",
      title: "Token usage updated",
      text: formatTokenUsageStatus(payload),
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "turn/plan/updated") {
    const itemTurnId = readString(payload, "turnId") ?? readString(payload, "turn_id") ?? event.turnId;
    return {
      id: `${eventId}-turn-plan-updated`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "status",
      title: "Plan updated",
      text: formatPlanUpdateStatus(payload),
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

  if (event.name === "item/tool/requestUserInput" || event.name === "tool/requestUserInput") {
    const questions = Array.isArray(payload?.questions)
      ? payload.questions
          .map((entry) => {
            if (!entry || typeof entry !== "object") {
              return null;
            }
            const record = entry as Record<string, unknown>;
            const header = readString(record, "header");
            const question = readString(record, "question");
            if (header && question) {
              return `${header}: ${question}`;
            }
            return question ?? header;
          })
          .filter((entry): entry is string => Boolean(entry))
      : [];
    return {
      id: `${eventId}-interaction-request`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Question requested",
      text: normalizeText(questions.join("\n")),
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "interaction/responded") {
    return {
      id: `${eventId}-interaction-responded`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Question answered",
      text: null,
      rawType: event.name,
      toolName: null,
      callId: null,
    };
  }

  if (event.name === "interaction/cancelled") {
    const reason = readString(payload, "reason");
    return {
      id: `${eventId}-interaction-cancelled`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "status",
      title: "Question cancelled",
      text: reason,
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

  if (event.name === "item/plan/delta") {
    const text = normalizeText(readString(payload, "delta") ?? readString(payload, "text"));
    if (!text) {
      return null;
    }
    const itemTurnId = readString(payload, "turn_id") ?? readString(payload, "turnId") ?? event.turnId;
    const callId = readString(payload, "itemId") ?? readString(payload, "item_id");
    return {
      id: `${eventId}-plan-delta`,
      ts: event.serverTs,
      turnId: itemTurnId,
      type: "reasoning",
      title: "Plan",
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

    if (itemType === "plan") {
      const text = normalizeText(readString(item, "text"));
      return text
        ? {
            id: `${eventId}-plan`,
            ts: event.serverTs,
            turnId: itemTurnId,
            type: "reasoning",
            title: "Plan",
            text,
            rawType: itemType,
            toolName: null,
            callId,
          }
        : null;
    }

    if (itemType === "enteredReviewMode" || itemType === "exitedReviewMode") {
      const reviewText = normalizeText(readString(item, "review"));
      return {
        id: `${eventId}-${itemType}`,
        ts: event.serverTs,
        turnId: itemTurnId,
        type: "status",
        title: itemType === "enteredReviewMode" ? "Entered review mode" : "Exited review mode",
        text: reviewText,
        rawType: itemType,
        toolName: null,
        callId,
      };
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

export function buildConversationTurns(items: ThreadTimelineItem[]): ConversationTurn[] {
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
        isStreaming: turn.status === "inProgress",
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
