import { describe, expect, it } from "vitest";
import { parseTimelineItemsFromLines } from "../src/timelineParser.js";

function line(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("parseTimelineItemsFromLines", () => {
  it("maps event_msg and response_item into timeline items", () => {
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "user_message", message: "Hello", turn_id: "turn-1" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "call-1" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:03.000Z",
        payload: { type: "function_call_output", output: "done", call_id: "call-1" },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:04.000Z",
        payload: { type: "task_complete", turn_id: "turn-1" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items.map((item) => item.type)).toEqual([
      "status",
      "userMessage",
      "toolCall",
      "toolResult",
      "status",
    ]);
    expect(items[2]).toMatchObject({
      title: "Tool call: read_file",
      turnId: "turn-1",
      callId: "call-1",
    });
    expect(items[3]).toMatchObject({
      title: "Tool output",
      turnId: "turn-1",
    });
  });

  it("deduplicates consecutive identical entries and respects limit", () => {
    const duplicate = line({
      type: "event_msg",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: { type: "agent_message", message: "same", turn_id: "turn-1" },
    });

    const items = parseTimelineItemsFromLines([duplicate, duplicate], "thread-1", 1);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("assistantMessage");
  });
});
