"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceTier } from "@lcwa/shared-types";

export type ThreadViewMode = "normal" | "thinking" | "verbose";
/**
 * @deprecated Use {@link ThreadViewMode}. Retained for tests/imports that
 * predate the desktop view-mode toggle being wired up.
 */
export type MobileViewMode = ThreadViewMode;

export const VIEW_MODE_OPTIONS: Array<{
  value: ThreadViewMode;
  label: string;
  description: string;
}> = [
  { value: "normal", label: "Normal", description: "Hide reasoning and raw tool detail" },
  { value: "thinking", label: "Thinking", description: "Show reasoning collapsibles" },
  { value: "verbose", label: "Verbose", description: "Show full tool call/output detail" },
];

type MobileChatTopBarProps = {
  projectLabel: string | null;
  threadTitle: string;
  collaborationMode: "plan" | "default";
  serviceTier: ServiceTier | null;
  pendingActionCount: number;
  isWorking: boolean;
  workingLabel: string;
  runningTurnId: string | null;
  stopBusy: boolean;
  viewMode: ThreadViewMode;
  canvasDisabled?: boolean;
  onViewModeChange: (mode: ThreadViewMode) => void;
  onOpenThreads: () => void;
  onOpenCanvas: () => void;
  onOpenControls: () => void;
  onOpenMoreControls?: () => void;
  onStop: (turnId: string) => void;
};

export default function MobileChatTopBar({
  projectLabel,
  threadTitle,
  collaborationMode,
  pendingActionCount,
  isWorking,
  workingLabel,
  runningTurnId,
  stopBusy,
  viewMode,
  canvasDisabled = false,
  onViewModeChange,
  onOpenThreads,
  onOpenCanvas,
  onOpenControls,
  onOpenMoreControls: _onOpenMoreControls,
  onStop,
}: MobileChatTopBarProps) {
  const planActive = collaborationMode === "plan";
  // "flex" tier is no longer offered (API rejects it on this plan; see
  // configRoutes allowlist), so there is no Flex pill to surface.
  const hasPill = planActive;
  const isRunning = runningTurnId !== null;

  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewMenuOpen) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (!viewMenuRef.current) return;
      if (!viewMenuRef.current.contains(event.target as Node)) {
        setViewMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [viewMenuOpen]);

  // A pending approval or interaction is a blocking foreground action — the
  // user's next move has to be approve/deny/answer. The view menu would
  // otherwise sit on top of the action layer (z-index 50 vs 70) and cover
  // the buttons, so collapse it as soon as something pending appears.
  useEffect(() => {
    if (pendingActionCount > 0) {
      setViewMenuOpen(false);
    }
  }, [pendingActionCount]);

  return (
    <header className="cdx-mobile-chat-topbar" data-testid="mobile-chat-topbar">
      <button
        type="button"
        className="cdx-mobile-icon-btn cdx-mobile-icon-btn--back"
        onClick={onOpenThreads}
        aria-label="Open threads"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M15 5l-7 7 7 7"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="cdx-mobile-chat-topbar-center">
        {projectLabel ? (
          <span
            className="cdx-mobile-chat-project"
            data-testid="mobile-chat-project-label"
          >
            {projectLabel}
          </span>
        ) : null}
        <h1 className="cdx-mobile-chat-title" data-testid="thread-title">
          {threadTitle}
        </h1>
        {hasPill ? (
          <div className="cdx-mobile-chat-pill-row">
            {planActive ? (
              <span
                className="cdx-mobile-chat-pill cdx-mobile-chat-pill--plan"
                data-testid="mobile-chat-plan-pill"
              >
                Planning
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="cdx-mobile-chat-topbar-actions">
        {/*
          Views and controls must stay reachable even while a turn is running:
          pending questions/approvals can arrive before the turn completes, and
          the user still needs a path into the sheet. Stop is rendered as an
          extra action so it never steals the controls entrypoint.
        */}
        {isWorking ? (
          <span
            className="cdx-mobile-running-beacon"
            data-testid="mobile-running-indicator"
            role="status"
            aria-live="polite"
            aria-label={workingLabel}
            title={workingLabel}
          >
            <span aria-hidden="true" />
            <span className="cdx-sr-only">{workingLabel}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="cdx-mobile-icon-btn"
          data-testid="mobile-topbar-canvas-toggle"
          onClick={onOpenCanvas}
          aria-label="Open canvas"
          title="Canvas"
          disabled={canvasDisabled}
        >
          ▣
        </button>
        <div className="cdx-mobile-view-menu-anchor" ref={viewMenuRef}>
          <button
            type="button"
            className="cdx-mobile-icon-btn"
            data-testid="mobile-topbar-views-toggle"
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            aria-label="Switch view mode"
            aria-disabled={pendingActionCount > 0 ? true : undefined}
            data-suppressed={pendingActionCount > 0 ? "pending" : undefined}
            onClick={() => {
              // While pending approvals/interactions are on screen the
              // action layer is the user's only valid next move — never
              // pop a competing menu over it.
              if (pendingActionCount > 0) return;
              setViewMenuOpen((value) => !value);
            }}
          >
            ◐
          </button>
          {viewMenuOpen && pendingActionCount === 0 ? (
            <div
              className="cdx-mobile-view-menu"
              role="menu"
              data-testid="mobile-topbar-views-menu"
            >
              {VIEW_MODE_OPTIONS.map((option) => {
                const active = option.value === viewMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`cdx-mobile-view-menu-item ${active ? "is-active" : ""}`}
                    data-testid={`mobile-topbar-views-${option.value}`}
                    onClick={() => {
                      onViewModeChange(option.value);
                      setViewMenuOpen(false);
                    }}
                  >
                    <span className="cdx-mobile-view-menu-item-label">{option.label}</span>
                    <span className="cdx-mobile-view-menu-item-desc">{option.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {isRunning ? (
          <button
            type="button"
            className="cdx-mobile-icon-btn cdx-mobile-icon-btn--stop"
            data-testid="mobile-topbar-stop"
            onClick={() => {
              if (runningTurnId) {
                onStop(runningTurnId);
              }
            }}
            aria-label="Stop turn"
            disabled={stopBusy}
          >
            {stopBusy ? "…" : "■"}
          </button>
        ) : null}
        <button
          type="button"
          className="cdx-mobile-icon-btn"
          data-testid="mobile-topbar-control-toggle"
          onClick={onOpenControls}
          aria-label="Open controls"
        >
          ⋯
          {pendingActionCount > 0 ? <span className="cdx-mobile-dot" aria-hidden="true" /> : null}
        </button>
      </div>
    </header>
  );
}
