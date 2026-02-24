import type { ThreadTimelineItem } from "@lcwa/shared-types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  obj: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!obj) {
    return null;
  }
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function stringifyCompact(value: unknown): string | null {
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

function truncateText(value: string | null, maxLength = 2000): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...`;
}

function pushTimelineItem(
  items: ThreadTimelineItem[],
  next: ThreadTimelineItem,
): void {
  const previous = items[items.length - 1];
  if (
    previous &&
    previous.type === next.type &&
    previous.turnId === next.turnId &&
    previous.text === next.text &&
    previous.rawType === next.rawType
  ) {
    return;
  }
  items.push(next);
}

export function parseTimelineItemsFromLines(
  lines: string[],
  threadId: string,
  limit: number,
): ThreadTimelineItem[] {
  const items: ThreadTimelineItem[] = [];
  let lineNumber = 0;
  let activeTurnId: string | null = null;

  const buildId = (prefix: string): string => `${prefix}-${threadId}-${lineNumber}`;

  for (const line of lines) {
    lineNumber += 1;
    if (!line) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const timestamp =
      (typeof parsed.timestamp === "string" ? parsed.timestamp : null) ??
      new Date().toISOString();
    const lineType = typeof parsed.type === "string" ? parsed.type : "";

    if (lineType === "event_msg") {
      const payload = asRecord(parsed.payload);
      const payloadType = pickString(payload, "type");
      const turnFromPayload = pickString(payload, "turn_id", "turnId");
      if (turnFromPayload) {
        activeTurnId = turnFromPayload;
      }
      const eventTurnId = turnFromPayload ?? activeTurnId;

      if (payloadType === "task_started") {
        pushTimelineItem(items, {
          id: buildId("status"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "status",
          title: "Turn started",
          text: eventTurnId ? `turn ${eventTurnId}` : null,
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        continue;
      }

      if (payloadType === "task_complete") {
        pushTimelineItem(items, {
          id: buildId("status"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "status",
          title: "Turn completed",
          text: eventTurnId ? `turn ${eventTurnId}` : null,
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        if (turnFromPayload && activeTurnId === turnFromPayload) {
          activeTurnId = null;
        }
        continue;
      }

      if (payloadType === "turn_aborted") {
        pushTimelineItem(items, {
          id: buildId("status"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "status",
          title: "Turn interrupted",
          text: eventTurnId ? `turn ${eventTurnId}` : null,
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        if (turnFromPayload && activeTurnId === turnFromPayload) {
          activeTurnId = null;
        }
        continue;
      }

      if (payloadType === "entered_review_mode" || payloadType === "exited_review_mode") {
        pushTimelineItem(items, {
          id: buildId("status"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "status",
          title: payloadType === "entered_review_mode" ? "Entered review mode" : "Exited review mode",
          text: pickString(payload, "user_facing_hint"),
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        continue;
      }

      if (payloadType === "context_compacted") {
        pushTimelineItem(items, {
          id: buildId("status"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "status",
          title: "Context compacted",
          text: null,
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        continue;
      }

      if (payloadType === "user_message") {
        pushTimelineItem(items, {
          id: buildId("user"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "userMessage",
          title: "User",
          text: truncateText(pickString(payload, "message"), 4000),
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        continue;
      }

      if (payloadType === "agent_message") {
        pushTimelineItem(items, {
          id: buildId("assistant"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "assistantMessage",
          title: "Assistant",
          text: truncateText(pickString(payload, "message"), 6000),
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
        continue;
      }

      if (payloadType === "agent_reasoning") {
        pushTimelineItem(items, {
          id: buildId("reasoning"),
          ts: timestamp,
          turnId: eventTurnId,
          type: "reasoning",
          title: "Thinking",
          text: truncateText(pickString(payload, "text"), 2000),
          rawType: payloadType,
          toolName: null,
          callId: null,
        });
      }
      continue;
    }

    if (lineType !== "response_item") {
      continue;
    }

    const payload = asRecord(parsed.payload);
    const payloadType = pickString(payload, "type");
    const callId = pickString(payload, "call_id");

    if (
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "web_search_call"
    ) {
      const toolName =
        pickString(payload, "name") ??
        (payloadType === "web_search_call" ? "web_search" : "tool");
      const argumentsText = truncateText(
        pickString(payload, "arguments", "input", "query") ??
          stringifyCompact(payload?.arguments ?? payload?.input ?? payload?.query),
        1800,
      );
      pushTimelineItem(items, {
        id: buildId("tool-call"),
        ts: timestamp,
        turnId: activeTurnId,
        type: "toolCall",
        title: `Tool call: ${toolName}`,
        text: argumentsText,
        rawType: payloadType,
        toolName,
        callId,
      });
      continue;
    }

    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output" ||
      payloadType === "web_search_call_output"
    ) {
      const outputText = truncateText(
        pickString(payload, "output") ??
          stringifyCompact(payload?.output ?? payload?.result ?? payload?.response),
        2200,
      );
      pushTimelineItem(items, {
        id: buildId("tool-result"),
        ts: timestamp,
        turnId: activeTurnId,
        type: "toolResult",
        title: "Tool output",
        text: outputText,
        rawType: payloadType,
        toolName: null,
        callId,
      });
    }
  }

  if (items.length <= limit) {
    return items;
  }
  return items.slice(-limit);
}
