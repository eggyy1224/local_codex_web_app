"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceTier } from "@lcwa/shared-types";

export type MobileViewMode = "normal" | "thinking" | "verbose";

export const VIEW_MODE_OPTIONS: Array<{
  value: MobileViewMode;
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
  runningTurnId: string | null;
  stopBusy: boolean;
  viewMode: MobileViewMode;
  onViewModeChange: (mode: MobileViewMode) => void;
  onOpenThreads: () => void;
  onOpenControls: () => void;
  onOpenMoreControls?: () => void;
  onStop: (turnId: string) => void;
};

export default function MobileChatTopBar({
  projectLabel,
  threadTitle,
  collaborationMode,
  serviceTier,
  pendingActionCount,
  runningTurnId,
  stopBusy,
  viewMode,
  onViewModeChange,
  onOpenThreads,
  onOpenControls,
  onOpenMoreControls: _onOpenMoreControls,
  onStop,
}: MobileChatTopBarProps) {
  const planActive = collaborationMode === "plan";
  const flexActive = serviceTier === "flex";
  const hasPill = planActive || flexActive;
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
        className="cdx-mobile-icon-btn"
        onClick={onOpenThreads}
        aria-label="Open threads"
      >
        ≡
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
            {flexActive ? (
              <span
                className="cdx-mobile-chat-pill cdx-mobile-chat-pill--flex"
                data-testid="mobile-chat-flex-pill"
              >
                Flex
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="cdx-mobile-chat-topbar-actions">
        {/*
          Views must stay reachable even while a turn is running — that's
          precisely when the user most needs to flip to Thinking/Verbose to
          inspect reasoning or tool detail. Stop is rendered alongside Views
          (instead of replacing it) so the two actions never collide.
        */}
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
        ) : (
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
        )}
      </div>
    </header>
  );
}
