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
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ["@lcwa/shared-types"],
};

export default nextConfig;
