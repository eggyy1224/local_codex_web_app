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
  closed = false;
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
    this.closed = true;
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

  it("optimistically renders the user message + thinking indicator while turn submission is in flight", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    let releaseTurnRequest: (() => void) | null = null;
    const turnRequestGate = new Promise<void>((resolve) => {
      releaseTurnRequest = resolve;
    });
    setMobileViewport(true);

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

    // While the POST is in flight: mobile topbar beacon shows (no real turns
    // yet) AND the user's text is already rendered optimistically so the
    // screen isn't blank during a slow request.
    await waitFor(() => {
      expect(screen.getByTestId("mobile-running-indicator")).toHaveTextContent("Preparing request");
      expect(screen.getByTestId("turn-submit")).toBeDisabled();
      expect(
        screen.getByText("run long request", { selector: ".cdx-turn-body" }),
      ).toBeInTheDocument();
    });

    releaseTurnRequest?.();

    // After POST returns: the beacon stays visible, but now represents the
    // accepted running turn instead of the preflight request. The optimistic
    // user bubble stays until the matching SSE user_message arrives (not
    // fired in this test — that's a separate path).
    await waitFor(() => {
      expect(screen.getByTestId("mobile-running-indicator")).toHaveTextContent(
        "Thinking in progress",
      );
      expect(
        screen.getByText("run long request", { selector: ".cdx-turn-body" }),
      ).toBeInTheDocument();
    });
  });

  it("desktop keeps the optimistic thinking pill and placeholder while turn submission is in flight", async () => {
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
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
      expect(
        screen.getByText("run long request", { selector: ".cdx-turn-body" }),
      ).toBeInTheDocument();
    });

    releaseTurnRequest?.();

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-thinking-placeholder")).not.toBeInTheDocument();
      expect(screen.getByText(/Live activity: 1 turn\(s\) streaming/)).toBeInTheDocument();
    });
  });

  it("sends auto permission mode from the desktop composer", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let capturedBody: any = null;
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
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ turnId: "turn-auto" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    const input = await screen.findByTestId("turn-input");

    fireEvent.change(screen.getByLabelText("Permission"), { target: { value: "auto" } });
    fireEvent.change(input, { target: { value: "run with auto review" } });
    fireEvent.click(screen.getByTestId("turn-submit"));

    await waitFor(() => {
      expect(capturedBody?.options?.permissionMode).toBe("auto");
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

  it("mobile composer updates the context ring from live token usage events", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

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
        HttpResponse.json({ data: [], nextCursor: null }),
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

    const ring = await screen.findByTestId("mobile-composer-context-ring");
    expect(ring).toHaveAttribute("title", "Context usage not available yet");
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }

    es.emit("gateway", {
      seq: 4,
      serverTs: "2026-01-01T00:00:04.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "status",
      name: "thread/tokenUsage/updated",
      payload: {
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 32_000,
            inputTokens: 30_000,
            outputTokens: 2_000,
          },
          modelContextWindow: 64_000,
        },
      },
    });

    await waitFor(() => {
      const updatedRing = screen.getByTestId("mobile-composer-context-ring");
      expect(updatedRing).toHaveAttribute("title", "Context 50%, 32k of 64k tokens");
      expect((updatedRing as HTMLElement).style.getPropertyValue("--context-ring-progress")).toBe("50%");
    });
  });

  it("mobile thread switcher groups by project, collapses per group, and creates a new thread in the chosen project", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    const createCalls: unknown[] = [];
    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Switcher Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/repos/alpha",
              title: "Alpha Active",
              preview: "",
              status: "active",
              lastActiveAt: "2026-01-03T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
            {
              id: "thread-2",
              projectKey: "/repos/alpha",
              title: "Alpha Idle",
              preview: "",
              status: "idle",
              lastActiveAt: "2026-01-02T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 0,
              errorCount: 0,
            },
            {
              id: "thread-3",
              projectKey: "/repos/beta",
              title: "Beta Waiting",
              preview: "",
              status: "idle",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
              archived: false,
              waitingApprovalCount: 2,
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
          cwd: "/repos/alpha",
          resolvedCwd: "/repos/alpha",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads", async ({ request }) => {
        const body = await request.json();
        createCalls.push(body);
        return HttpResponse.json({ threadId: "thread-new-beta" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByLabelText("Open threads"));
    await screen.findByTestId("mobile-thread-switcher-overlay");

    // Both projects are surfaced as separate groups.
    const groups = await screen.findAllByTestId("mobile-thread-switcher-group");
    expect(groups).toHaveLength(2);

    // The alpha-active thread surfaces a running badge; the beta thread
    // surfaces a waiting badge. We scope the lookup to badge elements
    // because the drawer also surfaces a "Running" filter tab now.
    const overlay = screen.getByTestId("mobile-thread-switcher-overlay");
    const badges = Array.from(
      overlay.querySelectorAll(".cdx-mobile-thread-switcher-badge"),
    ).map((node) => node.textContent);
    expect(badges).toContain("Running");
    expect(badges).toContain("2 pending");

    // Collapse the alpha group — its two items should disappear, but the beta group still renders its item.
    const alphaToggle = within(groups[0]).getByTestId("mobile-thread-switcher-group-toggle");
    fireEvent.click(alphaToggle);
    await waitFor(() => {
      expect(within(groups[0]).queryAllByTestId("mobile-thread-switcher-item")).toHaveLength(0);
      expect(screen.queryByText("Alpha Active")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Beta Waiting")).toBeInTheDocument();

    // The "+" button in the beta group creates a new thread scoped to that project's cwd.
    const betaPlus = within(groups[1]).getByTestId("mobile-thread-switcher-group-new");
    fireEvent.click(betaPlus);
    await waitFor(() => {
      expect(createCalls).toEqual([{ cwd: "/repos/beta" }]);
      expect(pushMock).toHaveBeenCalledWith("/threads/thread-new-beta");
    });
  });

  it("mobile thread switcher updates the active thread status from live turn events", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Switcher Thread",
            preview: "",
            status: "active",
            createdAt: null,
            updatedAt: null,
          },
          turns: [
            {
              id: "turn-running",
              status: "in_progress",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/repos/alpha",
              title: "Alpha Active",
              preview: "",
              status: "active",
              lastActiveAt: "2026-01-03T00:00:00.000Z",
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
              id: "tl-start",
              ts: "2026-01-03T00:00:00.000Z",
              turnId: "turn-running",
              type: "status",
              title: "Turn started",
              text: null,
              rawType: "turn/started",
              toolName: null,
              callId: null,
            },
          ],
        }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/repos/alpha",
          resolvedCwd: "/repos/alpha",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByLabelText("Open threads"));
    const overlay = await screen.findByTestId("mobile-thread-switcher-overlay");
    const activeRow = within(overlay).getByText("Alpha Active").closest("button");
    expect(activeRow).not.toBeNull();
    expect(within(activeRow as HTMLElement).getByText("Running")).toBeInTheDocument();

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }
    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-03T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-running",
      kind: "turn",
      name: "turn/completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-running",
        turn: { id: "turn-running", status: "completed" },
      },
    });

    await waitFor(() => {
      const updatedRow = within(overlay).getByText("Alpha Active").closest("button");
      expect(updatedRow).not.toBeNull();
      expect(within(updatedRow as HTMLElement).getByText("Idle")).toBeInTheDocument();
    });
  });

  it("keeps live thread-list status when a stale snapshot returns after SSE", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;
    let threadListCalls = 0;
    let releaseSecondThreadList: (() => void) | null = null;
    const secondThreadListGate = new Promise<void>((resolve) => {
      releaseSecondThreadList = resolve;
    });
    const staleIdleThread = {
      id: "thread-1",
      projectKey: "/repos/alpha",
      title: "Alpha Thread",
      preview: "",
      status: "idle",
      lastActiveAt: "2026-01-03T00:00:00.000Z",
      archived: false,
      waitingApprovalCount: 0,
      errorCount: 0,
    };

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Switcher Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", async () => {
        threadListCalls += 1;
        if (threadListCalls === 2) {
          await secondThreadListGate;
        }
        return HttpResponse.json({
          data: [staleIdleThread],
          nextCursor: null,
        });
      }),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-1",
          cwd: "/repos/alpha",
          resolvedCwd: "/repos/alpha",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByLabelText("Open threads"));
    const overlay = await screen.findByTestId("mobile-thread-switcher-overlay");
    expect(within(overlay).getByText("Idle")).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(threadListCalls).toBe(2);
    });

    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }
    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-03T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-running",
      kind: "turn",
      name: "turn/started",
      payload: {
        threadId: "thread-1",
        turnId: "turn-running",
        turn: { id: "turn-running", status: "in_progress" },
      },
    });
    for (let seq = 2; seq <= 620; seq += 1) {
      es.emit("gateway", {
        seq,
        serverTs: `2026-01-03T00:00:05.${String(seq).padStart(3, "0")}Z`,
        threadId: "thread-1",
        turnId: "turn-running",
        kind: "item",
        name: "item/agentMessage/delta",
        payload: { text: "streaming" },
      });
    }

    await waitFor(() => {
      const liveRow = within(overlay).getByText("Alpha Thread").closest("button");
      expect(liveRow).not.toBeNull();
      expect(within(liveRow as HTMLElement).getByText("Running")).toBeInTheDocument();
    });

    releaseSecondThreadList?.();

    await waitFor(() => {
      const preservedRow = within(overlay).getByText("Alpha Thread").closest("button");
      expect(preservedRow).not.toBeNull();
      expect(within(preservedRow as HTMLElement).getByText("Running")).toBeInTheDocument();
    });
  });

  it("mobile thread page opens a canvas iframe from the canvas query param", async () => {
    setMobileViewport(true);
    searchParamsValue = new URLSearchParams({
      canvas: "127.0.0.1:4173/preview.html",
    });
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Canvas Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/repos/canvas",
              title: "Canvas Thread",
              preview: "",
              status: "idle",
              lastActiveAt: "2026-01-03T00:00:00.000Z",
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
          cwd: "/repos/canvas",
          resolvedCwd: "/repos/canvas",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    fireEvent.click(await screen.findByTestId("mobile-topbar-canvas-toggle"));

    expect(screen.getByTestId("mobile-canvas-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-canvas-url-input")).toHaveValue(
      "http://127.0.0.1:4173/preview.html",
    );
    expect(screen.getByTestId("mobile-canvas-frame")).toHaveAttribute(
      "src",
      "http://127.0.0.1:4173/preview.html",
    );
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

  it("mobile control sheet closes when Close is pressed even after pointer-down on the header (regression)", async () => {
    // Reproduces the bug fix in commit 24617e4: the sheet header's
    // onPointerDown used to call setPointerCapture unconditionally, which ate
    // the Close button's click on pointer-up. Simulate the real interaction
    // pattern by firing pointerDown on the header (target = close button) then
    // clicking close — the sheet must dismiss.
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Close Regression Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
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
    const closeBtn = screen.getByTestId("mobile-control-sheet-close");
    // Simulate the pointer-down that the header receives when the user starts
    // pressing the Close button (the button bubbles its pointer event up to
    // the drag-handle header). Then complete the click.
    fireEvent.pointerDown(closeBtn, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(closeBtn, { pointerId: 1, clientY: 100 });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("mobile-control-sheet")).not.toBeInTheDocument();
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

    // The composer's + button now opens a lightweight menu first; tapping
    // "Controls" inside the menu opens the sheet on Pending when there are
    // pending items (regression guard for the original auto-default).
    fireEvent.click(screen.getByTestId("mobile-composer-control-toggle"));
    fireEvent.click(await screen.findByTestId("mobile-composer-plus-controls"));
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

  it("mobile renders the full primary user and assistant messages", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const longUserText = `${"u".repeat(9100)}USER_TAIL_VISIBLE`;
    const longAssistantText = `${"a".repeat(9100)}ASSISTANT_TAIL_VISIBLE`;

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Long Mobile Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-long",
              type: "userMessage",
              title: "User",
              text: longUserText,
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-assistant",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-long",
              type: "assistantMessage",
              title: "Assistant",
              text: longAssistantText,
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

    expect(await screen.findByText((content) => content.includes("USER_TAIL_VISIBLE"))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("ASSISTANT_TAIL_VISIBLE"))).toBeInTheDocument();
  });

  it("mobile composer @-mention queries fuzzy file search and inserts the picked path", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Mention",
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
          cwd: "/tmp/project-a",
          resolvedCwd: "/tmp/project-a",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/files/search", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("roots")).toBe("/tmp/project-a");
        expect(url.searchParams.get("query")).toBe("Mob");
        return HttpResponse.json({
          data: [
            {
              root: "/tmp/project-a",
              path: "apps/web/app/threads/MobileChatTopBar.tsx",
              fileName: "MobileChatTopBar.tsx",
              matchType: "file",
              score: 200,
              indices: [0, 1, 2],
            },
            {
              root: "/tmp/project-a",
              path: "apps/web/app/threads/MobileComposerDock.tsx",
              fileName: "MobileComposerDock.tsx",
              matchType: "file",
              score: 180,
              indices: [0, 1, 2],
            },
          ],
        });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const input = (await screen.findByTestId("turn-input")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "look at @Mob" } });

    const items = await screen.findAllByTestId("file-mention-item");
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toHaveAttribute(
      "data-path",
      "apps/web/app/threads/MobileChatTopBar.tsx",
    );

    fireEvent.mouseDown(items[0]);

    await waitFor(() => {
      expect((screen.getByTestId("turn-input") as HTMLTextAreaElement).value).toBe(
        "look at @apps/web/app/threads/MobileChatTopBar.tsx ",
      );
    });
    expect(screen.queryByTestId("file-mention-menu")).not.toBeInTheDocument();
  });

  it("mobile composer file mention menu dismisses on Escape and slash menu wins precedence", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Precedence",
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
          cwd: "/tmp/p",
          resolvedCwd: "/tmp/p",
          isFallback: false,
          source: "projection",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.get("http://127.0.0.1:8795/api/files/search", () =>
        HttpResponse.json({
          data: [
            {
              root: "/tmp/p",
              path: "x/y.ts",
              fileName: "y.ts",
              score: 1,
              matchType: "file",
              indices: [],
            },
          ],
        }),
      ),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    const input = (await screen.findByTestId("turn-input")) as HTMLTextAreaElement;

    // Open file mention menu via @ trigger.
    fireEvent.change(input, { target: { value: "@y" } });
    await screen.findByTestId("file-mention-menu");

    // Pressing Escape dismisses it but leaves the textarea text in place.
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-menu")).not.toBeInTheDocument();
    });
    expect(input.value).toBe("@y");

    // Typing past the @-token reopens the menu (no whitespace, new trigger).
    fireEvent.change(input, { target: { value: "@yz" } });
    await screen.findByTestId("file-mention-menu");

    // Now type / at the start — slash menu takes precedence, file menu hides.
    fireEvent.change(input, { target: { value: "/pla" } });
    await screen.findByTestId("thread-slash-menu");
    expect(screen.queryByTestId("file-mention-menu")).not.toBeInTheDocument();
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

    // On mobile, Enter belongs to textarea line breaks; the explicit Send button submits.
    fireEvent.change(screen.getByTestId("turn-input"), { target: { value: "via enter key" } });
    fireEvent.keyDown(screen.getByTestId("turn-input"), { key: "Enter" });
    expect(steerCalls).toHaveLength(1);
    expect((screen.getByTestId("turn-input") as HTMLTextAreaElement).value).toBe("via enter key");

    fireEvent.click(screen.getByTestId("turn-submit"));
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

    // Stop appears once the running turn is detected, while controls remain
    // available for pending approvals/questions during the run.
    const stopBtn = await screen.findByTestId("mobile-topbar-stop");
    expect(stopBtn).toBeInTheDocument();
    expect(screen.getByTestId("mobile-topbar-control-toggle")).toBeInTheDocument();

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
      expect(screen.getByTestId("control-stop")).not.toBeDisabled();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(controlCalls).toBe(2);
    });
  });

  it("Compact button posts to /api/threads/:id/compact and re-enables", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    let compactCalls = 0;
    let compactThreadId: string | null = null;

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
      http.post("http://127.0.0.1:8795/api/threads/:id/compact", ({ params }) => {
        compactCalls += 1;
        compactThreadId = String(params.id);
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

    const compactBtn = await screen.findByTestId("control-compact");
    fireEvent.click(compactBtn);

    await waitFor(() => {
      expect(compactCalls).toBe(1);
      expect(compactThreadId).toBe("thread-1");
      expect(screen.getByTestId("control-compact")).not.toBeDisabled();
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

  it("renders live sub-agent spawn events from SSE without requiring a refresh", async () => {
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

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances.at(-1);
    if (!es) {
      throw new Error("missing EventSource instance");
    }

    es.emit("gateway", {
      seq: 3,
      serverTs: "2026-01-01T00:00:03.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "item",
      name: "item/started",
      payload: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "thread-1",
          receiverThreadIds: [],
          prompt: "請審查剛剛的程式碼",
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-cursor")).toHaveTextContent("3");
      expect(screen.getByTestId("desktop-tool-batch")).toHaveTextContent("Ran 1 sub-agent step");
      expect(screen.getByTestId("desktop-tool-action")).toHaveTextContent(
        "Spawned sub-agent · 請審查剛剛的程式碼",
      );
    });
  });

  it("mobile reconciles a stuck running turn from the timeline snapshot when SSE completion is missed", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let timelineCalls = 0;

    const startedItem = {
      id: "tl-started",
      ts: "2026-01-01T00:00:00.000Z",
      turnId: "turn-stuck",
      type: "status",
      title: "Turn started",
      text: "turn turn-stuck",
      rawType: "turn/started",
      toolName: null,
      callId: null,
    };
    const completedItem = {
      id: "tl-completed",
      ts: "2026-01-01T00:00:10.000Z",
      turnId: "turn-stuck",
      type: "status",
      title: "Turn completed",
      text: "status: completed",
      rawType: "turn/completed",
      toolName: null,
      callId: null,
    };

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
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () => {
        timelineCalls += 1;
        return HttpResponse.json({
          data: timelineCalls === 1 ? [startedItem] : [startedItem, completedItem],
        });
      }),
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

    try {
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-running-indicator")).toHaveTextContent(
          "Thinking in progress",
        );
      });
      expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 15_000)).toBe(false);

      window.dispatchEvent(new Event("focus"));

      await waitFor(() => {
        expect(timelineCalls).toBeGreaterThanOrEqual(2);
        expect(screen.queryByTestId("mobile-running-indicator")).not.toBeInTheDocument();
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("mobile focus rebuilds the EventSource so a zombie PWA stream can replay missed events", async () => {
    setMobileViewport(true);
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
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

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    const first = MockEventSource.instances[0];
    expect(first.closed).toBe(false);

    first.emit("gateway", {
      seq: 7,
      serverTs: "2026-01-03T00:00:05.000Z",
      threadId: "thread-1",
      turnId: null,
      kind: "thread",
      name: "thread/updated",
      payload: {
        thread: { id: "thread-1", status: "idle" },
      },
    });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(2);
    });
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances.at(-1)?.url).toContain("/events?since=7");

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(2);
    });
  });

  it("keeps early EventSource events that arrive before the initial timeline snapshot", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

    let releaseTimeline: () => void = () => {};
    const timelineGate = new Promise<void>((resolve) => {
      releaseTimeline = resolve;
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
      http.get("http://127.0.0.1:8795/api/threads/:id/approvals/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", async () => {
        await timelineGate;
        return HttpResponse.json({ data: [] });
      }),
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
      http.post("http://127.0.0.1:8795/api/threads/:id/control", () =>
        HttpResponse.json({ ok: true }),
      ),
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
      seq: 7,
      serverTs: "2026-01-01T00:00:07.000Z",
      threadId: "thread-1",
      turnId: "turn-early",
      kind: "turn",
      name: "turn/started",
      payload: {
        turn: {
          id: "turn-early",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
        },
      },
    });

    releaseTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("event-cursor")).toHaveTextContent("7");
      expect(screen.getByText(/Live activity: 1 turn/)).toBeInTheDocument();
    });
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

    // The banner should be dismissable via its close button.
    fireEvent.click(screen.getByTestId("status-banner-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("status-banner")).not.toBeInTheDocument();
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

  it("submitTurnText uses the thread's resolved cwd, not the global activeProjectKey fallback (regression)", async () => {
    // Reproduces the user-reported bug: after pressing "+" in project B's
    // group, the new thread was created in /repos/beta (correct), but the
    // FIRST turn went to options.cwd = /repos/alpha because the new thread
    // hadn't propagated into threadList yet and activeProjectKey fell back to
    // the most-recently-active project. The fix is to prefer threadContext's
    // per-thread resolvedCwd over the global fallback.
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const turnCalls: Array<{ options?: { cwd?: string } }> = [];

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Newly created beta thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      // The thread list does NOT yet include thread-new — simulating the
      // race window between create and list propagation.
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-alpha",
              projectKey: "/repos/alpha",
              title: "Alpha most-recent",
              preview: "",
              status: "idle",
              lastActiveAt: "2026-01-05T00:00:00.000Z",
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
      // The per-thread context endpoint IS authoritative: gateway already
      // recorded the new thread in /repos/beta because we POSTed cwd=/repos/beta.
      http.get("http://127.0.0.1:8795/api/threads/:id/context", () =>
        HttpResponse.json({
          threadId: "thread-new",
          cwd: "/repos/beta",
          resolvedCwd: "/repos/beta",
          isFallback: false,
          source: "session_meta",
        }),
      ),
      http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      http.post("http://127.0.0.1:8795/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push((await request.json()) as { options?: { cwd?: string } });
        return HttpResponse.json({ turnId: "turn-1" });
      }),
    );

    render(<ThreadPage params={Promise.resolve({ id: "thread-new" })} />);
    // Wait for threadContext to be reflected in the cwd status pill so we
    // know the fetch completed before we send the turn.
    await screen.findByText(/cwd: \/repos\/beta/);
    const textarea = screen.getByTestId("turn-input");
    fireEvent.change(textarea, { target: { value: "!pwd" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(turnCalls).toHaveLength(1);
    });
    // Must be the thread's own cwd from /context, NOT the activeProjectKey
    // fallback (/repos/alpha).
    expect(turnCalls[0].options?.cwd).toBe("/repos/beta");
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
    // Streaming deltas are intentionally dropped now; the final agent message
    // arrives via item/completed and carries the full plan text.
    es.emit("gateway", {
      seq: 1,
      serverTs: "2026-01-01T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-2",
      kind: "item",
      name: "item/completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-2",
        item: {
          type: "agentMessage",
          id: "item-plan-2",
          turnId: "turn-2",
          text: "<proposed_plan>1. Ship\n2. Monitor</proposed_plan>",
        },
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

  it("desktop renders plan-ready CTA from a replayed reasoning item with rawType 'plan'", async () => {
    // Gateway projects `item_completed` + `Plan` items as reasoning timeline
    // entries with `rawType: "plan"` (see gateway commit 38cf963). When a
    // user reloads a historical thread that contains such an entry, the web
    // client should still surface the Plan ready CTA — exactly the same way
    // it does for a live `<proposed_plan>...</proposed_plan>` block.
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    searchParamsValue = new URLSearchParams("mode=plan");

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Reloaded Plan Thread",
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
      http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get("http://127.0.0.1:8795/api/threads", () =>
        HttpResponse.json({ data: [], nextCursor: null }),
      ),
      http.get("http://127.0.0.1:8795/api/threads/:id/timeline", () =>
        HttpResponse.json({
          data: [
            {
              id: "timeline-user",
              ts: "2026-05-13T00:00:00.000Z",
              turnId: "turn-replay",
              type: "userMessage",
              title: "You",
              text: "plan please",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "timeline-plan",
              ts: "2026-05-13T00:00:01.000Z",
              turnId: "turn-replay",
              type: "reasoning",
              title: "Plan",
              text: "<proposed_plan>1. Restore schema\n2. Backfill\n3. Verify</proposed_plan>",
              // Gateway emits the bare "plan" rawType for an item_completed
              // Plan projection — different from the live "item/plan/delta".
              rawType: "plan",
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
    expect(
      screen.getByText(/1\. Restore schema/, { selector: ".cdx-turn-body--plan" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Implement this plan" })).toBeInTheDocument();
  });

  it("desktop renders turn/plan/updated as a Codex tasks progress card (not the Plan ready CTA)", async () => {
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

    // turn/plan/updated is Codex's in-flight progress checklist, NOT a
    // proposed plan. It must render as the neutral "Codex tasks" card and
    // must not show the "Implement this plan" CTA — clicking that used to
    // steer the conversation with already-completed task content.
    const progressCard = await screen.findByTestId("turn-progress-card");
    expect(within(progressCard).getByText("Codex tasks")).toBeInTheDocument();
    expect(within(progressCard).getByText(/Evaluate scope/)).toBeInTheDocument();
    expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Implement this plan")).not.toBeInTheDocument();
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

  it("mobile pending approval stays foreground over view menu and thread drawer", async () => {
    setMobileViewport(true);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Foreground Approval",
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
              approvalId: "ap-foreground-1",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: null,
              type: "commandExecution",
              status: "pending",
              reason: "needs decision",
              commandPreview: "rm -rf dist",
              fileChangePreview: null,
              createdAt: "2026-05-01T00:00:00.000Z",
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
    expect(layer).toHaveAttribute("data-kind", "approval");

    // Opening the view menu while pending: the menu auto-collapses so it
    // cannot overlap the action buttons. The action layer remains
    // interactive.
    fireEvent.click(screen.getByTestId("mobile-topbar-views-toggle"));
    await waitFor(() => {
      expect(screen.queryByTestId("mobile-topbar-views-menu")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("mobile-action-layer")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-action-allow")).toBeEnabled();

    // Opening the thread switcher drawer with a pending approval on screen
    // is allowed (drawer is real navigation), but the action layer keeps
    // its stacking-context lead so its buttons remain in the foreground
    // even while the drawer is mounted.
    fireEvent.click(screen.getByLabelText("Open threads"));
    await screen.findByTestId("mobile-thread-switcher-overlay");
    const layerWithDrawer = screen.getByTestId("mobile-action-layer");
    expect(layerWithDrawer).toBeInTheDocument();
    const allowBtn = screen.getByTestId("mobile-action-allow");
    expect(allowBtn).toBeEnabled();
  });

  it("desktop thread view renders thinking + tools as segments driven by view mode", async () => {
    // Mirrors the mobile MobileMessageStream behaviour we already cover in
    // the mobile slice: tool batches always surface a semantic pill summary,
    // thinking only shows when the user opts into Thinking/Verbose, and raw
    // tool call/output only renders in Verbose. This exercises the desktop
    // topbar Views menu wiring + the segments-driven render path.
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Desktop View Mode Thread",
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
        HttpResponse.json({
          data: [
            {
              id: "tl-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "list files",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-thinking",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "reasoning",
              title: "Thinking",
              text: "Planning to run ls",
              rawType: "item/reasoning/completed",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-toolcall",
              ts: "2026-01-01T00:00:02.000Z",
              turnId: "turn-1",
              type: "toolCall",
              title: "Tool call",
              text: JSON.stringify({ command: "ls -la" }),
              rawType: "item/toolCall/completed",
              toolName: "exec_command",
              callId: "call-1",
            },
            {
              id: "tl-toolresult",
              ts: "2026-01-01T00:00:03.000Z",
              turnId: "turn-1",
              type: "toolResult",
              title: "Tool output",
              text: "drwx 4096 .\n-rw- 12 README",
              rawType: "item/toolResult/completed",
              toolName: null,
              callId: "call-1",
            },
            {
              id: "tl-assistant",
              ts: "2026-01-01T00:00:04.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "Listed two entries.",
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

    // Normal: tool batch + semantic pill visible, thinking + raw call/output hidden.
    await screen.findByTestId("desktop-tool-batch");
    expect(screen.getByTestId("desktop-tool-batch")).toHaveAttribute("data-view-mode", "normal");
    expect(screen.getByTestId("desktop-tool-action")).toHaveTextContent("Ran ls -la");
    expect(screen.queryByTestId("desktop-thinking-segment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-tool-batch-raw")).not.toBeInTheDocument();

    // Flip to Thinking via the desktop topbar Views menu.
    fireEvent.click(screen.getByTestId("desktop-topbar-views-toggle"));
    await screen.findByTestId("desktop-topbar-views-menu");
    fireEvent.click(screen.getByTestId("desktop-topbar-views-thinking"));

    await waitFor(() => {
      expect(screen.getByTestId("desktop-tool-batch")).toHaveAttribute(
        "data-view-mode",
        "thinking",
      );
    });
    expect(screen.getByTestId("desktop-thinking-segment")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-tool-batch-raw")).not.toBeInTheDocument();
    // Semantic pill stays put across view modes.
    expect(screen.getByTestId("desktop-tool-action")).toHaveTextContent("Ran ls -la");

    // Verbose: raw call/output now renders.
    fireEvent.click(screen.getByTestId("desktop-topbar-views-toggle"));
    await screen.findByTestId("desktop-topbar-views-menu");
    fireEvent.click(screen.getByTestId("desktop-topbar-views-verbose"));

    await screen.findByTestId("desktop-tool-batch-raw");
    expect(screen.getByTestId("desktop-tool-raw-call")).toHaveTextContent(/ls -la/);
    expect(screen.getByTestId("desktop-tool-raw-output")).toHaveTextContent(/README/);
  });

  it("desktop renders every assistant segment when a turn emits multiple agent_message events", async () => {
    // Regression: pre-fix the desktop card rendered only the longest
    // assistantText, so a turn shaped like
    //   commentary line → tool batch → final answer line
    // would lose the commentary line. The mobile MobileMessageStream
    // already walks `segments`, so this exercises the matching desktop
    // path: both assistant bubbles must be visible, with the tool batch
    // pill between them.
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Multi-segment desktop turn",
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
        HttpResponse.json({
          data: [
            {
              id: "tl-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "show me",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-assistant-1",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "Sure, let me check the directory first.",
              rawType: "agentMessage",
              toolName: null,
              callId: null,
            },
            {
              id: "tl-toolcall",
              ts: "2026-01-01T00:00:02.000Z",
              turnId: "turn-1",
              type: "toolCall",
              title: "Tool call",
              text: JSON.stringify({ command: "ls -la" }),
              rawType: "item/toolCall/completed",
              toolName: "exec_command",
              callId: "call-1",
            },
            {
              id: "tl-toolresult",
              ts: "2026-01-01T00:00:03.000Z",
              turnId: "turn-1",
              type: "toolResult",
              title: "Tool output",
              text: "README",
              rawType: "item/toolResult/completed",
              toolName: null,
              callId: "call-1",
            },
            {
              id: "tl-assistant-2",
              ts: "2026-01-01T00:00:04.000Z",
              turnId: "turn-1",
              type: "assistantMessage",
              title: "Assistant",
              text: "Found one README — done.",
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

    // Both assistant bubbles render — the commentary line is no longer
    // dropped on the floor.
    await waitFor(() => {
      const segments = screen.queryAllByTestId("desktop-assistant-segment");
      expect(segments.length).toBe(2);
    });
    const assistantSegments = screen.getAllByTestId("desktop-assistant-segment");
    expect(assistantSegments[0]).toHaveTextContent("Sure, let me check");
    expect(assistantSegments[1]).toHaveTextContent("Found one README");

    // Tool batch pill renders between the two assistant bubbles, not after
    // both of them.
    const toolBatch = screen.getByTestId("desktop-tool-batch");
    expect(toolBatch).toHaveTextContent(/ls -la/);

    const stack = screen.getByTestId("desktop-turn-segments");
    const orderedSegments = Array.from(
      stack.querySelectorAll(
        "[data-testid='desktop-assistant-segment'],[data-testid='desktop-tool-batch']",
      ),
    );
    expect(orderedSegments).toHaveLength(3);
    expect(orderedSegments[0]).toHaveAttribute("data-testid", "desktop-assistant-segment");
    expect(orderedSegments[1]).toHaveAttribute("data-testid", "desktop-tool-batch");
    expect(orderedSegments[2]).toHaveAttribute("data-testid", "desktop-assistant-segment");
  });

  it("desktop surfaces live thinking text while streaming even when segments lack a thinking entry", async () => {
    // Live reasoning deltas land in `turn.thinkingText` long before a
    // completed reasoning item ever produces a thinking segment, so the
    // Thinking/Verbose modes would otherwise look empty during the most
    // valuable part of the stream. Render a fallback card off of
    // `thinkingText` until a real segment shows up.
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

    server.use(
      http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
        HttpResponse.json({
          thread: {
            id: String(params.id),
            title: "Streaming reasoning desktop",
            preview: "",
            status: "running",
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
              id: "tl-user",
              ts: "2026-01-01T00:00:00.000Z",
              turnId: "turn-1",
              type: "userMessage",
              title: "You",
              text: "think out loud",
              rawType: "userMessage",
              toolName: null,
              callId: null,
            },
            // Reasoning delta only — no completed reasoning item, so the
            // segment builder produces no thinking segment yet.
            {
              id: "tl-think-delta",
              ts: "2026-01-01T00:00:01.000Z",
              turnId: "turn-1",
              type: "reasoning",
              title: "Thinking",
              text: "Considering the available options before I act...",
              rawType: "item/reasoning/delta",
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

    // Normal mode: live reasoning stays hidden (mirrors mobile).
    await screen.findByTestId("desktop-turn-segments");
    expect(
      screen.queryByTestId("desktop-thinking-streaming-fallback"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-thinking-segment")).not.toBeInTheDocument();

    // Flip to Thinking: the live delta is now visible via the fallback
    // card even though segments haven't produced a thinking entry yet.
    fireEvent.click(screen.getByTestId("desktop-topbar-views-toggle"));
    await screen.findByTestId("desktop-topbar-views-menu");
    fireEvent.click(screen.getByTestId("desktop-topbar-views-thinking"));

    await waitFor(() => {
      expect(
        screen.getByTestId("desktop-thinking-streaming-fallback"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("desktop-thinking-streaming-fallback")).toHaveTextContent(
      /Considering the available options/,
    );
    // Still no completed thinking segment — only the live fallback.
    expect(screen.queryByTestId("desktop-thinking-segment")).not.toBeInTheDocument();
  });

  describe("desktop sidebar thread switcher (parity with mobile drawer)", () => {
    function setDesktopViewport() {
      // useThreadViewportShell marks the viewport "compact" when
      // window.innerWidth <= 1024, which collapses the desktop sidebar (since
      // jsdom defaults to 1024). Push past that boundary so the sidebar
      // actually renders for these tests.
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1440,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 900,
      });
      setMobileViewport(false);
      // jsdom doesn't implement Element.prototype.scrollIntoView; without
      // this stub the rAF-scheduled scroll on the active sidebar card raises
      // an unhandled exception which marks the whole file as failed even
      // when every assertion passes.
      if (typeof (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView !== "function") {
        (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = () => {};
      }
    }

    function stubMultiThreadList() {
      setDesktopViewport();
      vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
      const createCalls: unknown[] = [];
      server.use(
        http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
          HttpResponse.json({
            thread: {
              id: String(params.id),
              title: "Alpha Running",
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
        http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
          HttpResponse.json({ data: [] }),
        ),
        http.get("http://127.0.0.1:8795/api/threads", () =>
          HttpResponse.json({
            data: [
              {
                id: "thread-1",
                projectKey: "/repos/alpha",
                title: "Alpha Running",
                preview: "alpha preview",
                status: "active",
                lastActiveAt: "2026-01-04T00:00:00.000Z",
                archived: false,
                waitingApprovalCount: 0,
                errorCount: 0,
              },
              {
                id: "thread-2",
                projectKey: "/repos/alpha",
                title: "Alpha Idle",
                preview: "alpha idle preview",
                status: "idle",
                lastActiveAt: "2026-01-03T00:00:00.000Z",
                archived: false,
                waitingApprovalCount: 0,
                errorCount: 0,
              },
              {
                id: "thread-3",
                projectKey: "/repos/beta",
                title: "Beta Waiting",
                preview: "beta preview",
                status: "idle",
                lastActiveAt: "2026-01-02T00:00:00.000Z",
                archived: false,
                waitingApprovalCount: 2,
                errorCount: 0,
              },
              {
                id: "thread-4",
                projectKey: "/repos/beta",
                title: "Beta Broken",
                preview: "beta broken preview",
                status: "systemError",
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
            cwd: "/repos/alpha",
            resolvedCwd: "/repos/alpha",
            isFallback: false,
            source: "projection",
          }),
        ),
        http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
        http.post("http://127.0.0.1:8795/api/threads", async ({ request }) => {
          const body = await request.json();
          createCalls.push(body);
          return HttpResponse.json({ threadId: "thread-new" });
        }),
      );
      return { createCalls };
    }

    it("renders one status badge per thread row matching the mobile priority", async () => {
      stubMultiThreadList();
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      // Wait for the sidebar list to populate.
      await screen.findByTestId("thread-status-badge-thread-1");

      // active without pending → Running
      expect(screen.getByTestId("thread-status-badge-thread-1")).toHaveTextContent(
        "Running",
      );
      // idle with waitingApprovalCount > 0 → "2 pending"
      expect(screen.getByTestId("thread-status-badge-thread-3")).toHaveTextContent(
        "2 pending",
      );
      // systemError → Error
      expect(screen.getByTestId("thread-status-badge-thread-4")).toHaveTextContent(
        "Error",
      );
      // idle → Idle
      expect(screen.getByTestId("thread-status-badge-thread-2")).toHaveTextContent(
        "Idle",
      );
    });

    it("New thread button creates a thread and routes to it", async () => {
      const { createCalls } = stubMultiThreadList();
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      // Wait for the thread list to land — activeProjectKey only resolves to
      // /repos/alpha once thread-1's row is in threadList; before that we'd
      // POST with an empty body. The list response is what derives cwd.
      await screen.findByTestId("thread-status-badge-thread-1");

      const btn = screen.getByTestId("desktop-sidebar-new-thread");
      fireEvent.click(btn);
      await waitFor(() => {
        // The default project key for an active thread is /repos/alpha.
        expect(createCalls).toEqual([{ cwd: "/repos/alpha" }]);
        expect(pushMock).toHaveBeenCalledWith("/threads/thread-new");
      });
    });

    it("per-project + buttons scope creates to the chosen project cwd", async () => {
      const { createCalls } = stubMultiThreadList();
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      const betaPlus = await screen.findByTestId(
        "desktop-thread-group-new-/repos/beta",
      );
      fireEvent.click(betaPlus);
      await waitFor(() => {
        expect(createCalls).toEqual([{ cwd: "/repos/beta" }]);
      });
    });

    it("Waiting filter hides idle + running + error rows", async () => {
      stubMultiThreadList();
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      await screen.findByTestId("thread-status-badge-thread-1");

      fireEvent.click(screen.getByTestId("desktop-thread-filter-waiting"));

      await waitFor(() => {
        // thread-3 has waitingApprovalCount > 0; everything else is hidden.
        expect(screen.getByTestId("thread-status-badge-thread-3")).toBeInTheDocument();
        expect(
          screen.queryByTestId("thread-status-badge-thread-1"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("thread-status-badge-thread-2"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("thread-status-badge-thread-4"),
        ).not.toBeInTheDocument();
      });
    });

    it("search filters by title and shows the empty state when no matches", async () => {
      stubMultiThreadList();
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);

      await screen.findByTestId("thread-status-badge-thread-1");

      const search = screen.getByTestId("desktop-thread-search");
      fireEvent.change(search, { target: { value: "broken" } });

      await waitFor(() => {
        // Only the Beta Broken row remains.
        expect(screen.getByTestId("thread-status-badge-thread-4")).toBeInTheDocument();
        expect(
          screen.queryByTestId("thread-status-badge-thread-1"),
        ).not.toBeInTheDocument();
      });

      // Type a term nothing matches → "No matches for …" empty-state banner.
      fireEvent.change(search, { target: { value: "no-such-thread-xyz" } });
      await waitFor(() => {
        expect(screen.getByTestId("desktop-thread-empty")).toHaveTextContent(
          /No matches/,
        );
      });
    });

    it("Running filter empty result surfaces a filter-specific empty state", async () => {
      setDesktopViewport();
      vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
      server.use(
        http.get("http://127.0.0.1:8795/api/threads/:id", ({ params }) =>
          HttpResponse.json({
            thread: {
              id: String(params.id),
              title: "Only Idle",
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
        http.get("http://127.0.0.1:8795/api/threads/:id/interactions/pending", () =>
          HttpResponse.json({ data: [] }),
        ),
        http.get("http://127.0.0.1:8795/api/threads", () =>
          HttpResponse.json({
            data: [
              {
                id: "thread-1",
                projectKey: "/repos/alpha",
                title: "Only Idle",
                preview: "",
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
            cwd: "/repos/alpha",
            resolvedCwd: "/repos/alpha",
            isFallback: false,
            source: "projection",
          }),
        ),
        http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
      );

      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
      await screen.findByTestId("thread-status-badge-thread-1");

      fireEvent.click(screen.getByTestId("desktop-thread-filter-running"));
      await waitFor(() => {
        expect(screen.getByTestId("desktop-thread-empty")).toHaveTextContent(
          /No running threads/,
        );
      });
    });
  });
});
