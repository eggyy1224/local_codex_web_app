"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { FuzzyFileMatch } from "@lcwa/shared-types";
import type { KnownSlashCommand } from "../../lib/slash-commands";
import AttachmentStrip, { type PendingAttachment } from "./AttachmentStrip";

type SlashSuggestion = {
  command: KnownSlashCommand;
  title: string;
  description: string;
};

export type MobileComposerStripInfo = {
  model: string | null;
  effortLabel: string | null;
  permissionLabel: string | null;
  pendingCount: number;
  contextUsage?: {
    totalTokens: number;
    modelContextWindow: number | null;
  } | null;
  // ⚡ is the Fast/speed-tier marker (mirrors the Codex app). Only shown
  // when the service tier is actually "fast" — never in Flex.
  speedFast?: boolean;
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
  strip?: MobileComposerStripInfo;
  attachments?: PendingAttachment[];
  onPromptChange: (value: string) => void;
  onPromptKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onApplySlash: (command: KnownSlashCommand) => void;
  onApplyFileMention: (path: string) => void;
  onSend: () => void;
  onOpenControls: () => void;
  onOpenAdvancedControls?: () => void;
  onInsertFileMentionTrigger?: () => void;
  onInsertSlashTrigger?: () => void;
  onSwipeOpenControls: () => void;
  onPickFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
};

const OPEN_DISTANCE_THRESHOLD = 64;
const OPEN_VELOCITY_THRESHOLD = 0.35;

function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}m`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}k`;
  }
  return String(tokens);
}

function contextRingDetails(usage: MobileComposerStripInfo["contextUsage"]) {
  if (!usage) {
    return {
      label: "Context usage not available yet",
      progress: null,
      level: "unknown" as const,
    };
  }

  const windowSize =
    usage.modelContextWindow && usage.modelContextWindow > 0
      ? usage.modelContextWindow
      : null;
  if (!windowSize) {
    return {
      label: `Context ${formatCompactTokenCount(usage.totalTokens)} tokens`,
      progress: null,
      level: "unknown" as const,
    };
  }

  const progress = Math.min(100, Math.max(0, (usage.totalTokens / windowSize) * 100));
  const rounded = Math.round(progress);
  const level = rounded >= 85 ? "high" : rounded >= 65 ? "medium" : "low";
  return {
    label: `Context ${rounded}%, ${formatCompactTokenCount(usage.totalTokens)} of ${formatCompactTokenCount(windowSize)} tokens`,
    progress,
    level,
  };
}

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
  strip,
  attachments,
  onPromptChange,
  onPromptKeyDown,
  onApplySlash,
  onApplyFileMention,
  onSend,
  onOpenControls,
  onOpenAdvancedControls,
  onInsertFileMentionTrigger,
  onInsertSlashTrigger,
  onSwipeOpenControls,
  onPickFiles,
  onRemoveAttachment,
}: MobileComposerDockProps) {
  const pointerStartRef = useRef<{ y: number; ts: number } | null>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileInputChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list || list.length === 0 || !onPickFiles) {
      return;
    }
    const files: File[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      if (file) files.push(file);
    }
    if (files.length > 0) {
      onPickFiles(files);
    }
    event.target.value = "";
  };

  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    setIsDragOver(false);
    if (!onPickFiles) return;
    const dropped = event.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < dropped.length; i += 1) {
      const file = dropped[i];
      if (file && file.type.startsWith("image/")) files.push(file);
    }
    if (files.length > 0) onPickFiles(files);
  };

  const handleTextareaPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPickFiles) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      onPickFiles(files);
    }
  };

  useEffect(() => {
    if (!plusMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (!plusMenuRef.current) return;
      if (!plusMenuRef.current.contains(event.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [plusMenuOpen]);

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

  const placeholder = steerActive ? "Steer the running turn…" : "Ask Codex";

  const handleStripClick = () => {
    if (onOpenAdvancedControls) {
      onOpenAdvancedControls();
    } else {
      onOpenControls();
    }
  };

  const contextRing = contextRingDetails(strip?.contextUsage ?? null);
  const contextRingStyle =
    contextRing.progress === null
      ? undefined
      : ({
          "--context-ring-progress": `${contextRing.progress}%`,
        } as CSSProperties & Record<"--context-ring-progress", string>);

  return (
    <section
      className={`cdx-mobile-composer-shell ${steerActive ? "is-steer" : ""} ${isDragOver ? "is-drag-over" : ""}`}
      data-testid="mobile-composer-dock"
      data-mode={steerActive ? "steer" : "idle"}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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

      {attachments && attachments.length > 0 && onRemoveAttachment ? (
        <AttachmentStrip
          attachments={attachments}
          onRemove={onRemoveAttachment}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="mobile-composer-file-input"
        className="cdx-mobile-file-input"
        onChange={handleFileInputChange}
      />

      <div className="cdx-mobile-composer">
        <textarea
          id="turn-input"
          data-testid="turn-input"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={onPromptKeyDown}
          onPaste={handleTextareaPaste}
          placeholder={placeholder}
          rows={1}
        />
        <div className="cdx-mobile-composer-bar">
        <div className="cdx-mobile-plus-menu-anchor" ref={plusMenuRef}>
          <button
            type="button"
            className="cdx-mobile-icon-btn"
            data-testid="mobile-composer-control-toggle"
            onClick={() => setPlusMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={plusMenuOpen}
            aria-label="Open composer actions"
          >
            +
          </button>
          {plusMenuOpen ? (
            <div
              className="cdx-mobile-plus-menu"
              role="menu"
              data-testid="mobile-composer-plus-menu"
            >
              {onPickFiles ? (
                <button
                  type="button"
                  role="menuitem"
                  className="cdx-mobile-plus-menu-item"
                  data-testid="mobile-composer-plus-image"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="cdx-mobile-plus-menu-item-label">Add image</span>
                  <span className="cdx-mobile-plus-menu-item-desc">Send a screenshot or photo</span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="cdx-mobile-plus-menu-item"
                data-testid="mobile-composer-plus-mention"
                onClick={() => {
                  setPlusMenuOpen(false);
                  onInsertFileMentionTrigger?.();
                }}
              >
                <span className="cdx-mobile-plus-menu-item-label">Add file mention</span>
                <span className="cdx-mobile-plus-menu-item-desc">Insert @ to pick a file</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="cdx-mobile-plus-menu-item"
                data-testid="mobile-composer-plus-slash"
                onClick={() => {
                  setPlusMenuOpen(false);
                  onInsertSlashTrigger?.();
                }}
              >
                <span className="cdx-mobile-plus-menu-item-label">Slash commands</span>
                <span className="cdx-mobile-plus-menu-item-desc">Insert / to browse commands</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="cdx-mobile-plus-menu-item"
                data-testid="mobile-composer-plus-controls"
                onClick={() => {
                  setPlusMenuOpen(false);
                  onOpenControls();
                }}
              >
                <span className="cdx-mobile-plus-menu-item-label">Controls</span>
                <span className="cdx-mobile-plus-menu-item-desc">Pending approvals, model, permission…</span>
              </button>
            </div>
          ) : null}
        </div>
        {strip ? (
          <button
            type="button"
            className="cdx-mobile-composer-strip"
            data-testid="mobile-composer-strip"
            onClick={handleStripClick}
            aria-label="Open advanced controls"
          >
            <span
              className="cdx-mobile-context-ring"
              data-testid="mobile-composer-context-ring"
              data-level={contextRing.level}
              style={contextRingStyle}
              aria-label={contextRing.label}
              title={contextRing.label}
            >
              <span aria-hidden="true" />
              <span className="cdx-sr-only">{contextRing.label}</span>
            </span>
            {strip.speedFast ? (
              <span
                className="cdx-mobile-composer-strip-bolt"
                data-testid="mobile-composer-strip-fast"
                aria-label="Fast mode"
                title="Fast mode"
              >
                ⚡
              </span>
            ) : null}
            {strip.model ? (
              <span
                className="cdx-mobile-composer-strip-chip"
                data-testid="mobile-composer-strip-model"
              >
                {strip.model}
              </span>
            ) : null}
            {strip.effortLabel ? (
              <span
                className="cdx-mobile-composer-strip-chip cdx-mobile-composer-strip-chip--muted"
                data-testid="mobile-composer-strip-effort"
              >
                {strip.effortLabel}
              </span>
            ) : null}
            {strip.permissionLabel ? (
              <span
                className="cdx-mobile-composer-strip-chip cdx-mobile-composer-strip-chip--muted"
                data-testid="mobile-composer-strip-permission"
              >
                {strip.permissionLabel}
              </span>
            ) : null}
            {strip.pendingCount > 0 ? (
              <span
                className="cdx-mobile-composer-strip-chip cdx-mobile-composer-strip-chip--alert"
                data-testid="mobile-composer-strip-pending"
              >
                {strip.pendingCount === 1
                  ? "1 pending"
                  : `${strip.pendingCount} pending`}
              </span>
            ) : null}
          </button>
        ) : null}
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
      </div>
    </section>
  );
}
