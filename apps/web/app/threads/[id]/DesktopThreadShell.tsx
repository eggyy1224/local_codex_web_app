"use client";

import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  Dispatch,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import Link from "next/link";
import type {
  ApprovalDecisionRequest,
  InteractionRespondRequest,
  ThreadContextResponse,
  ThreadControlRequest,
  TurnPermissionMode,
} from "@lcwa/shared-types";
import { MarkdownText } from "../../lib/MarkdownText";
import { resolveImageSrc } from "../../lib/resolve-image-src";
import type { ModelSelectOption } from "../../lib/model-options";
import {
  statusClass,
  statusLabel,
  summarizeToolAction,
  type ConversationTurn,
} from "../../lib/thread-logic";
import type {
  KnownSlashCommand,
  SlashCommandCatalogItem,
} from "../../lib/slash-commands";
import { type ThreadViewMode, VIEW_MODE_OPTIONS } from "./MobileChatTopBar";
import {
  THREAD_SWITCHER_FILTERS,
  badgeForThreadItem,
  type ThreadSwitcherFilter,
  type ThreadSwitcherGroup,
} from "./thread-switcher-shared";
import TerminalDock from "./TerminalDock";
import InteractionQuestionForm, {
  type InteractionQuestionDrafts,
  updateInteractionQuestionDrafts,
} from "./InteractionQuestionForm";
import AttachmentStrip, { type PendingAttachment } from "./AttachmentStrip";
import type {
  CollaborationModeKind,
  ContextUsageSummary,
  PendingApprovalCard,
  PendingInteractionCard,
} from "./thread-page-helpers";

// Local value-shapes that ThreadPageClient declares inline (not exported
// anywhere). Mirrored here so the prop surface is precisely typed without
// adding new exports to the controller. Matches the pattern established by
// MobileThreadShell.
type StatusBanner = {
  generatedAt: string;
  lines: string[];
};

// Derived from ThreadPageClient's `pendingApprovalList` / `pendingInteractionList`
// memos, which project the full ApprovalView / InteractionView cards down to
// exactly these fields before passing them through (only `.length` is read on
// the desktop surface, but the shape is kept faithful to the controller memo).
type DesktopPendingApproval = Pick<
  PendingApprovalCard,
  "approvalId" | "type" | "reason" | "commandPreview" | "fileChangePreview"
>;
type DesktopPendingInteraction = Pick<
  PendingInteractionCard,
  "interactionId" | "questions"
>;

type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "lagging";

export type DesktopThreadShellProps = {
  sidebarVisible: boolean;
  isThinkingActive: boolean;
  isCompactViewport: boolean;
  isMobileViewport: boolean;
  isThreadSwitcherOpen: boolean;
  sidebarOpen: boolean;
  handleSidebarToggle: () => void;
  createThread: (targetProjectKey?: string) => Promise<void>;
  desktopViewMenuRef: RefObject<HTMLDivElement | null>;
  desktopViewMenuOpen: boolean;
  setDesktopViewMenuOpen: Dispatch<SetStateAction<boolean>>;
  viewMode: ThreadViewMode;
  setViewMode: Dispatch<SetStateAction<ThreadViewMode>>;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  statusBanner: StatusBanner | null;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
  terminalEnabled: boolean;
  workspaceStyle: CSSProperties | undefined;
  sidebarRef: RefObject<HTMLElement | null>;
  sidebarSearchQuery: string;
  setSidebarSearchQuery: Dispatch<SetStateAction<string>>;
  sidebarStatusFilter: ThreadSwitcherFilter;
  setSidebarStatusFilter: Dispatch<SetStateAction<ThreadSwitcherFilter>>;
  sidebarFilteredGroups: ThreadSwitcherGroup[];
  threadPreviewById: Map<string, Map<string, string>>;
  switcherCollapsedGroups: Set<string>;
  handleToggleSwitcherGroup: (groupKey: string) => void;
  threadId: string;
  registerActiveThreadCard: (node: HTMLElement | null) => void;
  threadListLoading: boolean;
  sidebarListIsEmpty: boolean;
  sidebarEmptyMessage: string;
  activeThreadTitle: string;
  threadContext: ThreadContextResponse | null;
  shortCwdLabel: string;
  thinkingBannerText: string;
  connectionState: ConnectionState;
  connectionText: string;
  desktopContextUsage: ContextUsageSummary;
  activeProjectLabel: string;
  lastSeq: number;
  collaborationMode: CollaborationModeKind;
  pendingApprovalList: DesktopPendingApproval[];
  pendingInteractionList: DesktopPendingInteraction[];
  streamingTurnCount: number;
  loading: boolean;
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
  reviewSlashCommandByTurnId: Map<string, string>;
  formatTimestamp: (value: string | null) => string;
  truncateText: (text: string, maxLength: number) => string;
  gatewayUrl: string;
  copyMessage: (text: string) => Promise<void>;
  turnProgressByTurnId: Record<string, string>;
  actionablePlanByTurnId: Record<string, string>;
  openImplementDialog: (turnId: string, planText: string) => void;
  keepPlanning: (turnId: string, planText?: string) => void;
  activeApproval: PendingApprovalCard | null;
  activeInteraction: PendingInteractionCard | null;
  desktopDockTab: "questions" | "approvals";
  setDesktopDockTab: Dispatch<SetStateAction<"questions" | "approvals">>;
  desktopQuestionDrafts: InteractionQuestionDrafts;
  updateDesktopQuestionDraft: (
    interactionId: string,
    questionId: string,
    updater: Parameters<typeof updateInteractionQuestionDrafts>[3],
  ) => void;
  answersForDesktopInteraction: (
    interaction: PendingInteractionCard,
  ) => InteractionRespondRequest["answers"] | null;
  interactionBusy: string | null;
  respondInteraction: (
    interactionId: string,
    answers: InteractionRespondRequest["answers"],
  ) => Promise<void>;
  approvalBusy: string | null;
  decideApproval: (
    approvalId: string,
    decision: ApprovalDecisionRequest["decision"],
  ) => Promise<void>;
  isComposerDragOver: boolean;
  handleComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  handleComposerDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  handleComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  handleComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  desktopFileInputRef: RefObject<HTMLInputElement | null>;
  handleDesktopFileInputChange: (
    event: ReactChangeEvent<HTMLInputElement>,
  ) => void;
  runningTurnId: string | null;
  pendingAttachments: PendingAttachment[];
  handleRemoveAttachment: (id: string) => void;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSlashMenuDismissed: Dispatch<SetStateAction<boolean>>;
  handlePromptKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  handleDesktopTextareaPaste: (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => void;
  slashMenuOpen: boolean;
  slashSuggestions: SlashCommandCatalogItem[];
  activeSlashIndex: number;
  applyPromptSlash: (command: KnownSlashCommand) => void;
  controlBusy: ThreadControlRequest["action"] | null;
  sendControl: (action: ThreadControlRequest["action"]) => Promise<void>;
  compactBusy: boolean;
  compactThread: () => Promise<void>;
  selectedModelLabel: string;
  formatEffortLabel: (value: string) => string;
  thinkingEffort: string;
  permissionModeLabel: string;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  modelOptions: ModelSelectOption[];
  thinkingEffortOptions: string[];
  setThinkingEffort: Dispatch<SetStateAction<string>>;
  permissionMode: TurnPermissionMode;
  setPermissionMode: Dispatch<SetStateAction<TurnPermissionMode>>;
  sendTurn: () => Promise<void>;
  submitting: boolean;
  terminalWidth: number;
  handleTerminalResizeStart: (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  implementDialogOpen: boolean;
  setImplementDialogOpen: Dispatch<SetStateAction<boolean>>;
  implementDraft: string;
  setImplementDraft: Dispatch<SetStateAction<string>>;
  confirmImplementPlan: () => Promise<void>;
  implementTargetTurnId: string | null;
  implementTargetPlanText: string | null;
  setImplementTargetTurnId: Dispatch<SetStateAction<string | null>>;
  setImplementTargetPlanText: Dispatch<SetStateAction<string | null>>;
};

export default function DesktopThreadShell({
  sidebarVisible,
  isThinkingActive,
  isCompactViewport,
  isMobileViewport,
  isThreadSwitcherOpen,
  sidebarOpen,
  handleSidebarToggle,
  createThread,
  desktopViewMenuRef,
  desktopViewMenuOpen,
  setDesktopViewMenuOpen,
  viewMode,
  setViewMode,
  setTerminalOpen,
  statusBanner,
  setStatusBanner,
  terminalEnabled,
  workspaceStyle,
  sidebarRef,
  sidebarSearchQuery,
  setSidebarSearchQuery,
  sidebarStatusFilter,
  setSidebarStatusFilter,
  sidebarFilteredGroups,
  threadPreviewById,
  switcherCollapsedGroups,
  handleToggleSwitcherGroup,
  threadId,
  registerActiveThreadCard,
  threadListLoading,
  sidebarListIsEmpty,
  sidebarEmptyMessage,
  activeThreadTitle,
  threadContext,
  shortCwdLabel,
  thinkingBannerText,
  connectionState,
  connectionText,
  desktopContextUsage,
  activeProjectLabel,
  lastSeq,
  collaborationMode,
  pendingApprovalList,
  pendingInteractionList,
  streamingTurnCount,
  loading,
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
  reviewSlashCommandByTurnId,
  formatTimestamp,
  truncateText,
  gatewayUrl,
  copyMessage,
  turnProgressByTurnId,
  actionablePlanByTurnId,
  openImplementDialog,
  keepPlanning,
  activeApproval,
  activeInteraction,
  desktopDockTab,
  setDesktopDockTab,
  desktopQuestionDrafts,
  updateDesktopQuestionDraft,
  answersForDesktopInteraction,
  interactionBusy,
  respondInteraction,
  approvalBusy,
  decideApproval,
  isComposerDragOver,
  handleComposerDragOver,
  handleComposerDragEnter,
  handleComposerDragLeave,
  handleComposerDrop,
  desktopFileInputRef,
  handleDesktopFileInputChange,
  runningTurnId,
  pendingAttachments,
  handleRemoveAttachment,
  prompt,
  setPrompt,
  setSlashMenuDismissed,
  handlePromptKeyDown,
  handleDesktopTextareaPaste,
  slashMenuOpen,
  slashSuggestions,
  activeSlashIndex,
  applyPromptSlash,
  controlBusy,
  sendControl,
  compactBusy,
  compactThread,
  selectedModelLabel,
  formatEffortLabel,
  thinkingEffort,
  permissionModeLabel,
  model,
  setModel,
  modelOptions,
  thinkingEffortOptions,
  setThinkingEffort,
  permissionMode,
  setPermissionMode,
  sendTurn,
  submitting,
  terminalWidth,
  handleTerminalResizeStart,
  implementDialogOpen,
  setImplementDialogOpen,
  implementDraft,
  setImplementDraft,
  confirmImplementPlan,
  implementTargetTurnId,
  implementTargetPlanText,
  setImplementTargetTurnId,
  setImplementTargetPlanText,
}: DesktopThreadShellProps) {
  return (
    <div
      className={`cdx-app ${sidebarVisible ? "" : "cdx-app--sidebar-collapsed"} ${
        isThinkingActive ? "cdx-app--thinking" : ""
      }`}
    >
      <header
        className={`cdx-topbar ${isCompactViewport ? "cdx-topbar--compact" : ""} ${
          isMobileViewport ? "cdx-topbar--mobile" : ""
        }`}
      >
        <div className="cdx-topbar-group">
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--icon"
            title={
              isMobileViewport
                ? isThreadSwitcherOpen
                  ? "Hide thread switcher"
                  : "Show thread switcher"
                : sidebarOpen
                  ? "Hide sidebar"
                  : "Show sidebar"
            }
            onClick={handleSidebarToggle}
          >
            ≡
          </button>
          <button
            type="button"
            className="cdx-toolbar-btn cdx-toolbar-btn--solid cdx-toolbar-btn--thread"
            onClick={() => void createThread()}
          >
            New thread
          </button>
        </div>
        <div className="cdx-topbar-group cdx-topbar-group--right">
          {!isMobileViewport ? (
            <>
              <div
                className="cdx-topbar-view-menu-anchor"
                ref={desktopViewMenuRef}
              >
                <button
                  type="button"
                  className="cdx-toolbar-btn"
                  data-testid="desktop-topbar-views-toggle"
                  aria-haspopup="menu"
                  aria-expanded={desktopViewMenuOpen}
                  aria-label="Switch view mode"
                  onClick={() => setDesktopViewMenuOpen((value) => !value)}
                >
                  Views: {viewMode === "normal" ? "Normal" : viewMode === "thinking" ? "Thinking" : "Verbose"}
                  <span aria-hidden="true" style={{ marginLeft: 6, opacity: 0.6 }}>▾</span>
                </button>
                {desktopViewMenuOpen ? (
                  <div
                    className="cdx-topbar-view-menu"
                    role="menu"
                    data-testid="desktop-topbar-views-menu"
                  >
                    {VIEW_MODE_OPTIONS.map((option) => {
                      const active = option.value === viewMode;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={`cdx-topbar-view-menu-item ${active ? "is-active" : ""}`}
                          data-testid={`desktop-topbar-views-${option.value}`}
                          onClick={() => {
                            setViewMode(option.value);
                            setDesktopViewMenuOpen(false);
                          }}
                        >
                          <span className="cdx-topbar-view-menu-item-label">{option.label}</span>
                          <span className="cdx-topbar-view-menu-item-desc">{option.description}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <div className="cdx-toolbar-segment">
                <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--segment-start">
                  Open
                </button>
                <button type="button" className="cdx-toolbar-btn cdx-toolbar-btn--segment-end" aria-label="Secondary action">
                  ▾
                </button>
              </div>
              <button
                type="button"
                className="cdx-toolbar-btn cdx-toolbar-btn--icon"
                aria-label="Toggle terminal"
                title="Toggle terminal (Cmd+J)"
                onClick={() => setTerminalOpen((v) => !v)}
              >
                ▦
              </button>
              <button type="button" className="cdx-toolbar-btn" disabled>
                Pop out
              </button>
            </>
          ) : null}
        </div>
      </header>

      {statusBanner ? (
        <div className="cdx-status-banner" data-testid="status-banner">
          <span>{statusBanner.lines[0]}</span>
          <span>{statusBanner.lines[1]}</span>
          <span>{statusBanner.lines[2]}</span>
          <button
            type="button"
            className="cdx-status-banner-close"
            data-testid="status-banner-close"
            aria-label="Dismiss status"
            onClick={() => setStatusBanner(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        className={`cdx-workspace cdx-workspace--thread ${
          terminalEnabled ? "cdx-workspace--with-terminal" : ""
        }`}
        style={workspaceStyle}
      >
        {sidebarVisible ? (
          <aside className="cdx-sidebar" ref={sidebarRef}>
            <div className="cdx-sidebar-actions">
              <button
                type="button"
                className="cdx-sidebar-action cdx-sidebar-action--active"
                data-testid="desktop-sidebar-new-thread"
                onClick={() => void createThread()}
              >
                New thread
              </button>
              <button type="button" className="cdx-sidebar-action" disabled>
                Automations
              </button>
              <button type="button" className="cdx-sidebar-action" disabled>
                Skills & Apps
              </button>
            </div>
            <div className="cdx-sidebar-label">Threads</div>
            <div className="cdx-sidebar-search">
              <input
                type="search"
                className="cdx-sidebar-search-input"
                data-testid="desktop-thread-search"
                placeholder="Search threads"
                value={sidebarSearchQuery}
                onChange={(event) => setSidebarSearchQuery(event.target.value)}
                aria-label="Search threads"
              />
            </div>
            <div
              className="cdx-sidebar-filters"
              role="tablist"
              aria-label="Filter threads by status"
            >
              {THREAD_SWITCHER_FILTERS.map((option) => {
                const active = option.value === sidebarStatusFilter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`cdx-sidebar-filter ${active ? "is-active" : ""}`}
                    data-testid={`desktop-thread-filter-${option.value}`}
                    onClick={() => setSidebarStatusFilter(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="cdx-project-tree">
              {sidebarFilteredGroups.map((group) => {
                if (group.items.length === 0) {
                  // Hide entirely-empty groups so collapsed/filtered project
                  // headers don't pile up under the search bar.
                  return null;
                }
                const previewByThreadId = threadPreviewById.get(group.key) ?? new Map<string, string>();
                const collapsed = switcherCollapsedGroups.has(group.key);
                return (
                  <section
                    key={group.key}
                    className={`cdx-project-group ${collapsed ? "is-collapsed" : ""}`}
                  >
                    <div className="cdx-project-title">
                      <button
                        type="button"
                        className="cdx-project-title-toggle"
                        data-testid={`desktop-thread-group-toggle-${group.key}`}
                        aria-expanded={!collapsed}
                        aria-controls={`desktop-group-${group.key}`}
                        onClick={() => handleToggleSwitcherGroup(group.key)}
                      >
                        <span className="cdx-project-title-caret" aria-hidden="true">
                          {collapsed ? "▸" : "▾"}
                        </span>
                        <span className="cdx-project-title-label">{group.label}</span>
                      </button>
                      <span className="cdx-project-title-actions">
                        <span className="cdx-helper">{group.items.length}</span>
                        <button
                          type="button"
                          className="cdx-mini-btn"
                          data-testid={`desktop-thread-group-new-${group.key}`}
                          aria-label={`New thread in ${group.label}`}
                          title={`New thread in ${group.label}`}
                          onClick={() => void createThread(group.key)}
                        >
                          +
                        </button>
                      </span>
                    </div>
                    {collapsed ? null : (
                    <div className="cdx-thread-list" id={`desktop-group-${group.key}`}>
                      {group.items.map((item) => {
                        const badge = badgeForThreadItem(item);
                        const preview = previewByThreadId.get(item.id) ?? "";
                        return (
                          <Link
                            href={`/threads/${item.id}`}
                            key={item.id}
                            data-testid={`thread-link-${item.id}`}
                          >
                            <article
                              ref={item.id === threadId ? registerActiveThreadCard : null}
                              className={`cdx-thread-item ${item.isActive ? "is-active" : ""}`}
                              data-status={badge.kind}
                              data-testid={`thread-status-${item.id}`}
                            >
                              <div className="cdx-thread-item-head">
                                <h3 title={item.title}>{item.title}</h3>
                                <span
                                  className={`cdx-thread-item-badge cdx-thread-item-badge--${badge.kind}`}
                                  data-testid={`thread-status-badge-${item.id}`}
                                >
                                  {badge.label}
                                </span>
                              </div>
                              <p>{preview || "(empty preview)"}</p>
                              <span>{item.lastActiveAt}</span>
                            </article>
                          </Link>
                        );
                      })}
                    </div>
                    )}
                  </section>
                );
              })}
              {threadListLoading ? <p className="cdx-helper">Loading thread list...</p> : null}
              {!threadListLoading && sidebarListIsEmpty ? (
                <p className="cdx-helper" data-testid="desktop-thread-empty">
                  {sidebarEmptyMessage}
                </p>
              ) : null}
            </div>
          </aside>
        ) : null}

        <main className={`cdx-main ${isCompactViewport ? "cdx-main--compact" : ""}`}>
          <section className="cdx-hero cdx-hero--thread">
            <div className="cdx-hero-row">
              <div className="cdx-hero-identity">
                <h1 data-testid="thread-title">{activeThreadTitle}</h1>
                <p className="cdx-thread-context" title={threadContext?.resolvedCwd ?? undefined}>
                  {shortCwdLabel}
                </p>
              </div>
              <div className="cdx-hero-row-end">
                {isThinkingActive ? (
                  <span className="cdx-thinking-pill" aria-live="polite" data-testid="desktop-thinking-pill">
                    <span className="cdx-thinking-pill-dot" aria-hidden="true" />
                    {thinkingBannerText}
                  </span>
                ) : null}
                <span className={`cdx-status ${statusClass(connectionState === "connected" ? "completed" : "unknown")}`}>
                  {connectionText}
                </span>
                <span
                  data-testid="desktop-context-usage"
                  title={desktopContextUsage.label}
                  className={`cdx-status ${
                    desktopContextUsage.level === "high"
                      ? "is-offline"
                      : desktopContextUsage.level === "medium"
                        ? "is-pending"
                        : "is-online"
                  }`}
                >
                  {desktopContextUsage.label}
                </span>
                <button type="button" className="cdx-project-chip">
                  {activeProjectLabel}
                </button>
              </div>
            </div>
            <details className="cdx-thread-details">
              <summary>Details</summary>
              <div className="cdx-status-row cdx-status-row--details">
                <span className="cdx-status cdx-status--quiet">
                  thread {threadId} · seq <span data-testid="event-cursor">{lastSeq}</span>
                </span>
                <span
                  data-testid="collaboration-mode"
                  className={`cdx-status ${
                    collaborationMode === "plan" ? "is-pending" : "is-online"
                  }`}
                >
                  mode: {collaborationMode}
                </span>
                <span className="cdx-status is-pending">Pending approval: {pendingApprovalList.length}</span>
                <span className="cdx-status is-pending">
                  Pending questions: {pendingInteractionList.length}
                </span>
                <span
                  className={`cdx-status ${
                    threadContext?.isFallback ? "is-offline" : "is-online"
                  }`}
                >
                  {threadContext?.isFallback
                    ? "cwd unknown"
                    : `cwd: ${threadContext?.resolvedCwd ?? "-"}`}
                </span>
                <Link href="/">
                  <button type="button" className="cdx-toolbar-btn">
                    Home
                  </button>
                </Link>
              </div>
            </details>
            {isThinkingActive ? (
              <p className="cdx-helper cdx-helper--thinking cdx-live-activity">
                Live activity: {streamingTurnCount > 0 ? `${streamingTurnCount} turn(s) streaming` : "awaiting first tokens"}
              </p>
            ) : null}
            {loading ? <p className="cdx-helper">Loading thread...</p> : null}
            {error ? <p className="cdx-error">{error}</p> : null}
            {submitError ? <p className="cdx-error">{submitError}</p> : null}
            {approvalError ? <p className="cdx-error">{approvalError}</p> : null}
            {interactionError ? <p className="cdx-error">{interactionError}</p> : null}
            {controlError ? <p className="cdx-error">{controlError}</p> : null}
            {modelCatalogError ? (
              <p className="cdx-helper">Model catalog unavailable ({modelCatalogError}); using fallback list.</p>
            ) : null}
          </section>

          <section
            className="cdx-timeline"
            data-testid="timeline"
            ref={timelineRef}
            onScroll={handleTimelineScroll}
          >
            {isThinkingActive &&
            visibleConversationTurns.filter(
              (turn) => !turn.turnId.startsWith("pending-"),
            ).length === 0 ? (
              <section
                className="cdx-thinking-placeholder cdx-thinking-placeholder--global"
                aria-live="polite"
                data-testid="desktop-thinking-placeholder"
              >
                <header className="cdx-thinking-placeholder-head">
                  <span className="cdx-stream-indicator">
                    <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                    Codex is thinking
                  </span>
                </header>
                <div className="cdx-thinking-placeholder-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </section>
            ) : null}
            {hiddenTimelineCount > 0 && !showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(true)}
              >
                {hiddenTimelineCount} previous turns
              </button>
            ) : null}

            {hiddenTimelineCount > 0 && showAllTurns ? (
              <button
                type="button"
                className="cdx-toolbar-btn cdx-timeline-toggle"
                onClick={() => setShowAllTurns(false)}
              >
                Show fewer turns
              </button>
            ) : null}

            {visibleConversationTurns.length === 0 ? (
              <p className="cdx-helper">No conversation yet.</p>
            ) : (
              visibleConversationTurns.map((turn) => {
                const reviewSlashCommand = reviewSlashCommandByTurnId.get(turn.turnId) ?? null;
                const segments = turn.segments;
                // Mirror the mobile MobileMessageStream pattern: when the
                // segment narrative has produced no entries yet (very early
                // in a stream) we fall back to the aggregated user/assistant
                // text so the user still sees the most recent output. When
                // segments exist we walk them in chronological order, so
                // multi-segment assistant turns (commentary → tools → final)
                // render each agent_message as its own card instead of
                // collapsing to the longest one.
                const fallbackUserDisplayText =
                  segments.length === 0 ? reviewSlashCommand ?? turn.userText : null;
                const lastAssistantIndex = (() => {
                  for (let i = segments.length - 1; i >= 0; i -= 1) {
                    if (segments[i].kind === "assistant") return i;
                  }
                  return -1;
                })();
                const hasAssistantSegment = lastAssistantIndex !== -1;
                const fallbackAssistantText =
                  !hasAssistantSegment && turn.assistantText ? turn.assistantText : null;
                // Live reasoning deltas only land in `turn.thinkingText`;
                // segments don't get a `thinking` entry until a completed
                // reasoning item arrives. Without this fallback the
                // Thinking/Verbose view modes look empty during the most
                // valuable window of the stream. Render a card styled like
                // a thinking segment off of the live buffer until a real
                // segment shows up.
                const hasThinkingSegment = segments.some((s) => s.kind === "thinking");
                const shouldShowStreamingThinkingFallback =
                  viewMode !== "normal" &&
                  turn.isStreaming &&
                  !hasThinkingSegment &&
                  Boolean(turn.thinkingText);
                const emptyAssistantStateText = turn.isStreaming
                  ? "Codex is responding..."
                  : turn.status === "interrupted"
                    ? "Interrupted"
                    : turn.status === "failed"
                      ? "Failed"
                      : "No response.";
                return (
                  <article
                    className={`cdx-turn-card cdx-turn-card--conversation ${
                      turn.isStreaming ? "cdx-turn-card--streaming" : ""
                    } ${turn.thinkingText ? "cdx-turn-card--has-thinking" : ""}`}
                    key={turn.turnId}
                  >
                    <div className="cdx-turn-head">
                      <strong>Turn</strong>
                      <div className="cdx-turn-state">
                        {turn.isStreaming ? (
                          <span className="cdx-stream-indicator" aria-live="polite">
                            <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                            Responding
                          </span>
                        ) : null}
                        <span className={`cdx-status ${statusClass(turn.status)}`}>
                          {statusLabel(turn.status)}
                        </span>
                      </div>
                    </div>
                    <p className="cdx-turn-meta">
                      {formatTimestamp(turn.startedAt)} · turn {turn.turnId}
                    </p>
                    {fallbackUserDisplayText ? (
                      <section className="cdx-message cdx-message--user">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">You</strong>
                          {reviewSlashCommand ? <span className="cdx-status is-pending">slash command</span> : null}
                        </div>
                        <pre className="cdx-turn-body">{truncateText(fallbackUserDisplayText, 9000)}</pre>
                      </section>
                    ) : null}
                    {/*
                      Chronological segment loop. Mirrors the mobile
                      MobileMessageStream layout: every assistant segment
                      renders its own bubble, tool batches always surface a
                      semantic pill summary, raw call/output only renders in
                      Verbose, thinking rows hide in Normal. The desktop
                      `Echo:` smoke test still finds the text because each
                      assistant segment renders its markdown inside the
                      timeline element.
                    */}
                    {segments.length > 0 ? (
                      <div
                        className="cdx-message-stack cdx-message-stack--details"
                        data-testid="desktop-turn-segments"
                        data-view-mode={viewMode}
                      >
                        {segments.map((segment, index) => {
                          const key = `${turn.turnId}-desktop-seg-${index}`;
                          if (segment.kind === "user") {
                            const isFirstUser =
                              segments.findIndex((s) => s.kind === "user") === index;
                            const displayText =
                              isFirstUser && reviewSlashCommand
                                ? reviewSlashCommand
                                : segment.text;
                            return (
                              <section
                                key={key}
                                className={`cdx-message cdx-message--user ${segment.isSteer ? "is-steer" : ""}`}
                                data-testid={segment.isSteer ? "desktop-user-steer" : "desktop-user-message"}
                              >
                                <div className="cdx-message-meta">
                                  <strong className="cdx-message-role">
                                    {segment.isSteer ? "You · steered" : "You"}
                                  </strong>
                                  {isFirstUser && reviewSlashCommand ? (
                                    <span className="cdx-status is-pending">slash command</span>
                                  ) : null}
                                </div>
                                {segment.images && segment.images.length > 0 ? (
                                  <div
                                    className="cdx-message-images"
                                    data-testid="desktop-user-images"
                                  >
                                    {segment.images.map((src, imgIdx) => (
                                      <img
                                        key={`${key}-img-${imgIdx}`}
                                        src={resolveImageSrc(src, gatewayUrl)}
                                        alt={`attachment ${imgIdx + 1}`}
                                        className="cdx-message-image"
                                      />
                                    ))}
                                  </div>
                                ) : null}
                                {displayText ? (
                                  <pre className="cdx-turn-body">
                                    {truncateText(displayText, 9000)}
                                  </pre>
                                ) : null}
                              </section>
                            );
                          }
                          if (segment.kind === "assistant") {
                            const isLastAssistant = index === lastAssistantIndex;
                            return (
                              <section
                                key={key}
                                className={`cdx-message cdx-message--assistant ${
                                  turn.isStreaming && isLastAssistant ? "cdx-message--assistant-streaming" : ""
                                }`}
                                data-testid="desktop-assistant-segment"
                              >
                                {turn.isStreaming && isLastAssistant ? (
                                  <span className="cdx-message-live-rail" aria-hidden="true" />
                                ) : null}
                                <div className="cdx-message-meta">
                                  <strong className="cdx-message-role">Codex</strong>
                                  <button
                                    type="button"
                                    className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                                    onClick={() => void copyMessage(segment.text)}
                                  >
                                    Copy
                                  </button>
                                </div>
                                <div className="cdx-turn-body cdx-turn-body--md">
                                  <MarkdownText text={truncateText(segment.text, 9000)} gatewayUrl={gatewayUrl} />
                                  {turn.isStreaming && isLastAssistant ? (
                                    <span className="cdx-stream-cursor" aria-hidden="true" />
                                  ) : null}
                                </div>
                              </section>
                            );
                          }
                          if (segment.kind === "thinking") {
                            if (viewMode === "normal") return null;
                            return (
                              <details
                                key={key}
                                className="cdx-message cdx-message--detail cdx-desktop-thinking"
                                data-testid="desktop-thinking-segment"
                              >
                                <summary className="cdx-message-meta">
                                  <strong className="cdx-message-role">Thinking</strong>
                                </summary>
                                <div className="cdx-turn-body cdx-turn-body--md">
                                  <MarkdownText text={truncateText(segment.text, 6000)} gatewayUrl={gatewayUrl} />
                                </div>
                              </details>
                            );
                          }
                          if (segment.kind === "toolBatch") {
                            const actionRows = segment.items
                              .map((item, itemIndex) => ({
                                item,
                                itemIndex,
                                action: summarizeToolAction(item),
                              }))
                              .filter((row) => row.action !== null);
                            const showRawDetail = viewMode === "verbose";
                            return (
                              <section
                                key={key}
                                className="cdx-message cdx-message--detail cdx-desktop-tool-batch"
                                data-testid="desktop-tool-batch"
                                data-view-mode={viewMode}
                              >
                                <div className="cdx-desktop-tool-batch-summary">
                                  <span className="cdx-desktop-tool-batch-icon" aria-hidden="true">⚙</span>
                                  <span className="cdx-desktop-tool-batch-text">{segment.summary}</span>
                                </div>
                                <ul
                                  className="cdx-desktop-tool-action-list"
                                  data-testid="desktop-tool-action-list"
                                >
                                  {actionRows.map(({ action, itemIndex }) => {
                                    if (!action) return null;
                                    return (
                                      <li
                                        key={`${key}-action-${itemIndex}`}
                                        className={`cdx-desktop-tool-action cdx-desktop-tool-action--${action.kind}`}
                                        data-testid="desktop-tool-action"
                                        data-kind={action.kind}
                                      >
                                        <span className="cdx-desktop-tool-action-label">{action.label}</span>
                                      </li>
                                    );
                                  })}
                                </ul>
                                {showRawDetail ? (
                                  <details
                                    className="cdx-desktop-tool-batch-raw"
                                    data-testid="desktop-tool-batch-raw"
                                    open
                                  >
                                    <summary className="cdx-desktop-tool-batch-raw-summary">
                                      Raw call/output
                                    </summary>
                                    <div className="cdx-desktop-tool-batch-body">
                                      {segment.items.map((item, itemIndex) => {
                                        const itemKey = `${key}-raw-${itemIndex}`;
                                        if (item.kind === "toolCall") {
                                          return (
                                            <section
                                              key={itemKey}
                                              className="cdx-message cdx-message--tool"
                                              data-testid="desktop-tool-raw-call"
                                            >
                                              <div className="cdx-message-meta">
                                                <strong className="cdx-message-role">
                                                  Tool call: {item.toolName}
                                                </strong>
                                              </div>
                                              {item.text ? (
                                                <pre className="cdx-turn-body">
                                                  {truncateText(item.text, 4500)}
                                                </pre>
                                              ) : null}
                                            </section>
                                          );
                                        }
                                        if (item.kind === "toolResult") {
                                          return (
                                            <section
                                              key={itemKey}
                                              className="cdx-message cdx-message--detail"
                                              data-testid="desktop-tool-raw-output"
                                            >
                                              <div className="cdx-message-meta">
                                                <strong className="cdx-message-role">Tool output</strong>
                                              </div>
                                              <pre className="cdx-turn-body">
                                                {truncateText(item.text, 4500)}
                                              </pre>
                                            </section>
                                          );
                                        }
                                        return null;
                                      })}
                                    </div>
                                  </details>
                                ) : null}
                              </section>
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : null}
                    {shouldShowStreamingThinkingFallback ? (
                      <details
                        className="cdx-message cdx-message--detail cdx-desktop-thinking"
                        data-testid="desktop-thinking-streaming-fallback"
                        open
                      >
                        <summary className="cdx-message-meta">
                          <strong className="cdx-message-role">Thinking</strong>
                          <span className="cdx-stream-indicator" aria-live="polite">
                            <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                            Live
                          </span>
                        </summary>
                        <div className="cdx-turn-body cdx-turn-body--md">
                          <MarkdownText text={truncateText(turn.thinkingText ?? "", 6000)} gatewayUrl={gatewayUrl} />
                          <span className="cdx-stream-cursor" aria-hidden="true" />
                        </div>
                      </details>
                    ) : null}
                    {fallbackAssistantText ? (
                      <section
                        className={`cdx-message cdx-message--assistant ${
                          turn.isStreaming ? "cdx-message--assistant-streaming" : ""
                        }`}
                        data-testid="desktop-assistant-fallback"
                      >
                        {turn.isStreaming ? (
                          <span className="cdx-message-live-rail" aria-hidden="true" />
                        ) : null}
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Codex</strong>
                          <button
                            type="button"
                            className="cdx-toolbar-btn cdx-toolbar-btn--small cdx-event-copy"
                            onClick={() => void copyMessage(fallbackAssistantText)}
                          >
                            Copy
                          </button>
                        </div>
                        <div className="cdx-turn-body cdx-turn-body--md">
                          <MarkdownText text={truncateText(fallbackAssistantText, 9000)} gatewayUrl={gatewayUrl} />
                          {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                        </div>
                      </section>
                    ) : !hasAssistantSegment && turn.isStreaming ? (
                      <section className="cdx-thinking-placeholder" aria-live="polite">
                        <header className="cdx-thinking-placeholder-head">
                          <span className="cdx-stream-indicator">
                            <span className="cdx-stream-indicator-dot" aria-hidden="true" />
                            Codex is responding
                          </span>
                        </header>
                        <div className="cdx-thinking-placeholder-bars" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </div>
                        <p className="cdx-helper cdx-helper--streaming">Codex is responding...</p>
                      </section>
                    ) : !hasAssistantSegment ? (
                      <p className={`cdx-helper ${turn.isStreaming ? "cdx-helper--streaming" : ""}`}>
                        {emptyAssistantStateText}
                      </p>
                    ) : null}
                    {turnProgressByTurnId[turn.turnId] ? (
                      <section
                        className="cdx-message cdx-message--detail cdx-turn-progress-card"
                        data-testid="turn-progress-card"
                      >
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Codex tasks</strong>
                        </div>
                        <pre className="cdx-turn-body cdx-turn-body--plan">
                          {truncateText(turnProgressByTurnId[turn.turnId], 4000)}
                        </pre>
                      </section>
                    ) : null}
                    {actionablePlanByTurnId[turn.turnId] ? (
                      <section className="cdx-message cdx-message--detail cdx-plan-ready-card">
                        <div className="cdx-message-meta">
                          <strong className="cdx-message-role">Plan ready</strong>
                        </div>
                        <pre className="cdx-turn-body cdx-turn-body--plan">
                          {truncateText(actionablePlanByTurnId[turn.turnId], 4000)}
                        </pre>
                        <div className="cdx-inline-actions">
                          <button
                            type="button"
                            className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                            onClick={() => openImplementDialog(turn.turnId, actionablePlanByTurnId[turn.turnId])}
                          >
                            Implement this plan
                          </button>
                          <button
                            type="button"
                            className="cdx-toolbar-btn"
                            onClick={() => keepPlanning(turn.turnId, actionablePlanByTurnId[turn.turnId])}
                          >
                            Keep planning
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>

          {activeApproval || activeInteraction ? (
            <aside data-testid="approval-drawer" className="cdx-approval-dock">
              <div className="cdx-inline-actions">
                <button
                  type="button"
                  className={`cdx-toolbar-btn ${desktopDockTab === "questions" ? "cdx-toolbar-btn--solid" : ""}`}
                  onClick={() => setDesktopDockTab("questions")}
                >
                  Questions ({pendingInteractionList.length})
                </button>
                <button
                  type="button"
                  className={`cdx-toolbar-btn ${desktopDockTab === "approvals" ? "cdx-toolbar-btn--solid" : ""}`}
                  onClick={() => setDesktopDockTab("approvals")}
                >
                  Approvals ({pendingApprovalList.length})
                </button>
              </div>
              {desktopDockTab === "questions" ? (
                activeInteraction ? (
                  <>
                    <div className="cdx-turn-head">
                      <strong>Questions Required</strong>
                      <span className="cdx-status is-pending">pending</span>
                    </div>
                    <InteractionQuestionForm
                      interactionId={activeInteraction.interactionId}
                      namePrefix="desktop"
                      questions={activeInteraction.questions}
                      drafts={desktopQuestionDrafts}
                      onDraftChange={updateDesktopQuestionDraft}
                    />
                    <button
                      type="button"
                      data-testid="interaction-submit"
                      className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                      disabled={
                        interactionBusy !== null ||
                        !answersForDesktopInteraction(activeInteraction)
                      }
                      onClick={() => {
                        const answers = answersForDesktopInteraction(activeInteraction);
                        if (!answers) {
                          return;
                        }
                        void respondInteraction(activeInteraction.interactionId, answers);
                      }}
                    >
                      Submit answers
                    </button>
                  </>
                ) : (
                  <p className="cdx-helper">No pending questions.</p>
                )
              ) : activeApproval ? (
                <>
                  <div className="cdx-turn-head">
                    <strong>Approval Required</strong>
                    <span className="cdx-status is-pending">{activeApproval.type}</span>
                  </div>
                  <p>{activeApproval.reason ?? "This action requires your decision."}</p>
                  {activeApproval.commandPreview ? (
                    <pre className="cdx-turn-body">{activeApproval.commandPreview}</pre>
                  ) : null}
                  {activeApproval.fileChangePreview ? <p>target: {activeApproval.fileChangePreview}</p> : null}
                  <div className="cdx-inline-actions">
                    <button
                      type="button"
                      data-testid="approval-allow"
                      className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                      disabled={approvalBusy === activeApproval.approvalId}
                      onClick={() => void decideApproval(activeApproval.approvalId, "allow")}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      data-testid="approval-deny"
                      className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                      disabled={approvalBusy === activeApproval.approvalId}
                      onClick={() => void decideApproval(activeApproval.approvalId, "deny")}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      data-testid="approval-cancel"
                      className="cdx-toolbar-btn"
                      disabled={approvalBusy === activeApproval.approvalId}
                      onClick={() => void decideApproval(activeApproval.approvalId, "cancel")}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p className="cdx-helper">No pending approvals.</p>
              )}
            </aside>
          ) : null}

          <section
            className={`cdx-composer ${isComposerDragOver ? "is-drag-over" : ""}`}
            data-testid="desktop-composer"
            onDragOver={handleComposerDragOver}
            onDragEnter={handleComposerDragEnter}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
          >
            <input
              ref={desktopFileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="cdx-mobile-file-input"
              data-testid="desktop-composer-file-input"
              onChange={handleDesktopFileInputChange}
            />
            <div className="cdx-composer-tools">
              <button
                type="button"
                className="cdx-toolbar-btn cdx-composer-attach-btn"
                data-testid="desktop-composer-add-image"
                onClick={() => desktopFileInputRef.current?.click()}
                disabled={runningTurnId !== null}
                title={
                  runningTurnId !== null
                    ? "Wait for the current turn to finish"
                    : "Attach images (or just paste a screenshot)"
                }
              >
                📎 Add image
              </button>
            </div>
            {pendingAttachments.length > 0 ? (
              <AttachmentStrip
                attachments={pendingAttachments}
                onRemove={handleRemoveAttachment}
              />
            ) : null}
            <textarea
              id="turn-input"
              data-testid="turn-input"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setSlashMenuDismissed(false);
              }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handleDesktopTextareaPaste}
              placeholder="Ask Codex anything, / for commands"
              rows={3}
            />
            {slashMenuOpen ? (
              <div className="cdx-slash-menu" role="listbox" aria-label="Slash command suggestions" data-testid="thread-slash-menu">
                {slashSuggestions.map((item, index) => {
                  const active = index === activeSlashIndex;
                  return (
                    <button
                      key={item.command}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`cdx-slash-item ${active ? "is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyPromptSlash(item.command);
                      }}
                    >
                      <span className="cdx-slash-item-command">{item.title}</span>
                      <span className="cdx-slash-item-desc">{item.description}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className={`cdx-composer-row ${isMobileViewport ? "cdx-composer-row--mobile" : ""}`}>
              {isMobileViewport ? null : (
                <div className="cdx-composer-left">
                  <details className="cdx-composer-more">
                    <summary>Actions</summary>
                    <div className="cdx-inline-actions cdx-inline-actions--panel">
                      <button
                        type="button"
                        data-testid="control-stop"
                        className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                        disabled={controlBusy !== null}
                        onClick={() => void sendControl("stop")}
                      >
                        {controlBusy === "stop" ? "Stopping..." : "Stop"}
                      </button>
                      <button
                        type="button"
                        data-testid="control-retry"
                        className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                        disabled={controlBusy !== null}
                        onClick={() => void sendControl("retry")}
                      >
                        {controlBusy === "retry" ? "Retrying..." : "Retry"}
                      </button>
                      <button
                        type="button"
                        data-testid="control-cancel"
                        className="cdx-toolbar-btn"
                        disabled={controlBusy !== null}
                        onClick={() => void sendControl("cancel")}
                      >
                        {controlBusy === "cancel" ? "Cancelling..." : "Cancel"}
                      </button>
                      <button
                        type="button"
                        data-testid="control-compact"
                        className="cdx-toolbar-btn"
                        disabled={compactBusy || runningTurnId !== null}
                        title={
                          runningTurnId !== null
                            ? "對話進行中,無法 compact"
                            : "Compact conversation history"
                        }
                        aria-label={
                          runningTurnId !== null
                            ? "對話進行中,無法 compact"
                            : "Compact conversation history"
                        }
                        onClick={() => void compactThread()}
                      >
                        {compactBusy ? "Compacting..." : "Compact"}
                      </button>
                    </div>
                  </details>
                  <details className="cdx-composer-more cdx-composer-hints">
                    <summary>Shortcuts</summary>
                    <p className="cdx-helper">
                      Mode: {collaborationMode} · Pending questions: {pendingInteractionList.length} · Shift+Tab toggle · /plan /review /status
                    </p>
                  </details>
                </div>
              )}
              {isMobileViewport ? (
                <p className="cdx-helper">
                  Mode: {collaborationMode} · Pending questions: {pendingInteractionList.length} · Shift+Tab toggle · /plan /review /status
                </p>
              ) : null}
              <div className={`cdx-composer-right ${isMobileViewport ? "cdx-composer-right--mobile" : ""}`}>
                <details className="cdx-composer-more cdx-composer-settings">
                  <summary>
                    {selectedModelLabel} · {formatEffortLabel(thinkingEffort)} · {permissionModeLabel}
                  </summary>
                  <div className="cdx-composer-settings-panel">
                    <label
                      className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                      htmlFor="model"
                    >
                      <span>Model</span>
                      <select
                        id="model"
                        value={model}
                        onChange={(event) => {
                          setModel(event.target.value);
                        }}
                      >
                        {modelOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label
                      className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                      htmlFor="thinking-effort"
                    >
                      <span>Thinking</span>
                      <select
                        id="thinking-effort"
                        value={thinkingEffort}
                        onChange={(event) => {
                          setThinkingEffort(event.target.value);
                        }}
                      >
                        {thinkingEffortOptions.map((effort) => (
                          <option key={effort} value={effort}>
                            {formatEffortLabel(effort)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label
                      className={`cdx-composer-select ${isMobileViewport ? "cdx-composer-select--mobile" : ""}`}
                      htmlFor="permission-mode"
                    >
                      <span>Permission</span>
                      <select
                        id="permission-mode"
                        value={permissionMode}
                        onChange={(event) => {
                          const next = event.target.value;
                          if (next === "local" || next === "auto" || next === "full-access") {
                            setPermissionMode(next);
                          }
                        }}
                      >
                        <option value="local">Local (on-request)</option>
                        <option value="auto">Auto review</option>
                        <option value="full-access">Full access (never)</option>
                      </select>
                    </label>
                  </div>
                </details>
                <button
                  type="button"
                  data-testid="turn-submit"
                  className={`cdx-send-btn ${isMobileViewport ? "cdx-send-btn--mobile" : ""}`}
                  onClick={() => void sendTurn()}
                  disabled={
                    submitting
                    || pendingAttachments.some((a) => a.status === "uploading")
                    || (prompt.trim().length === 0
                      && !pendingAttachments.some((a) => a.status === "ready"))
                  }
                >
                  {submitting ? "Working..." : "Send"}
                </button>
              </div>
            </div>
          </section>
        </main>

        {terminalEnabled ? (
          <TerminalDock
            gatewayUrl={gatewayUrl}
            threadId={threadId}
            width={terminalWidth}
            context={threadContext}
            onResizeStart={handleTerminalResizeStart}
            onClose={() => setTerminalOpen(false)}
          />
        ) : null}
      </div>

      {implementDialogOpen ? (
        <div
          className="cdx-implement-overlay"
          data-testid="implement-dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setImplementDialogOpen(false);
            }
          }}
        >
          <section className="cdx-implement-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="cdx-turn-head">
              <strong>Implement plan</strong>
            </div>
            <textarea
              data-testid="implement-draft-input"
              value={implementDraft}
              onChange={(event) => setImplementDraft(event.target.value)}
              rows={12}
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
        </div>
      ) : null}

    </div>
  );
}
