/**
 * Turn whatever the gateway/timeline gave us into a string the browser can
 * actually fetch. Inputs:
 *   - `data:image/...` → returned as-is (model-side base64 images)
 *   - `http://...` / `https://` → returned as-is
 *   - `/api/uploads/foo.jpg` → prefixed with the gateway base URL so the
 *     <img> works from any origin (e.g. Tailscale)
 *
 * Anything else falls back to the raw value, which will almost certainly fail
 * to load but at least won't be silently dropped.
 */
export function resolveImageSrc(src: string, gatewayUrl: string): string {
  if (!src) return src;
  if (src.startsWith("data:") || /^https?:\/\//i.test(src)) {
    return src;
  }
  if (src.startsWith("/")) {
    return `${gatewayUrl.replace(/\/$/, "")}${src}`;
  }
  return src;
}

/**
 * Variant for markdown image renderers: when assistant output emits
 * `![alt](/Volumes/.../photo.jpg)` with a **local filesystem path**, route it
 * through the gateway's /api/files/preview endpoint so the browser can fetch
 * it. Other shapes (data:, http(s):, /api/uploads/...) fall back to
 * resolveImageSrc.
 *
 * Heuristic for "local filesystem path": starts with "/" AND is not already
 * an API path (/api/...). Windows-style "C:\foo" is also rewritten via the
 * encoded path on the off-chance Codex runs on Windows down the line.
 */
function tryDecodeUri(value: string): string {
  // react-markdown forwards image `src` verbatim, so paths with non-ASCII
  // characters (Chinese, spaces, etc.) come through already percent-encoded
  // by whoever wrote the markdown. If we hand that straight to
  // `encodeURIComponent`, the gateway sees doubly-encoded text and `fs.read`
  // fails because the filesystem path uses the original characters. Decode
  // first; if the input has no encoding, decode is a no-op.
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveMarkdownImageSrc(src: string, gatewayUrl: string): string {
  if (!src) return src;
  if (src.startsWith("data:") || /^https?:\/\//i.test(src)) {
    return src;
  }
  if (src.startsWith("/api/")) {
    return resolveImageSrc(src, gatewayUrl);
  }
  const isUnixAbs = src.startsWith("/");
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(src);
  if (isUnixAbs || isWindowsAbs) {
    const base = gatewayUrl.replace(/\/$/, "");
    const decoded = tryDecodeUri(src);
    return `${base}/api/files/preview?path=${encodeURIComponent(decoded)}`;
  }
  return src;
}
