"use client";

import { useMemo } from "react";
import type { ThreadListItem } from "@lcwa/shared-types";
import {
  groupThreadsByProject,
  pickDefaultProjectKey,
  projectLabelFromKey,
  type ProjectGroup,
} from "../../lib/projects";
import { type MobileThreadSwitcherGroup } from "./MobileThreadSwitcherOverlay";

type UseThreadListDerivationsControllerOptions = {
  // The raw thread list. This state (and its setter / loading flag) stays in
  // ThreadPageClient because it is SSE-coupled; only the pure derivations move
  // here. The value is threaded in identically so every dependency array below
  // observes the same identity it did inline.
  threadList: ThreadListItem[];
  // The active thread id. Used for the `activeThread` lookup and the
  // per-thread `isActive` flag inside the switcher groups.
  threadId: string;
};

type UseThreadListDerivationsControllerResult = {
  activeThread: ThreadListItem | undefined;
  groupedThreads: ProjectGroup[];
  mobileThreadSwitcherGroups: MobileThreadSwitcherGroup[];
  threadPreviewById: Map<string, Map<string, string>>;
  activeProjectKey: string;
  activeProjectLabel: string;
};

// Pure thread-list derivations computed from `threadList` + `threadId`.
//
// IMPORTANT: every memo body, its TypeScript annotation, and its dependency
// array are copied verbatim from the inline ThreadPageClient versions, in the
// same computation order, so each derived value keeps its exact identity and
// recompute condition. These values feed many downstream
// useMemo/useCallback/useEffect dependency arrays and are passed as props; a
// changed identity or recompute condition would cause subtle extra re-renders
// or stale closures. The `threadList` / `setThreadList` / `threadListLoading`
// state is deliberately NOT moved (SSE-coupled, high-risk) — it stays in
// ThreadPageClient and is passed in here as an argument.
//
// `activeThread` is a plain `.find()` expression (not a useMemo) in the
// original; it is reproduced identically here (still recomputed every render,
// returning the same element reference while `threadList`/`threadId` are
// unchanged). `activeProjectLabel` is the pure `projectLabelFromKey(
// activeProjectKey)` sibling; it had no memo inline and keeps that exact
// (non-memoised) recompute semantics here.
export function useThreadListDerivationsController({
  threadList,
  threadId,
}: UseThreadListDerivationsControllerOptions): UseThreadListDerivationsControllerResult {
  const activeThread = threadList.find((thread) => thread.id === threadId);
  const groupedThreads = useMemo(() => groupThreadsByProject(threadList), [threadList]);
  const mobileThreadSwitcherGroups = useMemo<MobileThreadSwitcherGroup[]>(
    () =>
      groupedThreads.map((group) => ({
        key: group.key,
        label: group.label,
        items: group.threads.map((thread) => ({
          id: thread.id,
          title: thread.title || "(untitled thread)",
          lastActiveAt: thread.lastActiveAt,
          isActive: thread.id === threadId,
          status: thread.status,
          waitingApprovalCount: thread.waitingApprovalCount,
          errorCount: thread.errorCount,
        })),
      })),
    [groupedThreads, threadId],
  );
  // Desktop sidebar reuses the same switcher group shape as the mobile drawer
  // but keeps preview text alongside so the row body looks the same as before.
  // Stored as Map<projectKey, Map<threadId, preview>> so the JSX can look up
  // the preview without re-traversing groupedThreads inside each map().
  const threadPreviewById = useMemo<Map<string, Map<string, string>>>(() => {
    const result = new Map<string, Map<string, string>>();
    for (const group of groupedThreads) {
      const inner = new Map<string, string>();
      for (const thread of group.threads) {
        inner.set(thread.id, thread.preview ?? "");
      }
      result.set(group.key, inner);
    }
    return result;
  }, [groupedThreads]);
  const activeProjectKey = useMemo(() => {
    if (activeThread?.projectKey) {
      return activeThread.projectKey;
    }
    return pickDefaultProjectKey(groupedThreads);
  }, [activeThread, groupedThreads]);
  const activeProjectLabel = projectLabelFromKey(activeProjectKey);

  return {
    activeThread,
    groupedThreads,
    mobileThreadSwitcherGroups,
    threadPreviewById,
    activeProjectKey,
    activeProjectLabel,
  };
}
