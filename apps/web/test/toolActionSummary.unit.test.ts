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

  it("recognizes fs/readFile and the generic *read* category, preferring file_path", () => {
    // `fs/readFile` is the literal tool name codex emits for replayed read
    // events; the *read* substring rule also picks up plugin tool names
    // like "doc_reader" so we don't drop them to the generic "Used" path.
    const fsRead = summarizeToolAction(
      toolCall("fs/readFile", JSON.stringify({ file_path: "apps/web/app/page.tsx" })),
    );
    expect(fsRead).toMatchObject({
      kind: "read",
      label: "Read apps/web/app/page.tsx",
    });

    const docReader = summarizeToolAction(
      toolCall("doc_reader", JSON.stringify({ filename: "README.md" })),
    );
    expect(docReader).toMatchObject({ kind: "read", label: "Read README.md" });
  });

  it("falls back to a plain 'Read file' label when no path-like field is present", () => {
    // No JSON, no detectable path — exercise the read fallback branch.
    const action = summarizeToolAction(toolCall("read_file", null));
    expect(action).toMatchObject({ kind: "read", label: "Read file" });
  });

  it("recognizes write_file / edit_file and the generic *edit*/*write*/*patch* categories", () => {
    const writeFile = summarizeToolAction(
      toolCall("write_file", JSON.stringify({ path: "apps/web/app/x.ts" })),
    );
    expect(writeFile).toMatchObject({
      kind: "edit",
      label: "Edited apps/web/app/x.ts",
    });

    const editFile = summarizeToolAction(
      toolCall("edit_file", JSON.stringify({ file: "tmp/notes.md" })),
    );
    expect(editFile).toMatchObject({ kind: "edit", label: "Edited tmp/notes.md" });

    // *patch* substring should land in the edit bucket even without an
    // exact apply_patch match.
    const customPatch = summarizeToolAction(
      toolCall("custom_patch_tool", JSON.stringify({ file_path: "src/a.rs" })),
    );
    expect(customPatch).toMatchObject({ kind: "edit", label: "Edited src/a.rs" });
  });

  it("uses the input field as the edit detail when no path-like field is present", () => {
    // The edit reader allows `input` as the last fallback so apply_patch
    // payloads (which carry a raw patch string in `input`) still surface
    // something useful instead of "Edited file".
    const action = summarizeToolAction(
      toolCall("apply_patch", JSON.stringify({ input: "*** Begin Patch\n*** Update File: foo.ts" })),
    );
    expect(action?.kind).toBe("edit");
    expect(action?.label.startsWith("Edited ")).toBe(true);
    expect(action?.label).toContain("Begin Patch");
  });

  it("falls back to 'Edited file' when no detail is recoverable", () => {
    const action = summarizeToolAction(toolCall("apply_patch", null));
    expect(action).toMatchObject({ kind: "edit", label: "Edited file" });
  });

  it("recognizes search variants (pattern, q, term) and *find* / *grep* names", () => {
    const byPattern = summarizeToolAction(
      toolCall("search_codebase", JSON.stringify({ pattern: "useEffect" })),
    );
    expect(byPattern).toMatchObject({ kind: "search", label: "Searched useEffect" });

    const byShortQ = summarizeToolAction(
      toolCall("grep", JSON.stringify({ q: "TODO" })),
    );
    expect(byShortQ).toMatchObject({ kind: "search", label: "Searched TODO" });

    const byTerm = summarizeToolAction(
      toolCall("find_files", JSON.stringify({ term: "*.ts" })),
    );
    expect(byTerm).toMatchObject({ kind: "search", label: "Searched *.ts" });
  });

  it("falls back to plain 'Searched' when no query field is parseable", () => {
    const action = summarizeToolAction(toolCall("grep_search", null));
    expect(action).toMatchObject({ kind: "search", label: "Searched" });
  });

  it("uses the toolName verbatim in the 'Used <toolName>' fallback for unknown categories", () => {
    // No JSON detail → still produces the fallback so verbose mode shows
    // *something* even when we can't classify the tool.
    const noDetail = summarizeToolAction(toolCall("mystery_tool", null));
    expect(noDetail).toMatchObject({ kind: "tool", label: "Used mystery_tool" });
    expect(noDetail?.detail).toBeUndefined();

    // Even with JSON detail we keep the fallback label — only the kind
    // hierarchies above (command/read/edit/search) generate a verb.
    const withDetail = summarizeToolAction(
      toolCall("mcp_call", JSON.stringify({ input: "anything" })),
    );
    expect(withDetail).toMatchObject({ kind: "tool", label: "Used mcp_call" });
    // The detail is still surfaced for verbose mode consumers.
    expect(withDetail?.detail).toBe("anything");
  });

  it("keeps the callId on the action so raw call/output can pair back to the call", () => {
    // Mobile + desktop both surface raw output collapsed under the
    // corresponding tool call; the callId is the join key.
    const action = summarizeToolAction(
      toolCall("read_file", JSON.stringify({ path: "a" }), "call-42"),
    );
    expect(action?.callId).toBe("call-42");
  });
});
