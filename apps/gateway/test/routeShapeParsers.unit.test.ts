import { describe, expect, it } from "vitest";
import { parseTerminalClientMessage } from "../src/routes/terminalRoutes.js";
import { readInteractionAnswers } from "../src/routes/approvalInteractionRoutes.js";

describe("parseTerminalClientMessage", () => {
  it("rejects non-objects and entries without a string type", () => {
    expect(parseTerminalClientMessage(null)).toBeNull();
    expect(parseTerminalClientMessage("terminal/open")).toBeNull();
    expect(parseTerminalClientMessage({})).toBeNull();
    expect(parseTerminalClientMessage({ type: 42 })).toBeNull();
    expect(parseTerminalClientMessage({ type: "unknown" })).toBeNull();
  });

  it("normalizes terminal/open with optional cwd", () => {
    expect(parseTerminalClientMessage({ type: "terminal/open", threadId: "t-1" })).toEqual({
      type: "terminal/open",
      threadId: "t-1",
    });
    expect(
      parseTerminalClientMessage({
        type: "terminal/open",
        threadId: "t-1",
        cwd: "/tmp/x",
      }),
    ).toEqual({ type: "terminal/open", threadId: "t-1", cwd: "/tmp/x" });
  });

  it("defaults a missing threadId to empty string so the route can reject it explicitly", () => {
    expect(parseTerminalClientMessage({ type: "terminal/open" })).toEqual({
      type: "terminal/open",
      threadId: "",
    });
  });

  it("requires data to be a string for terminal/input", () => {
    expect(parseTerminalClientMessage({ type: "terminal/input", data: 42 })).toBeNull();
    expect(parseTerminalClientMessage({ type: "terminal/input", data: "ls\n" })).toEqual({
      type: "terminal/input",
      data: "ls\n",
    });
  });

  it("validates and floors cols/rows for terminal/resize", () => {
    expect(parseTerminalClientMessage({ type: "terminal/resize" })).toBeNull();
    expect(
      parseTerminalClientMessage({ type: "terminal/resize", cols: "120", rows: 24 }),
    ).toBeNull();
    expect(
      parseTerminalClientMessage({
        type: "terminal/resize",
        cols: Number.POSITIVE_INFINITY,
        rows: 24,
      }),
    ).toBeNull();
    expect(
      parseTerminalClientMessage({ type: "terminal/resize", cols: 120.7, rows: 24.9 }),
    ).toEqual({ type: "terminal/resize", cols: 120, rows: 24 });
  });

  it("requires cwd to be a string for terminal/setCwd", () => {
    expect(parseTerminalClientMessage({ type: "terminal/setCwd" })).toBeNull();
    expect(parseTerminalClientMessage({ type: "terminal/setCwd", cwd: "/" })).toEqual({
      type: "terminal/setCwd",
      cwd: "/",
    });
  });

  it("accepts a bare terminal/close", () => {
    expect(parseTerminalClientMessage({ type: "terminal/close" })).toEqual({
      type: "terminal/close",
    });
  });
});

describe("readInteractionAnswers", () => {
  it("rejects non-objects and arrays", () => {
    expect(readInteractionAnswers(null as never)).toBeNull();
    expect(readInteractionAnswers([] as never)).toBeNull();
    expect(readInteractionAnswers("not an object" as never)).toBeNull();
  });

  it("rejects when no question id has a non-empty answer", () => {
    expect(readInteractionAnswers({})).toBeNull();
    expect(
      readInteractionAnswers({
        q1: { answers: ["   ", "\t"] },
      } as never),
    ).toBeNull();
  });

  it("rejects whitespace-only or empty question ids", () => {
    expect(
      readInteractionAnswers({
        "   ": { answers: ["a"] },
      } as never),
    ).toBeNull();
  });

  it("rejects malformed entries (missing answers array, wrong type)", () => {
    expect(
      readInteractionAnswers({
        q1: null,
      } as never),
    ).toBeNull();
    expect(
      readInteractionAnswers({
        q1: { answers: "single string" },
      } as never),
    ).toBeNull();
  });

  it("trims and filters answers, drops questions with no surviving non-empty answers", () => {
    expect(
      readInteractionAnswers({
        q1: { answers: ["  yes  ", "", 7 as never, "no"] },
        q2: { answers: ["", "   "] },
      } as never),
    ).toBeNull();
  });

  it("returns the normalized shape when at least one question yields answers", () => {
    expect(
      readInteractionAnswers({
        q1: { answers: ["  yes  ", "no"] },
        q2: { answers: ["maybe"] },
      } as never),
    ).toEqual({
      q1: { answers: ["yes", "no"] },
      q2: { answers: ["maybe"] },
    });
  });
});
