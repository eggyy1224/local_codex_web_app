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
      lastSeq: 0,
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

  it("discards pre-hydration backlog at the snapshot head but keeps genuinely-new early events", () => {
    let state = createThreadEventStoreState("thread-1");

    // SSE connected at since=0 before the snapshot resolved: replayed backlog
    // for a long-completed turn lands while lastSeq is still 0, so the
    // appendGatewayEvent guard cannot drop it yet.
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 200, name: "turn/started", turnId: "turn-old" }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({
        seq: 201,
        name: "item/agentMessage/delta",
        turnId: "turn-old",
        kind: "item",
        payload: { text: "stale" },
      }),
    });
    // A genuinely-new turn that started after the snapshot head was measured
    // also arrives in the race window.
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 600, name: "turn/started", turnId: "turn-new" }),
    });

    expect(state.liveEvents.map((event) => event.seq)).toEqual([200, 201, 600]);

    // Snapshot resolves with head 500: turn-old (<= 500) is historical
    // backlog; turn-new (600) is newer than the snapshot and must survive.
    state = threadEventStoreReducer(state, {
      type: "hydrateTimeline",
      threadId: "thread-1",
      items: [],
      lastSeq: 500,
    });

    expect(state.liveEvents.map((event) => event.seq)).toEqual([600]);
    expect(state.liveThreadListEvents.map((event) => event.turnId)).toEqual([
      "turn-new",
    ]);
    expect(state.lastSeq).toBe(600);

    const turnIds = new Set(
      selectThreadTimelineItems(state).map((item) => item.turnId),
    );
    expect(turnIds.has("turn-old")).toBe(false);
    expect(turnIds.has("turn-new")).toBe(true);
  });

  it("keeps watchdog-replayed missed events when a re-hydrate carries a newer head than the lagging snapshot timeline", () => {
    // Mobile PWA watchdog scenario (e2e mobile-pwa-sse.spec.ts:149):
    // 1. First snapshot applied at head 10 (authoritative).
    let state = createThreadEventStoreState("thread-1");
    state = threadEventStoreReducer(state, {
      type: "hydrateTimeline",
      threadId: "thread-1",
      items: [timelineItem({ id: "base-start", turnId: "turn-1" })],
      lastSeq: 10,
    });
    // 2. The turn streams live; the cursor genuinely advances past the head.
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 11, name: "turn/started", turnId: "turn-1" }),
    });
    expect(state.lastSeq).toBe(11);

    // 3. The stream goes stale (PWA backgrounded); the gateway keeps recording
    //    the turn's completion into events_log at seq 12..14. The web client
    //    misses them. The watchdog fires: SSE reconnects from since=11 and the
    //    gateway replays exactly those missed events into liveEvents.
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({
        seq: 12,
        name: "item/agentMessage/delta",
        turnId: "turn-1",
        kind: "item",
        payload: { text: "Echo: hi" },
      }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({
        seq: 13,
        name: "item/completed",
        turnId: "turn-1",
        kind: "item",
        payload: { item: { type: "agentMessage", text: "Echo: hi" } },
      }),
    });
    state = threadEventStoreReducer(state, {
      type: "appendGatewayEvent",
      event: gatewayEvent({ seq: 14, name: "turn/completed", turnId: "turn-1" }),
    });
    expect(state.liveEvents.map((event) => event.seq)).toEqual([11, 12, 13, 14]);

    // 4. The watchdog also resyncs the snapshot concurrently. The timeline
    //    snapshot is sourced from the rollout/session file, which lags the
    //    events_log head (and is empty for the e2e stub), so it returns NO
    //    items but a head of 14 (the events_log head, measured fresh). This
    //    re-hydrate must NOT discard the just-replayed missed events: the
    //    snapshot timeline does not contain them, so dropping them strands the
    //    conversation on "No conversation yet." forever.
    state = threadEventStoreReducer(state, {
      type: "hydrateTimeline",
      threadId: "thread-1",
      items: [],
      lastSeq: 14,
    });

    const texts = selectThreadTimelineItems(state)
      .map((item) => item.text ?? "")
      .join(" ");
    expect(texts).toContain("Echo: hi");
    expect(state.liveEvents.some((event) => event.seq === 12)).toBe(true);
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
      lastSeq: 0,
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
