import { describe, expect, it } from "vitest";
import { extractThreadId, extractTurnId } from "../src/appServerProjection.js";

describe("extractThreadId", () => {
  it("returns null for non-objects", () => {
    expect(extractThreadId(null)).toBeNull();
    expect(extractThreadId(undefined)).toBeNull();
    expect(extractThreadId("thread-1")).toBeNull();
    expect(extractThreadId(42)).toBeNull();
  });

  it("reads camelCase threadId", () => {
    expect(extractThreadId({ threadId: "t-1" })).toBe("t-1");
  });

  it("reads snake_case thread_id when camelCase is absent", () => {
    expect(extractThreadId({ thread_id: "t-2" })).toBe("t-2");
  });

  it("prefers camelCase when both forms are present", () => {
    expect(extractThreadId({ threadId: "camel", thread_id: "snake" })).toBe("camel");
  });

  it("falls back to params.thread.id when no top-level key matches", () => {
    expect(extractThreadId({ thread: { id: "nested" } })).toBe("nested");
  });

  it("returns null when nested thread.id is not a string", () => {
    expect(extractThreadId({ thread: { id: 123 } })).toBeNull();
  });

  it("returns null when the value is present but not a string", () => {
    expect(extractThreadId({ threadId: 42 })).toBeNull();
  });
});

describe("extractTurnId", () => {
  it("returns null for non-objects", () => {
    expect(extractTurnId(null)).toBeNull();
    expect(extractTurnId(undefined)).toBeNull();
    expect(extractTurnId([1, 2])).toBeNull();
  });

  it("reads camelCase turnId", () => {
    expect(extractTurnId({ turnId: "x" })).toBe("x");
  });

  it("reads snake_case turn_id when camelCase is absent", () => {
    expect(extractTurnId({ turn_id: "y" })).toBe("y");
  });

  it("falls back to params.turn.id when no top-level key matches", () => {
    expect(extractTurnId({ turn: { id: "nested-turn" } })).toBe("nested-turn");
  });

  it("returns null when the value is present but not a string", () => {
    expect(extractTurnId({ turnId: null })).toBeNull();
    expect(extractTurnId({ turn: { id: 7 } })).toBeNull();
  });
});
