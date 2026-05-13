const FALLBACK_GATEWAY_URL = "http://127.0.0.1:8795";

export const DEFAULT_GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? FALLBACK_GATEWAY_URL;
export const GATEWAY_URL_STORAGE_KEY = "lcwa.gatewayUrl.v1";

function parseUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function formatHostnameForUrl(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function gatewayPortFromDefault(defaultGatewayUrl: string): string {
  const defaultUrl = parseUrl(defaultGatewayUrl) ?? parseUrl(FALLBACK_GATEWAY_URL);
  return defaultUrl?.port ?? "";
}

function gatewayUrlFromPage(pageUrl: URL | null, gatewayPort: string): string | null {
  if (!pageUrl || !["http:", "https:"].includes(pageUrl.protocol)) {
    return null;
  }
  if (isLocalHostname(pageUrl.hostname)) {
    return null;
  }
  const port = gatewayPort ? `:${gatewayPort}` : "";
  return `${pageUrl.protocol}//${formatHostnameForUrl(pageUrl.hostname)}${port}`;
}

function shouldUseStoredOverride(
  overrideUrl: URL | null,
  pageUrl: URL | null,
  gatewayPort: string,
): boolean {
  if (!overrideUrl) {
    return false;
  }
  if (!pageUrl || isLocalHostname(pageUrl.hostname)) {
    return true;
  }
  return (
    normalizeHostname(overrideUrl.hostname) === normalizeHostname(pageUrl.hostname) &&
    overrideUrl.port === gatewayPort
  );
}

export function resolveGatewayUrlForPage(
  defaultGatewayUrl: string,
  pageHref: string | null,
  storedOverride: string | null,
): string {
  const pageUrl = parseUrl(pageHref);
  const overrideUrl = parseUrl(storedOverride);
  const gatewayPort = gatewayPortFromDefault(defaultGatewayUrl);
  if (overrideUrl && shouldUseStoredOverride(overrideUrl, pageUrl, gatewayPort)) {
    return overrideUrl.href.replace(/\/$/, "");
  }
  return gatewayUrlFromPage(pageUrl, gatewayPort) ?? defaultGatewayUrl;
}

export function resolveGatewayUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_GATEWAY_URL;
  }

  try {
    const override = window.localStorage.getItem(GATEWAY_URL_STORAGE_KEY)?.trim();
    return resolveGatewayUrlForPage(DEFAULT_GATEWAY_URL, window.location.href, override ?? null);
  } catch {
    return resolveGatewayUrlForPage(DEFAULT_GATEWAY_URL, window.location.href, null);
  }
}
