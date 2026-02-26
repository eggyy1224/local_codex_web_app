"use client";

type MobileChatTopBarProps = {
  threadTitle: string;
  modelLabel: string;
  pendingActionCount: number;
  onOpenThreads: () => void;
  onOpenControls: () => void;
};

export default function MobileChatTopBar({
  threadTitle,
  modelLabel,
  pendingActionCount,
  onOpenThreads,
  onOpenControls,
}: MobileChatTopBarProps) {
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
        <p className="cdx-mobile-chat-subtitle" data-testid="mobile-chat-model-label">
          {modelLabel}
        </p>
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
