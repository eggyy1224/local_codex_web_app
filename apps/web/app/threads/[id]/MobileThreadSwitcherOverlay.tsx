"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  THREAD_SWITCHER_FILTERS,
  badgeForThreadItem,
  emptyStateMessage,
  filterThreadSwitcherGroups,
  type ThreadStatusBadge,
  type ThreadSwitcherFilter,
  type ThreadSwitcherGroup,
  type ThreadSwitcherItem,
} from "./thread-switcher-shared";

// Re-exported under the historical mobile-prefixed names so existing tests
// and call sites keep working without churn. The implementations now live in
// `thread-switcher-shared.ts` and are reused by the desktop sidebar.
export type MobileThreadSwitcherItem = ThreadSwitcherItem;
export type MobileThreadSwitcherGroup = ThreadSwitcherGroup;
export type MobileSwitcherFilter = ThreadSwitcherFilter;

export const MOBILE_SWITCHER_FILTERS = THREAD_SWITCHER_FILTERS;

export const badgeForItem = badgeForThreadItem;
export const filterSwitcherGroups = filterThreadSwitcherGroups;

type MobileThreadSwitcherOverlayProps = {
  open: boolean;
  groups: MobileThreadSwitcherGroup[];
  collapsedGroups: Set<string>;
  loading: boolean;
  defaultProjectKey: string | null;
  onClose: () => void;
  onSelect: (threadId: string) => void;
  onToggleGroup: (groupKey: string) => void;
  onCreateThread: (projectKey: string) => void;
};

type StatusBadge = ThreadStatusBadge;
export type { StatusBadge };

export default function MobileThreadSwitcherOverlay({
  open,
  groups,
  collapsedGroups,
  loading,
  defaultProjectKey,
  onClose,
  onSelect,
  onToggleGroup,
  onCreateThread,
}: MobileThreadSwitcherOverlayProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState<MobileSwitcherFilter>("all");
  const [query, setQuery] = useState("");

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

  // Reset filter + query when the drawer closes so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setFilter("all");
      setQuery("");
    }
  }, [open]);

  const filteredGroups = useMemo(
    () => filterSwitcherGroups(groups, filter, query),
    [groups, filter, query],
  );

  if (!open) {
    return null;
  }

  const isEmpty = filteredGroups.every((group) => group.items.length === 0);
  const emptyMessage = emptyStateMessage(groups, filter, query);

  const createTargetProjectKey = defaultProjectKey ?? groups[0]?.key ?? null;

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
        <div className="cdx-mobile-thread-switcher-controls">
          <button
            type="button"
            className="cdx-mobile-thread-switcher-new-btn"
            data-testid="mobile-thread-switcher-new"
            onClick={() => {
              if (createTargetProjectKey) {
                onCreateThread(createTargetProjectKey);
              }
            }}
            disabled={!createTargetProjectKey}
          >
            <span aria-hidden="true">+</span>
            <span>New session</span>
          </button>
          <input
            type="search"
            className="cdx-mobile-thread-switcher-search"
            data-testid="mobile-thread-switcher-search"
            placeholder="Search threads"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search threads"
          />
          <div
            className="cdx-mobile-thread-switcher-filters"
            role="tablist"
            aria-label="Filter threads by status"
          >
            {MOBILE_SWITCHER_FILTERS.map((option) => {
              const active = option.value === filter;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`cdx-mobile-thread-switcher-filter ${active ? "is-active" : ""}`}
                  data-testid={`mobile-thread-switcher-filter-${option.value}`}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="cdx-mobile-thread-switcher-list">
          {loading ? <p className="cdx-helper">Loading thread list...</p> : null}
          {!loading && isEmpty ? (
            <p className="cdx-helper" data-testid="mobile-thread-switcher-empty">
              {emptyMessage}
            </p>
          ) : null}
          {filteredGroups.map((group) => {
            if (group.items.length === 0) {
              // Hide entirely-empty groups so the drawer doesn't surface
              // project headers with no matches under the current filter.
              return null;
            }
            const collapsed = collapsedGroups.has(group.key);
            return (
              <section
                key={group.key}
                className={`cdx-mobile-thread-switcher-group ${collapsed ? "is-collapsed" : ""}`}
                data-testid="mobile-thread-switcher-group"
                data-project-key={group.key}
              >
                <header className="cdx-mobile-thread-switcher-group-head">
                  <button
                    type="button"
                    className="cdx-mobile-thread-switcher-group-toggle"
                    data-testid="mobile-thread-switcher-group-toggle"
                    aria-expanded={!collapsed}
                    aria-controls={`group-${group.key}`}
                    onClick={() => onToggleGroup(group.key)}
                  >
                    <span
                      className="cdx-mobile-thread-switcher-group-caret"
                      aria-hidden="true"
                    >
                      {collapsed ? "▸" : "▾"}
                    </span>
                    <span className="cdx-mobile-thread-switcher-group-label">{group.label}</span>
                    <span className="cdx-mobile-thread-switcher-group-count">{group.items.length}</span>
                  </button>
                  <button
                    type="button"
                    className="cdx-mobile-thread-switcher-group-new"
                    data-testid="mobile-thread-switcher-group-new"
                    data-project-key={group.key}
                    aria-label={`New thread in ${group.label}`}
                    onClick={() => onCreateThread(group.key)}
                  >
                    +
                  </button>
                </header>
                {collapsed ? null : (
                  <div className="cdx-mobile-thread-switcher-group-items" id={`group-${group.key}`}>
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
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
