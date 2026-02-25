#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";

const gatewayPort = process.env.PORT ?? "8787";
const webPort = process.env.WEB_PORT ?? "3000";

function isPrivateIpv4(address) {
  if (address.startsWith("10.")) {
    return true;
  }
  if (address.startsWith("192.168.")) {
    return true;
  }
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (!match) {
    return false;
  }
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function isTailscaleIpv4(address) {
  return address.startsWith("100.");
}

function collectReachableIpv4() {
  const values = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const item of entries ?? []) {
      if (item.family !== "IPv4" || item.internal) {
        continue;
      }
      values.push(item.address);
    }
  }
  return Array.from(new Set(values));
}

function pickPreferredHost(ipv4List) {
  const explicit = process.env.LCWA_PUBLIC_HOST?.trim();
  if (explicit) {
    return explicit;
  }
  const tailscale = ipv4List.find((ip) => isTailscaleIpv4(ip));
  if (tailscale) {
    return tailscale;
  }
  const privateIp = ipv4List.find((ip) => isPrivateIpv4(ip));
  if (privateIp) {
    return privateIp;
  }
  return "127.0.0.1";
}

function buildCorsAllowlist(ipv4List) {
  const origins = new Set([
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ]);
  for (const ip of ipv4List) {
    origins.add(`http://${ip}:${webPort}`);
  }
  return Array.from(origins).join(",");
}

const ipv4List = collectReachableIpv4();
const preferredHost = pickPreferredHost(ipv4List);
const env = { ...process.env };

env.HOST = env.HOST ?? "0.0.0.0";
env.PORT = env.PORT ?? gatewayPort;
env.CORS_ALLOWLIST = env.CORS_ALLOWLIST ?? buildCorsAllowlist(ipv4List);
env.NEXT_PUBLIC_GATEWAY_URL =
  env.NEXT_PUBLIC_GATEWAY_URL ?? `http://${preferredHost}:${gatewayPort}`;

if (env.LCWA_DEV_DRY_RUN === "1") {
  console.log("HOST=", env.HOST);
  console.log("PORT=", env.PORT);
  console.log("NEXT_PUBLIC_GATEWAY_URL=", env.NEXT_PUBLIC_GATEWAY_URL);
  console.log("CORS_ALLOWLIST=", env.CORS_ALLOWLIST);
  process.exit(0);
}

const child = spawn("pnpm", ["-r", "--parallel", "--stream", "--no-bail", "dev"], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
