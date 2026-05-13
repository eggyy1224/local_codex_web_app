import type { GatewayEvent, ThreadTimelineItem } from "@lcwa/shared-types";

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";

export type ConversationToolCall = {
  toolName: string;
  text: string | null;
};

export type ConversationDetail =
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "toolCall"; ts: string; toolName: string; text: string | null; callId: string | null }
  | { kind: "toolResult"; ts: string; text: string; callId: string | null };

export type TurnSegmentBatchItem = ConversationDetail;

export type TurnSegment =
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | {
      kind: "toolBatch";
      ts: string;
      summary: string;
      items: TurnSegmentBatchItem[];
    };

export type ConversationTurn = {
  turnId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TurnStatus;
  isStreaming: boolean;
  userText: string | null;
  /** Aggregated assistant text. Kept for compatibility with surfaces that
   * only want one line of the final reply (Copy button, message details
   * sheet, plan-ready detection). UIs that want the real interleaved
   * narrative should walk `segments` instead. */
  assistantText: string | null;
  thinkingText: string | null;
  toolCalls: ConversationToolCall[];
  toolResults: string[];
  /**
   * thinking / tool-call / tool-result entries in the order they happened on
   * the server (chronological by timeline item ts). Kept for surfaces that
   * just want the raw detail stream; UIs rendering the conversation should
   * prefer `segments` because it merges adjacent tool steps into batches and
   * splits assistant text into the segments Codex actually emitted.
   */
  details: ConversationDetail[];
  /**
   * The turn's assistant output split into segments in chronological order.
   * Each `assistant` segment is a separate agent_message that Codex emitted
   * (e.g. a "commentary" line before tool use, then a "final_answer" line
   * after). Each `toolBatch` collapses adjacent tool calls / results into
   * one summary row (e.g. "Ran 3 commands") with the per-item detail
   * available inside. `thinking` segments surface reasoning blocks between
   * tool batches.
   */
  segments: TurnSegment[];
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
  details: ConversationDetail[];
  detailKeys: Set<string>;
  // narrative carries each visible event in arrival order so we can split
  // the turn into chronological segments at finalization time.
  narrative: NarrativeEntry[];
  narrativeKeys: Set<string>;
};

type NarrativeEntry =
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "toolCall"; ts: string; toolName: string; text: string | null; callId: string | null }
  | { kind: "toolResult"; ts: string; text: string; callId: string | null };

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

function isMeaningfulPlanBody(body: string): boolean {
  // Reject placeholder-like content ("...", "…", whitespace-only) and anything
  // too short to be a real plan. The detector is opportunistic so the bar for
  // what counts as a plan needs to be higher than "non-empty".
  const trimmed = body.trim();
  if (trimmed.length < 8) return false;
  if (/^[.…\s]+$/.test(trimmed)) return false;
  return true;
}

export function proposedPlanFromText(text: string | null): string | null {
  if (!text) {
    return null;
  }
  // The plan-ready CTA is opt-in via an explicit <proposed_plan>...</proposed_plan>
  // tag emitted by Codex. The previous "keyword + bullets" fallback fired on
  // any feature-explanation reply that mentioned plan mode and contained list
  // items — a common, frustrating false positive. Code spans are stripped
  // first so the tag has to be a real markup element, not documentation that
  // quotes the tag inside backticks.
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

  const match = normalized.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/i);
  if (!match) {
    return null;
  }
  const body = match[1]?.trim() ?? "";
  return isMeaningfulPlanBody(body) ? body : null;
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

  // The noisy delta streams (agent message body, plan body, command stdout,
  // file change body) are dropped — accumulating them blew the rendered <pre>
  // to 40k+ chars on long turns and froze mobile rendering. The completed
  // item below carries the final text. Reasoning deltas are KEPT (and capped
  // downstream) so the user can still watch Codex think while a turn runs.
  if (
    event.name === "item/agentMessage/delta" ||
    event.name === "item/plan/delta" ||
    event.name === "item/commandExecution/outputDelta" ||
    event.name === "item/fileChange/outputDelta"
  ) {
    return null;
  }

  if (
    event.name === "item/reasoning/summaryTextDelta" ||
    event.name === "item/reasoning/textDelta"
  ) {
    const delta = readString(payload, "delta");
    if (!delta) return null;
    return {
      id: `${eventId}-reasoning-delta`,
      ts: event.serverTs,
      turnId: event.turnId,
      type: "reasoning",
      title: "Thinking",
      text: delta,
      rawType: event.name,
      toolName: null,
      callId: null,
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

function summarizeBatch(items: ConversationDetail[]): string {
  // Bucket tool calls by a coarse category so the collapsed summary reads
  // like a normal English status line ("Ran 3 commands, edited 1 file").
  // Tool results aren't counted on their own — they're paired with a call.
  const categories = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "toolCall") continue;
    const name = item.toolName.toLowerCase();
    let category: string;
    if (
      name === "exec_command" ||
      name === "shell" ||
      name === "bash" ||
      name.includes("command")
    ) {
      category = "command";
    } else if (name === "read_file" || name === "fs/readfile" || name.includes("read")) {
      category = "read";
    } else if (
      name === "write_file" ||
      name === "edit_file" ||
      name === "apply_patch" ||
      name.includes("write") ||
      name.includes("edit") ||
      name.includes("patch")
    ) {
      category = "edit";
    } else if (name.includes("search") || name.includes("grep") || name.includes("find")) {
      category = "search";
    } else {
      category = "tool";
    }
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }

  const phrases: string[] = [];
  const labelFor = (category: string, count: number): string => {
    if (category === "command") return count === 1 ? "1 command" : `${count} commands`;
    if (category === "read") return count === 1 ? "read 1 file" : `read ${count} files`;
    if (category === "edit") return count === 1 ? "edited 1 file" : `edited ${count} files`;
    if (category === "search") return count === 1 ? "1 search" : `${count} searches`;
    return count === 1 ? "1 tool" : `${count} tools`;
  };
  const order = ["command", "edit", "read", "search", "tool"];
  for (const category of order) {
    const count = categories.get(category);
    if (!count) continue;
    phrases.push(labelFor(category, count));
  }
  if (phrases.length === 0) {
    // batch of only outputs (shouldn't really happen but guard anyway)
    return `${items.length} steps`;
  }
  const head = phrases[0];
  const capitalized = head[0].toUpperCase() + head.slice(1);
  return [
    capitalized.startsWith("Read") || capitalized.startsWith("Edited")
      ? capitalized
      : `Ran ${head}`,
    ...phrases.slice(1),
  ].join(", ");
}

function buildSegmentsFromNarrative(narrative: NarrativeEntry[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let currentBatch: { ts: string; items: ConversationDetail[] } | null = null;

  const flushBatch = () => {
    if (!currentBatch || currentBatch.items.length === 0) {
      currentBatch = null;
      return;
    }
    segments.push({
      kind: "toolBatch",
      ts: currentBatch.ts,
      summary: summarizeBatch(currentBatch.items),
      items: currentBatch.items,
    });
    currentBatch = null;
  };

  for (const entry of narrative) {
    if (entry.kind === "assistant") {
      flushBatch();
      segments.push({ kind: "assistant", ts: entry.ts, text: entry.text });
      continue;
    }
    if (entry.kind === "thinking") {
      flushBatch();
      segments.push({ kind: "thinking", ts: entry.ts, text: entry.text });
      continue;
    }
    if (entry.kind === "toolCall") {
      if (!currentBatch) currentBatch = { ts: entry.ts, items: [] };
      currentBatch.items.push({
        kind: "toolCall",
        ts: entry.ts,
        toolName: entry.toolName,
        text: entry.text,
        callId: entry.callId,
      });
      continue;
    }
    if (entry.kind === "toolResult") {
      if (!currentBatch) currentBatch = { ts: entry.ts, items: [] };
      currentBatch.items.push({
        kind: "toolResult",
        ts: entry.ts,
        text: entry.text,
        callId: entry.callId,
      });
    }
  }
  flushBatch();

  return segments;
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
        details: [],
        detailKeys: new Set<string>(),
        narrative: [],
        narrativeKeys: new Set<string>(),
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
        const narrativeKey = `assistant|${comparableText(item.text)}`;
        if (!turn.narrativeKeys.has(narrativeKey)) {
          turn.narrativeKeys.add(narrativeKey);
          turn.narrative.push({ kind: "assistant", ts: item.ts, text: item.text });
        }
      }
      continue;
    }

    if (item.type === "reasoning") {
      if (item.rawType.includes("delta")) {
        turn.thinkingDelta += item.text;
        // Cap the live buffer so long reasoning streams can't recreate the
        // 40k-char <pre> stall we saw on agent message deltas.
        if (turn.thinkingDelta.length > 2000) {
          turn.thinkingDelta = turn.thinkingDelta.slice(-2000);
        }
      } else {
        appendUniqueText(turn.thinkingTexts, turn.thinkingSeen, item.text);
        const key = `think|${comparableText(item.text)}`;
        if (!turn.detailKeys.has(key)) {
          turn.detailKeys.add(key);
          turn.details.push({ kind: "thinking", ts: item.ts, text: item.text });
          turn.narrative.push({ kind: "thinking", ts: item.ts, text: item.text });
        }
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
      const detailKey = `call|${item.callId ?? ""}|${toolName}|${comparableText(item.text)}`;
      if (!turn.detailKeys.has(detailKey)) {
        turn.detailKeys.add(detailKey);
        turn.details.push({
          kind: "toolCall",
          ts: item.ts,
          toolName,
          text: item.text,
          callId: item.callId,
        });
        turn.narrative.push({
          kind: "toolCall",
          ts: item.ts,
          toolName,
          text: item.text,
          callId: item.callId,
        });
      }
      continue;
    }

    if (item.type === "toolResult") {
      const key = comparableText(item.text);
      if (!turn.toolResultSeen.has(key)) {
        turn.toolResultSeen.add(key);
        turn.toolResults.push(item.text);
      }
      const detailKey = `result|${item.callId ?? ""}|${comparableText(item.text)}`;
      if (!turn.detailKeys.has(detailKey)) {
        turn.detailKeys.add(detailKey);
        turn.details.push({
          kind: "toolResult",
          ts: item.ts,
          text: item.text,
          callId: item.callId,
        });
        turn.narrative.push({
          kind: "toolResult",
          ts: item.ts,
          text: item.text,
          callId: item.callId,
        });
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
      const hasProgressSignals = turn.assistantDelta.length > 0 || turn.thinkingDelta.length > 0;
      const hasResolvedSignals =
        Boolean(assistantText) || Boolean(thinkingText) || turn.toolResults.length > 0;
      const normalizedStatus =
        turn.status === "unknown"
          ? hasProgressSignals
            ? "inProgress"
            : hasResolvedSignals
              ? "completed"
              : "unknown"
          : turn.status;

      // `details` already arrived in chronological order because sortedItems
      // was sorted by ts. If reasoning is streaming (delta) and no completed
      // reasoning item has landed yet, surface the live buffer as a tail
      // entry so the user still sees Codex thinking; otherwise the live
      // text is already represented by a completed thinking detail.
      const details = [...turn.details];
      if (
        turn.thinkingDelta.length > 0 &&
        !details.some((d) => d.kind === "thinking" && d.text.includes(turn.thinkingDelta.slice(-80)))
      ) {
        details.push({
          kind: "thinking",
          ts: turn.completedAt ?? turn.startedAt ?? "",
          text: turn.thinkingDelta,
        });
      }

      const segments = buildSegmentsFromNarrative(turn.narrative);

      return {
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        status: normalizedStatus as TurnStatus,
        isStreaming: normalizedStatus === "inProgress",
        userText: bestUserText,
        assistantText,
        thinkingText,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
        details,
        segments,
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
