import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  LEGACY_DEFAULT_MODEL,
  preferredModelOption,
  shouldRestoreSavedModel,
} from "../app/lib/model-options";

describe("model option defaults", () => {
  it("prefers GPT-5.5 over an older catalog default", () => {
    expect(
      preferredModelOption([
        { value: LEGACY_DEFAULT_MODEL, label: "GPT-5.3-Codex", isDefault: true },
        { value: DEFAULT_MODEL, label: "GPT-5.5", isDefault: false },
      ]),
    ).toMatchObject({ value: DEFAULT_MODEL });
  });

  it("does not restore the old default from localStorage", () => {
    expect(shouldRestoreSavedModel(LEGACY_DEFAULT_MODEL, null)).toBe(false);
    expect(shouldRestoreSavedModel(LEGACY_DEFAULT_MODEL, DEFAULT_MODEL)).toBe(true);
    expect(shouldRestoreSavedModel("gpt-5-codex", null)).toBe(true);
    expect(shouldRestoreSavedModel(null, null)).toBe(false);
  });
});
