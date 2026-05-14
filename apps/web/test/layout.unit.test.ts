import { describe, expect, it } from "vitest";
import {
  hydrationAttributeCleanupScript,
  nextDevIndicatorCleanupScript,
} from "../app/lib/hydration-cleanup";
import manifest from "../app/manifest";
import { metadata, viewport } from "../app/layout";

describe("layout metadata", () => {
  it("disables iOS format detection to avoid hydration mismatches", () => {
    const value =
      metadata.other && "format-detection" in metadata.other
        ? metadata.other["format-detection"]
        : undefined;
    expect(value).toBe("telephone=no, date=no, email=no, address=no");
  });

  it("declares standalone PWA metadata for mobile home-screen launch", () => {
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(metadata.appleWebApp).toMatchObject({
      capable: true,
      title: "Local Codex",
      statusBarStyle: "black-translucent",
    });
    expect(viewport.themeColor).toBe("#090909");
  });

  it("serves an installable web app manifest", () => {
    expect(manifest()).toMatchObject({
      name: "Local Codex",
      short_name: "Codex",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#090909",
    });
  });

  it("removes Chrome remote frame attributes before hydration", () => {
    expect(hydrationAttributeCleanupScript).toContain("__gcrremoteframetoken");
  });

  it("disables the Next dev indicator in development sessions", () => {
    expect(nextDevIndicatorCleanupScript).toContain("/__nextjs_disable_dev_indicator");
    expect(nextDevIndicatorCleanupScript).toContain("/__nextjs_devtools_config");
    expect(nextDevIndicatorCleanupScript).toContain("data-devtools-indicator");
    expect(nextDevIndicatorCleanupScript).toContain("next-logo");
  });
});
