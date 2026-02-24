import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: string | number;
  result: unknown;
};

type PendingCall = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

export class AppServerClient extends EventEmitter {
  private proc: ReturnType<typeof spawn> | null = null;
  private initialized = false;
  private connected = false;
  private lastError: string | null = null;
  private requestId = 1;
  private pending = new Map<string, PendingCall>();

  get isConnected(): boolean {
    return this.connected && this.initialized;
  }

  get errorMessage(): string | null {
    return this.lastError;
  }

  async start(): Promise<void> {
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    this.proc.on("error", (error) => {
      this.lastError = `spawn error: ${error.message}`;
      this.connected = false;
      this.initialized = false;
      this.emit("status");
    });

    this.proc.on("exit", (code, signal) => {
      this.lastError = `app-server exited (code=${code}, signal=${signal})`;
      this.connected = false;
      this.initialized = false;
      this.emit("status");
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      this.emit("stderr", line);
    });

    const rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      this.handleIncoming(line);
    });

    this.connected = true;
    this.emit("status");

    await this.initializeHandshake();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || !this.connected) {
      throw new Error("app-server not ready");
    }

    const id = this.requestId++;
    const payload: JsonRpcRequest = { id, method, params };
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(idKey(id));
        reject(new Error(`request timeout: ${method}`));
      }, 30_000);

      this.pending.set(idKey(id), { resolve, reject, timeout });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc) {
      return;
    }

    const payload: JsonRpcNotification = { method, params };
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: string | number, result: unknown): void {
    if (!this.proc) {
      return;
    }
    const payload: JsonRpcResponse = { id, result };
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private async initializeHandshake(): Promise<void> {
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "local_codex_web_app",
          title: "Local Codex Web App",
          version: "0.1.0",
        },
      });
      this.notify("initialized", {});
      this.initialized = true;
      this.lastError = null;
      this.emit("status");
    } catch (error) {
      this.initialized = false;
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : "initialize failed";
      this.emit("status");
      throw error;
    }
  }

  private handleIncoming(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg && typeof msg === "object" && "id" in msg && !("method" in msg)) {
      const key = idKey(msg.id as string | number);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(key);

      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "unknown error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg && typeof msg === "object" && "method" in msg) {
      this.emit("message", msg);
    }
  }
}
