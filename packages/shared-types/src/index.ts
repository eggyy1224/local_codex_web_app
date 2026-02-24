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
  projectKey: string;
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

export type ThreadTimelineItemType =
  | "userMessage"
  | "assistantMessage"
  | "reasoning"
  | "toolCall"
  | "toolResult"
  | "status";

export type ThreadTimelineItem = {
  id: string;
  ts: string;
  turnId: string | null;
  type: ThreadTimelineItemType;
  title: string;
  text: string | null;
  rawType: string;
  toolName: string | null;
  callId: string | null;
};

export type ThreadTimelineResponse = {
  data: ThreadTimelineItem[];
};

export type UserInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export type TurnStartOptions = {
  model?: string;
  effort?: string;
  cwd?: string;
  permissionMode?: TurnPermissionMode;
};

export type TurnPermissionMode = "local" | "full-access";

export type ModelReasoningEffortOption = {
  effort: string;
  description?: string;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  reasoningEffort?: ModelReasoningEffortOption[];
  upgrade?: string;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  isDefault?: boolean;
};

export type ModelsResponse = {
  data: ModelOption[];
};

export type CreateTurnRequest = {
  input: UserInputItem[];
  options?: TurnStartOptions;
};

export type CreateTurnResponse = {
  turnId: string;
};

export type ApprovalType = "commandExecution" | "fileChange" | "userInput";

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled";

export type ApprovalView = {
  approvalId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  type: ApprovalType;
  status: ApprovalStatus;
  reason: string | null;
  commandPreview: string | null;
  fileChangePreview: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type ApprovalDecisionRequest = {
  decision: "allow" | "deny" | "cancel";
  note?: string;
};

export type ApprovalDecisionResponse = {
  ok: true;
};

export type PendingApprovalsResponse = {
  data: ApprovalView[];
};

export type ThreadControlRequest = {
  action: "stop" | "retry" | "cancel";
};

export type ThreadControlResponse = {
  ok: true;
  appliedToTurnId?: string;
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
