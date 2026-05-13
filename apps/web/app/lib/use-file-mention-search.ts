"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FuzzyFileMatch, FuzzyFileSearchResponse } from "@lcwa/shared-types";
import { resolveGatewayUrl } from "./gateway-url";

export type FileMentionTrigger = {
  query: string;
  start: number; // index of "@" in the prompt
};

const DEBOUNCE_MS = 150;
const MAX_RESULTS = 8;

export function detectFileMentionTrigger(prompt: string): FileMentionTrigger | null {
  if (!prompt) return null;
  const at = prompt.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : prompt[at - 1];
  if (before && !/\s/.test(before)) return null;
  const tail = prompt.slice(at + 1);
  if (/\s/.test(tail)) return null;
  return { query: tail, start: at };
}

export type UseFileMentionSearchResult = {
  trigger: FileMentionTrigger | null;
  results: FuzzyFileMatch[];
  isLoading: boolean;
};

export function useFileMentionSearch(
  prompt: string,
  cwd: string | null,
  dismissed: boolean,
): UseFileMentionSearchResult {
  const trigger = useMemo(() => (dismissed ? null : detectFileMentionTrigger(prompt)), [
    prompt,
    dismissed,
  ]);
  const [results, setResults] = useState<FuzzyFileMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastQueryRef = useRef<{ query: string; cwd: string | null } | null>(null);

  useEffect(() => {
    if (!trigger || !cwd) {
      setResults([]);
      setIsLoading(false);
      abortRef.current?.abort();
      abortRef.current = null;
      lastQueryRef.current = null;
      return;
    }
    const queryKey = { query: trigger.query, cwd };
    if (
      lastQueryRef.current &&
      lastQueryRef.current.query === queryKey.query &&
      lastQueryRef.current.cwd === queryKey.cwd
    ) {
      return;
    }
    lastQueryRef.current = queryKey;

    const handle = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Capture the query identity inside the fetch closure so a slow response
      // for a stale query can't write back over fresher state.
      const fetchKey = { query: queryKey.query, cwd: queryKey.cwd };
      setIsLoading(true);

      const params = new URLSearchParams({ roots: cwd, query: trigger.query });
      fetch(`${resolveGatewayUrl()}/api/files/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`file search http ${res.status}`);
          }
          return (await res.json()) as FuzzyFileSearchResponse;
        })
        .then((body) => {
          const current = lastQueryRef.current;
          if (!current || current.query !== fetchKey.query || current.cwd !== fetchKey.cwd) {
            return; // stale response, ignore
          }
          setResults((body.data ?? []).slice(0, MAX_RESULTS));
          setIsLoading(false);
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return;
          const current = lastQueryRef.current;
          if (!current || current.query !== fetchKey.query || current.cwd !== fetchKey.cwd) {
            return; // stale failure for a query we don't care about
          }
          setResults([]);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [trigger, cwd]);

  return { trigger, results, isLoading };
}

export function applyFileMention(prompt: string, trigger: FileMentionTrigger, path: string): string {
  const before = prompt.slice(0, trigger.start);
  return `${before}@${path} `;
}
