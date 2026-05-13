import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadContextResolver } from "../src/threadContext.js";

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
});
