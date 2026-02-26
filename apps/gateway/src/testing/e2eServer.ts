import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayAppServerPort } from "../appServerPort.js";
import { createGatewayDb } from "../db.js";
import { createGatewayApp } from "../gatewayApp.js";

type StubTurn = {
  id: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  items: unknown[];
};

type StubThread = {
  id: string;
  name: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  turns: StubTurn[];
};

class StubAppServer extends EventEmitter implements GatewayAppServerPort {
  isConnected = true;
  errorMessage: string | null = null;

  private readonly threads = new Map<string, StubThread>();
  private threadSeq = 1;
  private turnSeq = 1;
  private approvalSeq = 100;
  private interactionSeq = 1_000;

  async start(): Promise<void> {
    // no-op
  }

  notify(): void {
    // no-op
  }

  respond(): void {
    // no-op
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === "model/list") {
      return {
        data: [
          { id: "gpt-5.3-codex", model: "gpt-5.3-codex", isDefault: true },
          { id: "gpt-5-codex", model: "gpt-5-codex" },
        ],
        nextCursor: null,
      } as T;
    }

    if (method === "thread/list") {
      const sorted = Array.from(this.threads.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        data: sorted,
        nextCursor: null,
      } as T;
    }

    if (method === "thread/start") {
      const p = (params ?? {}) as { cwd?: string; model?: string };
      const now = Math.floor(Date.now() / 1000);
      const id = `thread-${this.threadSeq++}`;
      const thread: StubThread = {
        id,
        name: `Thread ${id}`,
        preview: p.cwd ? `cwd: ${p.cwd}` : "",
        createdAt: now,
        updatedAt: now,
        status: "idle",
        turns: [],
      };
      this.threads.set(id, thread);
      return { thread } as T;
    }

    if (method === "thread/fork") {
      const p = (params ?? {}) as { threadId?: string };
      const source = p.threadId ? this.threads.get(p.threadId) : undefined;
      const now = Math.floor(Date.now() / 1000);
      const id = `thread-${this.threadSeq++}`;
      const thread: StubThread = {
        id,
        name: source ? `${source.name} (fork)` : `Thread ${id}`,
        preview: source?.preview ?? "",
        createdAt: now,
        updatedAt: now,
        status: "idle",
        turns: [],
      };
      this.threads.set(id, thread);
      return { thread } as T;
    }

    if (method === "thread/read") {
      const p = (params ?? {}) as { threadId?: string; includeTurns?: boolean };
      const thread = p.threadId ? this.threads.get(p.threadId) : undefined;
      if (!thread) {
        throw new Error("no rollout found");
      }
      return {
        thread: {
          ...thread,
          turns: p.includeTurns ? thread.turns : undefined,
        },
      } as T;
    }

    if (method === "thread/resume") {
      return {} as T;
    }

    if (method === "turn/start") {
      const p = (params ?? {}) as {
        threadId?: string;
        input?: Array<{ type?: string; text?: string }>;
      };
      if (!p.threadId) {
        throw new Error("thread not found");
      }
      const thread = this.threads.get(p.threadId);
      if (!thread) {
        throw new Error("thread not loaded");
      }

      const turnId = `turn-${this.turnSeq++}`;
      const startedAt = Math.floor(Date.now() / 1000);
      const userText = p.input?.find((item) => item.type === "text")?.text ?? "";
      const normalizedUserText = userText.toLowerCase();
      const shouldEmitPlanFlow = normalizedUserText.includes("plan flow");
      const turn: StubTurn = {
        id: turnId,
        status: "in_progress",
        startedAt,
        items: [],
      };
      thread.turns.push(turn);
      thread.updatedAt = startedAt;
      thread.status = "active";

      this.emit("message", {
        method: "turn/started",
        params: {
          threadId: thread.id,
          turnId,
        },
      });

      const approvalId = this.approvalSeq++;
      this.emit("message", {
        id: approvalId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: thread.id,
          turnId,
          reason: "Allow command execution",
          command: "npm test",
        },
      });

      if (shouldEmitPlanFlow) {
        const interactionId = this.interactionSeq++;
        this.emit("message", {
          id: interactionId,
          method: "tool/requestUserInput",
          params: {
            threadId: thread.id,
            turnId,
            itemId: `item-${turnId}-question`,
            questions: [
              {
                id: "deploy_target",
                header: "Deploy target",
                question: "Pick where to start rollout",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "Staging", description: "safe environment" },
                  { label: "Production", description: "live traffic" },
                ],
              },
            ],
          },
        });
      }

      setTimeout(() => {
        const assistantDelta = shouldEmitPlanFlow
          ? "Plan draft ready.\n<proposed_plan>1. Add interaction pipeline\n2. Build UI submit path\n3. Verify mobile + desktop</proposed_plan>"
          : `Echo: ${userText || "ok"}`;
        this.emit("message", {
          method: "item/agentMessage/delta",
          params: {
            threadId: thread.id,
            turnId,
            delta: assistantDelta,
          },
        });

        turn.status = "completed";
        turn.completedAt = Math.floor(Date.now() / 1000);
        thread.status = "idle";
        thread.updatedAt = turn.completedAt;

        this.emit("message", {
          method: "turn/completed",
          params: {
            threadId: thread.id,
            turnId,
            turn: {
              id: turnId,
              status: "completed",
            },
          },
        });
      }, 120);

      return {
        turn,
      } as T;
    }

    if (method === "turn/interrupt") {
      const p = (params ?? {}) as { threadId?: string; turnId?: string };
      if (p.threadId && p.turnId) {
        const thread = this.threads.get(p.threadId);
        const turn = thread?.turns.find((entry) => entry.id === p.turnId);
        if (thread && turn) {
          turn.status = "interrupted";
          turn.completedAt = Math.floor(Date.now() / 1000);
          thread.status = "idle";
          thread.updatedAt = turn.completedAt;
          this.emit("message", {
            method: "turn/completed",
            params: {
              threadId: p.threadId,
              turnId: p.turnId,
              turn: {
                id: p.turnId,
                status: "interrupted",
              },
            },
          });
        }
      }
      return {} as T;
    }

    throw new Error(`unsupported method: ${method}`);
  }
}

function parsePort(argv: string[]): number {
  const raw = argv.find((arg) => arg.startsWith("--port="));
  if (!raw) {
    return 8877;
  }
  const value = Number(raw.slice("--port=".length));
  return Number.isFinite(value) ? value : 8877;
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-e2e-gateway-"));
const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
const app = await createGatewayApp(
  {
    appServer: new StubAppServer(),
    db,
  },
  {
    corsAllowlist: ["http://127.0.0.1:3100"],
    startAppServerOnBoot: false,
  },
);

const port = parsePort(process.argv.slice(2));

const shutdown = async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({ host: "127.0.0.1", port });
