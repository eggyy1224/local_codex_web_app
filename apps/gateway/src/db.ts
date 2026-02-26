import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalStatus,
  ApprovalType,
  ApprovalView,
  GatewayEvent,
  InteractionStatus,
  InteractionType,
  InteractionView,
  ThreadListItem,
  ThreadStatus,
  UserInputQuestionView,
} from "@lcwa/shared-types";

export type ThreadProjection = {
  thread_id: string;
  project_key: string;
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

export type InteractionProjection = {
  interaction_id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  type: InteractionType;
  status: InteractionStatus;
  request_payload_json: string;
  response_payload_json: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type AuditLogEntry = {
  ts: string;
  actor: string;
  action: string;
  threadId: string | null;
  turnId: string | null;
  metadata: unknown;
};

export type GatewayDbPort = {
  upsertThreads(rows: ThreadProjection[]): void;
  listProjectedThreads(limit: number): ThreadListItem[];
  getProjectedThread(threadId: string): ThreadListItem | null;
  updateThreadProjectKey(threadId: string, projectKey: string): void;
  insertGatewayEvent(event: Omit<GatewayEvent, "seq">): number;
  listGatewayEventsSince(threadId: string, since: number, limit?: number): GatewayEvent[];
  upsertApprovalRequest(row: ApprovalProjection): void;
  resolveApprovalRequest(
    approvalId: string,
    status: ApprovalStatus,
    decision: string,
    note: string | null,
    resolvedAt: string,
  ): void;
  getApprovalById(approvalId: string): ApprovalView | null;
  listPendingApprovalsByThread(threadId: string): ApprovalView[];
  upsertInteractionRequest(row: InteractionProjection): void;
  respondInteractionRequest(
    interactionId: string,
    status: InteractionStatus,
    responsePayloadJson: string,
    resolvedAt: string,
  ): void;
  getInteractionById(interactionId: string): InteractionView | null;
  listPendingInteractions(): InteractionView[];
  listPendingInteractionsByThread(threadId: string): InteractionView[];
  insertAuditLog(entry: AuditLogEntry): void;
};

export type GatewayDb = GatewayDbPort & {
  sqlite: DatabaseSync;
  dataDir: string;
  dbPath: string;
};

export type GatewayDbOptions = {
  dataDir?: string;
  dbPath?: string;
};

function defaultGatewayDataDir(): string {
  return process.env.GATEWAY_DATA_DIR ?? path.join(os.homedir(), ".codex-web-gateway");
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

function readQuestions(requestPayload: Record<string, unknown>): UserInputQuestionView[] {
  if (!Array.isArray(requestPayload.questions)) {
    return [];
  }

  return requestPayload.questions
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const question = entry as Record<string, unknown>;
      const id = typeof question.id === "string" ? question.id : null;
      const header = typeof question.header === "string" ? question.header : null;
      const body = typeof question.question === "string" ? question.question : null;
      if (!id || !header || !body) {
        return null;
      }
      const options = Array.isArray(question.options)
        ? question.options
            .map((option) => {
              if (!option || typeof option !== "object") {
                return null;
              }
              const candidate = option as Record<string, unknown>;
              const label = typeof candidate.label === "string" ? candidate.label : null;
              const description =
                typeof candidate.description === "string"
                  ? candidate.description
                  : null;
              if (!label || !description) {
                return null;
              }
              return { label, description };
            })
            .filter((option): option is NonNullable<typeof option> => option !== null)
        : null;
      const normalizedOptions = options && options.length > 0 ? options : null;

      return {
        id,
        header,
        question: body,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options: normalizedOptions,
      };
    })
    .filter((entry): entry is UserInputQuestionView => entry !== null);
}

function toInteractionView(row: InteractionProjection): InteractionView {
  const requestPayload = JSON.parse(row.request_payload_json) as Record<string, unknown>;
  const questions = readQuestions(requestPayload);

  return {
    interactionId: row.interaction_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    type: row.type,
    status: row.status,
    questions,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function createGatewayDb(options: GatewayDbOptions = {}): GatewayDb {
  const dataDir = options.dataDir ?? defaultGatewayDataDir();
  const dbPath = options.dbPath ?? path.join(dataDir, "index.db");

  mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!options.dbPath) {
    mkdirSync(dataDir, { recursive: true });
  }

  const sqlite = new DatabaseSync(dbPath);

  sqlite.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS threads_projection (
  thread_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL DEFAULT 'unknown',
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

CREATE TABLE IF NOT EXISTS interactions (
  interaction_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  item_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  request_payload_json TEXT NOT NULL,
  response_payload_json TEXT,
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

  try {
    sqlite.exec("ALTER TABLE threads_projection ADD COLUMN project_key TEXT NOT NULL DEFAULT 'unknown'");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name")) {
      throw error;
    }
  }

  const upsertThreadStmt = sqlite.prepare(`
INSERT INTO threads_projection (thread_id, project_key, title, preview, status, archived, updated_at, last_error)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
  project_key = excluded.project_key,
  title = excluded.title,
  preview = excluded.preview,
  status = excluded.status,
  archived = excluded.archived,
  updated_at = excluded.updated_at,
  last_error = excluded.last_error;
`);

  const listThreadsStmt = sqlite.prepare(`
SELECT thread_id, project_key, title, preview, status, archived, updated_at, last_error
FROM threads_projection
ORDER BY updated_at DESC
LIMIT ?
`);

  const getThreadByIdStmt = sqlite.prepare(`
SELECT thread_id, project_key, title, preview, status, archived, updated_at, last_error
FROM threads_projection
WHERE thread_id = ?
LIMIT 1
`);

  const updateThreadProjectStmt = sqlite.prepare(`
UPDATE threads_projection
SET project_key = ?
WHERE thread_id = ?
`);

  const insertEventStmt = sqlite.prepare(`
INSERT INTO events_log (thread_id, turn_id, kind, name, payload_json, server_ts)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING seq
`);

  const listEventsSinceStmt = sqlite.prepare(`
SELECT seq, thread_id, turn_id, kind, name, payload_json, server_ts
FROM events_log
WHERE thread_id = ? AND seq > ?
ORDER BY seq ASC
LIMIT ?
`);

  const upsertApprovalStmt = sqlite.prepare(`
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

  const resolveApprovalStmt = sqlite.prepare(`
UPDATE approvals
SET status = ?, decision = ?, note = ?, resolved_at = ?
WHERE approval_id = ?
`);

  const getApprovalByIdStmt = sqlite.prepare(`
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

  const listPendingApprovalsByThreadStmt = sqlite.prepare(`
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

  const insertAuditStmt = sqlite.prepare(`
INSERT INTO audit_log (ts, actor, action, thread_id, turn_id, metadata_json)
VALUES (?, ?, ?, ?, ?, ?)
`);

  const upsertInteractionStmt = sqlite.prepare(`
INSERT INTO interactions (
  interaction_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  response_payload_json,
  created_at,
  resolved_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(interaction_id) DO UPDATE SET
  thread_id = excluded.thread_id,
  turn_id = excluded.turn_id,
  item_id = excluded.item_id,
  type = excluded.type,
  status = excluded.status,
  request_payload_json = excluded.request_payload_json,
  response_payload_json = excluded.response_payload_json,
  created_at = excluded.created_at,
  resolved_at = excluded.resolved_at;
`);

  const respondInteractionStmt = sqlite.prepare(`
UPDATE interactions
SET status = ?, response_payload_json = ?, resolved_at = ?
WHERE interaction_id = ?
`);

  const getInteractionByIdStmt = sqlite.prepare(`
SELECT
  interaction_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  response_payload_json,
  created_at,
  resolved_at
FROM interactions
WHERE interaction_id = ?
LIMIT 1
`);

  const listPendingInteractionsByThreadStmt = sqlite.prepare(`
SELECT
  interaction_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  response_payload_json,
  created_at,
  resolved_at
FROM interactions
WHERE thread_id = ? AND status = 'pending'
ORDER BY created_at ASC
`);

  const listPendingInteractionsStmt = sqlite.prepare(`
SELECT
  interaction_id,
  thread_id,
  turn_id,
  item_id,
  type,
  status,
  request_payload_json,
  response_payload_json,
  created_at,
  resolved_at
FROM interactions
WHERE status = 'pending'
ORDER BY created_at ASC
`);

  return {
    sqlite,
    dataDir,
    dbPath,
    upsertThreads(rows: ThreadProjection[]): void {
      sqlite.exec("BEGIN");
      try {
        for (const row of rows) {
          upsertThreadStmt.run(
            row.thread_id,
            row.project_key,
            row.title,
            row.preview,
            row.status,
            row.archived,
            row.updated_at,
            row.last_error,
          );
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    listProjectedThreads(limit: number): ThreadListItem[] {
      const rows = listThreadsStmt.all(limit) as ThreadProjection[];
      return rows.map((row) => ({
        id: row.thread_id,
        projectKey: row.project_key || "unknown",
        title: row.title,
        preview: row.preview,
        status: row.status,
        lastActiveAt: row.updated_at,
        archived: row.archived === 1,
        waitingApprovalCount: 0,
        errorCount: row.last_error ? 1 : 0,
      }));
    },
    getProjectedThread(threadId: string): ThreadListItem | null {
      const row = getThreadByIdStmt.get(threadId) as ThreadProjection | undefined;
      if (!row) {
        return null;
      }

      return {
        id: row.thread_id,
        projectKey: row.project_key || "unknown",
        title: row.title,
        preview: row.preview,
        status: row.status,
        lastActiveAt: row.updated_at,
        archived: row.archived === 1,
        waitingApprovalCount: 0,
        errorCount: row.last_error ? 1 : 0,
      };
    },
    updateThreadProjectKey(threadId: string, projectKey: string): void {
      updateThreadProjectStmt.run(projectKey, threadId);
    },
    insertGatewayEvent(event: Omit<GatewayEvent, "seq">): number {
      const row = insertEventStmt.get(
        event.threadId,
        event.turnId,
        event.kind,
        event.name,
        JSON.stringify(event.payload ?? null),
        event.serverTs,
      ) as { seq: number };
      return row.seq;
    },
    listGatewayEventsSince(threadId: string, since: number, limit = 500): GatewayEvent[] {
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
    },
    upsertApprovalRequest(row: ApprovalProjection): void {
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
    },
    resolveApprovalRequest(
      approvalId: string,
      status: ApprovalStatus,
      decision: string,
      note: string | null,
      resolvedAt: string,
    ): void {
      resolveApprovalStmt.run(status, decision, note, resolvedAt, approvalId);
    },
    getApprovalById(approvalId: string): ApprovalView | null {
      const row = getApprovalByIdStmt.get(approvalId) as ApprovalProjection | undefined;
      if (!row) {
        return null;
      }
      return toApprovalView(row);
    },
    listPendingApprovalsByThread(threadId: string): ApprovalView[] {
      const rows = listPendingApprovalsByThreadStmt.all(threadId) as ApprovalProjection[];
      return rows.map(toApprovalView);
    },
    upsertInteractionRequest(row: InteractionProjection): void {
      upsertInteractionStmt.run(
        row.interaction_id,
        row.thread_id,
        row.turn_id,
        row.item_id,
        row.type,
        row.status,
        row.request_payload_json,
        row.response_payload_json,
        row.created_at,
        row.resolved_at,
      );
    },
    respondInteractionRequest(
      interactionId: string,
      status: InteractionStatus,
      responsePayloadJson: string,
      resolvedAt: string,
    ): void {
      respondInteractionStmt.run(status, responsePayloadJson, resolvedAt, interactionId);
    },
    getInteractionById(interactionId: string): InteractionView | null {
      const row = getInteractionByIdStmt.get(interactionId) as InteractionProjection | undefined;
      if (!row) {
        return null;
      }
      return toInteractionView(row);
    },
    listPendingInteractions(): InteractionView[] {
      const rows = listPendingInteractionsStmt.all() as InteractionProjection[];
      return rows.map(toInteractionView);
    },
    listPendingInteractionsByThread(threadId: string): InteractionView[] {
      const rows = listPendingInteractionsByThreadStmt.all(threadId) as InteractionProjection[];
      return rows.map(toInteractionView);
    },
    insertAuditLog(entry: AuditLogEntry): void {
      insertAuditStmt.run(
        entry.ts,
        entry.actor,
        entry.action,
        entry.threadId,
        entry.turnId,
        JSON.stringify(entry.metadata ?? null),
      );
    },
  };
}

export const gatewayDb = createGatewayDb();
export const db = gatewayDb.sqlite;

export function upsertThreads(rows: ThreadProjection[]): void {
  gatewayDb.upsertThreads(rows);
}

export function listProjectedThreads(limit: number): ThreadListItem[] {
  return gatewayDb.listProjectedThreads(limit);
}

export function getProjectedThread(threadId: string): ThreadListItem | null {
  return gatewayDb.getProjectedThread(threadId);
}

export function updateThreadProjectKey(threadId: string, projectKey: string): void {
  gatewayDb.updateThreadProjectKey(threadId, projectKey);
}

export function insertGatewayEvent(event: Omit<GatewayEvent, "seq">): number {
  return gatewayDb.insertGatewayEvent(event);
}

export function listGatewayEventsSince(
  threadId: string,
  since: number,
  limit = 500,
): GatewayEvent[] {
  return gatewayDb.listGatewayEventsSince(threadId, since, limit);
}

export function upsertApprovalRequest(row: ApprovalProjection): void {
  gatewayDb.upsertApprovalRequest(row);
}

export function resolveApprovalRequest(
  approvalId: string,
  status: ApprovalStatus,
  decision: string,
  note: string | null,
  resolvedAt: string,
): void {
  gatewayDb.resolveApprovalRequest(approvalId, status, decision, note, resolvedAt);
}

export function getApprovalById(approvalId: string): ApprovalView | null {
  return gatewayDb.getApprovalById(approvalId);
}

export function listPendingApprovalsByThread(threadId: string): ApprovalView[] {
  return gatewayDb.listPendingApprovalsByThread(threadId);
}

export function upsertInteractionRequest(row: InteractionProjection): void {
  gatewayDb.upsertInteractionRequest(row);
}

export function respondInteractionRequest(
  interactionId: string,
  status: InteractionStatus,
  responsePayloadJson: string,
  resolvedAt: string,
): void {
  gatewayDb.respondInteractionRequest(interactionId, status, responsePayloadJson, resolvedAt);
}

export function getInteractionById(interactionId: string): InteractionView | null {
  return gatewayDb.getInteractionById(interactionId);
}

export function listPendingInteractions(): InteractionView[] {
  return gatewayDb.listPendingInteractions();
}

export function listPendingInteractionsByThread(threadId: string): InteractionView[] {
  return gatewayDb.listPendingInteractionsByThread(threadId);
}

export function insertAuditLog(entry: AuditLogEntry): void {
  gatewayDb.insertAuditLog(entry);
}
