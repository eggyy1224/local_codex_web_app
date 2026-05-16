import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayDb, type ThreadProjection } from "../src/db.js";

function makeRow(overrides: Partial<ThreadProjection> = {}): ThreadProjection {
  return {
    thread_id: "thread-1",
    project_key: "/tmp/p",
    title: "Title",
    preview: "Preview",
    status: "idle",
    archived: 0,
    updated_at: "2026-05-16T00:00:00.000Z",
    last_error: null,
    originator: null,
    ...overrides,
  };
}

describe("createGatewayDb originator column", () => {
  it("creates the nullable originator column and round-trips it", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-db-"));
    try {
      const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
      db.upsertThreads([
        makeRow({ thread_id: "gw", originator: "local_codex_web_app" }),
        makeRow({ thread_id: "tui", originator: "codex-tui" }),
        makeRow({ thread_id: "old", originator: null }),
      ]);

      expect(db.getThreadOriginator("gw")).toBe("local_codex_web_app");
      expect(db.getThreadOriginator("tui")).toBe("codex-tui");
      expect(db.getThreadOriginator("old")).toBeNull();
      expect(db.getThreadOriginator("missing")).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("migration is idempotent across reopen of the same db file", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-db-"));
    try {
      const dbPath = path.join(tmpDir, "index.db");
      const first = createGatewayDb({ dbPath });
      first.upsertThreads([makeRow({ thread_id: "t", originator: "codex-tui" })]);

      // Reopening must not throw on the duplicate-column ALTER and must keep
      // the previously persisted originator.
      const second = createGatewayDb({ dbPath });
      expect(second.getThreadOriginator("t")).toBe("codex-tui");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-upserting with originator=null does not wipe a backfilled value", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-db-"));
    try {
      const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
      db.upsertThreads([makeRow({ thread_id: "t", originator: null })]);
      db.updateThreadOriginator("t", "local_codex_web_app");
      expect(db.getThreadOriginator("t")).toBe("local_codex_web_app");

      // Simulates the thread/list path re-upserting (it passes originator=null).
      db.upsertThreads([
        makeRow({ thread_id: "t", title: "Updated", originator: null }),
      ]);

      expect(db.getThreadOriginator("t")).toBe("local_codex_web_app");
      expect(db.getProjectedThread("t")?.title).toBe("Updated");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updateThreadOriginator can clear a value back to null", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-db-"));
    try {
      const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
      db.upsertThreads([makeRow({ thread_id: "t", originator: "codex-tui" })]);
      db.updateThreadOriginator("t", null);
      expect(db.getThreadOriginator("t")).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
