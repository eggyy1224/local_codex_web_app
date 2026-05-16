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
          last: {
            totalTokens: 64,
            inputTokens: 50,
            outputTokens: 14,
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
      text: "last 64 · total 100 · input 70 · output 30 · window 128000",
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

  it("maps live collab-agent tool calls so spawned sub-agents appear before refresh", () => {
    const event: GatewayEvent = {
      seq: 30,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/started",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: [],
          prompt: "請審查剛剛的程式碼",
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
      },
    };

    expect(timelineItemFromGatewayEvent(event)).toMatchObject({
      type: "toolCall",
      title: "Tool call: spawn_agent",
      text: JSON.stringify({
        message: "請審查剛剛的程式碼",
        model: "gpt-5.5",
        reasoning_effort: "high",
      }),
      rawType: "collabAgentToolCall",
      toolName: "spawn_agent",
      callId: "collab-1",
    });
  });

  it("dedupes collab-agent start and completion events for the same spawned sub-agent", () => {
    const started = timelineItemFromGatewayEvent({
      seq: 31,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/started",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "inProgress",
          prompt: "請審查剛剛的程式碼",
        },
      },
    });
    const completed = timelineItemFromGatewayEvent({
      seq: 32,
      serverTs: "2026-01-01T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/completed",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["019e2980-378e-7b80-bfb7-41eb0eacfc51"],
          prompt: "請審查剛剛的程式碼",
        },
      },
    });

    expect(started).not.toBeNull();
    expect(completed).not.toBeNull();
    const turns = buildConversationTurns([started, completed].filter(Boolean) as ThreadTimelineItem[]);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls).toEqual([
      {
        toolName: "spawn_agent",
        text: JSON.stringify({ message: "請審查剛剛的程式碼" }),
      },
    ]);
    expect(turns[0].segments).toHaveLength(1);
    expect(turns[0].segments[0]).toMatchObject({
      kind: "toolBatch",
      summary: "Ran 1 sub-agent step",
    });
  });

  it("keeps failed collab-agent completion visible instead of deduping it as a successful spawn", () => {
    const started = timelineItemFromGatewayEvent({
      seq: 33,
      serverTs: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/started",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "inProgress",
          prompt: "請審查剛剛的程式碼",
        },
      },
    });
    const failed = timelineItemFromGatewayEvent({
      seq: 34,
      serverTs: "2026-01-01T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/completed",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "failed",
          prompt: "請審查剛剛的程式碼",
        },
      },
    });

    expect(started).not.toBeNull();
    expect(failed).toMatchObject({
      text: JSON.stringify({ message: "請審查剛剛的程式碼", status: "failed" }),
    });
    const turns = buildConversationTurns([started, failed].filter(Boolean) as ThreadTimelineItem[]);
    expect(turns[0].toolCalls).toHaveLength(2);
    expect(turns[0].segments[0]).toMatchObject({
      kind: "toolBatch",
      summary: "Ran 2 sub-agent steps",
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

  it("preserves chronological order of thinking, tool calls, and tool results in turn.details", () => {
    // Codex's real flow is "think → call → result → think more → call → result".
    // The legacy toolCalls / toolResults arrays squished everything by type,
    // so the UI couldn't show the actual narrative. turn.details fixes that.
    const items: ThreadTimelineItem[] = [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        turnId: "t",
        type: "reasoning",
        title: "Thinking",
        text: "first thought",
        rawType: "reasoning",
        toolName: null,
        callId: null,
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:01.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "ls",
        rawType: "function_call",
        toolName: "shell",
        callId: "call-1",
      },
      {
        id: "3",
        ts: "2026-01-01T00:00:02.000Z",
        turnId: "t",
        type: "toolResult",
        title: "Out",
        text: "file.ts",
        rawType: "function_call_output",
        toolName: null,
        callId: "call-1",
      },
      {
        id: "4",
        ts: "2026-01-01T00:00:03.000Z",
        turnId: "t",
        type: "reasoning",
        title: "Thinking",
        text: "second thought",
        rawType: "reasoning",
        toolName: null,
        callId: null,
      },
      {
        id: "5",
        ts: "2026-01-01T00:00:04.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "cat",
        rawType: "function_call",
        toolName: "shell",
        callId: "call-2",
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0].details.map((d) => `${d.kind}:${d.kind === "toolCall" ? d.text : d.kind === "toolResult" ? d.text : d.text}`)).toEqual([
      "thinking:first thought",
      "toolCall:ls",
      "toolResult:file.ts",
      "thinking:second thought",
      "toolCall:cat",
    ]);
  });

  it("builds interleaved segments: assistant text and tool batches alternate in time order", () => {
    // Real Codex pattern: commentary message → tool call → tool result → final answer.
    const items: ThreadTimelineItem[] = [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        turnId: "t",
        type: "assistantMessage",
        title: "Assistant",
        text: "我先去看 file",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:01.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "cat foo",
        rawType: "function_call",
        toolName: "exec_command",
        callId: "c1",
      },
      {
        id: "3",
        ts: "2026-01-01T00:00:02.000Z",
        turnId: "t",
        type: "toolResult",
        title: "Out",
        text: "ok",
        rawType: "function_call_output",
        toolName: null,
        callId: "c1",
      },
      {
        id: "4",
        ts: "2026-01-01T00:00:03.000Z",
        turnId: "t",
        type: "assistantMessage",
        title: "Assistant",
        text: "OK 看完了, 接著改",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
      {
        id: "5",
        ts: "2026-01-01T00:00:04.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "echo done",
        rawType: "function_call",
        toolName: "exec_command",
        callId: "c2",
      },
      {
        id: "6",
        ts: "2026-01-01T00:00:05.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "patch x",
        rawType: "function_call",
        toolName: "apply_patch",
        callId: "c3",
      },
      {
        id: "7",
        ts: "2026-01-01T00:00:06.000Z",
        turnId: "t",
        type: "assistantMessage",
        title: "Assistant",
        text: "好了",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    const segments = turns[0].segments;
    expect(segments.map((s) => s.kind)).toEqual([
      "assistant",
      "toolBatch",
      "assistant",
      "toolBatch",
      "assistant",
    ]);
    // First batch: 1 exec_command (and one result).
    expect(segments[1].kind === "toolBatch" && segments[1].summary).toBe("Ran 1 command");
    // Last assistant message keeps its text.
    expect(segments[2].kind === "assistant" && segments[2].text).toBe("OK 看完了, 接著改");
    // Second batch: 1 exec_command + 1 apply_patch.
    expect(segments[3].kind === "toolBatch" && segments[3].summary).toBe(
      "Ran 1 command, edited 1 file",
    );
    expect(segments[4].kind === "assistant" && segments[4].text).toBe("好了");
  });

  it("steer messages: subsequent user_message in the same turn becomes a steered segment", () => {
    // Real Codex flow: turn starts with userMessage, then mid-turn the user
    // steers (POST /api/threads/:id/steer) which injects another userMessage
    // BEFORE the next agent_message. The UI must surface both user bubbles
    // in order, with the steer one visually flagged.
    const items: ThreadTimelineItem[] = [
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        turnId: "t",
        type: "userMessage",
        title: "User",
        text: "原始 prompt",
        rawType: "user_message",
        toolName: null,
        callId: null,
      },
      {
        id: "2",
        ts: "2026-01-01T00:00:05.000Z",
        turnId: "t",
        type: "toolCall",
        title: "Tool",
        text: "ls",
        rawType: "function_call",
        toolName: "exec_command",
        callId: "c1",
      },
      {
        id: "3",
        ts: "2026-01-01T00:00:08.000Z",
        turnId: "t",
        type: "userMessage",
        title: "User",
        text: "steer 補充",
        rawType: "user_message",
        toolName: null,
        callId: null,
      },
      {
        id: "4",
        ts: "2026-01-01T00:00:12.000Z",
        turnId: "t",
        type: "assistantMessage",
        title: "Assistant",
        text: "好",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    const segments = turns[0].segments;
    expect(segments.map((s) => s.kind)).toEqual([
      "user",
      "toolBatch",
      "user",
      "assistant",
    ]);
    expect(segments[0]).toMatchObject({ kind: "user", text: "原始 prompt", isSteer: false });
    expect(segments[2]).toMatchObject({ kind: "user", text: "steer 補充", isSteer: true });
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

  it("keeps a turn streaming when only the rollout-flavored task_started item has arrived plus a partial assistant message (refresh during active turn)", () => {
    // Reproduces the bug reported live: after a page refresh during an
    // in-flight turn, /api/threads/:id/timeline returns task_started +
    // item_completed (assistantMessage) but the live SSE turn/completed has
    // not arrived yet. parseTurnStatus must recognize the rollout-style
    // "task_started" raw type so the partial assistant text doesn't trip the
    // hasResolvedSignals fallback and mark the turn "completed" prematurely.
    const items: ThreadTimelineItem[] = [
      {
        id: "user-1",
        ts: "2026-05-14T00:34:12.000Z",
        turnId: "turn-x",
        type: "userMessage",
        title: "User",
        text: "看一下狀態",
        rawType: "user_message",
        toolName: null,
        callId: null,
      },
      {
        id: "task-started",
        ts: "2026-05-14T00:34:13.000Z",
        turnId: "turn-x",
        type: "status",
        title: "Turn started",
        text: null,
        rawType: "task_started",
        toolName: null,
        callId: null,
      },
      {
        id: "assistant-partial",
        ts: "2026-05-14T00:34:30.000Z",
        turnId: "turn-x",
        type: "assistantMessage",
        title: "Assistant",
        text: "目前狀態很好，repo 是乾淨的",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("inProgress");
    expect(turns[0]!.isStreaming).toBe(true);
  });

  it("keeps a status-only started turn visible as streaming", () => {
    const items: ThreadTimelineItem[] = [
      {
        id: "started-only",
        ts: "2026-05-14T08:00:00.000Z",
        turnId: "turn-started-only",
        type: "status",
        title: "Turn started",
        text: "turn turn-started-only",
        rawType: "turn/started",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe("turn-started-only");
    expect(turns[0]!.status).toBe("inProgress");
    expect(turns[0]!.isStreaming).toBe(true);
  });

  it("marks turn_aborted from the rollout as a terminal interrupted turn", () => {
    // Regression: when codex CLI exited mid-stream (or /control stop was
    // dispatched) the rollout would record `turn_aborted` instead of
    // `task_complete`. The old parseTurnStatus returned null for that rawType,
    // so the turn stayed `inProgress` forever and the desktop / mobile UI
    // showed a stuck "Waiting for response…" + "Live activity: N turn(s)
    // streaming" days after the thread actually died.
    const items: ThreadTimelineItem[] = [
      {
        id: "task-started",
        ts: "2026-05-14T07:29:15.000Z",
        turnId: "turn-aborted",
        type: "status",
        title: "Turn started",
        text: null,
        rawType: "task_started",
        toolName: null,
        callId: null,
      },
      {
        id: "assistant-partial",
        ts: "2026-05-14T07:29:30.000Z",
        turnId: "turn-aborted",
        type: "assistantMessage",
        title: "Assistant",
        text: "我先快速看一下這個",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
      {
        id: "turn-aborted",
        ts: "2026-05-14T07:30:01.000Z",
        turnId: "turn-aborted",
        type: "status",
        title: "Turn interrupted",
        text: "turn turn-aborted",
        rawType: "turn_aborted",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("interrupted");
    expect(turns[0]!.isStreaming).toBe(false);
  });

  it("marks turn/aborted from live SSE as interrupted (live form)", () => {
    const items: ThreadTimelineItem[] = [
      {
        id: "started",
        ts: "2026-05-14T07:29:15.000Z",
        turnId: "turn-z",
        type: "status",
        title: "Turn started",
        text: null,
        rawType: "turn/started",
        toolName: null,
        callId: null,
      },
      {
        id: "partial",
        ts: "2026-05-14T07:29:20.000Z",
        turnId: "turn-z",
        type: "assistantMessage",
        title: "Assistant",
        text: "在",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
      {
        id: "aborted",
        ts: "2026-05-14T07:30:00.000Z",
        turnId: "turn-z",
        type: "status",
        title: "Turn interrupted",
        text: null,
        rawType: "turn/aborted",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("interrupted");
    expect(turns[0]!.isStreaming).toBe(false);
  });

  it("marks the turn completed once the rollout task_complete item arrives", () => {
    const items: ThreadTimelineItem[] = [
      {
        id: "task-started",
        ts: "2026-05-14T00:34:13.000Z",
        turnId: "turn-y",
        type: "status",
        title: "Turn started",
        text: null,
        rawType: "task_started",
        toolName: null,
        callId: null,
      },
      {
        id: "assistant-full",
        ts: "2026-05-14T00:34:30.000Z",
        turnId: "turn-y",
        type: "assistantMessage",
        title: "Assistant",
        text: "完整回應",
        rawType: "agent_message",
        toolName: null,
        callId: null,
      },
      {
        id: "task-complete",
        ts: "2026-05-14T00:34:40.000Z",
        turnId: "turn-y",
        type: "status",
        title: "Turn completed",
        text: "completed",
        rawType: "task_complete",
        toolName: null,
        callId: null,
      },
    ];

    const turns = buildConversationTurns(items);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("completed");
    expect(turns[0]!.isStreaming).toBe(false);
  });
});
