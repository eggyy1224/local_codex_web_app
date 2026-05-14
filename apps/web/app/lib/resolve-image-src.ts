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
