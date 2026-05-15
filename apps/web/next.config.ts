import type { NextConfig } from "next";

function hostnamesFromOrigins(value: string | undefined): string[] {
  const hostnames = new Set<string>();
  for (const item of value?.split(",") ?? []) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    try {
      hostnames.add(new URL(trimmed).hostname);
    } catch {
      hostnames.add(trimmed.replace(/:\d+$/, ""));
    }
  }
  return Array.from(hostnames);
}

const allowedDevOrigins = Array.from(
  new Set([
    ...hostnamesFromOrigins(process.env.CORS_ALLOWLIST),
    ...hostnamesFromOrigins(process.env.NEXT_PUBLIC_GATEWAY_URL),
    ...hostnamesFromOrigins(process.env.WEB_ORIGIN),
  ]),
);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  // Playwright spawns its own `next dev` while the user's live dev server is
  // also running; both default to `.next` and concurrent compiles corrupt
  // each other's chunks (500s on /threads/[id]). The e2e webServer sets
  // NEXT_DIST_DIR=.next-e2e so the two never share a build dir. Unset (the
  // normal dev/prod path) keeps the default `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ["@lcwa/shared-types"],
};

export default nextConfig;
