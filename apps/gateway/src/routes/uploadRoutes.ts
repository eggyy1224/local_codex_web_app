import type { FastifyInstance } from "fastify";
import type { UploadResponse } from "@lcwa/shared-types";
import {
  sniffImageKind,
  writeUploadFile,
  UploadError,
  type UploadEntryInternal,
} from "../uploads.js";

export type UploadRoutesOptions = {
  uploadRoot: string;
};

export function registerUploadRoutes(
  app: FastifyInstance,
  options: UploadRoutesOptions,
): void {
  const { uploadRoot } = options;

  app.post("/api/uploads", async (request): Promise<UploadResponse> => {
    if (!request.isMultipart()) {
      throw new UploadError(415, "expected multipart/form-data");
    }
    const entries: UploadEntryInternal[] = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") {
        continue;
      }
      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new UploadError(413, `file too large: ${part.filename ?? "upload"}`);
      }
      const kind = sniffImageKind(buffer.subarray(0, 12));
      if (!kind) {
        throw new UploadError(
          415,
          "only PNG, JPEG, and HEIC are supported",
        );
      }
      const entry = await writeUploadFile(
        uploadRoot,
        buffer,
        kind,
        part.filename ?? "upload",
      );
      entries.push(entry);
    }
    if (entries.length === 0) {
      throw new UploadError(400, "no files provided");
    }
    return { uploads: entries };
  });
}
