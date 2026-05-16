import type {
  GatewayEvent,
  ThreadTimelineItem,
  TurnView,
} from "@lcwa/shared-types";
import {
  buildConversationTurns,
  timelineItemFromGatewayEvent,
  type ConversationTurn,
  type TurnStatus,
} from "./thread-logic";

export type ThreadEventStoreState = {
  threadId: string;
  baseTimelineItems: ThreadTimelineItem[];
  liveEvents: GatewayEvent[];
  liveThreadListEvents: GatewayEvent[];
  lastSeq: number;
  activeTurnId: string | null;
};

export type ThreadEventStoreAction =
  | { type: "reset"; threadId: string }
  | {
      type: "hydrateTimeline";
      threadId: string;
      items: ThreadTimelineItem[];
      lastSeq: number;
    }
  | { type: "appendGatewayEvent"; event: GatewayEvent };

export const MAX_LIVE_EVENTS = 600;

const LOSSLESS_GATEWAY_EVENT_NAMES = new Set([
  "turn/completed",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);

export function isLosslessGatewayEventName(name: string): boolean {
  return LOSSLESS_GATEWAY_EVENT_NAMES.has(name);
}

export function createThreadEventStoreState(
  threadId = "",
): ThreadEventStoreState {
  return {
    threadId,
    baseTimelineItems: [],
    liveEvents: [],
    liveThreadListEvents: [],
    lastSeq: 0,
    activeTurnId: null,
  };
}

function shouldRetainThreadListEvent(event: GatewayEvent): boolean {
  return (
    event.name === "turn/started" ||
    event.name === "turn/completed" ||
    event.name === "thread/updated"
  );
}

function activeTurnIdAfterTimelineItems(
  items: ThreadTimelineItem[],
): string | null {
  let activeTurnId: string | null = null;
  const sorted = [...items].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
    return a.id.localeCompare(b.id);
  });

  for (const item of sorted) {
    if (!item.turnId) continue;
    if (item.rawType === "turn/started" || item.rawType === "task_started") {
      activeTurnId = item.turnId;
    } else if (
      item.rawType === "turn/completed" ||
      item.rawType === "task_complete" ||
      item.rawType === "turn/aborted" ||
      item.rawType === "turn_aborted"
    ) {
      if (activeTurnId === item.turnId) {
        activeTurnId = null;
      }
    }
  }

  return activeTurnId;
}

function activeTurnIdAfterGatewayEvent(
  current: string | null,
  event: GatewayEvent,
): string | null {
  if (event.name === "turn/started" && event.turnId) {
    return event.turnId;
  }

  if (
    (event.name === "turn/completed" || event.name === "turn/aborted") &&
    event.turnId &&
    current === event.turnId
  ) {
    return null;
  }

  if (event.name === "thread/closed") {
    return null;
  }

  return current;
}

export function threadEventStoreReducer(
  state: ThreadEventStoreState,
  action: ThreadEventStoreAction,
): ThreadEventStoreState {
  if (action.type === "reset") {
    return createThreadEventStoreState(action.threadId);
  }

  if (action.type === "hydrateTimeline") {
    if (state.threadId && action.threadId !== state.threadId) {
      return state;
    }
    return {
      ...state,
      threadId: action.threadId,
      baseTimelineItems: action.items,
      activeTurnId: activeTurnIdAfterTimelineItems(action.items),
      // Advance the cursor to the snapshot head so the SSE backlog replay
      // (every event with seq <= head) is dropped by appendGatewayEvent below
      // instead of re-applying a long-completed turn/started. Never move the
      // cursor backwards: a mid-stream resync may carry an older head than
      // live events already consumed.
      lastSeq: Math.max(state.lastSeq, action.lastSeq),
    };
  }

  if (action.event.threadId !== state.threadId) {
    return state;
  }
  if (action.event.seq <= state.lastSeq) {
    return state;
  }

  return {
    ...state,
    liveEvents: [...state.liveEvents, action.event].slice(-MAX_LIVE_EVENTS),
    liveThreadListEvents: shouldRetainThreadListEvent(action.event)
      ? [...state.liveThreadListEvents, action.event].slice(-MAX_LIVE_EVENTS)
      : state.liveThreadListEvents,
    lastSeq: action.event.seq,
    activeTurnId: activeTurnIdAfterGatewayEvent(state.activeTurnId, action.event),
  };
}

export function selectLiveTimelineItems(
  state: ThreadEventStoreState,
): ThreadTimelineItem[] {
  return state.liveEvents
    .map((event) => timelineItemFromGatewayEvent(event))
    .filter((item): item is ThreadTimelineItem => item !== null);
}

export function selectThreadTimelineItems(
  state: ThreadEventStoreState,
): ThreadTimelineItem[] {
  const dedupe = new Set<string>();
  return [...state.baseTimelineItems, ...selectLiveTimelineItems(state)]
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
}

function normalizeServerTurnStatus(status: string): TurnStatus | null {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "interrupted" || status === "aborted" || status === "cancelled") {
    return "interrupted";
  }
  if (status === "in_progress" || status === "inProgress" || status === "active") {
    return "inProgress";
  }
  return null;
}

export function selectConversationTurns(
  state: ThreadEventStoreState,
  serverTurns: TurnView[] = [],
): ConversationTurn[] {
  const built = buildConversationTurns(selectThreadTimelineItems(state));
  const serverStatusByTurnId = new Map<string, TurnStatus>();
  for (const turn of serverTurns) {
    if (typeof turn.status !== "string" || turn.status.length === 0) {
      continue;
    }
    const status = normalizeServerTurnStatus(turn.status);
    if (status) {
      serverStatusByTurnId.set(turn.id, status);
    }
  }
  if (serverStatusByTurnId.size === 0) {
    return built;
  }

  return built.map((turn) => {
    const serverStatus = serverStatusByTurnId.get(turn.turnId);
    if (!serverStatus || serverStatus === "inProgress") {
      return turn;
    }
    if (!turn.isStreaming) {
      return turn;
    }
    return {
      ...turn,
      status: serverStatus,
      isStreaming: false,
    };
  });
}
