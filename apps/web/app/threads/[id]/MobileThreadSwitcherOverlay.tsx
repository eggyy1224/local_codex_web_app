"use client";

import { useEffect, useRef } from "react";

export type MobileThreadSwitcherItem = {
  id: string;
  title: string;
  projectLabel: string;
  lastActiveAt: string;
  isActive: boolean;
};

type MobileThreadSwitcherOverlayProps = {
  open: boolean;
  items: MobileThreadSwitcherItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (threadId: string) => void;
};

export default function MobileThreadSwitcherOverlay({
  open,
  items,
  loading,
  onClose,
  onSelect,
}: MobileThreadSwitcherOverlayProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="cdx-mobile-thread-switcher-overlay"
      data-testid="mobile-thread-switcher-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="cdx-mobile-thread-switcher-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Thread switcher"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cdx-mobile-thread-switcher-head">
          <strong>Threads</strong>
          <button
            ref={closeBtnRef}
            type="button"
            className="cdx-toolbar-btn"
            data-testid="mobile-thread-switcher-close"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <div className="cdx-mobile-thread-switcher-list">
          {loading ? <p className="cdx-helper">Loading thread list...</p> : null}
          {!loading && items.length === 0 ? <p className="cdx-helper">No threads yet.</p> : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`cdx-mobile-thread-switcher-item ${item.isActive ? "is-active" : ""}`}
              data-testid="mobile-thread-switcher-item"
              onClick={() => onSelect(item.id)}
            >
              <span className="cdx-mobile-thread-switcher-item-title">{item.title}</span>
              <span className="cdx-mobile-thread-switcher-item-meta">
                {item.projectLabel} · {item.lastActiveAt}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
