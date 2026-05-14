import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertLocalImagePathsInsideRoot, UploadError } from "../src/uploads.js";

describe("assertLocalImagePathsInsideRoot", () => {
  let uploadRoot: string;

  beforeAll(() => {
    uploadRoot = mkdtempSync(path.join(os.tmpdir(), "lcwa-upload-root-"));
  });

  afterAll(() => {
    rmSync(uploadRoot, { recursive: true, force: true });
  });

  it("accepts a localImage whose path is inside the upload root", () => {
    expect(() =>
      assertLocalImagePathsInsideRoot(
        [{ type: "localImage", path: path.join(uploadRoot, "abc.png") }],
        uploadRoot,
      ),
    ).not.toThrow();
  });

  it("rejects a localImage path outside the upload root with 400", () => {
    let captured: unknown = null;
    try {
      assertLocalImagePathsInsideRoot(
        [{ type: "localImage", path: "/etc/passwd" }],
        uploadRoot,
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UploadError);
    expect((captured as UploadError).statusCode).toBe(400);
    expect((captured as UploadError).message).toContain("upload root");
  });

  it("rejects a localImage with a traversal segment that escapes the root", () => {
    expect(() =>
      assertLocalImagePathsInsideRoot(
        [
          {
            type: "localImage",
            path: path.join(uploadRoot, "..", "outside.png"),
          },
        ],
        uploadRoot,
      ),
    ).toThrow(UploadError);
  });

  it("rejects a localImage with no path string", () => {
    expect(() =>
      assertLocalImagePathsInsideRoot(
        [{ type: "localImage", path: undefined }],
        uploadRoot,
      ),
    ).toThrow(/required/);
  });

  it("does not touch non-localImage items (text/image/skill/mention)", () => {
    expect(() =>
      assertLocalImagePathsInsideRoot(
        [
          { type: "text", path: "/etc/passwd" } as unknown as {
            type: string;
            path?: unknown;
          },
          { type: "skill", path: "/Users/x/.codex/skills/y" },
          { type: "mention", path: "app://foo" },
        ],
        uploadRoot,
      ),
    ).not.toThrow();
  });

  it("rejects when mixed input has one bad localImage alongside good ones", () => {
    expect(() =>
      assertLocalImagePathsInsideRoot(
        [
          { type: "text" } as unknown as { type: string; path?: unknown },
          { type: "localImage", path: path.join(uploadRoot, "ok.jpg") },
          { type: "localImage", path: "/tmp/escape.jpg" },
        ],
        uploadRoot,
      ),
    ).toThrow(UploadError);
  });
});
