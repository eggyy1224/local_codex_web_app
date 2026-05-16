"use client";

import MobileActionLayer from "./MobileActionLayer";
import MobileCanvasSheet from "./MobileCanvasSheet";
import MobileChatTopBar from "./MobileChatTopBar";
import MobileComposerDock from "./MobileComposerDock";
import MobileControlSheet from "./MobileControlSheet";
import MobileMessageDetailsSheet from "./MobileMessageDetailsSheet";
import MobileMessageStream from "./MobileMessageStream";
import MobileThreadSwitcherOverlay from "./MobileThreadSwitcherOverlay";

type MobileThreadShellProps = {
  activeProjectLabel: any;
  activeThreadTitle: any;
  collaborationMode: any;
  gatewayConfig: any;
  pendingActionCount: any;
  isThinkingActive: any;
  thinkingBannerText: any;
  runningTurnId: any;
  controlBusy: any;
  viewMode: any;
  canvasBlocked: any;
  setViewMode: any;
  interruptRunningTurn: any;
  setIsThreadSwitcherOpen: any;
  canvasOpenRequestKey: any;
  setCanvasOpenRequestKey: any;
  openControlSheet: any;
  pendingInteractionList: any;
  pendingApprovalList: any;
  statusBanner: any;
  setStatusBanner: any;
  error: any;
  submitError: any;
  approvalError: any;
  interactionError: any;
  controlError: any;
  modelCatalogError: any;
  visibleConversationTurns: any;
  hiddenTimelineCount: any;
  showAllTurns: any;
  setShowAllTurns: any;
  timelineRef: any;
  handleTimelineScroll: any;
  formatTimestamp: any;
  reviewSlashCommandByTurnId: any;
  copyMessage: any;
  openMessageDetails: any;
  gatewayUrl: any;
  actionablePlanByTurnId: any;
  turnProgressByTurnId: any;
  truncateText: any;
  openImplementDialog: any;
  keepPlanning: any;
  searchParams: any;
  MOBILE_CANVAS_URL_STORAGE_KEY: any;
  isControlSheetOpen: any;
  isMessageDetailsOpen: any;
  implementDialogOpen: any;
  approvalBusy: any;
  decideApproval: any;
  prompt: any;
  submitting: any;
  pendingAttachments: any;
  handlePickFiles: any;
  handleRemoveAttachment: any;
  slashMenuOpen: any;
  slashSuggestions: any;
  activeSlashIndex: any;
  fileMentionOpen: any;
  fileMentionSearch: any;
  thinkingEffort: any;
  latestTokenUsage: any;
  setPrompt: any;
  setSlashMenuDismissed: any;
  setFileMentionDismissed: any;
  handlePromptKeyDown: any;
  applyPromptSlash: any;
  applyFileMention: any;
  submitComposer: any;
  controlSheetSection: any;
  controlSheetSnap: any;
  isDraggingSheet: any;
  sheetDragOffsetY: any;
  interactionBusy: any;
  compactBusy: any;
  model: any;
  modelOptions: any;
  thinkingEffortOptions: any;
  permissionMode: any;
  setControlSheetSection: any;
  setControlSheetSnap: any;
  closeControlSheet: any;
  setIsDraggingSheet: any;
  setSheetDragOffsetY: any;
  sendControl: any;
  compactThread: any;
  respondInteraction: any;
  setModel: any;
  setThinkingEffort: any;
  setPermissionMode: any;
  formatEffortLabel: any;
  implementDraft: any;
  setImplementDialogOpen: any;
  setImplementDraft: any;
  confirmImplementPlan: any;
  implementTargetTurnId: any;
  implementTargetPlanText: any;
  setImplementTargetTurnId: any;
  setImplementTargetPlanText: any;
  activeMessageDetails: any;
  closeMessageDetails: any;
  isThreadSwitcherOpen: any;
  mobileThreadSwitcherGroups: any;
  switcherCollapsedGroups: any;
  threadListLoading: any;
  activeProjectKey: any;
  selectThreadFromMobileSwitcher: any;
  handleToggleSwitcherGroup: any;
  createThread: any;
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
