import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalStatus,
  ApprovalType,
  ApprovalView,
  GatewayEvent,
  ThreadListItem,
  ThreadStatus,
} from "@lcwa/shared-types";

export type ThreadProjection = {
  thread_id: string;
  title: string;
  preview: string;
  status: ThreadStatus;
  archived: number;
  updated_at: string;
  last_error: string | null;
};

export type ApprovalProjection = {
  approval_id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  type: ApprovalType;
  status: ApprovalStatus;
  request_payload_json: string;
  decision: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
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

const upsertApprovalStmt = db.prepare(`
INSERT INTO approvals (
  approval_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  decision,
  note,
  created_at,
  resolved_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(approval_id) DO UPDATE SET
  thread_id = excluded.thread_id,
  turn_id = excluded.turn_id,
  item_id = excluded.item_id,
  type = excluded.type,
  status = excluded.status,
  request_payload_json = excluded.request_payload_json,
  decision = excluded.decision,
  note = excluded.note,
  created_at = excluded.created_at,
  resolved_at = excluded.resolved_at;
`);

const resolveApprovalStmt = db.prepare(`
UPDATE approvals
SET status = ?, decision = ?, note = ?, resolved_at = ?
WHERE approval_id = ?
`);

const getApprovalByIdStmt = db.prepare(`
SELECT
  approval_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  decision,
  note,
  created_at,
  resolved_at
FROM approvals
WHERE approval_id = ?
LIMIT 1
`);

const listPendingApprovalsByThreadStmt = db.prepare(`
SELECT
  approval_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  decision,
  note,
  created_at,
  resolved_at
FROM approvals
WHERE thread_id = ? AND status = 'pending'
ORDER BY created_at ASC
`);

const insertAuditStmt = db.prepare(`
INSERT INTO audit_log (ts, actor, action, thread_id, turn_id, metadata_json)
VALUES (?, ?, ?, ?, ?, ?)
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

function toApprovalView(row: ApprovalProjection): ApprovalView {
  const requestPayload = JSON.parse(row.request_payload_json) as Record<string, unknown>;

  const commandPreview =
    typeof requestPayload.command === "string" ? requestPayload.command : null;

  let fileChangePreview: string | null = null;
  const changes = requestPayload.changes;
  if (Array.isArray(changes)) {
    const firstPath = changes.find(
      (entry) =>
        entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).path === "string",
    ) as Record<string, unknown> | undefined;
    if (firstPath && typeof firstPath.path === "string") {
      fileChangePreview = firstPath.path;
    }
  }

  return {
    approvalId: row.approval_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    type: row.type,
    status: row.status,
    reason: typeof requestPayload.reason === "string" ? requestPayload.reason : null,
    commandPreview,
    fileChangePreview,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function upsertApprovalRequest(row: ApprovalProjection): void {
  upsertApprovalStmt.run(
    row.approval_id,
    row.thread_id,
    row.turn_id,
    row.item_id,
    row.type,
    row.status,
    row.request_payload_json,
    row.decision,
    row.note,
    row.created_at,
    row.resolved_at,
  );
}

export function resolveApprovalRequest(
  approvalId: string,
  status: ApprovalStatus,
  decision: string,
  note: string | null,
  resolvedAt: string,
): void {
  resolveApprovalStmt.run(status, decision, note, resolvedAt, approvalId);
}

export function getApprovalById(approvalId: string): ApprovalView | null {
  const row = getApprovalByIdStmt.get(approvalId) as ApprovalProjection | undefined;
  if (!row) {
    return null;
  }
  return toApprovalView(row);
}

export function listPendingApprovalsByThread(threadId: string): ApprovalView[] {
  const rows = listPendingApprovalsByThreadStmt.all(threadId) as ApprovalProjection[];
  return rows.map(toApprovalView);
}

export function insertAuditLog(entry: {
  ts: string;
  actor: string;
  action: string;
  threadId: string | null;
  turnId: string | null;
  metadata: unknown;
}): void {
  insertAuditStmt.run(
    entry.ts,
    entry.actor,
    entry.action,
    entry.threadId,
    entry.turnId,
    JSON.stringify(entry.metadata ?? null),
  );
}
