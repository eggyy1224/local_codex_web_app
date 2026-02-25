"use client";

type MobileThreadHeaderContextProps = {
  projectLabel: string;
  threadTitle: string;
  onOpenSwitcher: () => void;
};

export default function MobileThreadHeaderContext({
  projectLabel,
  threadTitle,
  onOpenSwitcher,
}: MobileThreadHeaderContextProps) {
  return (
    <section className="cdx-mobile-thread-context" data-testid="mobile-thread-context">
      <div className="cdx-mobile-thread-context-meta">
        <p className="cdx-mobile-thread-context-project">{projectLabel}</p>
        <h1 className="cdx-mobile-thread-context-title" data-testid="thread-title">
          {threadTitle}
        </h1>
      </div>
      <button
        type="button"
        className="cdx-toolbar-btn"
        data-testid="mobile-thread-switcher-toggle"
        onClick={onOpenSwitcher}
      >
        Threads
      </button>
    </section>
  );
}
