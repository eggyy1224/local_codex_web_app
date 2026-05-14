import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { FuzzyFileSearchResponse } from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../src/appServerPort.js";
import { createGatewayDb } from "../src/db.js";
import { createGatewayApp, type GatewayAppConfig, type GatewayAppDeps } from "../src/gatewayApp.js";

class StubAppServer extends EventEmitter implements GatewayAppServerPort {
  isConnected = true;
  errorMessage: string | null = null;
  requests: Array<{ method: string; params?: unknown }> = [];
  responses: Array<{ id: string | number; result: unknown }> = [];
  handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();

  async start(): Promise<void> {
    // no-op
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`unhandled method: ${method}`);
    }
    return (await handler(params)) as T;
  }

  notify(): void {
    // no-op
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }
}

type InjectedWs = {
  on(event: "message", listener: (data: Buffer) => void): void;
  once(event: "message", listener: (data: Buffer) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  terminate(): void;
};

async function readWsJson(ws: InjectedWs): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for websocket message"));
    }, 1_000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as unknown);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function createTestContext(options: {
  appConfig?: Partial<GatewayAppConfig>;
  deps?: Partial<Omit<GatewayAppDeps, "appServer" | "db">>;
} = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-gateway-test-"));
  const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
  const stub = new StubAppServer();
  const app = await createGatewayApp(
    {
      appServer: stub,
      db,
      ...options.deps,
    },
    {
      corsAllowlist: ["http://127.0.0.1:3000"],
      startAppServerOnBoot: false,
      ...options.appConfig,
    },
  );

  return {
    tmpDir,
    db,
    stub,
    app,
    async close() {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("gateway integration routes", () => {
  it("GET /health reflects connected/degraded", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.isConnected = true;
      const okRes = await ctx.app.inject({ method: "GET", url: "/health" });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toMatchObject({ status: "ok", appServerConnected: true });

      ctx.stub.isConnected = false;
      ctx.stub.errorMessage = "spawn error";
      const degradedRes = await ctx.app.inject({ method: "GET", url: "/health" });
      expect(degradedRes.statusCode).toBe(200);
      expect(degradedRes.json()).toMatchObject({ status: "degraded", appServerConnected: false, message: "spawn error" });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/gateway/status returns the live observability snapshot", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.isConnected = true;
      const okRes = await ctx.app.inject({ method: "GET", url: "/api/gateway/status" });
      expect(okRes.statusCode).toBe(200);
      const body = okRes.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        status: "ok",
        appServer: { connected: true, lastError: null },
        terminal: { enabled: true, sessionCount: 0 },
        events: {
          subscriberThreadCount: 0,
          subscriberTotal: 0,
          activeTurnCount: 0,
        },
        pending: { approvals: 0, interactions: 0 },
      });
      expect(typeof body.timestamp).toBe("string");
      expect(typeof body.uptimeSeconds).toBe("number");
      expect((body.sessionIndex as { size?: unknown })?.size).toBeTypeOf("number");

      ctx.stub.isConnected = false;
      ctx.stub.errorMessage = "spawn error";
      const degradedRes = await ctx.app.inject({ method: "GET", url: "/api/gateway/status" });
      expect(degradedRes.statusCode).toBe(200);
      expect(degradedRes.json()).toMatchObject({
        status: "degraded",
        appServer: { connected: false, lastError: "spawn error" },
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/gateway/status reports terminal.enabled=false when the dock is gated off", async () => {
    const ctx = await createTestContext({ appConfig: { terminalEnabled: false } });
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/api/gateway/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        terminal: { enabled: false, sessionCount: 0 },
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/models paginates, deduplicates, and forwards includeHidden", async () => {
    const ctx = await createTestContext();
    try {
      let call = 0;
      ctx.stub.handlers.set("model/list", (params) => {
        call += 1;
        if (call === 1) {
          expect(params).toMatchObject({ includeHidden: true, cursor: null, limit: 100 });
          return {
            data: [
              { id: "m1", model: "m1" },
              { id: "m2", model: "m2" },
            ],
            nextCursor: "next-1",
          };
        }
        return {
          data: [
            { id: "m1", model: "m1" },
            { id: "m3", model: "m3", displayName: "Model 3" },
          ],
          nextCursor: null,
        };
      });

      const res = await ctx.app.inject({ method: "GET", url: "/api/models?includeHidden=true" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [
          { id: "m1", model: "m1" },
          { id: "m2", model: "m2" },
          { id: "m3", model: "m3", displayName: "Model 3" },
        ],
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/threads falls back to projection cache on app-server failure", async () => {
    const ctx = await createTestContext();
    try {
      ctx.db.upsertThreads([
        {
          thread_id: "cached-thread",
          project_key: "/tmp/project-a",
          title: "Cached title",
          preview: "Cached preview",
          status: "idle",
          archived: 0,
          updated_at: "2026-01-01T00:00:00.000Z",
          last_error: null,
        },
      ]);

      ctx.stub.handlers.set("thread/list", () => {
        throw new Error("app-server unavailable");
      });

      const res = await ctx.app.inject({ method: "GET", url: "/api/threads?limit=10" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [
          {
            id: "cached-thread",
            projectKey: "/tmp/project-a",
            title: "Cached title",
            preview: "Cached preview",
            status: "idle",
            lastActiveAt: "2026-01-01T00:00:00.000Z",
            archived: false,
            waitingApprovalCount: 0,
            errorCount: 0,
          },
        ],
        nextCursor: null,
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads supports new and fork while persisting projections", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("thread/start", () => ({
        thread: {
          id: "t-new",
          name: "New thread",
          preview: "hello",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }));

      const createRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads",
        payload: { cwd: "/tmp/new-project", model: "gpt-5-codex" },
      });
      expect(createRes.statusCode).toBe(200);
      expect(createRes.json()).toEqual({ threadId: "t-new" });
      expect(ctx.db.getProjectedThread("t-new")?.projectKey).toBe("/tmp/new-project");

      ctx.db.upsertThreads([
        {
          thread_id: "t-source",
          project_key: "/tmp/source-project",
          title: "source",
          preview: "source",
          status: "idle",
          archived: 0,
          updated_at: "2026-01-01T00:00:00.000Z",
          last_error: null,
        },
      ]);

      ctx.stub.handlers.set("thread/fork", () => ({
        thread: {
          id: "t-fork",
          name: "Forked thread",
          preview: "fork",
          status: "idle",
          createdAt: 2,
          updatedAt: 2,
        },
      }));

      const forkRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads",
        payload: { mode: "fork", fromThreadId: "t-source" },
      });
      expect(forkRes.statusCode).toBe(200);
      expect(forkRes.json()).toEqual({ threadId: "t-fork" });
      expect(ctx.db.getProjectedThread("t-fork")?.projectKey).toBe("/tmp/source-project");
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/threads/:id retries resume and supports no rollout fallback", async () => {
    const ctx = await createTestContext();
    try {
      let readCall = 0;
      ctx.stub.handlers.set("thread/read", () => {
        readCall += 1;
        if (readCall === 1) {
          throw new Error("thread not loaded");
        }
        return {
          thread: {
            id: "thread-1",
            name: "Loaded",
            preview: "loaded",
            status: "idle",
            turns: [{ id: "turn-1", status: "completed", items: [] }],
          },
        };
      });
      ctx.stub.handlers.set("thread/resume", () => ({}));

      const resumedRes = await ctx.app.inject({ method: "GET", url: "/api/threads/thread-1?includeTurns=true" });
      expect(resumedRes.statusCode).toBe(200);
      expect(resumedRes.json()).toMatchObject({
        thread: { id: "thread-1", title: "Loaded" },
        turns: [{ id: "turn-1" }],
      });
      expect(ctx.stub.requests.map((entry) => entry.method)).toContain("thread/resume");

      ctx.db.upsertThreads([
        {
          thread_id: "fallback-thread",
          project_key: "unknown",
          title: "Fallback title",
          preview: "Fallback preview",
          status: "unknown",
          archived: 0,
          updated_at: "2026-01-01T00:00:00.000Z",
          last_error: null,
        },
      ]);
      ctx.stub.handlers.set("thread/read", () => {
        throw new Error("no rollout found");
      });

      const fallbackRes = await ctx.app.inject({ method: "GET", url: "/api/threads/fallback-thread" });
      expect(fallbackRes.statusCode).toBe(200);
      expect(fallbackRes.json()).toMatchObject({
        thread: { id: "fallback-thread", title: "Fallback title" },
        turns: [],
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/threads/:id retries resume when thread/read returns not found", async () => {
    const ctx = await createTestContext();
    try {
      let readCall = 0;
      ctx.stub.handlers.set("thread/read", () => {
        readCall += 1;
        if (readCall === 1) {
          throw new Error("thread not found: thread-1");
        }
        return {
          thread: {
            id: "thread-1",
            name: "Loaded after resume",
            preview: "loaded",
            status: "idle",
            turns: [{ id: "turn-1", status: "completed", items: [] }],
          },
        };
      });
      ctx.stub.handlers.set("thread/resume", () => ({}));

      const res = await ctx.app.inject({ method: "GET", url: "/api/threads/thread-1?includeTurns=true" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        thread: { id: "thread-1", title: "Loaded after resume" },
        turns: [{ id: "turn-1" }],
      });
      expect(ctx.stub.requests.map((entry) => entry.method)).toContain("thread/resume");
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns validates input and retries after resume with permission mapping", async () => {
    const ctx = await createTestContext();
    try {
      const invalidRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: { input: [] },
      });
      expect(invalidRes.statusCode).toBe(400);

      let turnStartCall = 0;
      ctx.stub.handlers.set("turn/start", (params) => {
        turnStartCall += 1;
        if (turnStartCall === 1) {
          throw new Error("thread not loaded");
        }
        expect(params).toMatchObject({
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        });
        return { turn: { id: "turn-1" } };
      });
      ctx.stub.handlers.set("thread/resume", () => ({}));

      const okRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "hello" }],
          options: { permissionMode: "full-access", model: "gpt-5-codex", effort: "high" },
        },
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toEqual({ turnId: "turn-1" });
      expect(ctx.stub.requests.map((entry) => entry.method)).toContain("thread/resume");
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns maps auto permission mode to auto reviewer", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("turn/start", (params) => {
        expect(params).toMatchObject({
          threadId: "thread-1",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        });
        return { turn: { id: "turn-auto" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "run with auto review" }],
          options: { permissionMode: "auto" },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ turnId: "turn-auto" });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns auto-injects skill/mention items from $tokens", async () => {
    const ctx = await createTestContext();
    try {
      let capturedStartParams: Record<string, unknown> | null = null;
      ctx.stub.handlers.set("skills/list", () => ({
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "openai-docs",
                path: "/Users/me/.codex/skills/openai-docs/SKILL.md",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      }));
      ctx.stub.handlers.set("app/list", () => ({
        data: [
          {
            id: "demo-app",
            name: "Demo App",
            isAccessible: true,
            isEnabled: true,
          },
        ],
        nextCursor: null,
      }));
      ctx.stub.handlers.set("turn/start", (params) => {
        capturedStartParams = params as Record<string, unknown>;
        return { turn: { id: "turn-1" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [
            {
              type: "text",
              text: "$openai-docs help me and $demo-app summarize and $unknown ignore",
            },
          ],
          options: {
            cwd: "/tmp/project",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ turnId: "turn-1" });
      expect(capturedStartParams).toBeTruthy();
      expect(capturedStartParams?.input).toEqual([
        {
          type: "text",
          text: "$openai-docs help me and $demo-app summarize and $unknown ignore",
        },
        {
          type: "skill",
          name: "openai-docs",
          path: "/Users/me/.codex/skills/openai-docs/SKILL.md",
        },
        {
          type: "mention",
          name: "Demo App",
          path: "app://demo-app",
        },
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns prefers skill over app when the same $token matches both", async () => {
    const ctx = await createTestContext();
    try {
      let capturedStartParams: Record<string, unknown> | null = null;
      ctx.stub.handlers.set("skills/list", () => ({
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "same-token",
                path: "/Users/me/.codex/skills/same-token/SKILL.md",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      }));
      ctx.stub.handlers.set("app/list", () => ({
        data: [
          {
            id: "same-token",
            name: "Same Token App",
            isAccessible: true,
            isEnabled: true,
          },
        ],
        nextCursor: null,
      }));
      ctx.stub.handlers.set("turn/start", (params) => {
        capturedStartParams = params as Record<string, unknown>;
        return { turn: { id: "turn-1" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "$same-token do work" }],
          options: {
            cwd: "/tmp/project",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(capturedStartParams?.input).toEqual([
        { type: "text", text: "$same-token do work" },
        {
          type: "skill",
          name: "same-token",
          path: "/Users/me/.codex/skills/same-token/SKILL.md",
        },
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns converts collaborationMode preset via collaborationMode/list", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("skills/list", () => ({ data: [] }));
      ctx.stub.handlers.set("app/list", () => ({ data: [], nextCursor: null }));
      ctx.stub.handlers.set("collaborationMode/list", () => ({
        data: [
          {
            name: "plan",
            mode: "plan",
            model: "gpt-5.3-codex",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        ],
      }));
      ctx.stub.handlers.set("turn/start", (params) => {
        expect(params).toMatchObject({
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-5.3-codex",
              reasoning_effort: "high",
              developer_instructions: null,
            },
          },
        });
        return { turn: { id: "turn-plan-1" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "Create a plan" }],
          options: { collaborationMode: "plan" },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ turnId: "turn-plan-1" });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns falls back when collaborationMode/list is unsupported", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("skills/list", () => ({ data: [] }));
      ctx.stub.handlers.set("app/list", () => ({ data: [], nextCursor: null }));
      ctx.stub.handlers.set("collaborationMode/list", () => {
        throw new Error("unsupported method: collaborationMode/list");
      });
      ctx.stub.handlers.set("turn/start", (params) => {
        expect(params).not.toHaveProperty("collaborationMode");
        return { turn: { id: "turn-plan-fallback-1" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "Create a plan" }],
          options: { collaborationMode: "plan" },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        turnId: "turn-plan-fallback-1",
        warnings: ["plan_mode_fallback"],
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/turns returns readable 400 when collaboration preset cannot be resolved", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("skills/list", () => ({ data: [] }));
      ctx.stub.handlers.set("app/list", () => ({ data: [], nextCursor: null }));
      ctx.stub.handlers.set("collaborationMode/list", () => {
        throw new Error("experimental api disabled");
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: {
          input: [{ type: "text", text: "Create a plan" }],
          options: { collaborationMode: "plan" },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("collaboration mode \"plan\" unavailable");
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/review defaults to uncommittedChanges and supports custom instructions", async () => {
    const ctx = await createTestContext();
    try {
      let callCount = 0;
      ctx.stub.handlers.set("review/start", (params) => {
        callCount += 1;
        if (callCount === 1) {
          expect(params).toMatchObject({
            threadId: "thread-1",
            delivery: "inline",
            target: { type: "uncommittedChanges" },
          });
          return {
            turn: { id: "turn-review-1" },
            reviewThreadId: "thread-1",
          };
        }

        expect(params).toMatchObject({
          threadId: "thread-1",
          delivery: "inline",
          target: { type: "custom", instructions: "focus on risky changes" },
        });
        return {
          turn: { id: "turn-review-2" },
          reviewThreadId: "thread-1",
        };
      });

      const defaultRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/review",
      });
      expect(defaultRes.statusCode).toBe(200);
      expect(defaultRes.json()).toEqual({
        turnId: "turn-review-1",
        reviewThreadId: "thread-1",
      });

      const customRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/review",
        payload: { instructions: "focus on risky changes" },
      });
      expect(customRes.statusCode).toBe(200);
      expect(customRes.json()).toEqual({
        turnId: "turn-review-2",
        reviewThreadId: "thread-1",
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/review retries after resume on not found", async () => {
    const ctx = await createTestContext();
    try {
      let callCount = 0;
      ctx.stub.handlers.set("review/start", () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("thread not found: thread-1");
        }
        return {
          turn: { id: "turn-review-1" },
          reviewThreadId: "thread-1",
        };
      });
      ctx.stub.handlers.set("thread/resume", () => ({}));

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/review",
        payload: { instructions: "focus risky changes" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        turnId: "turn-review-1",
        reviewThreadId: "thread-1",
      });
      expect(ctx.stub.requests.map((entry) => entry.method)).toContain("thread/resume");
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/account/rate-limits proxies success and falls back to 200 with error", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("account/rateLimits/read", () => ({
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 20,
            windowDurationMins: 15,
            resetsAt: 1_730_947_200,
          },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: {
              usedPercent: 20,
              windowDurationMins: 15,
              resetsAt: 1_730_947_200,
            },
            secondary: null,
          },
        },
      }));

      const okRes = await ctx.app.inject({ method: "GET", url: "/api/account/rate-limits" });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toMatchObject({
        rateLimits: { limitId: "codex" },
      });

      ctx.stub.handlers.set("account/rateLimits/read", () => {
        throw new Error("rate limits unavailable");
      });
      const fallbackRes = await ctx.app.inject({ method: "GET", url: "/api/account/rate-limits" });
      expect(fallbackRes.statusCode).toBe(200);
      expect(fallbackRes.json()).toEqual({
        rateLimits: null,
        rateLimitsByLimitId: null,
        error: "rate limits unavailable",
      });
    } finally {
      await ctx.close();
    }
  });

  it("approval route maps allow/deny/cancel, writes audit/event, and clears pending", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          reason: "Need permission",
          command: "npm test",
        },
      });

      const pendingRes = await ctx.app.inject({ method: "GET", url: "/api/threads/thread-1/approvals/pending" });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toHaveLength(1);

      const allowRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/approvals/99",
        payload: { decision: "allow" },
      });
      expect(allowRes.statusCode).toBe(200);
      expect(allowRes.json()).toEqual({ ok: true });
      expect(ctx.stub.responses).toContainEqual({ id: 99, result: { decision: "accept" } });

      const pendingAfterRes = await ctx.app.inject({ method: "GET", url: "/api/threads/thread-1/approvals/pending" });
      expect(pendingAfterRes.json().data).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/threads surfaces waitingApprovalCount per thread (regression)", async () => {
    // The thread switcher's amber "N pending" badge only fires if the gateway
    // actually fills waitingApprovalCount. Previously it was hard-coded to 0
    // for both the live and projection-cache branches.
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("thread/list", () => ({
        data: [
          { id: "thread-a", name: "A", preview: "", status: "idle", createdAt: 1, updatedAt: 1 },
          { id: "thread-b", name: "B", preview: "", status: "idle", createdAt: 1, updatedAt: 1 },
        ],
        nextCursor: null,
      }));

      // Two pending approvals for thread-a, one for thread-b.
      ctx.stub.emit("message", {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a", turnId: "t1", command: "x" },
      });
      ctx.stub.emit("message", {
        id: 2,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a", turnId: "t1", command: "y" },
      });
      ctx.stub.emit("message", {
        id: 3,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-b", turnId: "t2", command: "z" },
      });

      const res = await ctx.app.inject({ method: "GET", url: "/api/threads?limit=10" });
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { data: Array<{ id: string; waitingApprovalCount: number }> })
        .data;
      const byId = Object.fromEntries(items.map((item) => [item.id, item.waitingApprovalCount]));
      expect(byId).toEqual({ "thread-a": 2, "thread-b": 1 });
    } finally {
      await ctx.close();
    }
  });

  it("interaction route accepts requestUserInput and responds with answers", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 199,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "q1",
              header: "Deploy target",
              question: "Where should this deploy?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Staging", description: "safe environment" },
                { label: "Prod", description: "live traffic" },
              ],
            },
          ],
        },
      });

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json()).toEqual({
        data: [
          {
            interactionId: "199",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            type: "userInput",
            status: "pending",
            questions: [
              {
                id: "q1",
                header: "Deploy target",
                question: "Where should this deploy?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "Staging", description: "safe environment" },
                  { label: "Prod", description: "live traffic" },
                ],
              },
            ],
            createdAt: expect.any(String),
            resolvedAt: null,
          },
        ],
      });

      const respondRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/199/respond",
        payload: {
          answers: {
            q1: {
              answers: ["Staging", "roll out tonight"],
            },
          },
        },
      });
      expect(respondRes.statusCode).toBe(200);
      expect(respondRes.json()).toEqual({ ok: true });
      expect(ctx.stub.responses).toContainEqual({
        id: 199,
        result: {
          answers: {
            q1: {
              answers: ["Staging", "roll out tonight"],
            },
          },
        },
      });

      const pendingAfterRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingAfterRes.statusCode).toBe(200);
      expect(pendingAfterRes.json().data).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("interaction route returns 409 when interaction is already responded", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 201,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        },
      });

      const firstResponse = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/201/respond",
        payload: {
          answers: {
            q1: { answers: ["staging"] },
          },
        },
      });
      expect(firstResponse.statusCode).toBe(200);
      expect(ctx.stub.responses).toHaveLength(1);

      const secondResponse = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/201/respond",
        payload: {
          answers: {
            q1: { answers: ["prod"] },
          },
        },
      });
      expect(secondResponse.statusCode).toBe(409);
      expect(secondResponse.json().message).toContain("interaction is no longer pending");
      expect(ctx.stub.responses).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it("interaction route returns 409 when interaction is pending but no longer active in memory", async () => {
    const ctx = await createTestContext();
    try {
      const createdAt = new Date().toISOString();
      ctx.db.upsertInteractionRequest({
        interaction_id: "orphan-1",
        thread_id: "thread-1",
        turn_id: "turn-orphan",
        item_id: null,
        type: "userInput",
        status: "pending",
        request_payload_json: JSON.stringify({
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        }),
        response_payload_json: null,
        created_at: createdAt,
        resolved_at: null,
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/orphan-1/respond",
        payload: {
          answers: {
            q1: { answers: ["staging"] },
          },
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain("interaction is no longer active");
      expect(ctx.stub.responses).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("interaction route also accepts tool/requestUserInput alias", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 299,
        method: "tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-9",
          questions: [
            {
              id: "q-deploy",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: [{ label: "Staging", description: "safe env" }],
            },
          ],
        },
      });

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toHaveLength(1);
      expect(pendingRes.json().data[0]).toMatchObject({
        interactionId: "299",
        threadId: "thread-1",
        turnId: "turn-9",
        type: "userInput",
        status: "pending",
      });
    } finally {
      await ctx.close();
    }
  });

  it("interaction pending response normalizes filtered empty options to null", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 300,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-9",
          questions: [
            {
              id: "q-deploy",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: [{ label: "Staging" }],
            },
          ],
        },
      });

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data[0].questions[0].options).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("interaction route rejects empty answers payload and keeps pending", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 311,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-3",
          questions: [
            {
              id: "qEmpty",
              header: "Question",
              question: "Provide value",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        },
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/311/respond",
        payload: {
          answers: {
            qEmpty: {
              answers: ["   "],
            },
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(ctx.stub.responses).toHaveLength(0);

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toHaveLength(1);
      expect(pendingRes.json().data[0]).toMatchObject({
        interactionId: "311",
        status: "pending",
      });
    } finally {
      await ctx.close();
    }
  });

  it("turn/completed cancels pending interactions and emits interaction/cancelled event", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 401,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-10",
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: [{ label: "staging", description: "safe" }],
            },
          ],
        },
      });

      ctx.stub.emit("message", {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-10",
        },
      });

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-1/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toHaveLength(0);

      const row = ctx.db.getInteractionById("401");
      expect(row?.status).toBe("cancelled");

      const events = ctx.db.listGatewayEventsSince("thread-1", 0, 50);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "interaction",
            name: "interaction/cancelled",
            payload: expect.objectContaining({
              interactionId: "401",
              reason: "turn_completed",
            }),
          }),
        ]),
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/401/respond",
        payload: {
          answers: {
            q1: { answers: ["staging"] },
          },
        },
      });
      expect(response.statusCode).toBe(409);
      expect(ctx.stub.responses).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("startup reconciliation cancels stale pending interactions", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-gateway-test-"));
    const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
    const createdAt = new Date().toISOString();
    db.upsertInteractionRequest({
      interaction_id: "stale-1",
      thread_id: "thread-stale",
      turn_id: "turn-stale",
      item_id: null,
      type: "userInput",
      status: "pending",
      request_payload_json: JSON.stringify({
        questions: [
          {
            id: "q1",
            header: "Deploy",
            question: "Select target",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
      }),
      response_payload_json: null,
      created_at: createdAt,
      resolved_at: null,
    });

    const stub = new StubAppServer();
    const app = await createGatewayApp(
      {
        appServer: stub,
        db,
      },
      {
        corsAllowlist: ["http://127.0.0.1:3000"],
        startAppServerOnBoot: false,
      },
    );

    try {
      const pendingRes = await app.inject({
        method: "GET",
        url: "/api/threads/thread-stale/interactions/pending",
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toHaveLength(0);

      const row = db.getInteractionById("stale-1");
      expect(row?.status).toBe("cancelled");

      const events = db.listGatewayEventsSince("thread-stale", 0, 50);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "interaction",
            name: "interaction/cancelled",
            payload: expect.objectContaining({
              interactionId: "stale-1",
              reason: "gateway_restarted",
            }),
          }),
        ]),
      );
    } finally {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("interaction route rejects cross-thread response by interaction id", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.emit("message", {
        id: 355,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-2",
          turnId: "turn-5",
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Select target",
              isOther: false,
              isSecret: false,
              options: [{ label: "staging", description: "safe" }],
            },
          ],
        },
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interactions/355/respond",
        payload: {
          answers: {
            q1: {
              answers: ["staging"],
            },
          },
        },
      });

      expect(res.statusCode).toBe(404);
      expect(ctx.stub.responses).toHaveLength(0);

      const pendingThread2 = await ctx.app.inject({
        method: "GET",
        url: "/api/threads/thread-2/interactions/pending",
      });
      expect(pendingThread2.statusCode).toBe(200);
      expect(pendingThread2.json().data).toHaveLength(1);
      expect(pendingThread2.json().data[0]).toMatchObject({
        interactionId: "355",
        status: "pending",
      });
    } finally {
      await ctx.close();
    }
  });

  it("control route handles retry/no previous input and stop with active/no-active turns", async () => {
    const ctx = await createTestContext();
    try {
      const retryNoInput = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/control",
        payload: { action: "retry" },
      });
      expect(retryNoInput.statusCode).toBe(400);

      ctx.stub.handlers.set("turn/start", () => ({ turn: { id: "turn-1" } }));
      const seedTurn = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/turns",
        payload: { input: [{ type: "text", text: "seed" }], options: { permissionMode: "local" } },
      });
      expect(seedTurn.statusCode).toBe(200);

      ctx.stub.handlers.set("turn/start", () => ({ turn: { id: "turn-2" } }));
      const retryRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/control",
        payload: { action: "retry" },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json()).toEqual({ ok: true, appliedToTurnId: "turn-2" });

      ctx.stub.handlers.set("turn/interrupt", () => ({}));
      const stopRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/control",
        payload: { action: "stop" },
      });
      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json()).toEqual({ ok: true, appliedToTurnId: "turn-2" });

      const noActiveRes = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-x/control",
        payload: { action: "cancel" },
      });
      expect(noActiveRes.statusCode).toBe(200);
      expect(noActiveRes.json()).toEqual({ ok: true });
    } finally {
      await ctx.close();
    }
  });

  it("SSE route supports replay and live events with since cursor", async () => {
    const ctx = await createTestContext();
    try {
      ctx.db.insertGatewayEvent({
        serverTs: "2026-01-01T00:00:00.000Z",
        threadId: "thread-1",
        turnId: "turn-0",
        kind: "turn",
        name: "turn/started",
        payload: { turnId: "turn-0" },
      });

      await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      const address = ctx.app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to get listen address");
      }

      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/threads/thread-1/events?since=0`,
        {
          headers: { origin: "http://127.0.0.1:3000" },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("missing SSE stream");
      }

      ctx.stub.emit("message", {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });

      let text = "";
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !text.includes("turn/completed")) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += new TextDecoder().decode(value);
      }

      expect(text).toContain("turn/started");
      expect(text).toContain("turn/completed");
      controller.abort();
    } finally {
      await ctx.close();
    }
  });

  it("SSE route sends an immediate heartbeat for empty streams", async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      const address = ctx.app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to get listen address");
      }

      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/threads/thread-empty/events?since=0`,
        {
          headers: { origin: "http://127.0.0.1:3000" },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("missing SSE stream");
      }

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain("event: heartbeat");
      controller.abort();
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket can be disabled by feature flag and records an audit event", async () => {
    const ctx = await createTestContext({ appConfig: { terminalEnabled: false } });
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      })) as InjectedWs;

      expect(await readWsJson(ws)).toEqual({
        type: "terminal/error",
        message: "terminal dock is disabled",
        code: "TERMINAL_WS_DISABLED",
      });
      ws.terminate();

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string | null; metadata_json: string }>;
      expect(rows).toEqual([
        {
          action: "terminal.disabled",
          thread_id: null,
          metadata_json: JSON.stringify({ origin: "http://127.0.0.1:3000" }),
        },
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket rejects disallowed origins and records origin_denied audit", async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://evil.example.com" },
      })) as InjectedWs;

      expect(await readWsJson(ws)).toEqual({
        type: "terminal/error",
        message: "origin not allowed",
        code: "TERMINAL_WS_ORIGIN_DENIED",
      });
      ws.terminate();

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string | null; metadata_json: string }>;
      expect(rows).toEqual([
        {
          action: "terminal.origin_denied",
          thread_id: null,
          metadata_json: JSON.stringify({ origin: "http://evil.example.com" }),
        },
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket records terminal.closed reason=reopened when client opens a second thread", async () => {
    const opened: string[] = [];
    const terminalManager = {
      openClient(client: { send: (message: unknown) => void }, threadId: string) {
        opened.push(threadId);
        client.send({ type: "terminal/ready", sessionId: `s-${threadId}`, threadId });
      },
      closeClient() {},
      onClientDisconnect() {},
      writeInput() {
        return true;
      },
      resize() {
        return true;
      },
      setCwd() {
        return true;
      },
      destroy() {},
      setSessionEndedListener() {},
    } as unknown as NonNullable<GatewayAppDeps["terminalManager"]>;
    const threadContextResolver = {
      async resolveThreadContext(threadId: string) {
        return {
          threadId,
          cwd: `/tmp/${threadId}`,
          resolvedCwd: `/tmp/${threadId}`,
          isFallback: false,
          source: "projection" as const,
        };
      },
      invalidate() {},
    } as unknown as NonNullable<GatewayAppDeps["threadContextResolver"]>;
    const ctx = await createTestContext({
      deps: { terminalManager, threadContextResolver },
    });
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      })) as InjectedWs;

      ws.send(JSON.stringify({ type: "terminal/open", threadId: "thread-first" }));
      expect(await readWsJson(ws)).toMatchObject({ type: "terminal/ready", threadId: "thread-first" });

      ws.send(JSON.stringify({ type: "terminal/open", threadId: "thread-second" }));
      expect(await readWsJson(ws)).toMatchObject({ type: "terminal/ready", threadId: "thread-second" });

      ws.terminate();
      expect(opened).toEqual(["thread-first", "thread-second"]);

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string | null; metadata_json: string }>;
      const reopened = rows.find(
        (row) => row.action === "terminal.closed" && row.thread_id === "thread-first",
      );
      expect(reopened).toBeTruthy();
      expect(JSON.parse(reopened!.metadata_json)).toMatchObject({
        reason: "reopened",
        cwd: "/tmp/thread-first",
      });
      expect(
        rows.filter((row) => row.action === "terminal.opened").map((row) => row.thread_id),
      ).toEqual(["thread-first", "thread-second"]);
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket audits open and close lifecycle", async () => {
    const opened: Array<{ threadId: string }> = [];
    const terminalManager = {
      openClient(client: { send: (message: unknown) => void }, threadId: string) {
        opened.push({ threadId });
        client.send({ type: "terminal/ready", sessionId: "terminal-test", threadId });
      },
      closeClient() {
        // no-op
      },
      onClientDisconnect() {
        // no-op
      },
      writeInput() {
        return true;
      },
      resize() {
        return true;
      },
      setCwd() {
        return true;
      },
      destroy() {
        // no-op
      },
    } as unknown as NonNullable<GatewayAppDeps["terminalManager"]>;
    const threadContextResolver = {
      async resolveThreadContext(threadId: string) {
        return {
          threadId,
          cwd: "/tmp/project-a",
          resolvedCwd: "/tmp/project-a",
          isFallback: false,
          source: "projection" as const,
        };
      },
      invalidate() {
        // no-op
      },
    } as unknown as NonNullable<GatewayAppDeps["threadContextResolver"]>;
    const ctx = await createTestContext({
      deps: { terminalManager, threadContextResolver },
    });
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      })) as InjectedWs;

      ws.send(JSON.stringify({ type: "terminal/open", threadId: "thread-terminal" }));
      expect(await readWsJson(ws)).toEqual({
        type: "terminal/ready",
        sessionId: "terminal-test",
        threadId: "thread-terminal",
      });
      expect(opened).toEqual([{ threadId: "thread-terminal" }]);

      ws.send(JSON.stringify({ type: "terminal/close" }));
      await new Promise((resolve) => setImmediate(resolve));
      ws.terminate();

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string; metadata_json: string }>;
      expect(rows.map((row) => ({ action: row.action, threadId: row.thread_id }))).toEqual([
        { action: "terminal.opened", threadId: "thread-terminal" },
        { action: "terminal.closed", threadId: "thread-terminal" },
      ]);
      expect(JSON.parse(rows[0]!.metadata_json)).toEqual({
        origin: "http://127.0.0.1:3000",
        cwd: "/tmp/project-a",
        source: "projection",
        isFallback: false,
      });
      expect(JSON.parse(rows[1]!.metadata_json)).toEqual({
        origin: "http://127.0.0.1:3000",
        cwd: "/tmp/project-a",
        source: "projection",
        isFallback: false,
        reason: "client_message",
      });
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket records session_ended audit when manager kills a session", async () => {
    type EndedListener = (event: {
      threadId: string;
      reason: "exit" | "expired" | "evicted" | "destroyed" | "client_closed";
      detail?: string;
    }) => void;
    let endedListener: EndedListener | null = null;
    const terminalManager = {
      openClient(client: { send: (message: unknown) => void }, threadId: string) {
        client.send({ type: "terminal/ready", sessionId: "terminal-killed", threadId });
      },
      closeClient() {
        // no-op
      },
      onClientDisconnect() {
        // no-op
      },
      writeInput() {
        return true;
      },
      resize() {
        return true;
      },
      setCwd() {
        return true;
      },
      destroy() {
        // no-op
      },
      setSessionEndedListener(listener: EndedListener | null) {
        endedListener = listener;
      },
    } as unknown as NonNullable<GatewayAppDeps["terminalManager"]>;
    const threadContextResolver = {
      async resolveThreadContext(threadId: string) {
        return {
          threadId,
          cwd: "/tmp/project-b",
          resolvedCwd: "/tmp/project-b",
          isFallback: false,
          source: "projection" as const,
        };
      },
      invalidate() {
        // no-op
      },
    } as unknown as NonNullable<GatewayAppDeps["threadContextResolver"]>;
    const ctx = await createTestContext({
      deps: { terminalManager, threadContextResolver },
    });
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      })) as InjectedWs;

      ws.send(JSON.stringify({ type: "terminal/open", threadId: "thread-killed" }));
      expect(await readWsJson(ws)).toEqual({
        type: "terminal/ready",
        sessionId: "terminal-killed",
        threadId: "thread-killed",
      });

      // Simulate the manager killing the session out-of-band (idle prune,
      // eviction, pty exit, or manager destroy).
      expect(endedListener).not.toBeNull();
      endedListener!({ threadId: "thread-killed", reason: "expired", detail: "ttl elapsed" });
      ws.terminate();

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string; metadata_json: string }>;
      const actions = rows.map((row) => row.action);
      expect(actions).toContain("terminal.opened");
      const sessionEnded = rows.find((row) => row.action === "terminal.session_ended");
      expect(sessionEnded).toBeTruthy();
      expect(sessionEnded!.thread_id).toBe("thread-killed");
      expect(JSON.parse(sessionEnded!.metadata_json)).toEqual({
        origin: "http://127.0.0.1:3000",
        cwd: "/tmp/project-b",
        source: "projection",
        isFallback: false,
        reason: "expired",
        detail: "ttl elapsed",
      });
    } finally {
      await ctx.close();
    }
  });

  it("terminal websocket audits open_failed when resolveThreadContext throws", async () => {
    const terminalManager = {
      openClient() {
        throw new Error("should not be called");
      },
      closeClient() {},
      onClientDisconnect() {},
      writeInput() {
        return true;
      },
      resize() {
        return true;
      },
      setCwd() {
        return true;
      },
      destroy() {},
      setSessionEndedListener() {},
    } as unknown as NonNullable<GatewayAppDeps["terminalManager"]>;
    const threadContextResolver = {
      async resolveThreadContext() {
        throw new Error("project not found");
      },
      invalidate() {},
    } as unknown as NonNullable<GatewayAppDeps["threadContextResolver"]>;
    const ctx = await createTestContext({
      deps: { terminalManager, threadContextResolver },
    });
    try {
      await ctx.app.ready();
      const ws = (await (
        ctx.app as typeof ctx.app & {
          injectWS: (
            path: string,
            upgradeContext?: { headers?: Record<string, string> },
          ) => Promise<InjectedWs>;
        }
      ).injectWS("/api/terminal/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      })) as InjectedWs;

      ws.send(JSON.stringify({ type: "terminal/open", threadId: "thread-broken" }));
      expect(await readWsJson(ws)).toEqual({
        type: "terminal/error",
        message: "project not found",
        code: "TERMINAL_WS_OPEN_FAILED",
      });
      ws.terminate();

      const rows = ctx.db.sqlite
        .prepare("SELECT action, thread_id, metadata_json FROM audit_log ORDER BY id ASC")
        .all() as Array<{ action: string; thread_id: string; metadata_json: string }>;
      expect(rows).toEqual([
        {
          action: "terminal.open_failed",
          thread_id: "thread-broken",
          metadata_json: JSON.stringify({
            origin: "http://127.0.0.1:3000",
            stage: "resolveContext",
            error: "project not found",
          }),
        },
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/config maps service_tier/model/reasoning_effort from config/read", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("config/read", () => ({
        config: {
          service_tier: "fast",
          model: "gpt-5.5",
          reasoning_effort: "medium",
          unrelated: { ignored: true },
        },
        origins: {},
      }));
      const res = await ctx.app.inject({ method: "GET", url: "/api/config" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        config: { serviceTier: "fast", model: "gpt-5.5", reasoningEffort: "medium" },
        filePath: null,
        version: null,
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/config/value forwards keyPath/value/mergeStrategy and returns status", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("config/value/write", (params) => {
        captured = params;
        return {
          status: "ok",
          filePath: "/Users/x/.codex/config.toml",
          version: "sha256:abc",
        };
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/config/value",
        payload: { keyPath: "service_tier", value: "flex" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "ok",
        filePath: "/Users/x/.codex/config.toml",
        version: "sha256:abc",
      });
      expect(captured).toMatchObject({
        keyPath: "service_tier",
        value: "flex",
        mergeStrategy: "replace",
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/config/value rejects missing keyPath with 400", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/config/value",
        payload: { value: "flex" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/config/value rejects keyPaths outside the allowlist with 403", async () => {
    const ctx = await createTestContext();
    try {
      let forwarded = false;
      ctx.stub.handlers.set("config/value/write", () => {
        forwarded = true;
        return { status: "ok" };
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/config/value",
        payload: { keyPath: "model", value: "gpt-5.5" },
      });
      expect(res.statusCode).toBe(403);
      expect(forwarded).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/config/value rejects invalid value for allowlisted keyPath with 400", async () => {
    const ctx = await createTestContext();
    try {
      let forwarded = false;
      ctx.stub.handlers.set("config/value/write", () => {
        forwarded = true;
        return { status: "ok" };
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/config/value",
        payload: { keyPath: "service_tier", value: "extreme" },
      });
      expect(res.statusCode).toBe(400);
      expect(forwarded).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/steer forwards turn/steer params and returns turnId", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("turn/steer", (params) => {
        captured = params;
        return { turnId: "turn-steered" };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/steer",
        payload: {
          expectedTurnId: "turn-existing",
          input: [{ type: "text", text: "actually do this" }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ turnId: "turn-steered" });
      expect(captured).toEqual({
        threadId: "thread-1",
        expectedTurnId: "turn-existing",
        input: [{ type: "text", text: "actually do this" }],
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/steer rejects missing expectedTurnId with 400", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/steer",
        payload: {
          input: [{ type: "text", text: "no expected" }],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/interrupt forwards turn/interrupt with turnId", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("turn/interrupt", (params) => {
        captured = params;
        return {};
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interrupt",
        payload: { turnId: "turn-active" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(captured).toEqual({ threadId: "thread-1", turnId: "turn-active" });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/interrupt rejects missing turnId with 400", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/interrupt",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/fork forwards optional fields and returns new threadId", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("thread/fork", (params) => {
        captured = params;
        return { thread: { id: "t-forked" } };
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/source-thread/fork",
        payload: {
          model: "gpt-5-codex",
          serviceTier: "flex",
          approvalPolicy: "never",
          cwd: "/tmp/work",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ threadId: "t-forked" });
      expect(captured).toEqual({
        threadId: "source-thread",
        model: "gpt-5-codex",
        serviceTier: "flex",
        approvalPolicy: "never",
        cwd: "/tmp/work",
      });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/fork returns 502 when app-server response lacks thread.id", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("thread/fork", () => ({}));
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/source-thread/fork",
        payload: {},
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/rollback forwards numTurns and returns threadId", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("thread/rollback", (params) => {
        captured = params;
        return { thread: { id: "thread-after-rollback" } };
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/rollback",
        payload: { numTurns: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ threadId: "thread-after-rollback" });
      expect(captured).toEqual({ threadId: "thread-1", numTurns: 3 });
    } finally {
      await ctx.close();
    }
  });

  it("POST /api/threads/:id/rollback rejects numTurns < 1 with 400", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/threads/thread-1/rollback",
        payload: { numTurns: 0 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/files/search forwards roots/query, maps snake_case, and caps at 50", async () => {
    const ctx = await createTestContext();
    try {
      let captured: unknown = null;
      ctx.stub.handlers.set("fuzzyFileSearch", (params) => {
        captured = params;
        const oversized = Array.from({ length: 60 }, (_, i) => ({
          root: "/tmp/a",
          path: `/tmp/a/file-${i}.ts`,
          file_name: `file-${i}.ts`,
          score: 90 - i,
          match_type: "filename",
          indices: [0, 1, 2],
        }));
        return { data: oversized };
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/files/search?roots=/tmp/a,/tmp/b&query=file",
      });
      expect(res.statusCode).toBe(200);
      expect(captured).toEqual({ roots: ["/tmp/a", "/tmp/b"], query: "file" });
      const body = res.json() as FuzzyFileSearchResponse;
      expect(body.data).toHaveLength(50);
      expect(body.data[0]).toEqual({
        root: "/tmp/a",
        path: "/tmp/a/file-0.ts",
        fileName: "file-0.ts",
        score: 90,
        matchType: "filename",
        indices: [0, 1, 2],
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/files/search reads the real app-server `files` key (not `data`)", async () => {
    const ctx = await createTestContext();
    try {
      ctx.stub.handlers.set("fuzzyFileSearch", () => ({
        files: [
          {
            root: "/tmp/a",
            path: "apps/web/app/Foo.tsx",
            file_name: "Foo.tsx",
            score: 200,
            match_type: "file",
            indices: [0, 1, 2],
          },
        ],
      }));

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/files/search?roots=/tmp/a&query=Foo",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as FuzzyFileSearchResponse;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        path: "apps/web/app/Foo.tsx",
        fileName: "Foo.tsx",
        matchType: "file",
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /api/files/search rejects empty roots with 400", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/files/search?roots=&query=file",
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
