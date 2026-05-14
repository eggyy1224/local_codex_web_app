import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
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

const SERVE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function registerUploadRoutes(
  app: FastifyInstance,
  options: UploadRoutesOptions,
): void {
  const { uploadRoot } = options;
  const uploadRootAbs = path.resolve(uploadRoot);

  app.get<{ Params: { filename: string } }>(
    "/api/uploads/:filename",
    async (request, reply) => {
      const { filename } = request.params;
      if (
        !filename ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..")
      ) {
        throw new UploadError(400, "invalid filename");
      }
      const resolved = path.resolve(path.join(uploadRootAbs, filename));
      if (
        resolved !== uploadRootAbs &&
        !resolved.startsWith(uploadRootAbs + path.sep)
      ) {
        throw new UploadError(400, "invalid filename");
      }
      if (!existsSync(resolved)) {
        return reply.code(404).send({ error: "not found" });
      }
      const ext = path.extname(filename).toLowerCase();
      const mime = SERVE_MIME_BY_EXT[ext] ?? "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header("Cache-Control", "private, max-age=86400");
      return reply.send(createReadStream(resolved));
    },
  );

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
