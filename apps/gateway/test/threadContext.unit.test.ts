import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadContextResolver, normalizeProjectKey } from "../src/threadContext.js";

describe("normalizeProjectKey", () => {
  it("returns 'unknown' for missing input", () => {
    expect(normalizeProjectKey()).toBe("unknown");
    expect(normalizeProjectKey(null)).toBe("unknown");
    expect(normalizeProjectKey("")).toBe("unknown");
  });

  it("preserves a clean POSIX path unchanged", () => {
    expect(normalizeProjectKey("/tmp/project")).toBe("/tmp/project");
  });

  it("strips trailing slashes", () => {
    expect(normalizeProjectKey("/tmp/project/")).toBe("/tmp/project");
    expect(normalizeProjectKey("/tmp/project///")).toBe("/tmp/project");
  });

  it("converts Windows-style backslashes to forward slashes", () => {
    expect(normalizeProjectKey("C:\\Users\\me\\project")).toBe("C:/Users/me/project");
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeProjectKey("  /tmp/project  ")).toBe("/tmp/project");
  });
});

describe("ThreadContextResolver", () => {
  it("refreshes the session index when a session file appears after the first lookup", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-thread-context-"));
    const sessionsDir = path.join(tmpDir, "sessions");
    const threadId = "019e2085-d3f3-7fc3-9016-7f8952003c3a";

    try {
      mkdirSync(sessionsDir, { recursive: true });
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });

      expect(await resolver.getSessionFilePath(threadId)).toBeNull();
      expect((await resolver.resolveThreadContext(threadId)).source).toBe("fallback");

      const sessionDir = path.join(sessionsDir, "2026", "05", "13");
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(
        sessionDir,
        `rollout-2026-05-13T16-48-22-${threadId}.jsonl`,
      );
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          timestamp: "2026-05-13T08:48:22.848Z",
          type: "session_meta",
          payload: {
            id: threadId,
            cwd: "/tmp/project-a",
          },
        })}\n`,
      );

      expect(await resolver.getSessionFilePath(threadId)).toBe(sessionFile);
      expect(await resolver.resolveThreadContext(threadId)).toMatchObject({
        threadId,
        cwd: "/tmp/project-a",
        source: "session_meta",
        isFallback: false,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("upgrades a cached fallback context with the projected project key", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-thread-context-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      const threadId = "thread-no-session";

      // First call has no projection and no rollout file → fallback.
      const first = await resolver.resolveThreadContext(threadId);
      expect(first.isFallback).toBe(true);
      expect(first.source).toBe("fallback");

      // Subsequent call carries the projected projectKey we discovered later.
      const upgraded = await resolver.resolveThreadContext(threadId, "/tmp/project-b");
      expect(upgraded.isFallback).toBe(false);
      expect(upgraded.cwd).toBe("/tmp/project-b");
      expect(upgraded.resolvedCwd).toBe("/tmp/project-b");
      expect(upgraded.source).toBe("projection");

      // Cache now holds the upgraded value; subsequent reads return it
      // without needing the projection arg.
      const cached = await resolver.resolveThreadContext(threadId);
      expect(cached).toEqual(upgraded);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("invalidate() clears the cached context so the next call re-resolves", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-thread-context-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      const threadId = "thread-z";

      await resolver.resolveThreadContext(threadId, "/tmp/project-c");
      const before = await resolver.resolveThreadContext(threadId);
      expect(before.cwd).toBe("/tmp/project-c");

      resolver.invalidate(threadId);
      // Without the projected key again, re-resolution falls back to "fallback"
      // because there is still no rollout file in this temp dir.
      const after = await resolver.resolveThreadContext(threadId);
      expect(after.isFallback).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveProjectKey returns 'unknown' for fallback contexts and the cwd otherwise", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-thread-context-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveProjectKey("missing-thread")).toBe("unknown");
      expect(await resolver.resolveProjectKey("known-thread", "/tmp/known")).toBe("/tmp/known");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
