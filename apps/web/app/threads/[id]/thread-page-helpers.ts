import type {
  AccountRateLimitsResponse,
  ApprovalView,
  GatewayEvent,
  InteractionView,
  ThreadListItem,
  ThreadStatus,
} from "@lcwa/shared-types";

export type PendingApprovalCard = ApprovalView;
export type PendingInteractionCard = InteractionView;
export type CollaborationModeKind = "plan" | "default";
export type PlanActionState = "dismissed" | "implemented";

export type ThreadTokenUsageSummary = {
  threadId: string;
  turnId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  // `last` request's total tokens = the live context-window occupancy (the
  // whole conversation is resent every turn). This — not the cumulative
  // `totalTokens` — is what the context indicator must divide by the window.
  lastTokens: number | null;
  modelContextWindow: number | null;
  updatedAt: string;
};

export const THREAD_MODE_STORAGE_KEY_PREFIX = "lcwa.thread.mode.v1";
export const PLAN_ACTION_STORAGE_KEY_PREFIX = "lcwa.thread.planAction.v1";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export function readString(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function isThreadStatus(value: string | null): value is ThreadStatus {
  return (
    value === "notLoaded" ||
    value === "idle" ||
    value === "active" ||
    value === "systemError" ||
    value === "unknown"
  );
}

function maxIsoTimestamp(current: string, candidate: string): string {
  return candidate > current ? candidate : current;
}

// Reduce a single gateway event onto a sidebar row. Callers MUST only feed
// genuinely-live events here (seq > the snapshot head): the historical backlog
// is dropped upstream by the SSE since-cursor and the event-store reducer, so a
// long-completed turn/started can no longer strand a row on "active".
export function threadListItemFromGatewayEvent(
  item: ThreadListItem,
  event: GatewayEvent,
): ThreadListItem {
  if (item.id !== event.threadId) {
    return item;
  }

  if (event.name === "turn/started") {
    return {
      ...item,
      status: "active",
      lastActiveAt: maxIsoTimestamp(item.lastActiveAt, event.serverTs),
    };
  }

  if (event.name === "turn/completed") {
    const payload = asRecord(event.payload);
    const turn = asRecord(payload?.turn);
    const turnStatus = readString(turn, "status") ?? readString(payload, "status");
    const status: ThreadStatus =
      turnStatus === "failed" || turnStatus === "error" ? "systemError" : "idle";
    return {
      ...item,
      status,
      lastActiveAt: maxIsoTimestamp(item.lastActiveAt, event.serverTs),
    };
  }

  if (event.name === "thread/updated") {
    const payload = asRecord(event.payload);
    const thread = asRecord(payload?.thread);
    const status = readString(thread, "status") ?? readString(payload, "status");
    if (!isThreadStatus(status)) {
      return item;
    }
    return {
      ...item,
      status,
      lastActiveAt: maxIsoTimestamp(item.lastActiveAt, event.serverTs),
    };
  }

  return item;
}

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function approvalTypeFromEventName(
  eventName: string,
): PendingApprovalCard["type"] {
  if (eventName === "item/commandExecution/requestApproval") return "commandExecution";
  return "fileChange";
}

export function approvalFromEvent(event: GatewayEvent): PendingApprovalCard | null {
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

export function interactionFromEvent(event: GatewayEvent): PendingInteractionCard | null {
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
      const normalizedOptions = options && options.length > 0 ? options : null;

      return {
        id,
        header,
        question: body,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options: normalizedOptions,
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

export function isCollaborationModeKind(
  value: string | null,
): value is CollaborationModeKind {
  return value === "plan" || value === "default";
}

export function threadModeStorageKey(threadId: string): string {
  return `${THREAD_MODE_STORAGE_KEY_PREFIX}.${threadId}`;
}

export function normalizePlanActionText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function planActionHash(text: string): string {
  let hash = 2166136261;
  const normalized = normalizePlanActionText(text);
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

export function planActionStorageKey(
  threadId: string,
  turnId: string,
  planText: string,
): string {
  return [
    PLAN_ACTION_STORAGE_KEY_PREFIX,
    encodeURIComponent(threadId),
    encodeURIComponent(turnId),
    planActionHash(planText),
  ].join(".");
}

export function implementPlanPrompt(planText: string): string {
  return `Implement this plan:\n\n${planText}`;
}

export function isStoredPlanAction(value: string | null): value is PlanActionState {
  return value === "dismissed" || value === "implemented";
}

export function isImplementPlanPromptForPlan(
  userText: string | null,
  planText: string,
): boolean {
  if (!userText) {
    return false;
  }
  const normalizedPlan = normalizePlanActionText(planText);
  if (!normalizedPlan) {
    return false;
  }

  const normalizedUserText = normalizePlanActionText(userText);
  const prefix = "Implement this plan:";
  if (!normalizedUserText.toLowerCase().startsWith(prefix.toLowerCase())) {
    return false;
  }

  const body = normalizePlanActionText(normalizedUserText.slice(prefix.length));
  return body === normalizedPlan || body.includes(normalizedPlan);
}

// Ported verbatim from Codex core: `TokenUsage::percent_of_context_window_remaining`
// (codex-rs/protocol/src/protocol.rs) — the exact formula Codex's own TUI uses for
// its context indicator. Codex computes it from the LAST request's total tokens
// (the live window occupancy), NOT the cumulative thread total. A fixed baseline
// (system prompt + tool instructions) is subtracted from both numerator and
// denominator so the bar reads ~100% free right after the first prompt and trends
// to 0% as the user-controllable window fills. `modelContextWindow` is already the
// backend's effective (95%) window; the baseline applies on top, exactly as Codex.
export const CONTEXT_WINDOW_BASELINE_TOKENS = 12000;

export function contextWindowPercentRemaining(
  lastTotalTokens: number,
  modelContextWindow: number,
): number {
  if (modelContextWindow <= CONTEXT_WINDOW_BASELINE_TOKENS) {
    return 0;
  }
  const effectiveWindow = modelContextWindow - CONTEXT_WINDOW_BASELINE_TOKENS;
  const used = Math.max(0, lastTotalTokens - CONTEXT_WINDOW_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  const percent = (remaining / effectiveWindow) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

export type ContextUsageInput = {
  // Cumulative thread total — the Codex-consistent fallback shown when the
  // effective window is unknown.
  totalTokens: number;
  // Last request's total tokens = live window occupancy; drives the %.
  lastTokens: number | null;
  modelContextWindow: number | null;
} | null;

export type ContextUsageSummary = {
  label: string;
  progress: number | null;
  level: "unknown" | "low" | "medium" | "high";
};

export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}m`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}k`;
  }
  return String(tokens);
}

// Shared by the mobile composer context ring and the desktop status row so
// both viewports report identical numbers/labels from one source.
export function contextUsageSummary(usage: ContextUsageInput): ContextUsageSummary {
  if (!usage) {
    return {
      label: "Context usage not available yet",
      progress: null,
      level: "unknown",
    };
  }

  const windowSize =
    usage.modelContextWindow && usage.modelContextWindow > 0
      ? usage.modelContextWindow
      : null;
  // No effective window, or no per-request figure yet: fall back to the raw
  // cumulative count (matches Codex, which only shows the cumulative absolute
  // when the context window is unknown).
  if (!windowSize || usage.lastTokens === null) {
    return {
      label: `Context ${formatCompactTokenCount(usage.totalTokens)} tokens`,
      progress: null,
      level: "unknown",
    };
  }

  const remainingPercent = contextWindowPercentRemaining(usage.lastTokens, windowSize);
  const usedPercent = 100 - remainingPercent;
  const level = usedPercent >= 85 ? "high" : usedPercent >= 65 ? "medium" : "low";
  return {
    label: `Context ${usedPercent}% (${remainingPercent}% left), ${formatCompactTokenCount(usage.lastTokens)} of ${formatCompactTokenCount(windowSize)} tokens`,
    progress: usedPercent,
    level,
  };
}

export function tokenUsageFromEvent(event: GatewayEvent): ThreadTokenUsageSummary | null {
  if (event.name !== "thread/tokenUsage/updated") {
    return null;
  }
  const payload = asRecord(event.payload);
  const tokenUsage = asRecord(payload?.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  const last = asRecord(tokenUsage?.last);
  const totalTokens = total?.totalTokens;
  const inputTokens = total?.inputTokens;
  const outputTokens = total?.outputTokens;
  const lastTokens = typeof last?.totalTokens === "number" ? last.totalTokens : null;
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
    lastTokens,
    modelContextWindow,
    updatedAt: event.serverTs,
  };
}

export function formatRateLimitStatus(response: AccountRateLimitsResponse): string {
  if (response.error || !response.rateLimits) {
    return "rate limits: unavailable";
  }
  const primary = response.rateLimits.primary;
  if (!primary) {
    return "rate limits: unavailable";
  }
  const limitName = response.rateLimits.limitName ?? response.rateLimits.limitId ?? "default";
  const resetAt = new Date(primary.resetsAt * 1000);
  const resetLabel = Number.isNaN(resetAt.getTime())
    ? String(primary.resetsAt)
    : resetAt.toLocaleTimeString();
  return `rate limits: ${limitName} ${primary.usedPercent}% (reset ${resetLabel})`;
}
