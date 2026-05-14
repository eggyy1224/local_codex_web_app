"use client";

import type { ReactNode, RefObject } from "react";
import type { ConversationTurn, TurnSegment, TurnStatus } from "../../lib/thread-logic";
import {
  statusClass,
  statusLabel,
  summarizeToolAction,
  truncateText,
} from "../../lib/thread-logic";
import { MarkdownText } from "../../lib/MarkdownText";
import type { MobileViewMode } from "./MobileChatTopBar";

type MobileMessageStreamProps = {
  turns: ConversationTurn[];
  hiddenCount: number;
  showAllTurns: boolean;
  onToggleShowAll: (showAll: boolean) => void;
  timelineRef: RefObject<HTMLElement | null>;
  onTimelineScroll: () => void;
  formatTimestamp: (value: string | null) => string;
  reviewSlashCommandByTurnId: Map<string, string>;
  onCopyMessage: (text: string) => void;
  onOpenMessageDetails: (turnId: string) => void;
  renderTurnActions?: (turnId: string) => ReactNode;
  viewMode?: MobileViewMode;
};

function statusLabelCompact(status: TurnStatus): string {
  if (status === "completed") return "Done";
  if (status === "inProgress") return "Responding";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Stopped";
  return "Unknown";
}

function renderToolBatch(
  segment: Extract<TurnSegment, { kind: "toolBatch" }>,
  key: string,
  viewMode: MobileViewMode,
): ReactNode {
  const showRawDetail = viewMode === "verbose";
  // Action rows: only toolCall items collapse into Claude-like semantic
  // pills (Ran <cmd>, Read <file>, …). toolResult items pair with their
  // call so we don't surface them as a separate row unless verbose mode
  // explicitly asks for the raw output.
  const actionRows = segment.items
    .map((item, index) => ({ item, index, action: summarizeToolAction(item) }))
    .filter((row) => row.action !== null);

  return (
    <details
      key={key}
      className="cdx-mobile-tool-batch"
      data-testid="mobile-tool-batch"
      data-view-mode={viewMode}
    >
      <summary className="cdx-mobile-tool-batch-summary">
        <span className="cdx-mobile-tool-batch-icon" aria-hidden="true">⚙</span>
        <span className="cdx-mobile-tool-batch-text">{segment.summary}</span>
      </summary>
      <div className="cdx-mobile-tool-batch-body">
        <ul className="cdx-mobile-tool-action-list" data-testid="mobile-tool-action-list">
          {actionRows.map(({ action, index }) => {
            if (!action) return null;
            return (
              <li
                key={`${key}-action-${index}`}
                className={`cdx-mobile-tool-action cdx-mobile-tool-action--${action.kind}`}
                data-testid="mobile-tool-action"
                data-kind={action.kind}
              >
                <span className="cdx-mobile-tool-action-label">{action.label}</span>
              </li>
            );
          })}
        </ul>
        {showRawDetail
          ? segment.items.map((item, index) => {
              const itemKey = `${key}-raw-${index}`;
              if (item.kind === "toolCall") {
                return (
                  <section
                    className="cdx-mobile-msg cdx-mobile-msg--detail"
                    key={itemKey}
                    data-testid="mobile-tool-raw-call"
                  >
                    <header className="cdx-mobile-msg-head">
                      <strong>Tool call: {item.toolName}</strong>
                    </header>
                    {item.text ? (
                      <pre className="cdx-turn-body">{truncateText(item.text, 4500)}</pre>
                    ) : null}
                  </section>
                );
              }
              if (item.kind === "toolResult") {
                return (
                  <section
                    className="cdx-mobile-msg cdx-mobile-msg--detail"
                    key={itemKey}
                    data-testid="mobile-tool-raw-output"
                  >
                    <header className="cdx-mobile-msg-head">
                      <strong>Tool output</strong>
                    </header>
                    <pre className="cdx-turn-body">{truncateText(item.text, 4500)}</pre>
                  </section>
                );
              }
              return null;
            })
          : null}
      </div>
    </details>
  );
}

export default function MobileMessageStream({
  turns,
  hiddenCount,
  showAllTurns,
  onToggleShowAll,
  timelineRef,
  onTimelineScroll,
  formatTimestamp,
  reviewSlashCommandByTurnId,
  onCopyMessage,
  onOpenMessageDetails,
  renderTurnActions,
  viewMode = "normal",
}: MobileMessageStreamProps) {
  // Thinking segments are reasoning blocks Codex emits between tool batches.
  // Hidden in normal mode (the default) so the mobile timeline stays focused
  // on user turns + assistant output + semantic tool pills.
  const showThinking = viewMode !== "normal";
  return (
    <section
      ref={timelineRef}
      onScroll={onTimelineScroll}
      className="cdx-mobile-message-stream"
      data-testid="timeline"
      data-view-mode={viewMode}
    >
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="cdx-mobile-inline-btn"
          onClick={() => onToggleShowAll(!showAllTurns)}
        >
          {showAllTurns ? "Show fewer turns" : `Show ${hiddenCount} earlier turns`}
        </button>
      ) : null}

      {turns.length === 0 ? <p className="cdx-helper">No conversation yet.</p> : null}

      {turns.map((turn) => {
        const reviewSlashCommand = reviewSlashCommandByTurnId.get(turn.turnId) ?? null;
        const segments = turn.segments;
        const lastAssistantIndex = (() => {
          for (let i = segments.length - 1; i >= 0; i -= 1) {
            if (segments[i].kind === "assistant") return i;
          }
          return -1;
        })();
        // If no segments were produced (e.g. very early in the stream), fall
        // back to the aggregated userText / assistantText so the user still
        // sees something while the timeline loads.
        const fallbackUser =
          segments.length === 0 ? reviewSlashCommand ?? turn.userText : null;
        const fallbackAssistant =
          segments.length === 0 && turn.assistantText ? turn.assistantText : null;

        const isPending = turn.turnId.startsWith("pending-");
        return (
          <article
            key={turn.turnId}
            className={`cdx-mobile-turn ${turn.isStreaming ? "is-streaming" : ""} ${isPending ? "is-pending" : ""}`}
            data-testid={isPending ? "mobile-pending-turn" : undefined}
          >
            {fallbackUser ? (
              <section className="cdx-mobile-msg cdx-mobile-msg--user">
                <header className="cdx-mobile-msg-head">
                  <span>You</span>
                </header>
                <pre className="cdx-turn-body">{fallbackUser}</pre>
              </section>
            ) : null}

            {segments.map((segment, index) => {
              const key = `${turn.turnId}-seg-${index}`;
              if (segment.kind === "user") {
                // The leading user message is the original prompt; subsequent
                // user segments are steers injected mid-turn — flag them so
                // the bubble can label itself.
                const isFirstUser =
                  segments.findIndex((s) => s.kind === "user") === index;
                // If this is the first user message and we have a review
                // slash command, prefer the original full command text.
                const displayText =
                  isFirstUser && reviewSlashCommand ? reviewSlashCommand : segment.text;
                return (
                  <section
                    key={key}
                    className={`cdx-mobile-msg cdx-mobile-msg--user ${segment.isSteer ? "is-steer" : ""}`}
                    data-testid={segment.isSteer ? "mobile-user-steer" : "mobile-user-message"}
                  >
                    <header className="cdx-mobile-msg-head">
                      <span>{segment.isSteer ? "You · steered" : "You"}</span>
                    </header>
                    <pre className="cdx-turn-body">{displayText}</pre>
                  </section>
                );
              }
              if (segment.kind === "assistant") {
                const isLastAssistant = index === lastAssistantIndex;
                return (
                  <section
                    key={key}
                    className="cdx-mobile-msg cdx-mobile-msg--assistant"
                    data-testid="mobile-assistant-segment"
                  >
                    <header className="cdx-mobile-msg-head">
                      <strong>Codex</strong>
                      {isLastAssistant ? (
                        <div className="cdx-mobile-msg-actions">
                          <span className={`cdx-status ${statusClass(turn.status)}`}>
                            {statusLabelCompact(turn.status)}
                          </span>
                          <button
                            type="button"
                            className="cdx-mobile-inline-btn"
                            onClick={() => onCopyMessage(segment.text)}
                          >
                            Copy
                          </button>
                        </div>
                      ) : null}
                    </header>
                    <div className="cdx-turn-body cdx-turn-body--md">
                      <MarkdownText text={segment.text} />
                      {turn.isStreaming && isLastAssistant ? (
                        <span className="cdx-stream-cursor" aria-hidden="true" />
                      ) : null}
                    </div>
                  </section>
                );
              }
              if (segment.kind === "thinking") {
                if (!showThinking) {
                  return null;
                }
                return (
                  <details
                    key={key}
                    className="cdx-mobile-thinking-inline"
                    data-testid="mobile-thinking-inline"
                  >
                    <summary>Thinking</summary>
                    <div className="cdx-turn-body cdx-turn-body--md">
                      <MarkdownText text={truncateText(segment.text, 6000)} />
                    </div>
                  </details>
                );
              }
              return renderToolBatch(segment, key, viewMode);
            })}

            {fallbackAssistant ? (
              <section className="cdx-mobile-msg cdx-mobile-msg--assistant">
                <header className="cdx-mobile-msg-head">
                  <strong>Codex</strong>
                  <div className="cdx-mobile-msg-actions">
                    <span className={`cdx-status ${statusClass(turn.status)}`}>
                      {statusLabelCompact(turn.status)}
                    </span>
                    <button
                      type="button"
                      className="cdx-mobile-inline-btn"
                      onClick={() => onCopyMessage(fallbackAssistant)}
                    >
                      Copy
                    </button>
                  </div>
                </header>
                <div className="cdx-turn-body cdx-turn-body--md">
                  <MarkdownText text={fallbackAssistant} />
                  {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                </div>
              </section>
            ) : null}

            {segments.every((s) => s.kind === "user") && !fallbackAssistant ? (
              <p className="cdx-helper">
                {isPending
                  ? "Sending…"
                  : turn.isStreaming
                    ? "Codex is responding..."
                    : "Waiting for response..."}
              </p>
            ) : null}

            {!isPending && renderTurnActions ? renderTurnActions(turn.turnId) : null}

            {!isPending ? (
              <button
                type="button"
                className="cdx-mobile-inline-btn cdx-mobile-detail-btn"
                data-testid={`mobile-message-details-open-${turn.turnId}`}
                onClick={() => onOpenMessageDetails(turn.turnId)}
              >
                Message details · {statusLabel(turn.status)} · {formatTimestamp(turn.startedAt)}
              </button>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
