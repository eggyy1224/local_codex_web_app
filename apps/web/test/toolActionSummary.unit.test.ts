import { describe, expect, it } from "vitest";
import {
  summarizeToolAction,
  type ConversationDetail,
} from "../app/lib/thread-logic";

function toolCall(toolName: string, text: string | null, callId: string | null = null): ConversationDetail {
  return {
    kind: "toolCall",
    ts: "2026-01-01T00:00:00.000Z",
    toolName,
    text,
    callId,
  };
}

describe("summarizeToolAction", () => {
  it("returns null for toolResult items (only calls surface as action rows)", () => {
    expect(
      summarizeToolAction({
        kind: "toolResult",
        ts: "2026-01-01T00:00:00.000Z",
        text: "stdout",
        callId: null,
      }),
    ).toBeNull();
    expect(
      summarizeToolAction({
        kind: "thinking",
        ts: "2026-01-01T00:00:00.000Z",
        text: "reasoning",
      }),
    ).toBeNull();
  });

  it("recognizes exec_command with JSON arguments and surfaces the command", () => {
    const action = summarizeToolAction(
      toolCall("exec_command", JSON.stringify({ command: "pnpm test --watch" }), "c1"),
    );
    expect(action).toMatchObject({
      kind: "command",
      label: "Ran pnpm test --watch",
      detail: "pnpm test --watch",
      callId: "c1",
    });
  });

  it("handles argv arrays for exec_command", () => {
    const action = summarizeToolAction(
      toolCall("exec_command", JSON.stringify({ argv: ["ls", "-la", "apps/web"] })),
    );
    expect(action?.label).toBe("Ran ls -la apps/web");
  });

  it("falls back to a plain command label when arguments are unparseable", () => {
    const action = summarizeToolAction(toolCall("exec_command", null));
    expect(action).toMatchObject({ kind: "command", label: "Ran command" });
  });

  it("treats non-JSON text as the command detail (first line)", () => {
    const action = summarizeToolAction(toolCall("bash", "echo hello\necho extra"));
    expect(action?.kind).toBe("command");
    expect(action?.label).toBe("Ran echo hello");
  });

  it("recognizes read_file and surfaces the path", () => {
    const action = summarizeToolAction(
      toolCall("read_file", JSON.stringify({ path: "apps/web/page.tsx" })),
    );
    expect(action).toMatchObject({
      kind: "read",
      label: "Read apps/web/page.tsx",
    });
  });

  it("recognizes apply_patch as an edit and surfaces the input filename when available", () => {
    const action = summarizeToolAction(
      toolCall("apply_patch", JSON.stringify({ path: "apps/web/foo.ts" })),
    );
    expect(action).toMatchObject({ kind: "edit", label: "Edited apps/web/foo.ts" });
  });

  it("recognizes search-like tools and surfaces the query", () => {
    const action = summarizeToolAction(
      toolCall("grep_search", JSON.stringify({ query: "TODO" })),
    );
    expect(action).toMatchObject({ kind: "search", label: "Searched TODO" });
  });

  it("falls back to Used <toolName> for unknown tools", () => {
    const action = summarizeToolAction(toolCall("custom_thing", null));
    expect(action).toMatchObject({ kind: "tool", label: "Used custom_thing" });
  });

  it("truncates very long command lines so the label stays one line", () => {
    const long = "echo " + "a".repeat(300);
    const action = summarizeToolAction(toolCall("exec_command", JSON.stringify({ command: long })));
    expect(action?.label.length).toBeLessThanOrEqual(125); // "Ran " + trimmed
    expect(action?.label.endsWith("…")).toBe(true);
  });

  it("keeps the raw text on the action so verbose mode can render it", () => {
    const raw = JSON.stringify({ command: "ls" });
    const action = summarizeToolAction(toolCall("exec_command", raw));
    expect(action?.rawText).toBe(raw);
  });
});
