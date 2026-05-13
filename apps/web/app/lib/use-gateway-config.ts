"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  GatewayConfigResponse,
  GatewayConfigSnapshot,
  GatewayConfigValueWriteRequest,
  GatewayConfigValueWriteResponse,
} from "@lcwa/shared-types";
import { resolveGatewayUrl } from "./gateway-url";

type WriteStatus = "idle" | "writing" | "error";

export type UseGatewayConfigResult = {
  config: GatewayConfigSnapshot | null;
  status: WriteStatus;
  error: string | null;
  refresh: () => Promise<void>;
  writeValue: (input: GatewayConfigValueWriteRequest) => Promise<GatewayConfigValueWriteResponse | null>;
};

export function useGatewayConfig(): UseGatewayConfigResult {
  const [config, setConfig] = useState<GatewayConfigSnapshot | null>(null);
  const [status, setStatus] = useState<WriteStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${resolveGatewayUrl()}/api/config`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`config read failed: ${res.status}`);
      }
      const body = (await res.json()) as GatewayConfigResponse;
      setConfig(body.config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const writeValue = useCallback(
    async (input: GatewayConfigValueWriteRequest) => {
      setStatus("writing");
      try {
        const res = await fetch(`${resolveGatewayUrl()}/api/config/value`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          throw new Error(`config write failed: ${res.status}`);
        }
        const body = (await res.json()) as GatewayConfigValueWriteResponse;
        setStatus("idle");
        setError(null);
        await refresh();
        return body;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        return null;
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { config, status, error, refresh, writeValue };
}
