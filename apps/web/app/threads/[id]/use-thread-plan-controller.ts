"use client";

import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { proposedPlanFromText, type ConversationTurn } from "../../lib/thread-logic";
import {
  implementPlanPrompt,
  isImplementPlanPromptForPlan,
  planActionStorageKey,
  type PlanActionState,
} from "./thread-page-helpers";

type UseThreadPlanControllerOptions = {
  // The active thread id. Drives the per-plan localStorage key
  // (`planActionStorageKey(threadId, …)`) and is a dependency of the
  // readiness-key memo / `markPlanAction`. Threaded in identically so every
  // dependency array below observes the same identity it did inline.
  threadId: string;
  // The full conversation-turn list. This is group-A SSE-coupled state that
  // stays in ThreadPageClient (computed from the event store + detail.turns);
  // only the pure plan-detection derivations move here. The value is threaded
  // in identically so `planReadyByTurnId` / `implementedPlanReadyByTurnId`
  // observe the exact same reference and recompute condition they did inline.
  allConversationTurns: ConversationTurn[];
};

type UseThreadPlanControllerResult = {
  planActionByStorageKey: Record<string, PlanActionState>;
  setPlanActionByStorageKey: Dispatch<SetStateAction<Record<string, PlanActionState>>>;
  planActionStorageReadyKey: string;
  setPlanActionStorageReadyKey: Dispatch<SetStateAction<string>>;
  implementDialogOpen: boolean;
  setImplementDialogOpen: Dispatch<SetStateAction<boolean>>;
  implementDraft: string;
  setImplementDraft: Dispatch<SetStateAction<string>>;
  implementTargetTurnId: string | null;
  setImplementTargetTurnId: Dispatch<SetStateAction<string | null>>;
  implementTargetPlanText: string | null;
  setImplementTargetPlanText: Dispatch<SetStateAction<string | null>>;
  planReadyByTurnId: Record<string, string>;
  implementedPlanReadyByTurnId: Record<string, boolean>;
  planActionStorageReadinessKey: string;
  actionablePlanByTurnId: Record<string, string>;
  openImplementDialog: (turnId: string, planText: string) => void;
  markPlanAction: (turnId: string, planText: string, action: PlanActionState) => void;
  keepPlanning: (turnId: string, planText?: string) => void;
};

// Plan-proposal detection + the Implement-plan dialog state/helpers.
//
// IMPORTANT: every memo body, its TypeScript annotation, and its dependency
// array are copied verbatim from the inline ThreadPageClient versions, in the
// same computation order, so each derived value keeps its exact identity and
// recompute condition. `planReadyByTurnId` → `implementedPlanReadyByTurnId` →
// `planActionStorageReadinessKey` → `actionablePlanByTurnId` feed
// `visibleConversationTurns` and the shell props; a changed identity or
// recompute condition would cause subtle extra re-renders or stale closures.
//
// Two couplings are deliberately LEFT in ThreadPageClient and consume the
// values returned here instead of being moved:
//   1. The localStorage-readiness `useEffect` (it reads `planReadyByTurnId` /
//      `planActionStorageReadinessKey` and writes `setPlanActionByStorageKey`
//      / `setPlanActionStorageReadyKey`). Moving it into this hook would
//      register the effect earlier than its current inline slot relative to
//      the threadId mega-reset effect; mirroring slice 4c's deferred mode-init
//      effect, the effect stays at its original site and uses the setters /
//      derived keys returned here — registration order byte-identical.
//   2. `confirmImplementPlan` — it orchestrates the composer (`submitTurnText`,
//      HIGH-risk) + `applyCollaborationMode` (slice 4c hook) + `markPlanAction`
//      together (the just-shipped plan-mode-exit fix, commit 1f51282). It
//      stays in ThreadPageClient and calls the `markPlanAction` / dialog
//      setters returned here, so the implement-turn (default-mode) semantics
//      are preserved byte-exact.
//
// The mega-reset effect (dep `[threadId]`) also stays in ThreadPageClient and
// keeps resetting these via the returned setters (it resets ~20 unrelated
// states; it is not part of this group).
export function useThreadPlanController({
  threadId,
  allConversationTurns,
}: UseThreadPlanControllerOptions): UseThreadPlanControllerResult {
  const [planActionByStorageKey, setPlanActionByStorageKey] = useState<
    Record<string, PlanActionState>
  >({});
  const [planActionStorageReadyKey, setPlanActionStorageReadyKey] = useState("");
  const [implementDialogOpen, setImplementDialogOpen] = useState(false);
  const [implementDraft, setImplementDraft] = useState("");
  const [implementTargetTurnId, setImplementTargetTurnId] = useState<string | null>(null);
  const [implementTargetPlanText, setImplementTargetPlanText] = useState<string | null>(null);

  const planReadyByTurnId = useMemo(() => {
    // ONLY a real <proposed_plan> tag (in the assistant message or thinking)
    // means "I'm proposing a plan, please approve to implement". The
    // turn/plan/updated event is Codex's own in-flight todo tracking — it
    // belongs in turnProgressByTurnId, NOT here. Treating progress as a
    // proposal means clicking "Implement this plan" steers the conversation
    // with "Implement this plan: [completed] step1, [inProgress] step2 …"
    // which asks Codex to redo work it's currently doing.
    const result: Record<string, string> = {};
    for (const turn of allConversationTurns) {
      const plan =
        proposedPlanFromText(turn.assistantText) ??
        proposedPlanFromText(turn.thinkingText) ??
        null;
      if (!plan) {
        continue;
      }
      result[turn.turnId] = plan;
    }
    return result;
  }, [allConversationTurns]);

  const implementedPlanReadyByTurnId = useMemo(() => {
    const result: Record<string, boolean> = {};
    const turnIndexById = new Map(
      allConversationTurns.map((turn, index) => [turn.turnId, index] as const),
    );
    for (const [turnId, planText] of Object.entries(planReadyByTurnId)) {
      const planTurnIndex = turnIndexById.get(turnId);
      if (planTurnIndex === undefined) {
        continue;
      }
      const wasImplemented = allConversationTurns
        .slice(planTurnIndex + 1)
        .some((turn) => isImplementPlanPromptForPlan(turn.userText, planText));
      if (wasImplemented) {
        result[turnId] = true;
      }
    }
    return result;
  }, [allConversationTurns, planReadyByTurnId]);

  const planActionStorageReadinessKey = useMemo(() => {
    if (!threadId) {
      return "";
    }
    return Object.entries(planReadyByTurnId)
      .sort(([leftTurnId], [rightTurnId]) => leftTurnId.localeCompare(rightTurnId))
      .map(([turnId, planText]) => planActionStorageKey(threadId, turnId, planText))
      .join("|");
  }, [planReadyByTurnId, threadId]);

  const actionablePlanByTurnId = useMemo(() => {
    const result: Record<string, string> = {};
    const storageReady = !threadId || planActionStorageReadyKey === planActionStorageReadinessKey;
    for (const [turnId, planText] of Object.entries(planReadyByTurnId)) {
      if (implementedPlanReadyByTurnId[turnId]) {
        continue;
      }
      if (!storageReady) {
        continue;
      }
      const storageKey = threadId ? planActionStorageKey(threadId, turnId, planText) : turnId;
      if (planActionByStorageKey[storageKey]) {
        continue;
      }
      result[turnId] = planText;
    }
    return result;
  }, [
    implementedPlanReadyByTurnId,
    planActionByStorageKey,
    planActionStorageReadyKey,
    planActionStorageReadinessKey,
    planReadyByTurnId,
    threadId,
  ]);

  const openImplementDialog = useCallback((turnId: string, planText: string) => {
    setImplementTargetTurnId(turnId);
    setImplementTargetPlanText(planText);
    setImplementDraft(implementPlanPrompt(planText));
    setImplementDialogOpen(true);
  }, []);

  const markPlanAction = useCallback(
    (turnId: string, planText: string, action: PlanActionState) => {
      if (!threadId || !planText) {
        return;
      }
      const key = planActionStorageKey(threadId, turnId, planText);
      setPlanActionByStorageKey((prev) => ({
        ...prev,
        [key]: action,
      }));
      try {
        window.localStorage.setItem(key, action);
      } catch {
        // localStorage can be unavailable in private/restricted contexts; the
        // in-memory state still keeps this page from immediately re-showing it.
      }
    },
    [threadId],
  );

  const keepPlanning = useCallback(
    (turnId: string, planText?: string) => {
      const targetPlanText = planText ?? planReadyByTurnId[turnId];
      if (!targetPlanText) {
        return;
      }
      markPlanAction(turnId, targetPlanText, "dismissed");
    },
    [markPlanAction, planReadyByTurnId],
  );

  return {
    planActionByStorageKey,
    setPlanActionByStorageKey,
    planActionStorageReadyKey,
    setPlanActionStorageReadyKey,
    implementDialogOpen,
    setImplementDialogOpen,
    implementDraft,
    setImplementDraft,
    implementTargetTurnId,
    setImplementTargetTurnId,
    implementTargetPlanText,
    setImplementTargetPlanText,
    planReadyByTurnId,
    implementedPlanReadyByTurnId,
    planActionStorageReadinessKey,
    actionablePlanByTurnId,
    openImplementDialog,
    markPlanAction,
    keepPlanning,
  };
}
