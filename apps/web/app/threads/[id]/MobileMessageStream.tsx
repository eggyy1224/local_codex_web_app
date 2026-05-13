"use client";

import type { ReactNode, RefObject } from "react";
import type { ConversationTurn, TurnStatus } from "../../lib/thread-logic";
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
        const userDisplayText = reviewSlashCommand ?? turn.userText;

        return (
          <article
            key={turn.turnId}
            className={`cdx-mobile-turn ${turn.isStreaming ? "is-streaming" : ""}`}
          >
            {userDisplayText ? (
              <section className="cdx-mobile-msg cdx-mobile-msg--user">
                <header className="cdx-mobile-msg-head">
                  <span>You</span>
                </header>
                <pre className="cdx-turn-body">{userDisplayText}</pre>
              </section>
            ) : null}

            {turn.assistantText ? (
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
                      onClick={() => onCopyMessage(turn.assistantText ?? "")}
                    >
                      Copy
                    </button>
                  </div>
                </header>
                <pre className="cdx-turn-body">
                  {turn.assistantText}
                  {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                </pre>
              </section>
            ) : (
              <p className="cdx-helper">{turn.isStreaming ? "Codex is responding..." : "Waiting for response..."}</p>
            )}

            {turn.details.length > 0 ? (
              <details className="cdx-mobile-details-collapsible">
                <summary>Thinking & tools ({turn.details.length})</summary>
                <div className="cdx-mobile-details-body">
                  {turn.details.map((detail, index) => {
                    const key = `${turn.turnId}-detail-${index}-${detail.kind}`;
                    if (detail.kind === "thinking") {
                      return (
                        <section className="cdx-mobile-msg cdx-mobile-msg--detail" key={key}>
                          <header className="cdx-mobile-msg-head">
                            <strong>Thinking</strong>
                          </header>
                          <pre className="cdx-turn-body">{truncateText(detail.text, 6000)}</pre>
                        </section>
                      );
                    }
                    if (detail.kind === "toolCall") {
                      return (
                        <section className="cdx-mobile-msg cdx-mobile-msg--detail" key={key}>
                          <header className="cdx-mobile-msg-head">
                            <strong>Tool call: {detail.toolName}</strong>
                          </header>
                          {detail.text ? (
                            <pre className="cdx-turn-body">{truncateText(detail.text, 4500)}</pre>
                          ) : null}
                        </section>
                      );
                    }
                    return (
                      <section className="cdx-mobile-msg cdx-mobile-msg--detail" key={key}>
                        <header className="cdx-mobile-msg-head">
                          <strong>Tool output</strong>
                        </header>
                        <pre className="cdx-turn-body">{truncateText(detail.text, 4500)}</pre>
                      </section>
                    );
                  })}
                </div>
              </details>
            ) : null}

            {renderTurnActions ? renderTurnActions(turn.turnId) : null}

            <button
              type="button"
              className="cdx-mobile-inline-btn cdx-mobile-detail-btn"
              data-testid={`mobile-message-details-open-${turn.turnId}`}
              onClick={() => onOpenMessageDetails(turn.turnId)}
            >
              Message details · {statusLabel(turn.status)} · {formatTimestamp(turn.startedAt)}
            </button>
          </article>
        );
      })}
    </section>
  );
}
