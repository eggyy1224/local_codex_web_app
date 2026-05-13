import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useFileMentionSearch } from "../app/lib/use-file-mention-search";

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchOnce(payload: unknown, status = 200): FetchMock {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    root: "/tmp/project",
    path: `src/file-${i}.ts`,
    fileName: `file-${i}.ts`,
    score: 1 - i * 0.01,
    matchType: "filename",
    indices: [],
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("useFileMentionSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null trigger and empty results when prompt has no @ token", async () => {
    const fetchMock = mockFetchOnce({ data: [] });
    const { result } = renderHook(() => useFileMentionSearch("hello world", "/tmp/project", false));
    expect(result.current.trigger).toBeNull();
    expect(result.current.results).toEqual([]);
    await sleep(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null trigger when dismissed even if prompt has @", async () => {
    const fetchMock = mockFetchOnce({ data: [] });
    const { result } = renderHook(() =>
      useFileMentionSearch("read @Mob", "/tmp/project", true),
    );
    expect(result.current.trigger).toBeNull();
    await sleep(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null trigger when cwd is null (no project to search)", async () => {
    const fetchMock = mockFetchOnce({ data: [] });
    const { result } = renderHook(() => useFileMentionSearch("@Mob", null, false));
    expect(result.current.trigger).toEqual({ query: "Mob", start: 0 });
    await sleep(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it("debounces 150ms then fetches and exposes up to MAX_RESULTS (8) entries", async () => {
    const fetchMock = mockFetchOnce({ data: makeResults(12) });
    const { result } = renderHook(() => useFileMentionSearch("read @Mob", "/tmp/project", false));

    expect(fetchMock).not.toHaveBeenCalled();
    // Before debounce fires — still no fetch.
    await sleep(120);
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 1000 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/files/search?");
    expect(url).toContain("roots=%2Ftmp%2Fproject");
    expect(url).toContain("query=Mob");

    await waitFor(() => expect(result.current.results).toHaveLength(8));
    expect(result.current.isLoading).toBe(false);
  });

  it("ignores a stale response if the query has moved on", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    const firstResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(
      (resolve) => {
        resolveFirst = () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ data: makeResults(2) }),
          });
      },
    );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: makeResults(3) }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ prompt }: { prompt: string }) =>
        useFileMentionSearch(prompt, "/tmp/project", false),
      { initialProps: { prompt: "@aa" } },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 1000 });

    rerender({ prompt: "@bb" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });

    // Release the stale first response. Its data must not overwrite fresh state.
    resolveFirst?.({ ok: true });
    await waitFor(() => expect(result.current.results).toHaveLength(3));
  });

  it("clears results when the trigger is removed (e.g. the user types a space)", async () => {
    const fetchMock = mockFetchOnce({ data: makeResults(4) });
    const { result, rerender } = renderHook(
      ({ prompt }: { prompt: string }) =>
        useFileMentionSearch(prompt, "/tmp/project", false),
      { initialProps: { prompt: "@Mob" } },
    );

    await waitFor(() => expect(result.current.results).toHaveLength(4));

    rerender({ prompt: "@Mob done" }); // space after kills the trigger
    expect(result.current.trigger).toBeNull();
    expect(result.current.results).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recovers from an HTTP error by emptying results and clearing isLoading", async () => {
    mockFetchOnce({ data: [] }, 500);
    const { result } = renderHook(() => useFileMentionSearch("@Mob", "/tmp/project", false));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 1000 });
    // First the loading turns on (debounce fired, fetch sent), then off when the
    // 500 lands; results stay empty.
    expect(result.current.results).toEqual([]);
  });
});
