import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGatewayConfig } from "../app/lib/use-gateway-config";

type FetchResponseInit = {
  ok?: boolean;
  status?: number;
  payload?: unknown;
};

function fakeResponse({ ok = true, status = 200, payload }: FetchResponseInit) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

describe("useGatewayConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches /api/config on mount and exposes the snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({
        payload: {
          config: { serviceTier: "fast", model: "gpt-5.5", reasoningEffort: "medium" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());

    await waitFor(() => expect(result.current.config).not.toBeNull());
    expect(result.current.config).toEqual({
      serviceTier: "fast",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/config$/);
  });

  it("surfaces the error message and leaves config null when /api/config fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse({ ok: false, status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("500");
    expect(result.current.config).toBeNull();
  });

  it("writeValue posts the payload, returns the body, and refreshes the snapshot", async () => {
    const fetchMock = vi
      .fn()
      // initial mount read
      .mockResolvedValueOnce(
        fakeResponse({
          payload: {
            config: { serviceTier: null, model: null, reasoningEffort: null },
          },
        }),
      )
      // write
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { status: "ok", filePath: "/tmp/cfg.json", version: "v2" },
        }),
      )
      // refresh after write
      .mockResolvedValueOnce(
        fakeResponse({
          payload: {
            config: { serviceTier: "fast", model: null, reasoningEffort: null },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());
    await waitFor(() => expect(result.current.config?.serviceTier).toBeNull());

    let body: Awaited<ReturnType<typeof result.current.writeValue>> = null;
    await act(async () => {
      body = await result.current.writeValue({
        keyPath: "service_tier",
        value: "fast",
        mergeStrategy: "replace",
      });
    });

    expect(body).toEqual({ status: "ok", filePath: "/tmp/cfg.json", version: "v2" });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();

    // Refresh ran after the successful write — serviceTier should reflect the
    // post-write read.
    await waitFor(() => expect(result.current.config?.serviceTier).toBe("fast"));

    // 1 mount + 1 write + 1 post-write refresh
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const writeUrl = fetchMock.mock.calls[1]![0] as string;
    expect(writeUrl).toMatch(/\/api\/config\/value$/);
    const writeInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(writeInit.method).toBe("POST");
    expect(writeInit.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(writeInit.body as string)).toEqual({
      keyPath: "service_tier",
      value: "fast",
      mergeStrategy: "replace",
    });
  });

  it("writeValue transitions to status=writing during the request", async () => {
    let resolveWrite: ((value: unknown) => void) | null = null;
    const writePromise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(
      (resolve) => {
        resolveWrite = () =>
          resolve(fakeResponse({ payload: { status: "ok", filePath: null, version: null } }));
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { config: { serviceTier: null, model: null, reasoningEffort: null } },
        }),
      )
      .mockImplementationOnce(() => writePromise)
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { config: { serviceTier: "fast", model: null, reasoningEffort: null } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    let writePromiseHandle: Promise<unknown> | null = null;
    act(() => {
      writePromiseHandle = result.current.writeValue({
        keyPath: "service_tier",
        value: "fast",
      });
    });

    // The microtask sequencing: writeValue first runs setStatus("writing")
    // synchronously inside act(), so by the next tick the status reflects that.
    await waitFor(() => expect(result.current.status).toBe("writing"));

    await act(async () => {
      resolveWrite?.({ ok: true });
      await writePromiseHandle;
    });

    expect(result.current.status).toBe("idle");
  });

  it("writeValue records error + status='error' on HTTP failure and returns null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { config: { serviceTier: null, model: null, reasoningEffort: null } },
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    let outcome: Awaited<ReturnType<typeof result.current.writeValue>> = undefined as never;
    await act(async () => {
      outcome = await result.current.writeValue({
        keyPath: "service_tier",
        value: "bogus" as never,
      });
    });

    expect(outcome).toBeNull();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("422");
    // Failure path does NOT refresh — only mount + write fired.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refresh() can be called manually to re-fetch the snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { config: { serviceTier: "fast", model: null, reasoningEffort: null } },
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          payload: { config: { serviceTier: null, model: null, reasoningEffort: null } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGatewayConfig());
    await waitFor(() => expect(result.current.config?.serviceTier).toBe("fast"));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.config?.serviceTier).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
