import React, { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ConversationTurn } from "../app/lib/thread-logic";
import MobileMessageStream from "../app/threads/[id]/MobileMessageStream";
import type { MobileViewMode } from "../app/threads/[id]/MobileChatTopBar";

function makeTurn(): ConversationTurn {
  return {
    turnId: "turn-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "completed",
    isStreaming: false,
    userText: "do thing",
    assistantText: "done",
    thinkingText: "thinking aloud",
    toolCalls: [],
    toolResults: [],
    details: [],
    segments: [
      { kind: "user", ts: "2026-01-01T00:00:00.000Z", text: "do thing", isSteer: false },
      { kind: "thinking", ts: "2026-01-01T00:00:01.000Z", text: "thinking aloud" },
      {
        kind: "toolBatch",
        ts: "2026-01-01T00:00:02.000Z",
        summary: "Ran 1 command",
        items: [
          {
            kind: "toolCall",
            ts: "2026-01-01T00:00:02.000Z",
            toolName: "exec_command",
            text: JSON.stringify({ command: "ls -la" }),
            callId: "c1",
          },
          {
            kind: "toolResult",
            ts: "2026-01-01T00:00:03.000Z",
            text: "file-listing-output",
            callId: "c1",
          },
        ],
      },
      { kind: "assistant", ts: "2026-01-01T00:00:04.000Z", text: "done" },
    ],
  };
}

function StreamHarness({
  turn,
  viewMode,
}: {
  turn: ConversationTurn;
  viewMode: MobileViewMode;
}) {
  const timelineRef = useRef<HTMLElement | null>(null);
  return (
    <MobileMessageStream
      turns={[turn]}
      hiddenCount={0}
      showAllTurns={false}
      onToggleShowAll={() => {}}
      timelineRef={timelineRef}
      onTimelineScroll={() => {}}
      formatTimestamp={() => "now"}
      reviewSlashCommandByTurnId={new Map()}
      onCopyMessage={() => {}}
      onOpenMessageDetails={() => {}}
      viewMode={viewMode}
    />
  );
}

describe("MobileMessageStream view modes (slice 3)", () => {
  it("normal: hides thinking blocks, shows the tool batch summary + semantic action row, but not raw call/output", () => {
    render(<StreamHarness turn={makeTurn()} viewMode="normal" />);

    // Tool action row appears as a semantic pill.
    const actions = screen.getAllByTestId("mobile-tool-action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toHaveAttribute("data-kind", "command");
    expect(actions[0]).toHaveTextContent("Ran ls -la");

    // Reasoning is hidden.
    expect(screen.queryByTestId("mobile-thinking-inline")).not.toBeInTheDocument();

    // Raw tool call/output detail is hidden in normal mode (only verbose surfaces it).
    expect(screen.queryByTestId("mobile-tool-raw-call")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tool-raw-output")).not.toBeInTheDocument();
  });

  it("thinking: surfaces the reasoning collapsible, but still hides raw tool detail", () => {
    render(<StreamHarness turn={makeTurn()} viewMode="thinking" />);
    expect(screen.getByTestId("mobile-thinking-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tool-raw-call")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tool-raw-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-tool-action")).toBeInTheDocument();
  });

  it("verbose: shows reasoning AND raw call/output detail inside the tool batch", () => {
    render(<StreamHarness turn={makeTurn()} viewMode="verbose" />);
    expect(screen.getByTestId("mobile-thinking-inline")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tool-raw-call")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tool-raw-output")).toHaveTextContent("file-listing-output");
  });

  it("propagates viewMode to the timeline element for downstream styling/asserts", () => {
    render(<StreamHarness turn={makeTurn()} viewMode="verbose" />);
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-view-mode", "verbose");
  });

  // Avoid an unused-import lint complaint when running this file in isolation.
  it("smoke: vi is wired through (no-op)", () => {
    expect(typeof vi.fn).toBe("function");
  });
});
