"use client";

import {
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { MobileThreadSwitcherGroup } from "./MobileThreadSwitcherOverlay";
import {
  emptyStateMessage,
  filterThreadSwitcherGroups,
  type ThreadSwitcherFilter,
  type ThreadSwitcherGroup,
} from "./thread-switcher-shared";

type UseThreadSidebarFilterControllerOptions = {
  // Already-grouped switcher rows (shared mobile/desktop shape). The desktop
  // sidebar derives its filtered view from the same source as the mobile
  // drawer so status/filter/search stay in lockstep across both surfaces.
  switcherGroups: MobileThreadSwitcherGroup[];
};

type UseThreadSidebarFilterControllerResult = {
  sidebarSearchQuery: string;
  setSidebarSearchQuery: Dispatch<SetStateAction<string>>;
  sidebarStatusFilter: ThreadSwitcherFilter;
  setSidebarStatusFilter: Dispatch<SetStateAction<ThreadSwitcherFilter>>;
  sidebarFilteredGroups: ThreadSwitcherGroup[];
  sidebarListIsEmpty: boolean;
  sidebarEmptyMessage: string;
};

// Desktop sidebar — own copies of search + filter state so the mobile drawer
// resetting on close doesn't blow away what the user typed on desktop, and
// vice versa. This state is intentionally NOT reset on thread change (per the
// per-viewport-sticky rule); it has no coupling to SSE/turn/snapshot state.
export function useThreadSidebarFilterController({
  switcherGroups,
}: UseThreadSidebarFilterControllerOptions): UseThreadSidebarFilterControllerResult {
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [sidebarStatusFilter, setSidebarStatusFilter] = useState<ThreadSwitcherFilter>("all");

  const sidebarFilteredGroups = useMemo<ThreadSwitcherGroup[]>(
    () =>
      filterThreadSwitcherGroups(
        switcherGroups,
        sidebarStatusFilter,
        sidebarSearchQuery,
      ),
    [switcherGroups, sidebarStatusFilter, sidebarSearchQuery],
  );
  const sidebarListIsEmpty = useMemo(
    () => sidebarFilteredGroups.every((group) => group.items.length === 0),
    [sidebarFilteredGroups],
  );
  const sidebarEmptyMessage = useMemo(
    () =>
      emptyStateMessage(
        switcherGroups,
        sidebarStatusFilter,
        sidebarSearchQuery,
      ),
    [switcherGroups, sidebarStatusFilter, sidebarSearchQuery],
  );

  return {
    sidebarSearchQuery,
    setSidebarSearchQuery,
    sidebarStatusFilter,
    setSidebarStatusFilter,
    sidebarFilteredGroups,
    sidebarListIsEmpty,
    sidebarEmptyMessage,
  };
}
