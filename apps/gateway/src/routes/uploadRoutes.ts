import { createReadStream, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
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
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_SNIFF = [
  // PNG: 89 50 4E 47
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  // JPEG: FF D8 FF
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  // GIF87a / GIF89a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mime: "image/gif" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mime: "image/gif" },
] as const;

function sniffMimeFromHead(head: Buffer): string | null {
  for (const candidate of IMAGE_SNIFF) {
    if (head.length < candidate.bytes.length) continue;
    let match = true;
    for (let i = 0; i < candidate.bytes.length; i += 1) {
      if (head[i] !== candidate.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return candidate.mime;
  }
  // WEBP: "RIFF...WEBP" at byte 8..12
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function registerUploadRoutes(
  app: FastifyInstance,
  options: UploadRoutesOptions,
): void {
  const { uploadRoot } = options;
  const uploadRootAbs = path.resolve(uploadRoot);

  // Serve an arbitrary local image file referenced by Codex assistant output.
  // Codex often emits markdown like `![alt](/Volumes/.../photo.jpg)`; the
  // browser can't load that directly, so the markdown img renderer rewrites
  // such srcs to `/api/files/preview?path=<abs>` and we serve here. Designed
  // for the single-user local app threat model ([[project_single_user_personal_app]]);
  // guarded by: absolute path, regular file only, image magic-byte sniff,
  // PREVIEW_MAX_BYTES cap.
  app.get<{ Querystring: { path?: string } }>(
    "/api/files/preview",
    async (request, reply) => {
      const target = (request.query?.path ?? "").trim();
      if (!target) {
        throw new UploadError(400, "missing path");
      }
      if (target.includes("\0")) {
        throw new UploadError(400, "invalid path");
      }
      if (!path.isAbsolute(target)) {
        throw new UploadError(400, "path must be absolute");
      }
      const resolved = path.resolve(target);
      let stats;
      try {
        stats = statSync(resolved);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!stats.isFile()) {
        throw new UploadError(400, "not a regular file");
      }
      if (stats.size > PREVIEW_MAX_BYTES) {
        throw new UploadError(413, "file too large for preview");
      }
      let head: Buffer;
      const handle = await open(resolved, "r");
      try {
        const buf = Buffer.alloc(12);
        const { bytesRead } = await handle.read(buf, 0, 12, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const mime = sniffMimeFromHead(head);
      if (!mime) {
        throw new UploadError(415, "not a recognized image format");
      }
      reply
        .header("Content-Type", mime)
        .header("Cache-Control", "private, max-age=300");
      return reply.send(createReadStream(resolved));
    },
  );

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
