import { describe, expect, it } from "vitest";
import type { GatewayEvent, ThreadTimelineItem } from "@lcwa/shared-types";
import {
  buildConversationTurns,
  formatEffortLabel,
  proposedPlanFromText,
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

  it("drops streaming delta events from the timeline (we render only completed items)", () => {
    const event: GatewayEvent = {
      seq: 10,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/agentMessage/delta",
      payload: { delta: "Hello" },
    };
    expect(timelineItemFromGatewayEvent(event)).toBeNull();
  });

  it("drops plan / command / file-change delta events but keeps reasoning deltas as live thinking items", () => {
    const droppedNames = [
      "item/plan/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ] as const;
    for (const name of droppedNames) {
      const event: GatewayEvent = {
        seq: 1,
        serverTs: "2026-01-01T00:00:00.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "item",
        name,
        payload: { delta: "x" },
      };
      expect(timelineItemFromGatewayEvent(event)).toBeNull();
    }

    const reasoningNames = ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta"] as const;
    for (const name of reasoningNames) {
      const event: GatewayEvent = {
        seq: 1,
        serverTs: "2026-01-01T00:00:00.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "item",
        name,
        payload: { delta: "thinking..." },
      };
      expect(timelineItemFromGatewayEvent(event)).toMatchObject({
        type: "reasoning",
        title: "Thinking",
        text: "thinking...",
        rawType: name,
      });
    }
  });

  it("maps plan/review/token usage events to timeline items", () => {
    const planDelta: GatewayEvent = {
      seq: 20,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/plan/delta",
      payload: { delta: "Step 1" },
    };
    const reviewItem: GatewayEvent = {
      seq: 21,
      serverTs: "2026-01-01T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/completed",
      payload: {
        item: {
          type: "enteredReviewMode",
          id: "item-1",
          review: "start review",
          turnId: "turn-1",
        },
      },
    };
    const tokenUsage: GatewayEvent = {
      seq: 22,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "thread",
      name: "thread/tokenUsage/updated",
      payload: {
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 70,
            outputTokens: 30,
          },
          modelContextWindow: 128000,
        },
      },
    };
    const planUpdated: GatewayEvent = {
      seq: 23,
      serverTs: "2026-01-01T00:00:03.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "turn",
      name: "turn/plan/updated",
      payload: {
        turnId: "turn-1",
        explanation: "Working through steps",
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Write tests", status: "inProgress" },
        ],
      },
    };
    const interactionResponded: GatewayEvent = {
      seq: 24,
      serverTs: "2026-01-01T00:00:04.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "interaction",
      name: "interaction/responded",
      payload: {
        interactionId: "ia-1",
      },
    };
    const interactionCancelled: GatewayEvent = {
      seq: 25,
      serverTs: "2026-01-01T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "interaction",
      name: "interaction/cancelled",
      payload: {
        interactionId: "ia-1",
        reason: "turn_completed",
      },
    };

    expect(timelineItemFromGatewayEvent(planDelta)).toBeNull();
    expect(timelineItemFromGatewayEvent(reviewItem)).toMatchObject({
      type: "status",
      title: "Entered review mode",
      text: "start review",
    });
    expect(timelineItemFromGatewayEvent(tokenUsage)).toMatchObject({
      type: "status",
      title: "Token usage updated",
      text: "total 100 · input 70 · output 30 · window 128000",
    });
    expect(timelineItemFromGatewayEvent(planUpdated)).toMatchObject({
      type: "status",
      title: "Plan updated",
      text: "Working through steps\n[completed] Inspect code\n[inProgress] Write tests",
    });
    expect(timelineItemFromGatewayEvent(interactionResponded)).toMatchObject({
      type: "status",
      title: "Question answered",
    });
    expect(timelineItemFromGatewayEvent(interactionCancelled)).toMatchObject({
      type: "status",
      title: "Question cancelled",
      text: "turn_completed",
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

  it("infers completed status when assistant text exists without turn status events", () => {
    const items: ThreadTimelineItem[] = [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        turnId: "turn-1",
        type: "userMessage",
        title: "You",
        text: "hello",
        rawType: "userMessage",
        toolName: null,
        callId: null,
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:01.000Z",
        turnId: "turn-1",
        type: "assistantMessage",
        title: "Assistant",
        text: "world",
        rawType: "agentMessage",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      isStreaming: false,
      assistantText: "world",
    });
  });
});

describe("proposedPlanFromText", () => {
  it("extracts real plan content from <proposed_plan> tags", () => {
    const result = proposedPlanFromText(
      "Here's the plan:\n<proposed_plan>1. Add API\n2. Add UI\n3. Ship</proposed_plan>",
    );
    expect(result).toBe("1. Add API\n2. Add UI\n3. Ship");
  });

  it("returns null when <proposed_plan> appears inside backticks (feature documentation)", () => {
    // Reproduces the user-reported false positive: the assistant explained the
    // feature and quoted `<proposed_plan>...</proposed_plan>` literally; the
    // detector should not treat that as a real plan.
    const text =
      "我們有 proposed plan CTA：看到 `<proposed_plan>...</proposed_plan>` 就會顯示 Implement.";
    expect(proposedPlanFromText(text)).toBeNull();
  });

  it("returns null for fenced code-block discussions of the plan tag", () => {
    const text = "Docs:\n```html\n<proposed_plan>1. step</proposed_plan>\n```\nthat's how.";
    expect(proposedPlanFromText(text)).toBeNull();
  });

  it("rejects placeholder plan bodies like '...'", () => {
    expect(proposedPlanFromText("<proposed_plan>...</proposed_plan>")).toBeNull();
    expect(proposedPlanFromText("<proposed_plan>…</proposed_plan>")).toBeNull();
    expect(proposedPlanFromText("<proposed_plan>   </proposed_plan>")).toBeNull();
  });

  it("returns null when prose mentions plans with bullets but no <proposed_plan> tag (false-positive guard)", () => {
    // Reproduces: assistant explains plan-mode features in a bullet list — UI
    // must NOT treat that as a real plan. The canonical signal is the tag.
    const text =
      "我們有 plan mode：\n- Web 支援 /plan slash command\n- Gateway 會呼叫 collaborationMode/list\n- Mobile 有 plan pill 和 implement plan sheet";
    expect(proposedPlanFromText(text)).toBeNull();
  });

  it("returns null when input is empty or null", () => {
    expect(proposedPlanFromText(null)).toBeNull();
    expect(proposedPlanFromText("")).toBeNull();
  });
});
