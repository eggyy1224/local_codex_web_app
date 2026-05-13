"use client";

type MobileChatTopBarProps = {
  threadTitle: string;
  collaborationMode: "plan" | "default";
  pendingActionCount: number;
  onOpenThreads: () => void;
  onOpenControls: () => void;
};

export default function MobileChatTopBar({
  threadTitle,
  collaborationMode,
  pendingActionCount,
  onOpenThreads,
  onOpenControls,
}: MobileChatTopBarProps) {
  const planActive = collaborationMode === "plan";
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
        {planActive ? (
          <span
            className="cdx-mobile-chat-pill cdx-mobile-chat-pill--plan"
            data-testid="mobile-chat-plan-pill"
          >
            Planning
          </span>
        ) : null}
      </div>
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
    </header>
  );
}
