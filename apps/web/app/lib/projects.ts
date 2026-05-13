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

function projectKeyParts(key: string): string[] {
  return key
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

export function projectLabelFromKey(key: string): string {
  if (!key || key === "unknown") {
    return "Unassigned";
  }
  const parts = projectKeyParts(key);
  return parts[parts.length - 1] ?? key;
}

function disambiguateGroupLabels(groups: ProjectGroup[]): void {
  // When two project keys share the same trailing segment (e.g. a worktree of
  // a repo carrying the same folder name), tack on the next parent segment(s)
  // until each label is unique. Reads "name (·parent)" so the user can still
  // tell which is which.
  const byLabel = new Map<string, ProjectGroup[]>();
  for (const group of groups) {
    const list = byLabel.get(group.label) ?? [];
    list.push(group);
    byLabel.set(group.label, list);
  }
  for (const list of byLabel.values()) {
    if (list.length <= 1) continue;
    const partsByGroup = list.map((group) => projectKeyParts(group.key));
    let depth = 1;
    while (depth < 8) {
      const candidates = list.map((group, idx) => {
        const parts = partsByGroup[idx];
        const slice = parts.slice(Math.max(0, parts.length - 1 - depth), parts.length);
        return slice.join("/");
      });
      if (new Set(candidates).size === candidates.length) {
        for (let i = 0; i < list.length; i += 1) {
          list[i].label = candidates[i];
        }
        break;
      }
      depth += 1;
    }
  }
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

  disambiguateGroupLabels(groups);

  return groups;
}

export function pickDefaultProjectKey(groups: ProjectGroup[]): string {
  if (groups.length === 0) {
    return "unknown";
  }
  const preferred = groups.find((group) => group.key !== "unknown");
  return preferred?.key ?? groups[0].key;
}
