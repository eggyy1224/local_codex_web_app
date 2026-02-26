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

export type ThreadContextSource =
  | "session_meta"
  | "turn_context"
  | "projection"
  | "fallback";

export type ThreadContextResponse = {
  threadId: string;
  cwd: string | null;
  resolvedCwd: string;
  isFallback: boolean;
  source: ThreadContextSource;
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
    }
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name: string;
      path: string;
    };

export type TurnStartOptions = {
  model?: string;
  effort?: string;
  cwd?: string;
  permissionMode?: TurnPermissionMode;
  collaborationMode?: "plan" | "default";
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
  warnings?: string[];
};

export type ReviewDelivery = "inline" | "detached";

export type ReviewTarget =
  | {
      type: "uncommittedChanges";
    }
  | {
      type: "baseBranch";
      branch: string;
    }
  | {
      type: "commit";
      sha: string;
      title?: string | null;
    }
  | {
      type: "custom";
      instructions: string;
    };

export type CreateReviewRequest = {
  delivery?: ReviewDelivery;
  target?: ReviewTarget;
  instructions?: string;
};

export type CreateReviewResponse = {
  turnId: string;
  reviewThreadId: string;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits?: unknown;
  planType?: string | null;
};

export type AccountRateLimitsResponse = {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  error?: string;
};

export type ApprovalType = "commandExecution" | "fileChange";

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

export type InteractionType = "userInput";

export type InteractionStatus = "pending" | "responded" | "cancelled";

export type UserInputOptionView = {
  label: string;
  description: string;
};

export type UserInputQuestionView = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOptionView[] | null;
};

export type InteractionView = {
  interactionId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  type: InteractionType;
  status: InteractionStatus;
  questions: UserInputQuestionView[];
  createdAt: string;
  resolvedAt: string | null;
};

export type PendingInteractionsResponse = {
  data: InteractionView[];
};

export type InteractionRespondRequest = {
  answers: Record<string, { answers: string[] }>;
};

export type InteractionRespondResponse = {
  ok: true;
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
  kind: "thread" | "turn" | "item" | "approval" | "interaction" | "system";
  name: string;
  payload: unknown;
};

export type TerminalClientMessage =
  | {
      type: "terminal/open";
      threadId: string;
      cwd?: string;
    }
  | {
      type: "terminal/input";
      data: string;
    }
  | {
      type: "terminal/resize";
      cols: number;
      rows: number;
    }
  | {
      type: "terminal/setCwd";
      cwd: string;
    }
  | {
      type: "terminal/close";
    };

export type TerminalServerMessage =
  | {
      type: "terminal/ready";
      sessionId: string;
      threadId: string;
    }
  | {
      type: "terminal/output";
      data: string;
      stream?: "stdout" | "stderr";
    }
  | {
      type: "terminal/error";
      message: string;
      code?: string;
    }
  | {
      type: "terminal/status";
      connected: boolean;
      cwd: string;
      pid: number | null;
      isFallback: boolean;
      source: ThreadContextSource;
    };
