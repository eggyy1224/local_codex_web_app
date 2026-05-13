import { describe, expect, it } from "vitest";
import {
  applyFileMention,
  detectFileMentionTrigger,
} from "../app/lib/use-file-mention-search";

describe("detectFileMentionTrigger", () => {
  it("triggers on @ at the start of an empty query", () => {
    expect(detectFileMentionTrigger("@")).toEqual({ query: "", start: 0 });
  });

  it("triggers on @ followed by a token at end of prompt", () => {
    expect(detectFileMentionTrigger("read @Mob")).toEqual({ query: "Mob", start: 5 });
  });

  it("does not trigger when @ is in the middle of a word (e.g. email)", () => {
    expect(detectFileMentionTrigger("name@example")).toBeNull();
  });

  it("does not trigger after the user added whitespace past the @", () => {
    expect(detectFileMentionTrigger("@Mob hello")).toBeNull();
  });

  it("picks the LAST @-token when multiple @ exist", () => {
    expect(detectFileMentionTrigger("see @first then @sec")).toEqual({
      query: "sec",
      start: 16,
    });
  });
});

describe("applyFileMention", () => {
  it("replaces the @-token with the picked path and trailing space", () => {
    const trigger = { query: "Mob", start: 5 } as const;
    expect(applyFileMention("read @Mob", trigger, "apps/web/MobileChatTopBar.tsx")).toBe(
      "read @apps/web/MobileChatTopBar.tsx ",
    );
  });

  it("preserves text before the @ unchanged", () => {
    const trigger = { query: "x", start: 6 } as const;
    expect(applyFileMention("hello @x", trigger, "src/a.ts")).toBe("hello @src/a.ts ");
  });
});
