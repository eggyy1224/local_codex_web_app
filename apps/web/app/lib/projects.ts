import type { ThreadListItem } from "@lcwa/shared-types";

export type ProjectGroup = {
  key: string;
  label: string;
  threads: ThreadListItem[];
  latestMs: number;
};

function parseLatestMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function projectLabelFromKey(key: string): string {
  if (!key || key === "unknown") {
    return "Unassigned";
  }
  const normalized = key.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function groupThreadsByProject(threads: ThreadListItem[]): ProjectGroup[] {
  const byKey = new Map<string, ProjectGroup>();

  for (const thread of threads) {
    const key = thread.projectKey || "unknown";
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        label: projectLabelFromKey(key),
        threads: [thread],
        latestMs: parseLatestMs(thread.lastActiveAt),
      });
      continue;
    }
    existing.threads.push(thread);
    existing.latestMs = Math.max(existing.latestMs, parseLatestMs(thread.lastActiveAt));
  }

  const groups = Array.from(byKey.values());
  for (const group of groups) {
    group.threads.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  groups.sort((a, b) => {
    if (a.key === "unknown" && b.key !== "unknown") {
      return 1;
    }
    if (b.key === "unknown" && a.key !== "unknown") {
      return -1;
    }
    return b.latestMs - a.latestMs;
  });

  return groups;
}

export function pickDefaultProjectKey(groups: ProjectGroup[]): string {
  if (groups.length === 0) {
    return "unknown";
  }
  const preferred = groups.find((group) => group.key !== "unknown");
  return preferred?.key ?? groups[0].key;
}
