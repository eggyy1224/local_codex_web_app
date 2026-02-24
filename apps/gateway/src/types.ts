export interface GatewayAppServerPort {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => Promise<void>;
  respond: (id: string, result: unknown) => Promise<void>;
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  isConnected: () => boolean;
  errorMessage: () => string | null;
  start: () => Promise<void>;
}

export type PermissionMode = 'local' | 'full-access' | undefined;

export interface TurnStartParams {
  approvalPolicy: 'on-request' | 'never';
  sandbox: 'workspace-write' | 'danger-full-access';
}

export interface ModelOption {
  id: string;
  reasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  [key: string]: unknown;
}
