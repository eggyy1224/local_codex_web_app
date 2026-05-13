"use client";

import { useEffect, useRef } from "react";
import type { ThreadStatus } from "@lcwa/shared-types";

export type MobileThreadSwitcherItem = {
  id: string;
  title: string;
  lastActiveAt: string;
  isActive: boolean;
  status: ThreadStatus;
  waitingApprovalCount: number;
  errorCount: number;
};

export type MobileThreadSwitcherGroup = {
  key: string;
  label: string;
  items: MobileThreadSwitcherItem[];
};

type MobileThreadSwitcherOverlayProps = {
  open: boolean;
  groups: MobileThreadSwitcherGroup[];
  loading: boolean;
  onClose: () => void;
  onSelect: (threadId: string) => void;
};

type StatusBadge = {
  kind: "running" | "waiting" | "error" | "idle";
  label: string;
};

function badgeForItem(item: MobileThreadSwitcherItem): StatusBadge {
  if (item.status === "active") {
    return { kind: "running", label: "Running" };
  }
  if (item.waitingApprovalCount > 0) {
    return {
      kind: "waiting",
      label: item.waitingApprovalCount === 1 ? "1 pending" : `${item.waitingApprovalCount} pending`,
    };
  }
  if (item.status === "systemError" || item.errorCount > 0) {
    return { kind: "error", label: "Error" };
  }
  return { kind: "idle", label: "Idle" };
}

export default function MobileThreadSwitcherOverlay({
  open,
  groups,
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

  const isEmpty = groups.every((group) => group.items.length === 0);

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
          {!loading && isEmpty ? <p className="cdx-helper">No threads yet.</p> : null}
          {groups.map((group) =>
            group.items.length === 0 ? null : (
              <section
                key={group.key}
                className="cdx-mobile-thread-switcher-group"
                data-testid="mobile-thread-switcher-group"
                data-project-key={group.key}
              >
                <header className="cdx-mobile-thread-switcher-group-head">
                  <span className="cdx-mobile-thread-switcher-group-label">{group.label}</span>
                  <span className="cdx-mobile-thread-switcher-group-count">{group.items.length}</span>
                </header>
                {group.items.map((item) => {
                  const badge = badgeForItem(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`cdx-mobile-thread-switcher-item ${item.isActive ? "is-active" : ""}`}
                      data-testid="mobile-thread-switcher-item"
                      data-status={badge.kind}
                      onClick={() => onSelect(item.id)}
                    >
                      <span
                        className={`cdx-mobile-thread-switcher-status cdx-mobile-thread-switcher-status--${badge.kind}`}
                        aria-hidden="true"
                      />
                      <span className="cdx-mobile-thread-switcher-item-body">
                        <span className="cdx-mobile-thread-switcher-item-title">{item.title}</span>
                        <span className="cdx-mobile-thread-switcher-item-meta">
                          <span
                            className={`cdx-mobile-thread-switcher-badge cdx-mobile-thread-switcher-badge--${badge.kind}`}
                          >
                            {badge.label}
                          </span>
                          <span>{item.lastActiveAt}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ),
          )}
        </div>
      </section>
    </div>
  );
}
