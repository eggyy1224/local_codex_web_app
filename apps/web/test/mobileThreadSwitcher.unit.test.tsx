import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ThreadStatus } from "@lcwa/shared-types";
import MobileThreadSwitcherOverlay, {
  filterSwitcherGroups,
  type MobileThreadSwitcherGroup,
  type MobileThreadSwitcherItem,
} from "../app/threads/[id]/MobileThreadSwitcherOverlay";

function item(
  partial: Partial<MobileThreadSwitcherItem> & Pick<MobileThreadSwitcherItem, "id">,
): MobileThreadSwitcherItem {
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

function group(key: string, label: string, items: MobileThreadSwitcherItem[]): MobileThreadSwitcherGroup {
  return { key, label, items };
}

describe("filterSwitcherGroups", () => {
  const groups: MobileThreadSwitcherGroup[] = [
    group("/repos/alpha", "alpha", [
      item({ id: "a1", title: "Alpha running", status: "active" }),
      item({ id: "a2", title: "Alpha idle" }),
    ]),
    group("/repos/beta", "beta", [
      item({ id: "b1", title: "Beta waiting", waitingApprovalCount: 2 }),
      item({ id: "b2", title: "Beta broken", status: "systemError" }),
    ]),
  ];

  it("returns running items only when filter=running", () => {
    const filtered = filterSwitcherGroups(groups, "running", "");
    const ids = filtered.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["a1"]);
  });

  it("returns waiting items only when filter=waiting (pending wins over running)", () => {
    const withRunningWaiting: MobileThreadSwitcherGroup[] = [
      group("/repos/alpha", "alpha", [
        item({ id: "a1", status: "active", waitingApprovalCount: 1 }),
        item({ id: "a2", status: "active" }),
      ]),
    ];
    const filtered = filterSwitcherGroups(withRunningWaiting, "waiting", "");
    expect(filtered[0].items.map((i) => i.id)).toEqual(["a1"]);
  });

  it("returns error items only when filter=error", () => {
    const filtered = filterSwitcherGroups(groups, "error", "");
    const ids = filtered.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["b2"]);
  });

  it("narrows by case-insensitive title substring", () => {
    const filtered = filterSwitcherGroups(groups, "all", "WAITING");
    const ids = filtered.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["b1"]);
  });

  it("combines filter + search (filter first, then search inside)", () => {
    const filtered = filterSwitcherGroups(groups, "running", "broken");
    const ids = filtered.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual([]);
  });
});

describe("MobileThreadSwitcherOverlay slice 2: drawer + controls", () => {
  function renderOverlay(overrides: Partial<React.ComponentProps<typeof MobileThreadSwitcherOverlay>> = {}) {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onToggleGroup = vi.fn();
    const onCreateThread = vi.fn();
    const defaultGroups: MobileThreadSwitcherGroup[] = [
      group("/repos/alpha", "alpha", [
        item({ id: "a1", title: "Alpha running", status: "active" }),
        item({ id: "a2", title: "Alpha idle" }),
      ]),
      group("/repos/beta", "beta", [
        item({ id: "b1", title: "Beta waiting", waitingApprovalCount: 2 }),
      ]),
    ];
    const props: React.ComponentProps<typeof MobileThreadSwitcherOverlay> = {
      open: true,
      groups: defaultGroups,
      collapsedGroups: new Set<string>(),
      loading: false,
      defaultProjectKey: "/repos/alpha",
      onClose,
      onSelect,
      onToggleGroup,
      onCreateThread,
      ...overrides,
    };
    const utils = render(<MobileThreadSwitcherOverlay {...props} />);
    return { ...utils, onClose, onSelect, onToggleGroup, onCreateThread };
  }

  it("renders the search input, filter tabs, and New session entry", () => {
    renderOverlay();
    expect(screen.getByTestId("mobile-thread-switcher-search")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-thread-switcher-filter-all")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("mobile-thread-switcher-new")).toBeInTheDocument();
  });

  it("New session button creates a thread in the defaultProjectKey", () => {
    const { onCreateThread } = renderOverlay();
    fireEvent.click(screen.getByTestId("mobile-thread-switcher-new"));
    expect(onCreateThread).toHaveBeenCalledWith("/repos/alpha");
  });

  it("typing in the search box hides non-matching threads and shows a No matches state", () => {
    renderOverlay();
    const search = screen.getByTestId("mobile-thread-switcher-search");
    fireEvent.change(search, { target: { value: "nothing-matches-this" } });
    expect(screen.queryByText("Alpha running")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta waiting")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-thread-switcher-empty")).toHaveTextContent(/No matches/);
  });

  it("Running filter hides idle threads and surfaces the running ones", () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId("mobile-thread-switcher-filter-running"));
    expect(screen.getByText("Alpha running")).toBeInTheDocument();
    expect(screen.queryByText("Alpha idle")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta waiting")).not.toBeInTheDocument();
  });

  it("Waiting filter surfaces pending-approval threads even when they're also active", () => {
    renderOverlay({
      groups: [
        group("/repos/alpha", "alpha", [
          item({ id: "a1", title: "Alpha running+waiting", status: "active", waitingApprovalCount: 1 }),
          item({ id: "a2", title: "Alpha plain running", status: "active" }),
        ]),
      ],
    });
    fireEvent.click(screen.getByTestId("mobile-thread-switcher-filter-waiting"));
    expect(screen.getByText("Alpha running+waiting")).toBeInTheDocument();
    expect(screen.queryByText("Alpha plain running")).not.toBeInTheDocument();
  });

  it("preserves the per-project + button for creating a thread inside a group", () => {
    const { onCreateThread } = renderOverlay();
    const groups = screen.getAllByTestId("mobile-thread-switcher-group");
    const betaPlus = within(groups[1]).getByTestId("mobile-thread-switcher-group-new");
    fireEvent.click(betaPlus);
    expect(onCreateThread).toHaveBeenCalledWith("/repos/beta");
  });

  it("collapsed projects still hide their items (regression guard for prior collapse behavior)", () => {
    renderOverlay({ collapsedGroups: new Set(["/repos/alpha"]) });
    expect(screen.queryByText("Alpha running")).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha idle")).not.toBeInTheDocument();
    expect(screen.getByText("Beta waiting")).toBeInTheDocument();
  });
});
