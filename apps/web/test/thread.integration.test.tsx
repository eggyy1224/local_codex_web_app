import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function setMobileViewport(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
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
    window.localStorage.clear();
    pathnameValue = "/threads/thread-1";
    searchParamsValue = new URLSearchParams();
    MockEventSource.instances.length = 0;
    setMobileViewport(false);
    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", () =>
        HttpResponse.json({ ok: true }),
      ),
    );
  });

  it("loads thread detail + approvals + timeline + list + context", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
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
      http.get("http://127.0.0.1:8795/api/threads", () =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText(/Main Thread/);
    expect(await screen.findByTestId("approval-drawer")).toBeInTheDocument();
    expect(await screen.findByText("Need approval")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("shows desktop thinking state while turn submission is in flight", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    let releaseTurnRequest: (() => void) | null = null;
    const turnRequestGate = new Promise<void>((resolve) => {
      releaseTurnRequest = resolve;
    });

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async () => {
        await turnRequestGate;
        return HttpResponse.json({ turnId: "turn-2" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByTestId("turn-input");

    fireEvent.change(screen.getByTestId("turn-input"), { target: { value: "run long request" } });
    fireEvent.click(screen.getByTestId("turn-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("desktop-thinking-pill")).toHaveTextContent("Preparing request");
      expect(screen.getByTestId("desktop-thinking-placeholder")).toBeInTheDocument();
      expect(screen.getByTestId("turn-submit")).toBeDisabled();
    });

    releaseTurnRequest?.();

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-thinking-pill")).not.toBeInTheDocument();
      expect(screen.queryByTestId("desktop-thinking-placeholder")).not.toBeInTheDocument();
    });
  });

  it("mobile thread page uses chat-first shell with overlay switcher and control sheet", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Mobile Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project-a",
              title: "Mobile Thread",
              preview: "Preview A",
              status: "idle",
              lastActiveAt: "2026-01-02T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
            {
              id: "thread-2",
              projectKey: "/tmp/project-b",
              title: "Other Thread",
              preview: "Preview B",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project-a",
          resolvedCwd: "/tmp/project-a",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("mobile-chat-topbar");
    expect(screen.queryByText("THREADS")).not.toBeInTheDocument();

    expect(screen.getByTestId("mobile-topbar-control-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-composer-control-toggle")).toBeInTheDocument();

    // Simplified mobile chrome: no model subtitle, no composer mode meta line; plan/flex pills hidden by default.
    expect(screen.queryByTestId("mobile-chat-model-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-chat-plan-pill")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-chat-flex-pill")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Mode:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Open threads"));
    await screen.findByTestId("mobile-thread-switcher-overlay");

    fireEvent.click(screen.getByText("Other Thread"));
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/threads/thread-2");
    });
  });

  it("mobile settings tab toggles service tier via /api/config/value", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let currentTier: "fast" | "flex" = "fast";
    let writeBody: unknown = null;

    server.use(
      http.get("http://127.0.0.1:8795/api/config", () =>
        HttpResponse.json({
          config: { serviceTier: currentTier, model: null, reasoningEffort: null },
          filePath: null,
          version: null,
        }),
      ),
      http.post("http://127.0.0.1:8795/api/config/value", async ({ request }) => {
        const body = (await request.json()) as { keyPath: string; value: string };
        writeBody = body;
        if (body.keyPath === "service_tier" && (body.value === "fast" || body.value === "flex")) {
          currentTier = body.value;
        }
        return HttpResponse.json({ status: "ok", filePath: null, version: null });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Tier Thread",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByTestId("mobile-topbar-control-toggle"));
    await screen.findByTestId("mobile-control-sheet");
    fireEvent.click(screen.getByTestId("mobile-control-tab-advanced"));

    const fastBtn = await screen.findByTestId("mobile-service-tier-fast");
    const flexBtn = screen.getByTestId("mobile-service-tier-flex");
    await waitFor(() => {
      expect(fastBtn).toHaveAttribute("aria-checked", "true");
      expect(flexBtn).toHaveAttribute("aria-checked", "false");
    });

    fireEvent.click(flexBtn);

    await waitFor(() => {
      expect(writeBody).toEqual({ keyPath: "service_tier", value: "flex" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("mobile-service-tier-flex")).toHaveAttribute("aria-checked", "true");
    });
    // After the toggle commits, the topbar should surface the Flex state as a persistent pill.
    await waitFor(() => {
      expect(screen.getByTestId("mobile-chat-flex-pill")).toBeInTheDocument();
    });
  });

  it("mobile pending approval renders the foreground action layer and posts allow", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    const decisionCalls: Array<{ approvalId: string; body: unknown }> = [];
    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Approval Thread",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-fg-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Run database migration",
              commandPreview: "pnpm migrate up",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post(
        "http://127.0.0.1:8795/api/threads/:id/approvals/:approvalId",
        async ({ params, request }) => {
          decisionCalls.push({
            approvalId: String(params.approvalId),
            body: await request.json(),
          });
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const layer = await screen.findByTestId("mobile-action-layer");
    expect(layer).toHaveAttribute("data-kind", "approval");
    expect(layer).toHaveAttribute("data-approval-id", "ap-fg-1");
    expect(layer).toHaveTextContent("Run command?");
    expect(layer).toHaveTextContent("Run database migration");
    expect(layer).toHaveTextContent("pnpm migrate up");

    fireEvent.click(screen.getByTestId("mobile-action-allow"));

    await waitFor(() => {
      expect(decisionCalls).toHaveLength(1);
    });
    expect(decisionCalls[0]).toEqual({
      approvalId: "ap-fg-1",
      body: { decision: "allow" },
    });
  });

  it("mobile sheet defaults to Pending when topbar opens it with pending items", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Default Open",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-default-open",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Reason",
              commandPreview: "echo 1",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByTestId("mobile-action-layer");

    fireEvent.click(screen.getByTestId("mobile-topbar-control-toggle"));
    const sheet = await screen.findByTestId("mobile-control-sheet");
    expect(within(sheet).getByTestId("mobile-control-tab-pending")).toHaveClass("is-active");
    expect(within(sheet).getByTestId("mobile-control-tab-advanced")).not.toHaveClass(
      "is-active",
    );
    // The sheet's Pending body should be rendering the approval card too.
    expect(within(sheet).getByTestId("approval-allow")).toBeInTheDocument();
  });

  it("mobile composer + button defaults to Pending when pending items exist", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Composer Default",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-composer-open",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Run",
              commandPreview: "echo 2",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByTestId("mobile-action-layer");

    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    const sheet = await screen.findByTestId("mobile-control-sheet");
    expect(within(sheet).getByTestId("mobile-control-tab-pending")).toHaveClass("is-active");
  });

  it("mobile action layer shows N-pending counter and reveals next approval after deny", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    const baseApprovals = [
      {
        approvalId: "ap-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: null,
        type: "commandExecution" as const,
        status: "pending" as const,
        reason: "First",
        commandPreview: "rm -rf /tmp/old",
        fileChangePreview: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
      },
      {
        approvalId: "ap-2",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: null,
        type: "fileChange" as const,
        status: "pending" as const,
        reason: "Second",
        commandPreview: null,
        fileChangePreview: "src/index.ts",
        createdAt: "2026-01-01T00:00:01.000Z",
        resolvedAt: null,
      },
    ];
    const decisionCalls: Array<{ approvalId: string; body: unknown }> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Multi Approval",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: baseApprovals }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post(
        "http://127.0.0.1:8795/api/threads/:id/approvals/:approvalId",
        async ({ params, request }) => {
          decisionCalls.push({
            approvalId: String(params.approvalId),
            body: await request.json(),
          });
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const layer = await screen.findByTestId("mobile-action-layer");
    expect(layer).toHaveAttribute("data-approval-id", "ap-1");
    expect(layer).toHaveTextContent("2 pending");

    fireEvent.click(screen.getByTestId("mobile-action-deny"));

    await waitFor(() => {
      expect(decisionCalls).toHaveLength(1);
    });
    expect(decisionCalls[0]).toEqual({
      approvalId: "ap-1",
      body: { decision: "deny" },
    });

    // After the local optimistic resolution of ap-1, ap-2 should surface as the new card.
    await waitFor(() => {
      const next = screen.getByTestId("mobile-action-layer");
      expect(next).toHaveAttribute("data-approval-id", "ap-2");
    });
    const nextLayer = screen.getByTestId("mobile-action-layer");
    expect(nextLayer).not.toHaveTextContent("2 pending");
    expect(nextLayer).toHaveTextContent("src/index.ts");
  });

  it("mobile action layer prefers question card when both an approval and a question are pending", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Both Pending",
            preview: "",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Run script",
              commandPreview: "pnpm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "userInput",
              status: "pending",
              questions: [
                {
                  id: "q1",
                  header: "Branch",
                  question: "Which branch should I push to?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: "main", description: "default" },
                    { label: "dev", description: "" },
                  ],
                },
              ],
              createdAt: "2026-01-01T00:00:01.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const layer = await screen.findByTestId("mobile-action-layer");
    expect(layer).toHaveAttribute("data-kind", "question");

    // Approval is NOT surfaced inline while a question is blocking the turn.
    expect(screen.queryByTestId("mobile-action-allow")).not.toBeInTheDocument();

    // Tapping Answer opens the Questions tab in the sheet.
    fireEvent.click(screen.getByTestId("mobile-action-open-question"));
    await screen.findByTestId("mobile-control-sheet");
    const questionsTab = screen.getByTestId("mobile-control-tab-pending");
    expect(questionsTab).toHaveClass("is-active");
  });

  it("mobile composer steers via /steer instead of /turns while a turn is running", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    const steerCalls: Array<{ threadId: string; body: unknown }> = [];
    let turnsCalled = false;

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Steer Thread",
            preview: "",
            status: "active",
            createdAt: null,
            updatedAt: null,
          },
          turns: [
            {
              id: "turn-running",
              status: "inProgress",
              startedAt: null,
              completedAt: null,
              error: null,
              items: [],
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "tl-start",
              ts: "2026-05-13T10:00:00.000Z",
              turnId: "turn-running",
              type: "status",
              title: "Turn started",
              text: null,
              rawType: "turn/started",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-delta",
              ts: "2026-05-13T10:00:01.000Z",
              turnId: "turn-running",
              type: "assistantMessage",
              title: "Codex",
              text: "running…",
              rawType: "item/agentMessage/delta",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post(
        "http://127.0.0.1:8795/api/threads/:id/steer",
        async ({ params, request }) => {
          steerCalls.push({ threadId: String(params.id), body: await request.json() });
          return HttpResponse.json({ turnId: "turn-running" });
        },
      ),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", () => {
        turnsCalled = true;
        return HttpResponse.json({ turnId: "should-not-fire" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    // Wait for streaming-derived steer mode to engage.
    await waitFor(() => {
      const composer = screen.getByTestId("mobile-composer-dock");
      expect(composer).toHaveAttribute("data-mode", "steer");
    });
    const input = screen.getByTestId("turn-input");
    expect(input).toHaveAttribute("placeholder", expect.stringMatching(/Steer/i));

    fireEvent.change(input, { target: { value: "change direction please" } });
    fireEvent.click(screen.getByTestId("turn-submit"));

    await waitFor(() => {
      expect(steerCalls).toHaveLength(1);
    });
    expect(steerCalls[0]).toEqual({
      threadId: "thread-1",
      body: {
        expectedTurnId: "turn-running",
        input: [{ type: "text", text: "change direction please" }],
      },
    });
    expect(turnsCalled).toBe(false);
    // Composer should clear after a successful steer.
    await waitFor(() => {
      expect((screen.getByTestId("turn-input") as HTMLTextAreaElement).value).toBe("");
    });

    // Enter-key path must route through steer too (caught by Codex review of 899bba3).
    fireEvent.change(screen.getByTestId("turn-input"), { target: { value: "via enter key" } });
    fireEvent.keyDown(screen.getByTestId("turn-input"), { key: "Enter" });
    await waitFor(() => {
      expect(steerCalls).toHaveLength(2);
    });
    expect(steerCalls[1].body).toEqual({
      expectedTurnId: "turn-running",
      input: [{ type: "text", text: "via enter key" }],
    });
    expect(turnsCalled).toBe(false);
  });

  it("mobile steer failure keeps the typed text in the composer", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Steer Failure Thread",
            preview: "",
            status: "active",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "tl-start",
              ts: "2026-05-13T10:00:00.000Z",
              turnId: "turn-running",
              type: "status",
              title: "Turn started",
              text: null,
              rawType: "turn/started",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-delta",
              ts: "2026-05-13T10:00:01.000Z",
              turnId: "turn-running",
              type: "assistantMessage",
              title: "Codex",
              text: "running…",
              rawType: "item/agentMessage/delta",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post(
        "http://127.0.0.1:8795/api/threads/:id/steer",
        () => new HttpResponse("nope", { status: 500 }),
      ),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await waitFor(() => {
      expect(screen.getByTestId("mobile-composer-dock")).toHaveAttribute("data-mode", "steer");
    });

    const input = screen.getByTestId("turn-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "kept on error" } });
    fireEvent.click(screen.getByTestId("turn-submit"));

    // On a 500, the text must NOT be cleared so the user can retry.
    await waitFor(() => {
      expect(screen.getByText(/steer http 500/i)).toBeInTheDocument();
    });
    expect((screen.getByTestId("turn-input") as HTMLTextAreaElement).value).toBe("kept on error");
  });

  it("mobile topbar shows Stop button during a streaming turn and posts to /interrupt", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    const interruptCalls: Array<{ threadId: string; body: unknown }> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Running Thread",
            preview: "",
            status: "active",
            createdAt: null,
            updatedAt: null,
          },
          turns: [
            {
              id: "turn-running",
              status: "inProgress",
              startedAt: null,
              completedAt: null,
              error: null,
              items: [],
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "tl-start",
              ts: "2026-05-13T10:00:00.000Z",
              turnId: "turn-running",
              type: "status",
              title: "Turn started",
              text: null,
              rawType: "turn/started",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-delta",
              ts: "2026-05-13T10:00:01.000Z",
              turnId: "turn-running",
              type: "assistantMessage",
              title: "Codex",
              text: "thinking…",
              rawType: "item/agentMessage/delta",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post(
        "http://127.0.0.1:8795/api/threads/:id/interrupt",
        async ({ params, request }) => {
          interruptCalls.push({ threadId: String(params.id), body: await request.json() });
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    // Stop appears once the running turn is detected.
    const stopBtn = await screen.findByTestId("mobile-topbar-stop");
    expect(stopBtn).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-topbar-control-toggle")).not.toBeInTheDocument();

    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(interruptCalls).toHaveLength(1);
    });
    expect(interruptCalls[0]).toEqual({
      threadId: "thread-1",
      body: { turnId: "turn-running" },
    });
  });

  it("keeps mobile topbar interactive after timeline scroll", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Scrollable Mobile Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project-a",
              title: "Scrollable Mobile Thread",
              preview: "Preview A",
              status: "idle",
              lastActiveAt: "2026-01-02T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
            {
              id: "thread-2",
              projectKey: "/tmp/project-b",
              title: "Other Thread",
              preview: "Preview B",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-1",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "scroll seed",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-2",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "scroll response",
              rawType: "agentMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project-a",
          resolvedCwd: "/tmp/project-a",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("mobile-chat-topbar");
    const timeline = await screen.findByTestId("timeline");
    fireEvent.scroll(timeline, { target: { scrollTop: 120 } });

    fireEvent.click(screen.getByLabelText("Open threads"));
    await screen.findByTestId("mobile-thread-switcher-overlay");
  });

  it("uses untitled title fallback for empty mobile thread title", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [{ id: "thread-1", projectKey: "/tmp/project", title: "", status: "idle", preview: "Preview", lastActiveAt: "2026-01-01T00:00:00.000Z", archived: false, waitingApprovalCount: 0, errorCount: 0, }], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const title = await screen.findByTestId("thread-title");
    expect(title).toHaveTextContent("(untitled thread)");
  });

  it("keeps mobile control sheet open when opened during initial thread bootstrap", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let resolveThreadId: ((value: { id: string }) => void) | null = null;
    const params = new Promise<{ id: string }>((resolve) => {
      resolveThreadId = resolve;
    });

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Bootstrap Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Bootstrap Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={params} />);

    const controlToggle = await screen.findByTestId("mobile-topbar-control-toggle");
    fireEvent.click(controlToggle);
    await screen.findByTestId("mobile-control-sheet");

    if (!resolveThreadId) {
      throw new Error("thread params resolver is not set");
    }
    resolveThreadId({ id: "thread-1" });

    await screen.findByText("Bootstrap Thread");
    await waitFor(() => {
      expect(screen.getByTestId("mobile-control-sheet")).toBeInTheDocument();
    });
  });

  it("disables all mobile approval actions during in-flight decision", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let approvalCalls = 0;
    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({
          data: [
            {
              approvalId: "ap-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Run command A",
              commandPreview: "npm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
            {
              approvalId: "ap-2",
              threadId: "thread-1",
              turnId: "turn-2",
              itemId: null,
              type: "fileChange",
              status: "pending",
              reason: "Apply patch",
              commandPreview: null,
              fileChangePreview: "src/main.ts",
              createdAt: "2026-01-01T00:00:01.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/approvals/:approvalId", async () => {
        approvalCalls += 1;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 75);
        });
        return HttpResponse.json({ ok: true });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByTestId("mobile-topbar-control-toggle"));
    await screen.findByTestId("mobile-control-sheet");
    fireEvent.click(screen.getByTestId("mobile-control-tab-pending"));

    const allowButtons = screen.getAllByTestId("approval-allow");
    const denyButtons = screen.getAllByTestId("approval-deny");
    const cancelButtons = screen.getAllByTestId("approval-cancel");

    expect(allowButtons).toHaveLength(2);
    expect(denyButtons).toHaveLength(2);
    expect(cancelButtons).toHaveLength(2);

    fireEvent.click(allowButtons[0]);

    await waitFor(() => {
      const allow = screen.getAllByTestId("approval-allow");
      const deny = screen.getAllByTestId("approval-deny");
      const cancel = screen.getAllByTestId("approval-cancel");
      for (const button of [...allow, ...deny, ...cancel]) {
        expect(button).toBeDisabled();
      }
    });

    fireEvent.click(allowButtons[1]);
    fireEvent.click(denyButtons[1]);
    fireEvent.click(cancelButtons[1]);

    await waitFor(() => {
      expect(approvalCalls).toBe(1);
    });
  });

  it("handles approval and control flows", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let approvalCalls = 0;
    let controlCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
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
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/approvals/:approvalId", () => {
        approvalCalls += 1;
        return HttpResponse.json({ ok: true });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => {
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
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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

  it("clears thread-scoped UI state and ignores stale SSE events after switching threads", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

    let releaseThread2Load: () => void = () => {};
    const thread2LoadGate = new Promise<void>((resolve) => {
      releaseThread2Load = resolve;
    });

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", async ({ params }) => {
        const id = String(params.id);
        if (id === "thread-2") {
          await thread2LoadGate;
        }
        return HttpResponse.json({
          thread: {
            id,
            title: id === "thread-2" ? "Second Thread" : "First Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", async ({ params }) => {
        const id = String(params.id);
        if (id === "thread-2") {
          await thread2LoadGate;
        }
        return HttpResponse.json({
          data:
            id === "thread-1"
              ? [
                  {
                    approvalId: "ap-old",
                    threadId: "thread-1",
                    turnId: "turn-1",
                    itemId: null,
                    type: "commandExecution",
                    status: "pending",
                    reason: "Old approval",
                    commandPreview: "npm test",
                    fileChangePreview: null,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    resolvedAt: null,
                  },
                ]
              : [],
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "First Thread",
              preview: "Preview",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 1,
              errorCount: 0,
            },
            {
              id: "thread-2",
              projectKey: "/tmp/project",
              title: "Second Thread",
              preview: "Preview",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:01.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", async ({ params }) => {
        const id = String(params.id);
        if (id === "thread-2") {
          await thread2LoadGate;
        }
        return HttpResponse.json({
          data:
            id === "thread-1"
              ? [
                  {
                    id: "timeline-old",
                    ts: "2026-01-01T00:00:00.000Z",
                    turnId: "turn-1",
                    type: "assistantMessage",
                    title: "Assistant",
                    text: "Old assistant text",
                    rawType: "agentMessage",
                    toolName: null,
                    callId: null,
                  },
                ]
              : [],
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", async ({ params }) => {
        const id = String(params.id);
        if (id === "thread-2") {
          await thread2LoadGate;
        }
        return HttpResponse.json({
          threadId: id,
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        });
      }),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    const { rerender } = render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("Old approval");
    await screen.findByText("Old assistant text");
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });
    const firstEventSource = MockEventSource.instances[0];

    pathnameValue = "/threads/thread-2";
    rerender(<ThreadPage params={Promise.resolve({ id: "thread-2" })} />);

    await waitFor(() => {
      expect(screen.queryByText("Old approval")).not.toBeInTheDocument();
      expect(screen.queryByText("Old assistant text")).not.toBeInTheDocument();
      expect(screen.getByTestId("event-cursor")).toHaveTextContent("0");
    });
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(2);
    });
    expect(MockEventSource.instances[1]?.url).toContain("/api/threads/thread-2/events?since=0");

    firstEventSource.emit("gateway", {
      seq: 99,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-stale",
      kind: "approval",
      name: "item/commandExecution/requestApproval",
      payload: {
        approvalId: "ap-stale",
        approvalType: "commandExecution",
        reason: "Stale old-thread approval",
        command: "npm test",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale old-thread approval")).not.toBeInTheDocument();
    expect(screen.getByTestId("event-cursor")).toHaveTextContent("0");

    releaseThread2Load();
    await screen.findByText("Second Thread");
  });

  it("merges delayed pending snapshots without losing newer SSE pending state", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

    let releasePendingSnapshot: () => void = () => {};
    const pendingSnapshotGate = new Promise<void>((resolve) => {
      releasePendingSnapshot = resolve;
    });

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", async () => {
        await pendingSnapshotGate;
        return HttpResponse.json({
          data: [
            {
              approvalId: "ap-resolved-before-snapshot",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "Stale snapshot approval",
              commandPreview: "npm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", async () => {
        await pendingSnapshotGate;
        return HttpResponse.json({ data: [] });
      }),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

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
        approvalId: "ap-live-before-snapshot",
        approvalType: "commandExecution",
        reason: "Live approval",
        command: "pnpm test",
      },
    });
    es.emit("gateway", {
      seq: 2,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "approval",
      name: "approval/decision",
      payload: {
        approvalId: "ap-resolved-before-snapshot",
        decision: "allow",
      },
    });

    await screen.findByText("Live approval");
    releasePendingSnapshot();

    await waitFor(() => {
      expect(screen.getByText("Live approval")).toBeInTheDocument();
      expect(screen.queryByText("Stale snapshot approval")).not.toBeInTheDocument();
      expect(screen.getByText(/Pending approval: 1/)).toBeInTheDocument();
    });
  });

  it("ignores in-flight approval responses after switching threads", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let releaseApprovalResponse: () => void = () => {};
    const approvalResponseGate = new Promise<void>((resolve) => {
      releaseApprovalResponse = resolve;
    });

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) => {
        const id = String(params.id);
        return HttpResponse.json({
          thread: {
            id,
            title: id === "thread-2" ? "Second Thread" : "First Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", ({ params }) => {
        const id = String(params.id);
        return HttpResponse.json({
          data: [
            {
              approvalId: "shared-approval-id",
              threadId: id,
              turnId: id === "thread-2" ? "turn-2" : "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: id === "thread-2" ? "New thread approval" : "Old thread approval",
              commandPreview: "npm test",
              fileChangePreview: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "First Thread",
              preview: "Preview",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 1,
              errorCount: 0,
            },
            {
              id: "thread-2",
              projectKey: "/tmp/project",
              title: "Second Thread",
              preview: "Preview",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:01.000Z",
              archived: false,
              waitingApprovalCount: 1,
              errorCount: 0,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", ({ params }) =>
        HttpResponse.json({
          threadId: String(params.id),
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/thread-1/approvals/shared-approval-id", async () => {
        await approvalResponseGate;
        return HttpResponse.json({ ok: true });
      }),
    );

    const { rerender } = render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("Old thread approval");
    fireEvent.click(screen.getByTestId("approval-allow"));

    pathnameValue = "/threads/thread-2";
    rerender(<ThreadPage params={Promise.resolve({ id: "thread-2" })} />);

    await screen.findByText(/Approvals \(1\)/);
    fireEvent.click(screen.getByText(/Approvals \(1\)/));
    await screen.findByText("New thread approval");
    releaseApprovalResponse();

    await waitFor(() => {
      expect(screen.getByText("New thread approval")).toBeInTheDocument();
      expect(screen.getByText(/Pending approval: 1/)).toBeInTheDocument();
    });
  });

  it("supports /plan slash command and Shift+Tab mode toggle", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-plan-1" });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/review", async ({ request }) => {
        reviewCalls += 1;
        const payload = await request.json();
        expect(payload).toEqual({ instructions: "focus risky diff" });
        return HttpResponse.json({ turnId: "turn-review-1", reviewThreadId: "thread-1" });
      }),
      http.get("http://127.0.0.1:8795/api/account/rate-limits", () => {
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
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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

  it("shows full /review command text in timeline user message", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-review-mode",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-review-1",
              type: "status",
              title: "Entered review mode",
              text: "last commit",
              rawType: "entered_review_mode",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:02.000Z",
              turnId: "turn-review-1",
              type: "userMessage",
              title: "User",
              text: "last commit",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("/review last commit");
    expect(screen.getByText("slash command")).toBeInTheDocument();
  });

  it("autocompletes /r to /review and separates apply from submit", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    let reviewCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/review", async ({ request }) => {
        reviewCalls += 1;
        expect(await request.json()).toEqual({});
        return HttpResponse.json({ turnId: "turn-review-1", reviewThreadId: "thread-1" });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-1" });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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

  it("desktop questions flow: composer stays enabled and submits interaction answers", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const interactionCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  options: [{ label: "Staging", description: "safe env" }],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", async ({ request }) => {
        interactionCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("approval-drawer");
    const textarea = await screen.findByTestId("turn-input");
    expect(textarea).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText("Staging - safe env"));
    fireEvent.change(screen.getByPlaceholderText("Other"), { target: { value: "nightly canary" } });
    fireEvent.click(screen.getByTestId("interaction-submit"));

    await waitFor(() => {
      expect(interactionCalls).toHaveLength(1);
      expect(screen.queryByTestId("approval-drawer")).not.toBeInTheDocument();
    });
    expect(interactionCalls[0]).toEqual({
      answers: {
        q1: {
          answers: ["Staging", "nightly canary"],
        },
      },
    });
  });

  it("desktop interaction options are mutually exclusive per question", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const interactionCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: "Staging", description: "safe env" },
                    { label: "Production", description: "live traffic" },
                  ],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", async ({ request }) => {
        interactionCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("approval-drawer");
    fireEvent.click(screen.getByLabelText("Staging - safe env"));
    fireEvent.click(screen.getByLabelText("Production - live traffic"));
    fireEvent.click(screen.getByTestId("interaction-submit"));

    await waitFor(() => {
      expect(interactionCalls).toHaveLength(1);
    });
    expect(interactionCalls[0]).toEqual({
      answers: {
        q1: {
          answers: ["Production"],
        },
      },
    });
  });

  it("desktop questions fall back to freeform input when options are empty", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const interactionCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  isOther: false,
                  isSecret: false,
                  options: [],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", async ({ request }) => {
        interactionCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const drawer = await screen.findByTestId("approval-drawer");
    const freeformInput = within(drawer).getByRole("textbox");
    fireEvent.change(freeformInput, { target: { value: "staging" } });
    fireEvent.click(within(drawer).getByTestId("interaction-submit"));

    await waitFor(() => {
      expect(interactionCalls).toHaveLength(1);
    });
    expect(interactionCalls[0]).toEqual({
      answers: {
        q1: {
          answers: ["staging"],
        },
      },
    });
  });

  it("desktop removes pending interaction when SSE emits interaction/cancelled", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  isOther: false,
                  isSecret: false,
                  options: [{ label: "Staging", description: "safe env" }],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByTestId("approval-drawer");

    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }

    es.emit("gateway", {
      seq: 10,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "interaction",
      name: "interaction/cancelled",
      payload: {
        interactionId: "ix-1",
        reason: "turn_completed",
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("approval-drawer")).not.toBeInTheDocument();
    });
  });

  it("mobile questions tab opens from topbar and submits answers", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const interactionCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Mobile Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  isOther: false,
                  isSecret: false,
                  options: [{ label: "Staging", description: "safe env" }],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Mobile Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", async ({ request }) => {
        interactionCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("mobile-chat-topbar");
    fireEvent.click(screen.getByTestId("mobile-topbar-control-toggle"));
    const sheet = await screen.findByTestId("mobile-control-sheet");
    expect(within(sheet).getByText("Pending (1)")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByTestId("mobile-control-tab-pending"));

    fireEvent.click(await within(sheet).findByLabelText("Staging - safe env"));
    fireEvent.click(within(sheet).getByTestId("interaction-submit"));

    await waitFor(() => {
      expect(interactionCalls).toHaveLength(1);
      expect(within(sheet).getByText("Pending (0)")).toBeInTheDocument();
    });
  });

  it("mobile questions fall back to freeform input when options are empty", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const interactionCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Mobile Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({
          data: [
            {
              interactionId: "ix-1",
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
                  isOther: false,
                  isSecret: false,
                  options: [],
                },
              ],
              createdAt: "2026-01-01T00:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Mobile Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/interactions/:interactionId/respond", async ({ request }) => {
        interactionCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("mobile-chat-topbar");
    fireEvent.click(screen.getByTestId("mobile-topbar-control-toggle"));
    const sheet = await screen.findByTestId("mobile-control-sheet");
    fireEvent.click(within(sheet).getByTestId("mobile-control-tab-pending"));

    const freeformInput = within(sheet).getByRole("textbox");
    fireEvent.change(freeformInput, { target: { value: "staging" } });
    fireEvent.click(within(sheet).getByTestId("interaction-submit"));

    await waitFor(() => {
      expect(interactionCalls).toHaveLength(1);
      expect(within(sheet).getByText("Pending (0)")).toBeInTheDocument();
    });
    expect(interactionCalls[0]).toEqual({
      answers: {
        q1: {
          answers: ["staging"],
        },
      },
    });
  });

  it("desktop proposed plan CTA supports implement + keep planning flows", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan");
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "plan please",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-assistant",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "<proposed_plan>1. Add pipeline\n2. Verify flow</proposed_plan>",
              rawType: "agentMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-2" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("Plan ready");
    fireEvent.click(screen.getByText("Keep planning"));
    await waitFor(() => {
      expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
    });
    expect(turnCalls).toHaveLength(0);

    const input = screen.getByTestId("turn-input");
    fireEvent.change(input, { target: { value: "please plan again" } });
    fireEvent.click(screen.getByTestId("turn-submit"));

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "please plan again" }],
      options: { collaborationMode: "plan" },
    });
    turnCalls.length = 0;

    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }
    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-2",
      kind: "item",
      name: "item/agentMessage/delta",
      payload: {
        threadId: "thread-1",
        turnId: "turn-2",
        delta: "<proposed_plan>1. Ship\n2. Monitor</proposed_plan>",
      },
    });
    es.emit("gateway", {
      seq: 2,
      serverTs: "2026-01-01T00:00:03.000Z",
      threadId: "thread-1",
      turnId: "turn-2",
      kind: "turn",
      name: "turn/completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-2",
        turn: { id: "turn-2", status: "completed" },
      },
    });

    await screen.findByText("Plan ready");
    fireEvent.click(screen.getByText("Implement this plan"));
    const dialog = await screen.findByTestId("implement-dialog");
    const draftInput = within(dialog).getByTestId("implement-draft-input");
    fireEvent.change(draftInput, { target: { value: "Implement quickly" } });
    fireEvent.click(within(dialog).getByText("Implement this plan"));

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
      expect(screen.getByTestId("collaboration-mode")).toHaveTextContent("mode: default");
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "Implement quickly" }],
    });
    expect(turnCalls[0]).not.toMatchObject({
      options: { collaborationMode: "plan" },
    });
  });

  it("desktop shows plan-ready CTA when proposed plan only exists in thinking", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan");

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "plan please",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-thinking",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "reasoning",
              title: "Thinking",
              text: "<proposed_plan>1. Evaluate scope\n2. Ship incrementally</proposed_plan>",
              rawType: "item/plan/delta",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByText("Plan ready");
    expect(screen.getByText(/1\. Evaluate scope/, { selector: ".cdx-turn-body--plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Implement this plan" })).toBeInTheDocument();
  });

  it("desktop shows plan-ready CTA from live turn/plan/updated event", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan");

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "plan please",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByText("plan please");

    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }

    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "turn",
      name: "turn/plan/updated",
      payload: {
        turnId: "turn-1",
        explanation: "Plan drafted",
        plan: [
          { step: "Evaluate scope", status: "completed" },
          { step: "Ship incrementally", status: "inProgress" },
        ],
      },
    });

    await screen.findByText("Plan ready");
    expect(screen.getByText(/Evaluate scope/, { selector: ".cdx-turn-body--plan" })).toBeInTheDocument();
  });

  it("mobile proposed plan CTA opens sheet and confirms implement", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Mobile Thread",
            preview: "Preview",
            status: "idle",
            createdAt: null,
            updatedAt: null,
          },
          turns: [],
          nextCursor: null,
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Mobile Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "plan please",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-assistant",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "<proposed_plan>1. Add API\n2. Add UI</proposed_plan>",
              rawType: "agentMessage",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-2" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    await screen.findByTestId("mobile-chat-topbar");
    fireEvent.click(await screen.findByText("Implement this plan"));
    const sheet = await screen.findByTestId("mobile-implement-sheet");
    fireEvent.change(within(sheet).getByTestId("implement-draft-input"), {
      target: { value: "Implement mobile plan" },
    });
    fireEvent.click(within(sheet).getByText("Implement this plan"));

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "Implement mobile plan" }],
    });
    expect(turnCalls[0]).not.toMatchObject({
      options: { collaborationMode: "plan" },
    });
  });

  it("applies mode/status query params on entry", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan&status=1");
    let rateLimitCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/tmp/project",
          resolvedCwd: "/tmp/project",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/account/rate-limits", () => {
        rateLimitCalls += 1;
        return HttpResponse.json({
          rateLimits: null,
          rateLimitsByLimitId: null,
          error: "unavailable",
        });
      }),
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () => HttpResponse.json({ ok: true })),
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
