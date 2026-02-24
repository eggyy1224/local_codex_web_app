export type GatewayRpcId = string | number;

export type GatewayAppServerEvents = {
  stderr: (line: string) => void;
  message: (message: unknown) => void;
  status: () => void;
};

export interface GatewayAppServerPort {
  readonly isConnected: boolean;
  readonly errorMessage: string | null;
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: GatewayRpcId, result: unknown): void;
  on(event: "stderr", listener: GatewayAppServerEvents["stderr"]): this;
  on(event: "message", listener: GatewayAppServerEvents["message"]): this;
  on(event: "status", listener: GatewayAppServerEvents["status"]): this;
}
