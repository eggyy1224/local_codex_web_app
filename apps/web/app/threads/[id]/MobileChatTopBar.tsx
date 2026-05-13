"use client";

import type { ServiceTier } from "@lcwa/shared-types";

type MobileChatTopBarProps = {
  threadTitle: string;
  collaborationMode: "plan" | "default";
  serviceTier: ServiceTier | null;
  pendingActionCount: number;
  runningTurnId: string | null;
  stopBusy: boolean;
  onOpenThreads: () => void;
  onOpenControls: () => void;
  onStop: (turnId: string) => void;
};

export default function MobileChatTopBar({
  threadTitle,
  collaborationMode,
  serviceTier,
  pendingActionCount,
  runningTurnId,
  stopBusy,
  onOpenThreads,
  onOpenControls,
  onStop,
}: MobileChatTopBarProps) {
  const planActive = collaborationMode === "plan";
  const flexActive = serviceTier === "flex";
  const hasPill = planActive || flexActive;
  const isRunning = runningTurnId !== null;
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
    </header>
  );
}
