import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAttachments, UploadClientError } from "../app/lib/upload-client";

const gateway = "http://gateway.test";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(response.json ?? {}), {
      status: response.ok ? 200 : (response.status ?? 500),
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("uploadAttachments", () => {
  it("returns [] without calling fetch for an empty file list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await uploadAttachments(gateway, []);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs multipart/form-data with all files under the same field name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          uploads: [
            {
              id: "a",
              path: "/tmp/a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              originalName: "a.png",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const file = new File(["x"], "a.png", { type: "image/png" });
    const result = await uploadAttachments(gateway, [file]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${gateway}/api/uploads`);
    expect((init as RequestInit).method).toBe("POST");
    const body = (init as RequestInit).body;
    expect(body instanceof FormData).toBe(true);
    const fileEntries = (body as FormData).getAll("file");
    expect(fileEntries).toHaveLength(1);
    expect(result[0]!.path).toBe("/tmp/a.png");
  });

  it("throws UploadClientError on 4xx and surfaces the server message", async () => {
    mockFetchOnce({
      ok: false,
      status: 415,
      statusText: "Unsupported Media Type",
      json: { message: "only PNG, JPEG, and HEIC are supported" },
    });

    const file = new File(["x"], "foo.txt", { type: "text/plain" });
    await expect(uploadAttachments(gateway, [file])).rejects.toMatchObject({
      statusCode: 415,
      message: "only PNG, JPEG, and HEIC are supported",
    });
  });

  it("throws UploadClientError on 413 oversized", async () => {
    mockFetchOnce({
      ok: false,
      status: 413,
      statusText: "Payload Too Large",
      json: { error: "file too large" },
    });
    const file = new File(["x"], "big.png", { type: "image/png" });
    try {
      await uploadAttachments(gateway, [file]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UploadClientError);
      expect((err as UploadClientError).statusCode).toBe(413);
    }
  });
});
