"use client";

import { useCallback, useState } from "react";
import {
  threadModeStorageKey,
  type CollaborationModeKind,
} from "./thread-page-helpers";

type UseThreadCollaborationModeControllerOptions = {
  // The active thread id. Drives the per-thread localStorage key
  // (`threadModeStorageKey(threadId)`) and is the sole dependency of
  // `applyCollaborationMode` — kept identical to the inline version so the
  // callback identity (used in other deps arrays) does not change.
  threadId: string;
};

type UseThreadCollaborationModeControllerResult = {
  collaborationMode: CollaborationModeKind;
  applyCollaborationMode: (nextMode: CollaborationModeKind) => CollaborationModeKind;
  toggleCollaborationMode: () => CollaborationModeKind;
};

// Collaboration mode (plan vs default) state + its two mutators.
//
// IMPORTANT: this is intentionally only the state + callbacks. The mode-init
// useEffect that reads searchParams/localStorage and may call
// `replaceWithoutQueryParams` is deliberately LEFT in ThreadPageClient. That
// effect has a hard run-order dependency on the threadId mega-reset effect via
// the shared `modeInitializedRef` (the mega-reset clears it on thread change
// and the init effect must run *after* that clear). Moving the effect into this
// hook would register it before the mega-reset effect and invert that order, so
// it stays at its original site and calls the returned `applyCollaborationMode`
// instead — behaviour, deps, and run order unchanged.
//
// `submitTurnText` and the composer read `collaborationMode` every turn; the
// value returned here is the exact same state value, threaded to the call site
// identically.
export function useThreadCollaborationModeController({
  threadId,
}: UseThreadCollaborationModeControllerOptions): UseThreadCollaborationModeControllerResult {
  const [collaborationMode, setCollaborationMode] = useState<CollaborationModeKind>("default");

  const applyCollaborationMode = useCallback(
    (nextMode: CollaborationModeKind) => {
      setCollaborationMode(nextMode);
      if (threadId) {
        window.localStorage.setItem(threadModeStorageKey(threadId), nextMode);
      }
      return nextMode;
    },
    [threadId],
  );

  const toggleCollaborationMode = useCallback((): CollaborationModeKind => {
    const nextMode: CollaborationModeKind = collaborationMode === "plan" ? "default" : "plan";
    applyCollaborationMode(nextMode);
    return nextMode;
  }, [applyCollaborationMode, collaborationMode]);

  return {
    collaborationMode,
    applyCollaborationMode,
    toggleCollaborationMode,
  };
}
