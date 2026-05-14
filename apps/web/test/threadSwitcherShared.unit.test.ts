import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@lcwa/shared-types";
import {
  badgeForThreadItem,
  emptyStateMessage,
  filterThreadSwitcherGroups,
  type ThreadSwitcherGroup,
  type ThreadSwitcherItem,
} from "../app/threads/[id]/thread-switcher-shared";

function item(
  partial: Partial<ThreadSwitcherItem> & Pick<ThreadSwitcherItem, "id">,
): ThreadSwitcherItem {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    lastActiveAt: partial.lastActiveAt ?? "2026-01-01T00:00:00.000Z",
    isActive: partial.isActive ?? false,
    status: partial.status ?? ("idle" as ThreadStatus),
    waitingApprovalCount: partial.waitingApprovalCount ?? 0,
    errorCount: partial.errorCount ?? 0,
  };
}

function group(
  key: string,
  label: string,
  items: ThreadSwitcherItem[],
): ThreadSwitcherGroup {
  return { key, label, items };
}

describe("badgeForThreadItem priority (shared)", () => {
  it("waitingApproval > running > error > idle", () => {
    // Pending wins over running so a paused-for-approval thread doesn't get
    // hidden behind a "Running" pill — the user is the blocker here.
    expect(
      badgeForThreadItem(item({ id: "a", status: "active", waitingApprovalCount: 1 }))
        .kind,
    ).toBe("waiting");
    expect(badgeForThreadItem(item({ id: "a", status: "active" })).kind).toBe("running");
    expect(badgeForThreadItem(item({ id: "a", status: "systemError" })).kind).toBe(
      "error",
    );
    expect(badgeForThreadItem(item({ id: "a", errorCount: 2 })).kind).toBe("error");
    expect(badgeForThreadItem(item({ id: "a" })).kind).toBe("idle");
  });

  it("singular vs plural pending labels", () => {
    expect(
      badgeForThreadItem(item({ id: "a", waitingApprovalCount: 1 })).label,
    ).toBe("1 pending");
    expect(
      badgeForThreadItem(item({ id: "a", waitingApprovalCount: 4 })).label,
    ).toBe("4 pending");
  });
});

describe("filterThreadSwitcherGroups (shared)", () => {
  const groups: ThreadSwitcherGroup[] = [
    group("/repos/alpha", "alpha", [
      item({ id: "a1", title: "Alpha running", status: "active" }),
      item({ id: "a2", title: "Alpha idle" }),
    ]),
    group("/repos/beta", "beta", [
      item({ id: "b1", title: "Beta waiting", waitingApprovalCount: 2 }),
      item({ id: "b2", title: "Beta broken", status: "systemError" }),
    ]),
  ];

  it("filter=running keeps only active threads", () => {
    const filtered = filterThreadSwitcherGroups(groups, "running", "");
    expect(filtered.flatMap((g) => g.items.map((i) => i.id))).toEqual(["a1"]);
  });

  it("filter=waiting beats running when a thread is both", () => {
    const both: ThreadSwitcherGroup[] = [
      group("/repos/alpha", "alpha", [
        item({ id: "a1", status: "active", waitingApprovalCount: 1 }),
        item({ id: "a2", status: "active" }),
      ]),
    ];
    expect(
      filterThreadSwitcherGroups(both, "waiting", "")[0].items.map((i) => i.id),
    ).toEqual(["a1"]);
  });

  it("filter=error catches systemError and errorCount>0", () => {
    const errs: ThreadSwitcherGroup[] = [
      group("/repos/alpha", "alpha", [
        item({ id: "a1", status: "systemError" }),
        item({ id: "a2", errorCount: 3 }),
        item({ id: "a3" }),
      ]),
    ];
    expect(
      filterThreadSwitcherGroups(errs, "error", "")[0].items.map((i) => i.id),
    ).toEqual(["a1", "a2"]);
  });

  it("search is case-insensitive substring match on title", () => {
    const filtered = filterThreadSwitcherGroups(groups, "all", "WAITING");
    expect(filtered.flatMap((g) => g.items.map((i) => i.id))).toEqual(["b1"]);
  });

  it("filter and search compose (filter then search)", () => {
    const filtered = filterThreadSwitcherGroups(groups, "running", "broken");
    expect(filtered.flatMap((g) => g.items.map((i) => i.id))).toEqual([]);
  });
});

describe("emptyStateMessage (shared)", () => {
  it("returns 'No threads yet.' when there are no items at all", () => {
    expect(emptyStateMessage([], "all", "")).toBe("No threads yet.");
    expect(
      emptyStateMessage([group("k", "label", [])], "running", ""),
    ).toBe("No threads yet.");
  });

  it("returns 'No matches for ...' when a query is set and groups exist", () => {
    const groups = [
      group("/repos/alpha", "alpha", [item({ id: "a1", title: "foo" })]),
    ];
    expect(emptyStateMessage(groups, "all", "xyz")).toBe('No matches for "xyz".');
  });

  it("filter-specific empty messages", () => {
    const groups = [
      group("/repos/alpha", "alpha", [item({ id: "a1", title: "foo" })]),
    ];
    expect(emptyStateMessage(groups, "running", "")).toBe("No running threads.");
    expect(emptyStateMessage(groups, "waiting", "")).toBe("No waiting threads.");
    expect(emptyStateMessage(groups, "error", "")).toBe("No threads with errors.");
    expect(emptyStateMessage(groups, "all", "")).toBe(
      "No threads match the current filters.",
    );
  });
});
