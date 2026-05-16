"use client";

import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";
import type {
  ApprovalDecisionRequest,
  ApprovalView,
  InteractionRespondRequest,
  InteractionView,
  ThreadControlRequest,
  TurnPermissionMode,
} from "@lcwa/shared-types";
import type { ConversationTurn } from "../../lib/thread-logic";
import type { ModelSelectOption } from "../../lib/model-options";
import type {
  KnownSlashCommand,
  SlashCommandCatalogItem,
} from "../../lib/slash-commands";
import type { UseGatewayConfigResult } from "../../lib/use-gateway-config";
import type {
  FileMentionTrigger,
  UseFileMentionSearchResult,
} from "../../lib/use-file-mention-search";
import type { PendingAttachment } from "./AttachmentStrip";
import MobileActionLayer from "./MobileActionLayer";
import MobileCanvasSheet from "./MobileCanvasSheet";
import MobileChatTopBar, { type ThreadViewMode } from "./MobileChatTopBar";
import MobileComposerDock from "./MobileComposerDock";
import MobileControlSheet from "./MobileControlSheet";
import MobileMessageDetailsSheet from "./MobileMessageDetailsSheet";
import MobileMessageStream from "./MobileMessageStream";
import MobileThreadSwitcherOverlay, {
  type MobileThreadSwitcherGroup,
} from "./MobileThreadSwitcherOverlay";
import type {
  CollaborationModeKind,
  ThreadTokenUsageSummary,
} from "./thread-page-helpers";

// Local value-shapes that ThreadPageClient declares inline (not exported
// anywhere). Mirrored here so the prop surface is precisely typed without
// adding new exports to the controller. `MobileMessageDetails` matches the
// shape MobileMessageDetailsSheet consumes via its `details` prop.
type StatusBanner = {
  generatedAt: string;
  lines: string[];
};
type MobileMessageDetails = {
  turnId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  streaming: boolean;
  toolCalls: number;
  toolResults: number;
  hasThinking: boolean;
};

// Derived from ThreadPageClient's `pendingApprovalList` / `pendingInteractionList`
// memos, which project the full ApprovalView / InteractionView cards down to
// exactly these fields before passing them through.
type MobilePendingApproval = Pick<
  ApprovalView,
  "approvalId" | "type" | "reason" | "commandPreview" | "fileChangePreview"
>;
type MobilePendingInteraction = Pick<
  InteractionView,
  "interactionId" | "questions"
>;

export type MobileThreadShellProps = {
  activeProjectLabel: string;
  activeThreadTitle: string;
  collaborationMode: CollaborationModeKind;
  gatewayConfig: UseGatewayConfigResult;
  pendingActionCount: number;
  isThinkingActive: boolean;
  thinkingBannerText: string;
  runningTurnId: string | null;
  controlBusy: ThreadControlRequest["action"] | null;
  viewMode: ThreadViewMode;
  canvasBlocked: boolean;
  setViewMode: Dispatch<SetStateAction<ThreadViewMode>>;
  interruptRunningTurn: (turnId: string) => Promise<void>;
  setIsThreadSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  canvasOpenRequestKey: number;
  setCanvasOpenRequestKey: Dispatch<SetStateAction<number>>;
  openControlSheet: (
    section?: "pending" | "advanced",
    snap?: "half" | "full",
  ) => void;
  pendingInteractionList: MobilePendingInteraction[];
  pendingApprovalList: MobilePendingApproval[];
  statusBanner: StatusBanner | null;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
  error: string | null;
  submitError: string | null;
  approvalError: string | null;
  interactionError: string | null;
  controlError: string | null;
  modelCatalogError: string | null;
  visibleConversationTurns: ConversationTurn[];
  hiddenTimelineCount: number;
  showAllTurns: boolean;
  setShowAllTurns: Dispatch<SetStateAction<boolean>>;
  timelineRef: RefObject<HTMLElement | null>;
  handleTimelineScroll: () => void;
  formatTimestamp: (value: string | null) => string;
  reviewSlashCommandByTurnId: Map<string, string>;
  copyMessage: (text: string) => Promise<void>;
  openMessageDetails: (turnId: string) => void;
  gatewayUrl: string;
  actionablePlanByTurnId: Record<string, string>;
  turnProgressByTurnId: Record<string, string>;
  truncateText: (text: string, maxLength: number) => string;
  openImplementDialog: (turnId: string, planText: string) => void;
  keepPlanning: (turnId: string, planText?: string) => void;
  searchParams: ReadonlyURLSearchParams;
  MOBILE_CANVAS_URL_STORAGE_KEY: string;
  isControlSheetOpen: boolean;
  isMessageDetailsOpen: boolean;
  implementDialogOpen: boolean;
  approvalBusy: string | null;
  decideApproval: (
    approvalId: string,
    decision: ApprovalDecisionRequest["decision"],
  ) => Promise<void>;
  prompt: string;
  submitting: boolean;
  pendingAttachments: PendingAttachment[];
  handlePickFiles: (files: File[]) => Promise<void>;
  handleRemoveAttachment: (id: string) => void;
  slashMenuOpen: boolean;
  slashSuggestions: SlashCommandCatalogItem[];
  activeSlashIndex: number;
  fileMentionOpen: boolean;
  fileMentionSearch: UseFileMentionSearchResult;
  thinkingEffort: string;
  latestTokenUsage: ThreadTokenUsageSummary | null;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSlashMenuDismissed: Dispatch<SetStateAction<boolean>>;
  setFileMentionDismissed: Dispatch<SetStateAction<boolean>>;
  handlePromptKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  applyPromptSlash: (command: KnownSlashCommand) => void;
  applyFileMention: (
    prompt: string,
    trigger: FileMentionTrigger,
    path: string,
  ) => string;
  submitComposer: () => void;
  controlSheetSection: "pending" | "advanced";
  controlSheetSnap: "half" | "full";
  isDraggingSheet: boolean;
  sheetDragOffsetY: number;
  interactionBusy: string | null;
  compactBusy: boolean;
  model: string;
  modelOptions: ModelSelectOption[];
  thinkingEffortOptions: string[];
  permissionMode: TurnPermissionMode;
  setControlSheetSection: Dispatch<SetStateAction<"pending" | "advanced">>;
  setControlSheetSnap: Dispatch<SetStateAction<"half" | "full">>;
  closeControlSheet: () => void;
  setIsDraggingSheet: Dispatch<SetStateAction<boolean>>;
  setSheetDragOffsetY: Dispatch<SetStateAction<number>>;
  sendControl: (action: ThreadControlRequest["action"]) => Promise<void>;
  compactThread: () => Promise<void>;
  respondInteraction: (
    interactionId: string,
    answers: InteractionRespondRequest["answers"],
  ) => Promise<void>;
  setModel: Dispatch<SetStateAction<string>>;
  setThinkingEffort: Dispatch<SetStateAction<string>>;
  setPermissionMode: Dispatch<SetStateAction<TurnPermissionMode>>;
  formatEffortLabel: (value: string) => string;
  implementDraft: string;
  setImplementDialogOpen: Dispatch<SetStateAction<boolean>>;
  setImplementDraft: Dispatch<SetStateAction<string>>;
  confirmImplementPlan: () => Promise<void>;
  implementTargetTurnId: string | null;
  implementTargetPlanText: string | null;
  setImplementTargetTurnId: Dispatch<SetStateAction<string | null>>;
  setImplementTargetPlanText: Dispatch<SetStateAction<string | null>>;
  activeMessageDetails: MobileMessageDetails | null;
  closeMessageDetails: () => void;
  isThreadSwitcherOpen: boolean;
  mobileThreadSwitcherGroups: MobileThreadSwitcherGroup[];
  switcherCollapsedGroups: Set<string>;
  threadListLoading: boolean;
  activeProjectKey: string;
  selectThreadFromMobileSwitcher: (nextThreadId: string) => void;
  handleToggleSwitcherGroup: (groupKey: string) => void;
  createThread: (targetProjectKey?: string) => Promise<void>;
};

export default function MobileThreadShell({
  activeProjectLabel,
  activeThreadTitle,
  collaborationMode,
  gatewayConfig,
  pendingActionCount,
  isThinkingActive,
  thinkingBannerText,
  runningTurnId,
  controlBusy,
  viewMode,
  canvasBlocked,
  setViewMode,
  interruptRunningTurn,
  setIsThreadSwitcherOpen,
  canvasOpenRequestKey,
  setCanvasOpenRequestKey,
  openControlSheet,
  pendingInteractionList,
  pendingApprovalList,
  statusBanner,
  setStatusBanner,
  error,
  submitError,
  approvalError,
  interactionError,
  controlError,
  modelCatalogError,
  visibleConversationTurns,
  hiddenTimelineCount,
  showAllTurns,
  setShowAllTurns,
  timelineRef,
  handleTimelineScroll,
  formatTimestamp,
  reviewSlashCommandByTurnId,
  copyMessage,
  openMessageDetails,
  gatewayUrl,
  actionablePlanByTurnId,
  turnProgressByTurnId,
  truncateText,
  openImplementDialog,
  keepPlanning,
  searchParams,
  MOBILE_CANVAS_URL_STORAGE_KEY,
  isControlSheetOpen,
  isMessageDetailsOpen,
  implementDialogOpen,
  approvalBusy,
  decideApproval,
  prompt,
  submitting,
  pendingAttachments,
  handlePickFiles,
  handleRemoveAttachment,
  slashMenuOpen,
  slashSuggestions,
  activeSlashIndex,
  fileMentionOpen,
  fileMentionSearch,
  thinkingEffort,
  latestTokenUsage,
  setPrompt,
  setSlashMenuDismissed,
  setFileMentionDismissed,
  handlePromptKeyDown,
  applyPromptSlash,
  applyFileMention,
  submitComposer,
  controlSheetSection,
  controlSheetSnap,
  isDraggingSheet,
  sheetDragOffsetY,
  interactionBusy,
  compactBusy,
  model,
  modelOptions,
  thinkingEffortOptions,
  permissionMode,
  setControlSheetSection,
  setControlSheetSnap,
  closeControlSheet,
  setIsDraggingSheet,
  setSheetDragOffsetY,
  sendControl,
  compactThread,
  respondInteraction,
  setModel,
  setThinkingEffort,
  setPermissionMode,
  formatEffortLabel,
  implementDraft,
  setImplementDialogOpen,
  setImplementDraft,
  confirmImplementPlan,
  implementTargetTurnId,
  implementTargetPlanText,
  setImplementTargetTurnId,
  setImplementTargetPlanText,
  activeMessageDetails,
  closeMessageDetails,
  isThreadSwitcherOpen,
  mobileThreadSwitcherGroups,
  switcherCollapsedGroups,
  threadListLoading,
  activeProjectKey,
  selectThreadFromMobileSwitcher,
  handleToggleSwitcherGroup,
  createThread,
}: MobileThreadShellProps) {
  return (
<div className="cdx-mobile-thread-page">
  <MobileChatTopBar
    projectLabel={activeProjectLabel}
    threadTitle={activeThreadTitle}
    collaborationMode={collaborationMode}
    serviceTier={gatewayConfig.config?.serviceTier ?? null}
    pendingActionCount={pendingActionCount}
    isWorking={isThinkingActive}
    workingLabel={thinkingBannerText}
    runningTurnId={runningTurnId}
    stopBusy={controlBusy === "stop"}
    viewMode={viewMode}
    canvasDisabled={canvasBlocked}
    onViewModeChange={setViewMode}
    onStop={(turnId) => void interruptRunningTurn(turnId)}
    onOpenThreads={() => setIsThreadSwitcherOpen(true)}
    onOpenCanvas={() => {
      if (canvasBlocked) return;
      setCanvasOpenRequestKey((value: number) => value + 1);
    }}
    onOpenControls={() =>
      openControlSheet(
        pendingInteractionList.length > 0 || pendingApprovalList.length > 0
          ? "pending"
          : "advanced",
        "half",
      )
    }
  />

  <main className="cdx-mobile-thread-main">
    {statusBanner ? (
      <div className="cdx-mobile-status-banner" data-testid="status-banner">
        <div className="cdx-mobile-status-banner-lines">
          <span>{statusBanner.lines[0]}</span>
          <span>{statusBanner.lines[1]}</span>
          <span>{statusBanner.lines[2]}</span>
        </div>
        <button
          type="button"
          className="cdx-mobile-status-banner-close"
          data-testid="status-banner-close"
          aria-label="Dismiss status"
          onClick={() => setStatusBanner(null)}
        >
          ×
        </button>
      </div>
    ) : null}
    {error ? <p className="cdx-error">{error}</p> : null}
    {submitError ? <p className="cdx-error">{submitError}</p> : null}
    {approvalError ? <p className="cdx-error">{approvalError}</p> : null}
    {interactionError ? <p className="cdx-error">{interactionError}</p> : null}
    {controlError ? <p className="cdx-error">{controlError}</p> : null}
    {modelCatalogError ? (
      <p className="cdx-helper">Model catalog unavailable ({modelCatalogError}); using fallback list.</p>
    ) : null}

    <MobileMessageStream
      turns={visibleConversationTurns}
      hiddenCount={hiddenTimelineCount}
      showAllTurns={showAllTurns}
      onToggleShowAll={setShowAllTurns}
      timelineRef={timelineRef}
      onTimelineScroll={handleTimelineScroll}
      formatTimestamp={formatTimestamp}
      reviewSlashCommandByTurnId={reviewSlashCommandByTurnId}
      onCopyMessage={(text) => void copyMessage(text)}
      onOpenMessageDetails={openMessageDetails}
      viewMode={viewMode}
      gatewayUrl={gatewayUrl}
      renderTurnActions={(turnId) => {
        const planText = actionablePlanByTurnId[turnId];
        const progressText = turnProgressByTurnId[turnId];
        const showPlan = Boolean(planText);
        return (
          <>
            {progressText ? (
              <section
                className="cdx-message cdx-message--detail cdx-turn-progress-card"
                data-testid="turn-progress-card"
              >
                <div className="cdx-message-meta">
                  <strong className="cdx-message-role">Codex tasks</strong>
                </div>
                <pre className="cdx-turn-body cdx-turn-body--plan">
                  {truncateText(progressText, 4000)}
                </pre>
              </section>
            ) : null}
            {showPlan ? (
              <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                <div className="cdx-message-meta">
                  <strong className="cdx-message-role">Plan ready</strong>
                </div>
                <pre className="cdx-turn-body cdx-turn-body--plan">
                  {truncateText(planText, 4000)}
                </pre>
                <div className="cdx-inline-actions">
                  <button
                    type="button"
                    className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                    onClick={() => openImplementDialog(turnId, planText)}
                  >
                    Implement this plan
                  </button>
                  <button
                    type="button"
                    className="cdx-toolbar-btn"
                    onClick={() => keepPlanning(turnId, planText)}
                  >
                    Keep planning
                  </button>
                </div>
              </section>
            ) : null}
          </>
        );
      }}
    />
  </main>

  <MobileCanvasSheet
    initialUrl={searchParams.get("canvas")}
    storageKey={MOBILE_CANVAS_URL_STORAGE_KEY}
    openRequestKey={canvasOpenRequestKey}
    showTrigger={false}
    hidden={canvasBlocked}
  />

  {/* The control sheet, the message details sheet, and the implement
      dialog are themselves the canonical "answer / approve" surface
      once they open — keep the floating action layer hidden while any
      of them is up so it can't intercept clicks on the actual form
      underneath (the action layer now sits at a higher z-index than
      the sheet backdrop). */}
  {isControlSheetOpen || isMessageDetailsOpen || implementDialogOpen ? null : (
    <MobileActionLayer
      pendingApprovals={pendingApprovalList}
      pendingInteractions={pendingInteractionList}
      approvalBusy={approvalBusy}
      onDecision={(approvalId, decision) => void decideApproval(approvalId, decision)}
      onOpenQuestion={() => openControlSheet("pending", "full")}
    />
  )}

  <MobileComposerDock
    prompt={prompt}
    submitting={submitting}
    canSend={
      runningTurnId !== null
        ? prompt.trim().length > 0
        : (prompt.trim().length > 0 ||
            pendingAttachments.some((a: { status: string }) => a.status === "ready")) &&
          !pendingAttachments.some((a: { status: string }) => a.status === "uploading")
    }
    attachments={pendingAttachments}
    onPickFiles={runningTurnId === null ? handlePickFiles : undefined}
    onRemoveAttachment={handleRemoveAttachment}
    slashMenuOpen={slashMenuOpen}
    slashSuggestions={slashSuggestions}
    activeSlashIndex={activeSlashIndex}
    steerActive={runningTurnId !== null}
    fileMentionOpen={fileMentionOpen}
    fileMentionResults={fileMentionSearch.results}
    fileMentionLoading={fileMentionSearch.isLoading}
    strip={{
      model: model || null,
      effortLabel: thinkingEffort ? formatEffortLabel(thinkingEffort) : null,
      permissionLabel: permissionMode ? permissionMode : null,
      pendingCount: pendingActionCount,
      contextUsage: latestTokenUsage
        ? {
            totalTokens: latestTokenUsage.totalTokens,
            lastTokens: latestTokenUsage.lastTokens,
            modelContextWindow: latestTokenUsage.modelContextWindow,
          }
        : null,
      speedFast: gatewayConfig.config?.serviceTier === "fast",
    }}
    onPromptChange={(value: string) => {
      setPrompt(value);
      setSlashMenuDismissed(false);
      setFileMentionDismissed(false);
    }}
    onPromptKeyDown={handlePromptKeyDown}
    onApplySlash={applyPromptSlash}
    onApplyFileMention={(path) => {
      if (!fileMentionSearch.trigger) return;
      setPrompt(applyFileMention(prompt, fileMentionSearch.trigger, path));
      setFileMentionDismissed(true);
    }}
    onSend={submitComposer}
    onInsertFileMentionTrigger={() => {
      setPrompt((current: string) => (current.length === 0 || current.endsWith(" ") ? `${current}@` : `${current} @`));
      setSlashMenuDismissed(false);
      setFileMentionDismissed(false);
    }}
    onInsertSlashTrigger={() => {
      setPrompt((current: string) => (current.length === 0 ? "/" : `${current} /`));
      setSlashMenuDismissed(false);
      setFileMentionDismissed(false);
    }}
    onOpenControls={() =>
      openControlSheet(
        pendingInteractionList.length > 0 || pendingApprovalList.length > 0
          ? "pending"
          : "advanced",
        "half",
      )
    }
    onOpenAdvancedControls={() => openControlSheet("advanced", "half")}
    onSwipeOpenControls={() =>
      openControlSheet(
        pendingInteractionList.length > 0 || pendingApprovalList.length > 0
          ? "pending"
          : "advanced",
        "full",
      )
    }
  />

  <MobileControlSheet
    open={isControlSheetOpen}
    section={controlSheetSection}
    snap={controlSheetSnap}
    isDragging={isDraggingSheet}
    dragOffsetY={sheetDragOffsetY}
    approvalBusy={approvalBusy}
    interactionBusy={interactionBusy}
    controlBusy={controlBusy}
    compactBusy={compactBusy}
    turnRunning={runningTurnId !== null}
    pendingApprovals={pendingApprovalList}
    pendingInteractions={pendingInteractionList}
    model={model}
    modelOptions={modelOptions.map((option: { value: string; label: string }) => ({ value: option.value, label: option.label }))}
    thinkingEffort={thinkingEffort}
    thinkingEffortOptions={thinkingEffortOptions}
    permissionMode={permissionMode}
    serviceTier={gatewayConfig.config?.serviceTier ?? null}
    serviceTierBusy={gatewayConfig.status === "writing"}
    onServiceTierChange={(tier) => {
      void gatewayConfig.writeValue({ keyPath: "service_tier", value: tier });
    }}
    onSectionChange={(section) => {
      setControlSheetSection(section);
      // Advanced tab pins controls (Stop/Retry/Cancel) at the bottom of
      // the form — at half-snap they fall below the viewport and become
      // unreachable. Auto-expand to full when the user switches in.
      if (section === "advanced") {
        setControlSheetSnap("full");
      }
    }}
    onSnapChange={setControlSheetSnap}
    onClose={closeControlSheet}
    onDraggingChange={setIsDraggingSheet}
    onDragOffsetChange={setSheetDragOffsetY}
    onControl={(action) => void sendControl(action)}
    onCompact={() => void compactThread()}
    onDecision={(approvalId, decision) => void decideApproval(approvalId, decision)}
    onRespondInteraction={(interactionId, answers) => void respondInteraction(interactionId, answers)}
    onModelChange={setModel}
    onThinkingEffortChange={setThinkingEffort}
    onPermissionModeChange={setPermissionMode}
    formatEffortLabel={formatEffortLabel}
  />

  {implementDialogOpen ? (
    <section className="cdx-mobile-implement-sheet" data-testid="mobile-implement-sheet">
      <div className="cdx-turn-head">
        <strong>Implement plan</strong>
        <button
          type="button"
          className="cdx-mobile-inline-btn"
          onClick={() => setImplementDialogOpen(false)}
        >
          Close
        </button>
      </div>
      <textarea
        data-testid="implement-draft-input"
        value={implementDraft}
        onChange={(event) => setImplementDraft(event.target.value)}
        rows={8}
      />
      <div className="cdx-inline-actions">
        <button
          type="button"
          className="cdx-toolbar-btn cdx-toolbar-btn--positive"
          onClick={() => void confirmImplementPlan()}
          disabled={submitting || implementDraft.trim().length === 0}
        >
          Implement this plan
        </button>
        <button
          type="button"
          className="cdx-toolbar-btn"
          onClick={() => {
            if (implementTargetTurnId && implementTargetPlanText) {
              keepPlanning(implementTargetTurnId, implementTargetPlanText);
            }
            setImplementDialogOpen(false);
            setImplementTargetTurnId(null);
            setImplementTargetPlanText(null);
          }}
        >
          Keep planning
        </button>
      </div>
    </section>
  ) : null}

  <MobileMessageDetailsSheet
    open={isMessageDetailsOpen}
    details={activeMessageDetails}
    onClose={closeMessageDetails}
  />

  <MobileThreadSwitcherOverlay
    open={isThreadSwitcherOpen}
    groups={mobileThreadSwitcherGroups}
    collapsedGroups={switcherCollapsedGroups}
    loading={threadListLoading}
    defaultProjectKey={activeProjectKey}
    onClose={() => setIsThreadSwitcherOpen(false)}
    onSelect={selectThreadFromMobileSwitcher}
    onToggleGroup={handleToggleSwitcherGroup}
    onCreateThread={(projectKey) => {
      setIsThreadSwitcherOpen(false);
      void createThread(projectKey);
    }}
  />
</div>
  );
}
