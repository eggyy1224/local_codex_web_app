export type HealthResponse = {
  status: "ok" | "degraded";
  appServerConnected: boolean;
  timestamp: string;
  message?: string;
};

export type ThreadStatus =
  | "notLoaded"
  | "idle"
  | "active"
  | "systemError"
  | "unknown";

export type ThreadListItem = {
  id: string;
  title: string;
  preview: string;
  status: ThreadStatus;
  lastActiveAt: string;
  archived: boolean;
  waitingApprovalCount: number;
  errorCount: number;
};

export type ThreadListResponse = {
  data: ThreadListItem[];
  nextCursor: string | null;
};

export type TurnView = {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: unknown;
  items: unknown[];
};

export type ThreadMeta = {
  id: string;
  title: string;
  preview: string;
  status: ThreadStatus;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ThreadDetailResponse = {
  thread: ThreadMeta;
  turns: TurnView[];
  nextCursor: string | null;
};

export type GatewayEvent = {
  seq: number;
  serverTs: string;
  threadId: string;
  turnId: string | null;
  kind: "thread" | "turn" | "item" | "approval" | "system";
  name: string;
  payload: unknown;
};
