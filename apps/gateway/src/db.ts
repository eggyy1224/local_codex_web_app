import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewayEvent, ThreadListItem, ThreadStatus } from "@lcwa/shared-types";

export type ThreadProjection = {
  thread_id: string;
  title: string;
  preview: string;
  status: ThreadStatus;
  archived: number;
  updated_at: string;
  last_error: string | null;
};

const dataDir = process.env.GATEWAY_DATA_DIR ?? path.join(os.homedir(), ".codex-web-gateway");
const dbPath = path.join(dataDir, "index.db");

mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS threads_projection (
  thread_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  status TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS turns_projection (
  turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT
);

CREATE TABLE IF NOT EXISTS events_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  server_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  item_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  request_payload_json TEXT NOT NULL,
  decision TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  metadata_json TEXT
);
`);

const upsertThreadStmt = db.prepare(`
INSERT INTO threads_projection (thread_id, title, preview, status, archived, updated_at, last_error)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
  title = excluded.title,
  preview = excluded.preview,
  status = excluded.status,
  archived = excluded.archived,
  updated_at = excluded.updated_at,
  last_error = excluded.last_error;
`);

const listThreadsStmt = db.prepare(`
SELECT thread_id, title, preview, status, archived, updated_at, last_error
FROM threads_projection
ORDER BY updated_at DESC
LIMIT ?
`);

const getThreadByIdStmt = db.prepare(`
SELECT thread_id, title, preview, status, archived, updated_at, last_error
FROM threads_projection
WHERE thread_id = ?
LIMIT 1
`);

const insertEventStmt = db.prepare(`
INSERT INTO events_log (thread_id, turn_id, kind, name, payload_json, server_ts)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING seq
`);

const listEventsSinceStmt = db.prepare(`
SELECT seq, thread_id, turn_id, kind, name, payload_json, server_ts
FROM events_log
WHERE thread_id = ? AND seq > ?
ORDER BY seq ASC
LIMIT ?
`);

export function upsertThreads(rows: ThreadProjection[]): void {
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertThreadStmt.run(
        row.thread_id,
        row.title,
        row.preview,
        row.status,
        row.archived,
        row.updated_at,
        row.last_error,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProjectedThreads(limit: number): ThreadListItem[] {
  const rows = listThreadsStmt.all(limit) as ThreadProjection[];
  return rows.map((row) => ({
    id: row.thread_id,
    title: row.title,
    preview: row.preview,
    status: row.status,
    lastActiveAt: row.updated_at,
    archived: row.archived === 1,
    waitingApprovalCount: 0,
    errorCount: row.last_error ? 1 : 0,
  }));
}

export function getProjectedThread(threadId: string): ThreadListItem | null {
  const row = getThreadByIdStmt.get(threadId) as ThreadProjection | undefined;
  if (!row) {
    return null;
  }

  return {
    id: row.thread_id,
    title: row.title,
    preview: row.preview,
    status: row.status,
    lastActiveAt: row.updated_at,
    archived: row.archived === 1,
    waitingApprovalCount: 0,
    errorCount: row.last_error ? 1 : 0,
  };
}

export function insertGatewayEvent(event: Omit<GatewayEvent, "seq">): number {
  const row = insertEventStmt.get(
    event.threadId,
    event.turnId,
    event.kind,
    event.name,
    JSON.stringify(event.payload ?? null),
    event.serverTs,
  ) as { seq: number };
  return row.seq;
}

export function listGatewayEventsSince(
  threadId: string,
  since: number,
  limit = 500,
): GatewayEvent[] {
  const rows = listEventsSinceStmt.all(threadId, since, limit) as Array<{
    seq: number;
    thread_id: string;
    turn_id: string | null;
    kind: GatewayEvent["kind"];
    name: string;
    payload_json: string;
    server_ts: string;
  }>;

  return rows.map((row) => ({
    seq: row.seq,
    threadId: row.thread_id,
    turnId: row.turn_id,
    kind: row.kind,
    name: row.name,
    payload: JSON.parse(row.payload_json),
    serverTs: row.server_ts,
  }));
}
