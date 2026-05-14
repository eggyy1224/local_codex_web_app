import type { UploadEntry, UploadResponse } from "@lcwa/shared-types";

export class UploadClientError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "UploadClientError";
  }
}

export async function uploadAttachments(
  gatewayUrl: string,
  files: File[],
): Promise<UploadEntry[]> {
  if (files.length === 0) {
    return [];
  }
  const form = new FormData();
  for (const file of files) {
    form.append("file", file, file.name);
  }
  const res = await fetch(`${gatewayUrl}/api/uploads`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // body wasn't JSON; keep statusText
    }
    throw new UploadClientError(res.status, detail || `upload failed (${res.status})`);
  }
  const json = (await res.json()) as UploadResponse;
  return json.uploads;
}
