import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw/server";
import {
  implementPlanPrompt,
  planActionStorageKey,
} from "../app/threads/[id]/thread-page-helpers";

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

const planText = "1. Add API\n2. Verify flow";

function installThreadHandlers(timelineItems: Array<Record<string, unknown>>): void {
  server.use(
    http.get("http://127.0.0.1:8795/api/models", () => HttpResponse.json({ data: [] })),
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
      HttpResponse.json({ data: timelineItems }),
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
  );
}

function proposedPlanTimeline(): Array<Record<string, unknown>> {
  return [
    {
      id: "timeline-user",
      ts: "2026-01-01T00:00:00.000Z",
      turnId: "turn-plan",
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
      turnId: "turn-plan",
      type: "assistantMessage",
      title: "Assistant",
      text: `<proposed_plan>${planText}</proposed_plan>`,
      rawType: "agentMessage",
      toolName: null,
      callId: null,
    },
  ];
}

describe("Thread page plan actions", () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    window.localStorage.clear();
    pathnameValue = "/threads/thread-1";
    searchParamsValue = new URLSearchParams("mode=plan");
    MockEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  it("persists Keep planning dismissal so the same plan card stays hidden after remount", async () => {
    installThreadHandlers(proposedPlanTimeline());

    const first = render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByText("Plan ready");
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));

    await waitFor(() => {
      expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(planActionStorageKey("thread-1", "turn-plan", planText))).toBe(
      "dismissed",
    );

    first.unmount();
    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByText("plan please");

    await waitFor(() => {
      expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Implement this plan" })).not.toBeInTheDocument();
    });
  });

  it("does not flash a stored dismissed plan while timeline data loads", async () => {
    window.localStorage.setItem(planActionStorageKey("thread-1", "turn-plan", planText), "dismissed");
    installThreadHandlers(proposedPlanTimeline());

    let sawPlanReady = false;
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("Plan ready")) {
        sawPlanReady = true;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    try {
      render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
      await screen.findByText("plan please");

      await waitFor(() => {
        expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Implement this plan" })).not.toBeInTheDocument();
      });
      expect(sawPlanReady).toBe(false);
    } finally {
      observer.disconnect();
    }
  });

  it("hides a historical plan card when a later user turn implemented that same plan", async () => {
    installThreadHandlers([
      ...proposedPlanTimeline(),
      {
        id: "timeline-implement-user",
        ts: "2026-01-01T00:00:02.000Z",
        turnId: "turn-implement",
        type: "userMessage",
        title: "You",
        text: implementPlanPrompt(planText),
        rawType: "userMessage",
        toolName: null,
        callId: null,
      },
      {
        id: "timeline-implement-assistant",
        ts: "2026-01-01T00:00:03.000Z",
        turnId: "turn-implement",
        type: "assistantMessage",
        title: "Assistant",
        text: "Done.",
        rawType: "agentMessage",
        toolName: null,
        callId: null,
      },
    ]);

    render(<ThreadPage params={Promise.resolve({ id: "thread-1" })} />);
    await screen.findByText("Done.");

    expect(screen.queryByText("Plan ready")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Implement this plan" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(planActionStorageKey("thread-1", "turn-plan", planText))).toBeNull();
  });
});
