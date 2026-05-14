import { describe, expect, it } from "vitest";
import {
  resolveImageSrc,
  resolveMarkdownImageSrc,
} from "../app/lib/resolve-image-src";

const gateway = "http://gateway.test:8795";

describe("resolveImageSrc", () => {
  it("passes data URLs through unchanged", () => {
    const src = "data:image/png;base64,AAAA";
    expect(resolveImageSrc(src, gateway)).toBe(src);
  });

  it("passes absolute http(s) URLs through unchanged", () => {
    expect(resolveImageSrc("https://example.com/foo.jpg", gateway)).toBe(
      "https://example.com/foo.jpg",
    );
  });

  it("prefixes gateway-relative API paths with the gateway base URL", () => {
    expect(resolveImageSrc("/api/uploads/abc.png", gateway)).toBe(
      `${gateway}/api/uploads/abc.png`,
    );
  });

  it("strips a trailing slash on the gateway base before joining", () => {
    expect(resolveImageSrc("/api/uploads/abc.png", `${gateway}/`)).toBe(
      `${gateway}/api/uploads/abc.png`,
    );
  });

  it("leaves unknown formats verbatim", () => {
    expect(resolveImageSrc("foo.png", gateway)).toBe("foo.png");
  });
});

describe("resolveMarkdownImageSrc", () => {
  it("routes a local absolute path through /api/files/preview", () => {
    const local = "/Volumes/2024data/photo.jpg";
    expect(resolveMarkdownImageSrc(local, gateway)).toBe(
      `${gateway}/api/files/preview?path=${encodeURIComponent(local)}`,
    );
  });

  it("preserves /api/uploads/... by reusing resolveImageSrc", () => {
    expect(resolveMarkdownImageSrc("/api/uploads/abc.png", gateway)).toBe(
      `${gateway}/api/uploads/abc.png`,
    );
  });

  it("passes data URLs through unchanged", () => {
    expect(resolveMarkdownImageSrc("data:image/png;base64,AAAA", gateway)).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("passes http(s) URLs through unchanged", () => {
    expect(resolveMarkdownImageSrc("https://example.com/x.jpg", gateway)).toBe(
      "https://example.com/x.jpg",
    );
  });

  it("encodes special characters and spaces in local paths", () => {
    const local = "/Users/me/photos/some pic & file.jpg";
    expect(resolveMarkdownImageSrc(local, gateway)).toBe(
      `${gateway}/api/files/preview?path=${encodeURIComponent(local)}`,
    );
  });

  it("routes a Windows-style absolute path through /api/files/preview", () => {
    const win = "C:\\Users\\me\\photo.jpg";
    expect(resolveMarkdownImageSrc(win, gateway)).toBe(
      `${gateway}/api/files/preview?path=${encodeURIComponent(win)}`,
    );
  });

  it("decodes already percent-encoded markdown paths before re-encoding for the query", () => {
    // Codex emits `![](/Volumes/.../%E9%90%B5%E5%B1%B1.jpg)` — react-markdown
    // forwards that verbatim. If we re-encode the percent signs the gateway
    // sees doubly-encoded bytes and the file read fails.
    const fromMarkdown = "/Volumes/2024data/%E9%90%B5%E5%B1%B1.jpg";
    const decoded = "/Volumes/2024data/鐵山.jpg";
    expect(resolveMarkdownImageSrc(fromMarkdown, gateway)).toBe(
      `${gateway}/api/files/preview?path=${encodeURIComponent(decoded)}`,
    );
  });
});
