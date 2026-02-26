import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { GatewayAppServerPort } from "../src/appServerPort.js";
import { createGatewayDb } from "../src/db.js";
import { createGatewayApp } from "../src/gatewayApp.js";

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

async function createTestContext() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcwa-gateway-test-"));
  const db = createGatewayDb({ dbPath: path.join(tmpDir, "index.db") });
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
});
