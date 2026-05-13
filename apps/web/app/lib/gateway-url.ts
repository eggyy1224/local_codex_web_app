export const DEFAULT_GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:8795";
export const GATEWAY_URL_STORAGE_KEY = "lcwa.gatewayUrl.v1";

export function resolveGatewayUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_GATEWAY_URL;
  }

  try {
    const override = window.localStorage.getItem(GATEWAY_URL_STORAGE_KEY)?.trim();
    return override || DEFAULT_GATEWAY_URL;
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}
