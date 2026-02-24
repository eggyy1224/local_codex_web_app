import { describe, expect, it } from "vitest";
import type { GatewayEvent, ThreadTimelineItem } from "@lcwa/shared-types";
import {
  buildConversationTurns,
  formatEffortLabel,
  statusClass,
  statusLabel,
  timelineItemFromGatewayEvent,
  truncateText,
} from "../app/lib/thread-logic";

describe("thread logic helpers", () => {
  it("formats status and text helpers", () => {
    expect(statusClass("completed")).toBe("is-online");
    expect(statusClass("inProgress")).toBe("is-pending");
    expect(statusLabel("failed")).toBe("Failed");
    expect(formatEffortLabel("very_high")).toBe("Very High");
    expect(truncateText("abcdef", 4)).toBe("abcd...");
  });

  it("maps gateway events to timeline items", () => {
    const event: GatewayEvent = {
      seq: 10,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/agentMessage/delta",
      payload: { delta: "Hello" },
    };

    const item = timelineItemFromGatewayEvent(event);
    expect(item).toMatchObject({
      id: "live-10-assistant-delta",
      type: "assistantMessage",
      text: "Hello",
      turnId: "turn-1",
    });
  });

  it("aggregates conversation turns with delta merge and dedupe", () => {
    const items: ThreadTimelineItem[] = [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        turnId: "turn-1",
        type: "status",
        title: "Turn started",
        text: "turn turn-1",
        rawType: "turn/started",
        toolName: null,
        callId: null,
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:01.000Z",
        turnId: "turn-1",
        type: "assistantMessage",
        title: "Assistant",
        text: "Hello",
        rawType: "item/agentMessage/delta",
        toolName: null,
        callId: "a",
      },
      {
        id: "3",
        ts: "2026-01-01T00:00:02.000Z",
        turnId: "turn-1",
        type: "assistantMessage",
        title: "Assistant",
        text: "Hello world",
        rawType: "agentMessage",
        toolName: null,
        callId: "a",
      },
      {
        id: "4",
        ts: "2026-01-01T00:00:03.000Z",
        turnId: "turn-1",
        type: "toolCall",
        title: "Tool call",
        text: "{}",
        rawType: "function_call",
        toolName: "read_file",
        callId: "call-1",
      },
      {
        id: "5",
        ts: "2026-01-01T00:00:04.000Z",
        turnId: "turn-1",
        type: "toolCall",
        title: "Tool call",
        text: "{}",
        rawType: "function_call",
        toolName: "read_file",
        callId: "call-2",
      },
      {
        id: "6",
        ts: "2026-01-01T00:00:05.000Z",
        turnId: "turn-1",
        type: "status",
        title: "Turn completed",
        text: "completed",
        rawType: "turn/completed",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      assistantText: "Hello world",
      toolCalls: [{ toolName: "read_file", text: "{}" }],
    });
  });
});
