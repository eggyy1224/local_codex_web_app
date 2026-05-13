"use client";

import type { ReactNode, RefObject } from "react";
import type { ConversationTurn, TurnSegment, TurnStatus } from "../../lib/thread-logic";
import { statusClass, statusLabel, truncateText } from "../../lib/thread-logic";

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
): ReactNode {
  return (
    <details
      key={key}
      className="cdx-mobile-tool-batch"
      data-testid="mobile-tool-batch"
    >
      <summary className="cdx-mobile-tool-batch-summary">
        <span className="cdx-mobile-tool-batch-icon" aria-hidden="true">⚙</span>
        <span className="cdx-mobile-tool-batch-text">{segment.summary}</span>
      </summary>
      <div className="cdx-mobile-tool-batch-body">
        {segment.items.map((item, index) => {
          const itemKey = `${key}-item-${index}`;
          if (item.kind === "toolCall") {
            return (
              <section className="cdx-mobile-msg cdx-mobile-msg--detail" key={itemKey}>
                <header className="cdx-mobile-msg-head">
                  <strong>Tool call: {item.toolName}</strong>
                </header>
                {item.text ? (
                  <pre className="cdx-turn-body">{truncateText(item.text, 4500)}</pre>
                ) : null}
              </section>
            );
          }
          return (
            <section className="cdx-mobile-msg cdx-mobile-msg--detail" key={itemKey}>
              <header className="cdx-mobile-msg-head">
                <strong>Tool output</strong>
              </header>
              <pre className="cdx-turn-body">{truncateText(item.text, 4500)}</pre>
            </section>
          );
        })}
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
}: MobileMessageStreamProps) {
  return (
    <section
      ref={timelineRef}
      onScroll={onTimelineScroll}
      className="cdx-mobile-message-stream"
      data-testid="timeline"
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
                    <pre className="cdx-turn-body">
                      {segment.text}
                      {turn.isStreaming && isLastAssistant ? (
                        <span className="cdx-stream-cursor" aria-hidden="true" />
                      ) : null}
                    </pre>
                  </section>
                );
              }
              if (segment.kind === "thinking") {
                return (
                  <details key={key} className="cdx-mobile-thinking-inline">
                    <summary>Thinking</summary>
                    <pre className="cdx-turn-body">{truncateText(segment.text, 6000)}</pre>
                  </details>
                );
              }
              return renderToolBatch(segment, key);
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
                <pre className="cdx-turn-body">
                  {fallbackAssistant}
                  {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                </pre>
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
