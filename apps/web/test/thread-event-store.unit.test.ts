import { describe, expect, it } from "vitest";
import type {
  GatewayEvent,
  ThreadTimelineItem,
  TurnView,
} from "@lcwa/shared-types";
import {
  createThreadEventStoreState,
  isLosslessGatewayEventName,
  selectConversationTurns,
  selectThreadTimelineItems,
  threadEventStoreReducer,
} from "../app/lib/thread-event-store";

function gatewayEvent(
  overrides: Partial<GatewayEvent> & Pick<GatewayEvent, "seq" | "name">,
): GatewayEvent {
  return {
    serverTs: "2026-05-15T00:00:00.000Z",
    threadId: "thread-1",
    turnId: "turn-1",
    kind: "turn",
    payload: null,
    ...overrides,
  };
}

function timelineItem(
  overrides: Partial<ThreadTimelineItem> = {},
): ThreadTimelineItem {
  return {
    id: "base-started",
    ts: "2026-05-15T00:00:00.000Z",
    turnId: "turn-1",
    type: "status",
    title: "Turn started",
    text: "turn turn-1",
    rawType: "turn/started",
    toolName: null,
    callId: null,
    ...overrides,
  };
}

describe("thread event store", () => {
  it("hydrates replay items, appends live events, and dedupes the merged timeline", () => {
    let state = createThreadEventStoreState("thread-1");
    state = threadEventStoreReducer(state, {
      type: "hydrateTimeline",
      threadId: "thread-1",
      items: [timelineItem()],
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({
        seq: 1,
        name: "turn/started",
        payload: { turn: { id: "turn-1" } },
      }),
    });

    expect(state.activeTurnId).toBe("turn-1");
    expect(state.lastSeq).toBe(1);
    expect(selectThreadTimelineItems(state)).toHaveLength(1);
  });

  it("ignores events from another thread and stale seq values", () => {
    let state = createThreadEventStoreState("thread-1");
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 2, name: "turn/started" }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 1, name: "turn/completed" }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({
        seq: 3,
        name: "turn/completed",
        threadId: "other-thread",
      }),
    });

    expect(state.lastSeq).toBe(2);
    expect(state.liveEvents.map((event) => event.name)).toEqual(["turn/started"]);
    expect(state.activeTurnId).toBe("turn-1");
  });

  it("clears active turn when a matching terminal event arrives", () => {
    let state = createThreadEventStoreState("thread-1");
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 1, name: "turn/started" }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 2, name: "turn/completed" }),
    });

    expect(state.activeTurnId).toBeNull();
  });

  it("normalizes server terminal status without treating in_progress as done", () => {
    let state = createThreadEventStoreState("thread-1");
    state = threadEventStoreReducer(state, {
      type: "hydrateTimeline",
      threadId: "thread-1",
      items: [
        timelineItem(),
        timelineItem({
          id: "assistant",
          ts: "2026-05-15T00:00:01.000Z",
          type: "assistantMessage",
          title: "Assistant",
          text: "working",
          rawType: "agent_message",
        }),
      ],
    });

    const inProgressServerTurn: TurnView = {
      id: "turn-1",
      status: "in_progress",
      startedAt: null,
      completedAt: null,
      error: null,
      items: [],
    };
    expect(selectConversationTurns(state, [inProgressServerTurn])[0]).toMatchObject({
      status: "inProgress",
      isStreaming: true,
    });

    const completedServerTurn: TurnView = {
      ...inProgressServerTurn,
      status: "completed",
    };
    expect(selectConversationTurns(state, [completedServerTurn])[0]).toMatchObject({
      status: "completed",
      isStreaming: false,
    });
  });

  it("matches Codex's lossless event tier for UI-critical stream events", () => {
    expect(isLosslessGatewayEventName("item/agentMessage/delta")).toBe(true);
    expect(isLosslessGatewayEventName("item/plan/delta")).toBe(true);
    expect(isLosslessGatewayEventName("item/reasoning/textDelta")).toBe(true);
    expect(isLosslessGatewayEventName("item/commandExecution/outputDelta")).toBe(false);
  });
});
