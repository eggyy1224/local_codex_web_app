import { execFile as execFileCb } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type ImageKind = "png" | "jpeg" | "heic";

export type UploadEntryInternal = {
  id: string;
  path: string;
  mimeType: "image/png" | "image/jpeg";
  sizeBytes: number;
  originalName: string;
};

export class UploadError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "UploadError";
  }
}

/**
 * Reject a CreateTurnRequest / steer input that smuggles `localImage` items
 * pointing outside the gateway's upload root. The browser composer normally
 * fills these paths from the upload response, so any same-origin client that
 * synthesises a path on its own (e.g. `/etc/passwd` rendered as an image,
 * exfiltrating its bytes through the model) is treated as malicious.
 *
 * The security model only assumes the user trusts every CORS-allowlisted
 * origin; it does NOT assume those origins trust each other, so this check
 * is the boundary that keeps a misbehaving allowlisted page from reading
 * arbitrary local files through codex's vision pipeline.
 */
export function assertLocalImagePathsInsideRoot(
  input: ReadonlyArray<{ type: string; path?: unknown }>,
  uploadRoot: string,
): void {
  const normalizedRoot = path.resolve(uploadRoot);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  for (const item of input) {
    if (item.type !== "localImage") {
      continue;
    }
    const rawPath = typeof item.path === "string" ? item.path : null;
    if (!rawPath) {
      const err = new UploadError(400, "localImage.path is required");
      throw err;
    }
    const resolved = path.resolve(rawPath);
    if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
      throw new UploadError(
        400,
        `localImage.path must live inside the upload root (${normalizedRoot})`,
      );
    }
  }
}

export function resolveUploadRoot(
  options: { explicit?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  const explicit = options.explicit ?? env.LCWA_UPLOAD_ROOT;
  const root = explicit
    ? path.resolve(explicit)
    : path.join(
        env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), ".codex", "sessions"),
        "uploads",
      );
  mkdirSync(root, { recursive: true });
  return root;
}

export function sniffImageKind(head: Buffer): ImageKind | null {
  if (head.length < 12) {
    return null;
  }
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return "png";
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "jpeg";
  }
  if (
    head[4] === 0x66 &&
    head[5] === 0x74 &&
    head[6] === 0x79 &&
    head[7] === 0x70
  ) {
    const brand = head.subarray(8, 12).toString("ascii");
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "mif1" ||
      brand === "heis" ||
      brand === "hevc" ||
      brand === "msf1" ||
      brand === "heim"
    ) {
      return "heic";
    }
  }
  return null;
}

export async function transcodeHeicToJpeg(srcPath: string, outPath: string): Promise<void> {
  try {
    await execFile(
      "/usr/bin/sips",
      ["-s", "format", "jpeg", "-s", "formatOptions", "high", srcPath, "--out", outPath],
      { timeout: 5000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UploadError(500, `HEIC transcode failed: ${message}`);
  }
}

export async function writeUploadFile(
  uploadRoot: string,
  buffer: Buffer,
  kind: ImageKind,
  originalName: string,
): Promise<UploadEntryInternal> {
  const id = randomUUID();
  if (kind === "heic") {
    const heicPath = path.join(uploadRoot, `${id}.heic`);
    const jpegPath = path.join(uploadRoot, `${id}.jpg`);
    await writeFile(heicPath, buffer);
    try {
      await transcodeHeicToJpeg(heicPath, jpegPath);
    } finally {
      await unlink(heicPath).catch(() => {});
    }
    const stats = await stat(jpegPath);
    return {
      id,
      path: jpegPath,
      mimeType: "image/jpeg",
      sizeBytes: stats.size,
      originalName,
    };
  }
  const ext = kind === "png" ? "png" : "jpg";
  const filePath = path.join(uploadRoot, `${id}.${ext}`);
  await writeFile(filePath, buffer);
  return {
    id,
    path: filePath,
    mimeType: kind === "png" ? "image/png" : "image/jpeg",
    sizeBytes: buffer.byteLength,
    originalName,
  };
}
