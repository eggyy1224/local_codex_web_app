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

  it("keeps consecutive tool calls with same args but different call_id", () => {
    // Regression: dedup keyed only on type/turnId/text/rawType collapsed two
    // distinct tool calls whose payloads happened to share the same arguments.
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "call-a" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "call-b" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    const toolCalls = items.filter((item) => item.type === "toolCall");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].callId).toBe("call-a");
    expect(toolCalls[1].callId).toBe("call-b");
  });

  it("emits turn_aborted as interrupted status and clears active turn", () => {
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "turn_aborted", turn_id: "turn-1" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "call-1" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items.map((item) => item.type)).toEqual(["status", "status", "toolCall"]);
    expect(items[1]).toMatchObject({ title: "Turn interrupted", rawType: "turn_aborted" });
    // After interrupt the active-turn binding is cleared, so a tool call with
    // no turn_id of its own surfaces as turnId=null instead of accidentally
    // re-attaching to the aborted turn.
    expect(items[2].turnId).toBeNull();
  });

  it("maps review-mode enter/exit events", () => {
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          type: "entered_review_mode",
          turn_id: "turn-r",
          user_facing_hint: "Reviewing uncommitted changes",
        },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:05.000Z",
        payload: { type: "exited_review_mode", turn_id: "turn-r" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Entered review mode",
      text: "Reviewing uncommitted changes",
      rawType: "entered_review_mode",
    });
    expect(items[1]).toMatchObject({
      title: "Exited review mode",
      rawType: "exited_review_mode",
    });
  });

  it("maps context_compacted as a status row", () => {
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "context_compacted", turn_id: "turn-1" },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Context compacted",
      type: "status",
      rawType: "context_compacted",
      text: null,
    });
  });

  it("truncates reasoning text past the 2000-char cap with the ...newline marker", () => {
    const longThought = "r".repeat(2500);
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "agent_reasoning", text: longThought, turn_id: "turn-1" },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("reasoning");
    expect(items[0].text).toBe(`${"r".repeat(2000)}\n...`);
  });

  it("custom_tool_call and web_search_call use call-type-specific tool names + truncate args at 1800", () => {
    const longArgs = "x".repeat(2200);
    const lines = [
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          type: "custom_tool_call",
          name: "shell",
          input: longArgs,
          call_id: "call-c",
        },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "web_search_call", query: "remodex pairing", call_id: "call-w" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items[0]).toMatchObject({
      type: "toolCall",
      title: "Tool call: shell",
      callId: "call-c",
      toolName: "shell",
    });
    // Truncated to 1800 chars + "\n..." suffix.
    expect(items[0].text).toBe(`${"x".repeat(1800)}\n...`);
    expect(items[1]).toMatchObject({
      type: "toolCall",
      // web_search_call has no `name` field — falls back to the default.
      title: "Tool call: web_search",
      text: "remodex pairing",
      toolName: "web_search",
    });
  });

  it("custom_tool_call_output and web_search_call_output truncate to 2200 chars", () => {
    const longOutput = "y".repeat(2600);
    const lines = [
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "custom_tool_call_output", output: longOutput, call_id: "call-c" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: {
          type: "web_search_call_output",
          result: { hits: [{ url: "https://example.com" }] },
          call_id: "call-w",
        },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items[0]).toMatchObject({
      type: "toolResult",
      title: "Tool output",
      callId: "call-c",
    });
    expect(items[0].text).toBe(`${"y".repeat(2200)}\n...`);
    // Non-string `result` is stringified compactly so the UI can still preview.
    expect(items[1].text).toContain('"https://example.com"');
  });

  it("inherits activeTurnId from the most recent event_msg when response_items omit turn_id", () => {
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-active" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "function_call", name: "ls", arguments: "{}", call_id: "call-1" },
      }),
      line({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "function_call_output", output: "ok", call_id: "call-1" },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items[1].turnId).toBe("turn-active");
    expect(items[2].turnId).toBe("turn-active");
  });

  it("silently skips lines that are not parseable JSON or have unknown top-level types", () => {
    const lines = [
      "not json",
      "",
      line({ type: "unknown_top_level", payload: {} }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items).toHaveLength(1);
    expect(items[0].rawType).toBe("task_started");
  });

  it("falls back to current time when a line omits its timestamp", () => {
    const before = Date.now();
    const lines = [
      line({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
    ];
    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    const ts = new Date(items[0].ts).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("respects the limit by keeping the trailing window of items", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({
        type: "event_msg",
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        payload: { type: "agent_message", message: `m${i}`, turn_id: "turn-1" },
      }),
    );
    const items = parseTimelineItemsFromLines(lines, "thread-1", 5);
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.text)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });

  it("passes through long user and assistant messages without truncation", () => {
    // Reproduces the gap exposed by the codex review: the gateway used to
    // truncate user_message at 4000 and agent_message at 6000 chars, so the
    // web UI's full-bubble rendering still showed clipped historical turns.
    const longUser = `${"u".repeat(10_000)}USER_TAIL_KEEPS`;
    const longAssistant = `${"a".repeat(10_000)}ASSISTANT_TAIL_KEEPS`;
    const lines = [
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "user_message", message: longUser, turn_id: "turn-1" },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "agent_message", message: longAssistant, turn_id: "turn-1" },
      }),
    ];

    const items = parseTimelineItemsFromLines(lines, "thread-1", 50);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe(longUser);
    expect(items[0].text).toContain("USER_TAIL_KEEPS");
    expect(items[1].text).toBe(longAssistant);
    expect(items[1].text).toContain("ASSISTANT_TAIL_KEEPS");
  });
});
