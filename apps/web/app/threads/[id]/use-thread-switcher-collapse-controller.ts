"use client";

import { useCallback, useState } from "react";

type UseThreadSwitcherCollapseControllerResult = {
  switcherCollapsedGroups: Set<string>;
  handleToggleSwitcherGroup: (groupKey: string) => void;
};

// Shared by the mobile switcher overlay and the desktop sidebar so a project
// folder collapsed on one viewport stays collapsed on the other (collapse is
// never reset on thread change, unlike search/filter which are intentionally
// per-viewport). No coupling to SSE/turn/snapshot state — the only mutator is
// the toggle below, and the value flows verbatim into both shells.
export function useThreadSwitcherCollapseController(): UseThreadSwitcherCollapseControllerResult {
  const [switcherCollapsedGroups, setSwitcherCollapsedGroups] = useState<Set<string>>(() => new Set());

  const handleToggleSwitcherGroup = useCallback((groupKey: string) => {
    setSwitcherCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  return {
    switcherCollapsedGroups,
    handleToggleSwitcherGroup,
  };
}
