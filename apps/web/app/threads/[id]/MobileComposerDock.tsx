"use client";

import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { FuzzyFileMatch } from "@lcwa/shared-types";
import type { KnownSlashCommand } from "../../lib/slash-commands";

type SlashSuggestion = {
  command: KnownSlashCommand;
  title: string;
  description: string;
};

type MobileComposerDockProps = {
  prompt: string;
  submitting: boolean;
  canSend: boolean;
  slashMenuOpen: boolean;
  slashSuggestions: SlashSuggestion[];
  activeSlashIndex: number;
  steerActive: boolean;
  fileMentionOpen: boolean;
  fileMentionResults: FuzzyFileMatch[];
  fileMentionLoading: boolean;
  onPromptChange: (value: string) => void;
  onPromptKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onApplySlash: (command: KnownSlashCommand) => void;
  onApplyFileMention: (path: string) => void;
  onSend: () => void;
  onOpenControls: () => void;
  onSwipeOpenControls: () => void;
};

const OPEN_DISTANCE_THRESHOLD = 64;
const OPEN_VELOCITY_THRESHOLD = 0.35;

export default function MobileComposerDock({
  prompt,
  submitting,
  canSend,
  slashMenuOpen,
  slashSuggestions,
  activeSlashIndex,
  steerActive,
  fileMentionOpen,
  fileMentionResults,
  fileMentionLoading,
  onPromptChange,
  onPromptKeyDown,
  onApplySlash,
  onApplyFileMention,
  onSend,
  onOpenControls,
  onSwipeOpenControls,
}: MobileComposerDockProps) {
  const pointerStartRef = useRef<{ y: number; ts: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = {
      y: event.clientY,
      ts: performance.now(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) {
      return;
    }
    const now = performance.now();
    const deltaY = event.clientY - start.y;
    const durationMs = Math.max(1, now - start.ts);
    const velocity = (-deltaY) / durationMs;

    if (-deltaY >= OPEN_DISTANCE_THRESHOLD || velocity >= OPEN_VELOCITY_THRESHOLD) {
      onSwipeOpenControls();
    }
  };

  const placeholder = steerActive
    ? "Steer the running turn…"
    : "Ask Codex anything, / for commands";

  return (
    <section
      className={`cdx-mobile-composer-shell ${steerActive ? "is-steer" : ""}`}
      data-testid="mobile-composer-dock"
      data-mode={steerActive ? "steer" : "idle"}
    >
      <div
        className="cdx-mobile-composer-swipe-handle"
        data-testid="mobile-composer-swipe-handle"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <span className="cdx-mobile-composer-handle-bar" aria-hidden="true" />
      </div>

      {slashMenuOpen ? (
        <div className="cdx-mobile-slash-menu" role="listbox" aria-label="Slash command suggestions" data-testid="thread-slash-menu">
          {slashSuggestions.map((item, index) => {
            const active = index === activeSlashIndex;
            return (
              <button
                key={item.command}
                type="button"
                role="option"
                aria-selected={active}
                className={`cdx-mobile-slash-item ${active ? "is-active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onApplySlash(item.command);
                }}
              >
                <span className="cdx-mobile-slash-item-command">{item.title}</span>
                <span className="cdx-mobile-slash-item-desc">{item.description}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {fileMentionOpen ? (
        <div
          className="cdx-mobile-slash-menu cdx-mobile-mention-menu"
          role="listbox"
          aria-label="File mention suggestions"
          data-testid="file-mention-menu"
        >
          {fileMentionResults.length === 0 ? (
            <div className="cdx-mobile-slash-item" data-testid="file-mention-empty">
              <span className="cdx-mobile-slash-item-command">
                {fileMentionLoading ? "Searching…" : "No matches"}
              </span>
              <span className="cdx-mobile-slash-item-desc">
                {fileMentionLoading ? "" : "Try a different prefix"}
              </span>
            </div>
          ) : (
            fileMentionResults.map((file) => (
              <button
                key={`${file.root}/${file.path}`}
                type="button"
                role="option"
                className="cdx-mobile-slash-item"
                data-testid="file-mention-item"
                data-path={file.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onApplyFileMention(file.path);
                }}
              >
                <span className="cdx-mobile-slash-item-command">{file.fileName}</span>
                <span className="cdx-mobile-slash-item-desc">{file.path}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      <div className="cdx-mobile-composer">
        <button
          type="button"
          className="cdx-mobile-icon-btn"
          data-testid="mobile-composer-control-toggle"
          onClick={onOpenControls}
          aria-label="Open advanced controls"
        >
          +
        </button>
        <textarea
          id="turn-input"
          data-testid="turn-input"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={onPromptKeyDown}
          placeholder={placeholder}
          rows={1}
        />
        <button
          type="button"
          className={`cdx-mobile-send-btn ${steerActive ? "cdx-mobile-send-btn--steer" : ""}`}
          data-testid="turn-submit"
          onClick={onSend}
          disabled={submitting || !canSend}
          aria-label={steerActive ? "Steer running turn" : "Send turn"}
        >
          {submitting ? "..." : steerActive ? "↪" : "↑"}
        </button>
      </div>
    </section>
  );
}
