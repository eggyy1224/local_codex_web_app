import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw/server";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import HomePage from "../app/page";

describe("Home page integration", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  it("loads health + threads + model catalog", async () => {
    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () =>
        HttpResponse.json({
          data: [
            {
              id: "thread-1",
              projectKey: "/tmp/project",
              title: "Thread One",
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
      http.get("http://127.0.0.1:8787/api/models", () =>
        HttpResponse.json({
          data: [{ id: "gpt-5-codex", model: "gpt-5-codex", displayName: "GPT-5-Codex", isDefault: true }],
        }),
      ),
    );

    render(<HomePage />);

    await screen.findByText("Gateway connected");
    await screen.findByTestId("thread-link-thread-1");
    expect(screen.getByTestId("home-model-select")).toBeInTheDocument();
  });

  it("shows model catalog fallback message when model API fails", async () => {
    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/models", () => new HttpResponse(null, { status: 500 })),
    );

    render(<HomePage />);

    await screen.findByText(/Model catalog unavailable/);
  });

  it("submits composer via Enter and routes to the new thread", async () => {
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/models", () =>
        HttpResponse.json({ data: [{ id: "gpt-5-codex", model: "gpt-5-codex", isDefault: true }] }),
      ),
      http.post("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ threadId: "thread-new" })),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-1" });
      }),
    );

    render(<HomePage />);

    const textarea = await screen.findByPlaceholderText("Ask Codex anything, @ to add files, / for commands");
    fireEvent.change(textarea, { target: { value: "Build tests" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/threads/thread-new");
    });
    expect(turnCalls).toHaveLength(1);
  });

  it("supports /plan slash command with initial plan turn", async () => {
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/models", () =>
        HttpResponse.json({ data: [{ id: "gpt-5-codex", model: "gpt-5-codex", isDefault: true }] }),
      ),
      http.post("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ threadId: "thread-plan" })),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-1" });
      }),
    );

    render(<HomePage />);

    const textarea = await screen.findByPlaceholderText("Ask Codex anything, @ to add files, / for commands");
    fireEvent.change(textarea, { target: { value: "/plan draft roadmap" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/threads/thread-plan?mode=plan");
    });
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "draft roadmap" }],
      options: { collaborationMode: "plan" },
    });
  });

  it("supports /review and /status slash commands", async () => {
    let reviewCalls = 0;
    let turnCalls = 0;

    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/models", () =>
        HttpResponse.json({ data: [{ id: "gpt-5-codex", model: "gpt-5-codex", isDefault: true }] }),
      ),
      http.post("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ threadId: "thread-cmd" })),
      http.post("http://127.0.0.1:8787/api/threads/:id/review", async ({ request }) => {
        reviewCalls += 1;
        expect(await request.json()).toEqual({ instructions: "focus tests" });
        return HttpResponse.json({ turnId: "turn-r", reviewThreadId: "thread-cmd" });
      }),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", () => {
        turnCalls += 1;
        return HttpResponse.json({ turnId: "turn-1" });
      }),
    );

    render(<HomePage />);
    const textarea = await screen.findByPlaceholderText("Ask Codex anything, @ to add files, / for commands");

    fireEvent.change(textarea, { target: { value: "/review focus tests" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(reviewCalls).toBe(1);
      expect(pushMock).toHaveBeenLastCalledWith("/threads/thread-cmd");
    });
    expect(turnCalls).toBe(0);

    fireEvent.change(textarea, { target: { value: "/status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(pushMock).toHaveBeenLastCalledWith("/threads/thread-cmd?status=1");
    });

    fireEvent.change(textarea, { target: { value: "status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(pushMock).toHaveBeenLastCalledWith("/threads/thread-cmd?status=1");
    });
  });

  it("keeps unknown slash as plain text", async () => {
    const turnCalls: Array<unknown> = [];

    server.use(
      http.get("http://127.0.0.1:8787/health", () =>
        HttpResponse.json({ status: "ok", appServerConnected: true, timestamp: new Date().toISOString() }),
      ),
      http.get("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ data: [], nextCursor: null })),
      http.get("http://127.0.0.1:8787/api/models", () =>
        HttpResponse.json({ data: [{ id: "gpt-5-codex", model: "gpt-5-codex", isDefault: true }] }),
      ),
      http.post("http://127.0.0.1:8787/api/threads", () => HttpResponse.json({ threadId: "thread-u" })),
      http.post("http://127.0.0.1:8787/api/threads/:id/turns", async ({ request }) => {
        turnCalls.push(await request.json());
        return HttpResponse.json({ turnId: "turn-1" });
      }),
    );

    render(<HomePage />);
    const textarea = await screen.findByPlaceholderText("Ask Codex anything, @ to add files, / for commands");
    fireEvent.change(textarea, { target: { value: "/foo bar" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/threads/thread-u");
      expect(turnCalls).toHaveLength(1);
    });
    expect(turnCalls[0]).toMatchObject({
      input: [{ type: "text", text: "/foo bar" }],
    });
  });
});
