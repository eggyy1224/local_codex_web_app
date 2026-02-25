import { describe, expect, it } from "vitest";
import { metadata } from "../app/layout";

describe("layout metadata", () => {
  it("disables iOS format detection to avoid hydration mismatches", () => {
    const value =
      metadata.other && "format-detection" in metadata.other
        ? metadata.other["format-detection"]
        : undefined;
    expect(value).toBe("telephone=no, date=no, email=no, address=no");
  });
});
