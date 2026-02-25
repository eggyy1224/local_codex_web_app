import { describe, expect, it } from "vitest";
import { applySlashSuggestion, getSlashSuggestions } from "../app/lib/slash-commands";

describe("slash command suggestions", () => {
  it("shows /review for /r", () => {
    const suggestions = getSlashSuggestions("/r");
    expect(suggestions.map((item) => item.command)).toEqual(["review"]);
  });

  it("orders /p suggestions as /plan then /plan-mode", () => {
    const suggestions = getSlashSuggestions("/p");
    expect(suggestions.map((item) => item.command)).toEqual(["plan", "plan-mode"]);
  });

  it("returns empty suggestions for unknown slash prefix", () => {
    expect(getSlashSuggestions("/x")).toEqual([]);
  });

  it("does not show suggestions for non-slash text", () => {
    expect(getSlashSuggestions("status")).toEqual([]);
  });

  it("applies command and appends trailing space for slash-only input", () => {
    expect(applySlashSuggestion("/r", "review")).toBe("/review ");
  });

  it("applies command and preserves arguments", () => {
    expect(applySlashSuggestion("/r fix", "review")).toBe("/review fix");
  });

  it("supports fullwidth slash input", () => {
    expect(applySlashSuggestion("／r", "review")).toBe("/review ");
    expect(getSlashSuggestions("／r").map((item) => item.command)).toEqual(["review"]);
  });
});
