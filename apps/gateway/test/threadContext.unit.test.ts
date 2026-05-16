import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_ORIGINATOR,
  ThreadContextResolver,
  normalizeProjectKey,
} from "../src/threadContext.js";

const THREAD_ID = "019e3008-d992-79e3-8df6-377df64d96f2";

function writeSessionFile(sessionsDir: string, contents: string): string {
  const dir = path.join(sessionsDir, "2026", "05", "16");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-05-16T17-05-46-${THREAD_ID}.jsonl`);
  writeFileSync(file, contents);
  return file;
}

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

describe("ThreadContextResolver.resolveOriginator", () => {
  it("reads session_meta.payload.originator from the first line", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({
          timestamp: "2026-05-16T09:05:46.000Z",
          type: "session_meta",
          payload: { id: THREAD_ID, cwd: "/tmp/p", originator: GATEWAY_ORIGINATOR },
        })}\n${JSON.stringify({ type: "turn_context", payload: {} })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe(GATEWAY_ORIGINATOR);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a non-gateway originator verbatim", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({
          type: "session_meta",
          payload: { originator: "codex-tui" },
        })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe("codex-tui");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses a very long first session_meta line without truncation", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      // Real session_meta lines on this machine are ~22 KB. Build a >64 KB
      // first line so a fixed 16 KB read window (the bug seen elsewhere) would
      // truncate before reaching `originator`.
      const bigInstructions = "x".repeat(64 * 1024);
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: THREAD_ID,
            cwd: "/tmp/p",
            base_instructions: bigInstructions,
            originator: GATEWAY_ORIGINATOR,
          },
        })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe(GATEWAY_ORIGINATOR);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips a bare {id,timestamp} leading line and finds session_meta after it", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ id: THREAD_ID, timestamp: "2026-05-16T09:05:46.000Z" })}\n${JSON.stringify(
          { type: "session_meta", payload: { originator: "codex_exec" } },
        )}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe("codex_exec");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when session_meta is missing", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ type: "turn_context", payload: { cwd: "/tmp/p" } })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for malformed session_meta JSON without throwing", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(sessionsDir, `{ this is not valid json\n`);
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when session_meta has no originator field", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/p" } })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when there is no session file for the thread", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator("no-such-thread")).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("memoises a resolved originator and clears it on invalidate()", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const file = writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ type: "session_meta", payload: { originator: "codex-tui" } })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe("codex-tui");

      // Rewrite the file; the memoised value should still be returned.
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { originator: GATEWAY_ORIGINATOR } })}\n`,
      );
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe("codex-tui");

      resolver.invalidate(THREAD_ID);
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe(GATEWAY_ORIGINATOR);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("memoises the definitive 'session_meta present, no originator' case (immutable)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const file = writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/p" } })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();

      // A definitively-read session_meta with no originator is immutable for
      // the session — Codex never adds the field later — so this null IS
      // memoised. Corrupting the file afterwards must not change the answer.
      writeFileSync(file, "garbage not json\n");
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT memoise a transient unreadable miss; re-reads once session_meta lands (memoise-null race)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      // File exists but has no session_meta line yet (it is being written:
      // only a bare {id,timestamp} bootstrap line so far). This is transient,
      // NOT the definitive "no originator" case.
      const file = writeSessionFile(
        sessionsDir,
        `${JSON.stringify({ id: THREAD_ID, timestamp: "2026-05-16T09:05:46.000Z" })}\n`,
      );
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();

      // The session_meta line lands later with a concrete non-gateway
      // originator. Because the transient miss was NOT memoised, the next
      // read picks it up (instead of staying cached as null and leaking the
      // external thread into the default scope).
      writeFileSync(
        file,
        `${JSON.stringify({ id: THREAD_ID, timestamp: "2026-05-16T09:05:46.000Z" })}\n${JSON.stringify(
          { type: "session_meta", payload: { id: THREAD_ID, originator: "codex-tui" } },
        )}\n`,
      );
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe("codex-tui");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT memoise an empty (being-written) session file", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const file = writeSessionFile(sessionsDir, "");
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();

      writeFileSync(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { originator: GATEWAY_ORIGINATOR } })}\n`,
      );
      expect(await resolver.resolveOriginator(THREAD_ID)).toBe(GATEWAY_ORIGINATOR);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aborts a pathological huge / no-newline session file and returns null (I/O guard)", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-originator-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      // A single >1 MB line with no newline (corrupt/binary local file). The
      // max-line guard must abort the parse and return null instead of
      // buffering it unbounded — and must NOT throw.
      const huge = "x".repeat(2 * 1024 * 1024);
      writeSessionFile(sessionsDir, huge);
      const resolver = new ThreadContextResolver({ codexSessionsDir: sessionsDir });
      expect(await resolver.resolveOriginator(THREAD_ID)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
