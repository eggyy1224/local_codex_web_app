import type { ThreadStatus } from "@lcwa/shared-types";

// Shared shape used by the mobile drawer AND the desktop sidebar so the
// status / filter / search logic stays in lockstep across both surfaces.
export type ThreadSwitcherItem = {
  id: string;
  title: string;
  lastActiveAt: string;
  isActive: boolean;
  status: ThreadStatus;
  waitingApprovalCount: number;
  errorCount: number;
};

export type ThreadSwitcherGroup = {
  key: string;
  label: string;
  items: ThreadSwitcherItem[];
};

export type ThreadSwitcherFilter = "all" | "running" | "waiting" | "error";

export const THREAD_SWITCHER_FILTERS: Array<{
  value: ThreadSwitcherFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "error", label: "Error" },
];

export type ThreadStatusBadge = {
  kind: "running" | "waiting" | "error" | "idle";
  label: string;
};

// Priority rules — mirrored exactly in the original mobile drawer:
//   waitingApproval > status=active (running) > systemError | errorCount > idle
// "Pending wins over running" because a paused-for-approval thread surfaces
// an action item the reader of the switcher should act on first.
export function badgeForThreadItem(item: ThreadSwitcherItem): ThreadStatusBadge {
  if (item.waitingApprovalCount > 0) {
    return {
      kind: "waiting",
      label: item.waitingApprovalCount === 1 ? "1 pending" : `${item.waitingApprovalCount} pending`,
    };
  }
  if (item.status === "active") {
    return { kind: "running", label: "Running" };
  }
  if (item.status === "systemError" || item.errorCount > 0) {
    return { kind: "error", label: "Error" };
  }
  return { kind: "idle", label: "Idle" };
}

function itemMatchesFilter(
  item: ThreadSwitcherItem,
  filter: ThreadSwitcherFilter,
): boolean {
  if (filter === "all") return true;
  const badge = badgeForThreadItem(item);
  return badge.kind === filter;
}

function itemMatchesSearch(item: ThreadSwitcherItem, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return item.title.toLowerCase().includes(normalizedQuery);
}

export function filterThreadSwitcherGroups(
  groups: ThreadSwitcherGroup[],
  filter: ThreadSwitcherFilter,
  query: string,
): ThreadSwitcherGroup[] {
  const normalized = query.trim().toLowerCase();
  return groups.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => itemMatchesFilter(item, filter) && itemMatchesSearch(item, normalized),
    ),
  }));
}

export function emptyStateMessage(
  groups: ThreadSwitcherGroup[],
  filter: ThreadSwitcherFilter,
  query: string,
): string {
  const hasAny = groups.some((group) => group.items.length > 0);
  if (!hasAny) {
    return "No threads yet.";
  }
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    return `No matches for "${trimmed}".`;
  }
  if (filter === "running") return "No running threads.";
  if (filter === "waiting") return "No waiting threads.";
  if (filter === "error") return "No threads with errors.";
  return "No threads match the current filters.";
}
