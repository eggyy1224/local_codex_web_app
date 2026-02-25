import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw/server";

const pushMock = vi.fn();
const replaceMock = vi.fn();
let pathnameValue = "/threads/thread-1";
let searchParamsValue = new URLSearchParams();

class MockEventSource {
  static instances: MockEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(cb);
    this.listeners.set(type, existing);
  }

  emit(type: string, data: unknown): void {
    const handlers = this.listeners.get(type) ?? [];
    const event = { data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent;
    for (const handler of handlers) {
      handler(event);
    }
  }

  close(): void {
    // no-op
  }
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => pathnameValue,
  useSearchParams: () => searchParamsValue,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../app/threads/[id]/TerminalDock", () => ({
  default: () => <div data-testid="terminal-dock">terminal</div>,
}));

import ThreadPage from "../app/threads/[id]/page";

describe("Thread page integration", () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    pathnameValue = "/threads/thread-1";
    searchParamsValue = new URLSearchParams();
    MockEventSource.instances.length = 0;
  });

  it("loads thread detail + approvals + timeline + list + context", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Need approval",
              commandPreview: "npm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Main Thread",
              preview: "Preview",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-1",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "Hello",
              rawType: "agentMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText(/Main Thread/);
    expect(await screen.findByTestId("approval-drawer")).toBeInTheDocument();
    expect(screen.getByText("Need approval")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("handles approval and control flows", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let approvalCalls = 0;
    let controlCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Need approval",
              commandPreview: "npm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/approvals/:approvalId", () => {
        approvalCalls += 1;
        return HttpResponse.json({ ok: true });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => {
        controlCalls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const allowBtn = await screen.findByTestId("approval-allow");
    fireEvent.click(allowBtn);

    await waitFor(() => {
      expect(approvalCalls).toBe(1);
      expect(screen.queryByTestId("approval-drawer")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("control-stop"));
    await waitFor(() => {
      expect(controlCalls).toBe(1);
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(controlCalls).toBe(2);
    });
  });

  it("updates event cursor and pending approvals from EventSource events", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText(/Pending approval: 0/);
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }

    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-01T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "approval",
      name: "item/commandExecution/requestApproval",
      payload: {
        approvalId: "ap-live",
        approvalType: "commandExecution",
        reason: "Run command",
        command: "npm test",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-cursor")).toHaveTextContent("1");
      expect(screen.getByText(/Pending approval: 1/)).toBeInTheDocument();
    });

    es.emit("gateway", {
      seq: 2,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "approval",
      name: "approval/decision",
      payload: {
        approvalId: "ap-live",
        decision: "allow",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-cursor")).toHaveTextContent("2");
      expect(screen.getByText(/Pending approval: 0/)).toBeInTheDocument();
    });

    es.onerror?.(new Event("error"));
    await screen.findByText("Reconnecting");
  });

  it("supports /plan slash command and Shift+Tab mode toggle", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-plan-1" });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("mode: default");
    const textarea = await screen.findByTestId("turn-input");
    fireEvent.change(textarea, { target: { value: "/plan draft plan now" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
      expect(screen.getByTestId("collaboration-mode")).toHaveTextContent("mode: plan");
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "draft plan now" }],
      options: { collaborationMode: "plan" },
    });

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("collaboration-mode")).toHaveTextContent("mode: default");
    });
  });

  it("supports /review and /status slash commands", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    let reviewCalls = 0;
    let rateLimitCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/review", async ({ request }) => {
        reviewCalls += 1;
        const payload = await request.json();
        expect(payload).toEqual({ instructions: "focus risky diff" });
        return HttpResponse.json({ turnId: "turn-review-1", reviewThreadId: "thread-1" });
      }),
      http.get("http://127.0.0.1:8787/api/account/rate-limits", () => {
        rateLimitCalls += 1;
        return HttpResponse.json({
          rateLimits: {
            limitId: "codex",
            limitName: null,
            primary: {
              usedPercent: 10,
              windowDurationMins: 15,
              resetsAt: 1_730_947_200,
            },
            secondary: null,
          },
          rateLimitsByLimitId: {},
        });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    const textarea = await screen.findByTestId("turn-input");

    fireEvent.change(textarea, { target: { value: "/review focus risky diff" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(reviewCalls).toBe(1);
    });

    fireEvent.change(textarea, { target: { value: "/status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(rateLimitCalls).toBe(1);
      expect(screen.getByTestId("status-banner")).toBeInTheDocument();
      expect(screen.getByText(/thread: thread-1/)).toBeInTheDocument();
    });

    fireEvent.change(textarea, { target: { value: "status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(rateLimitCalls).toBe(2);
      expect(screen.getByTestId("status-banner")).toBeInTheDocument();
    });
  });

  it("autocompletes /r to /review and separates apply from submit", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    let reviewCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/review", async ({ request }) => {
        reviewCalls += 1;
        expect(await request.json()).toEqual({});
        return HttpResponse.json({ turnId: "turn-review-1", reviewThreadId: "thread-1" });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    const textarea = await screen.findByTestId("turn-input");

    fireEvent.change(textarea, { target: { value: "/r" } });
    expect(screen.getByTestId("thread-slash-menu")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/review/i })).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(textarea).toHaveValue("/review ");
    });
    expect(reviewCalls).toBe(0);

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(reviewCalls).toBe(1);
    });
  });

  it("treats unknown slash as plain text input", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-1" });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    const textarea = await screen.findByTestId("turn-input");
    fireEvent.change(textarea, { target: { value: "/foo bar" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "/foo bar" }],
    });
  });

  it("applies mode/status query params on entry", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan&status=1");
    let rateLimitCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8787/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Main Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8787/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8787/api/models", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8787/api/account/rate-limits", () => {
        rateLimitCalls += 1;
        return HttpResponse.json({
          rateLimits: null,
          rateLimitsByLimitId: null,
          error: "unavailable",
        });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await waitFor(() => {
      expect(screen.getByTestId("collaboration-mode")).toHaveTextContent("mode: plan");
      expect(screen.getByTestId("status-banner")).toBeInTheDocument();
      expect(rateLimitCalls).toBe(1);
    });
    expect(replaceMock).toHaveBeenCalled();
  });
});
