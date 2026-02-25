"use client";

import type { RefObject } from "react";
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
          {showAllTurns ? "Show fewer turns" : `${hiddenCount} earlier turns`}
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
                <pre className="cdx-turn-body">{truncateText(userDisplayText, 9000)}</pre>
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
                  {truncateText(turn.assistantText, 9000)}
                  {turn.isStreaming ? <span className="cdx-stream-cursor" aria-hidden="true" /> : null}
                </pre>
              </section>
            ) : (
              <p className="cdx-helper">{turn.isStreaming ? "Codex is responding..." : "Waiting for response..."}</p>
            )}

            {turn.thinkingText || turn.toolCalls.length > 0 || turn.toolResults.length > 0 ? (
              <details className="cdx-mobile-details-collapsible">
                <summary>
                  Thinking & tools ({(turn.thinkingText ? 1 : 0) + turn.toolCalls.length + turn.toolResults.length})
                </summary>
                <div className="cdx-mobile-details-body">
                  {turn.thinkingText ? (
                    <section className="cdx-mobile-msg cdx-mobile-msg--detail">
                      <header className="cdx-mobile-msg-head">
                        <strong>Thinking</strong>
                      </header>
                      <pre className="cdx-turn-body">{truncateText(turn.thinkingText, 6000)}</pre>
                    </section>
                  ) : null}
                  {turn.toolCalls.map((call, index) => (
                    <section
                      className="cdx-mobile-msg cdx-mobile-msg--detail"
                      key={`${turn.turnId}-mobile-tool-call-${index}-${call.toolName}`}
                    >
                      <header className="cdx-mobile-msg-head">
                        <strong>Tool call: {call.toolName}</strong>
                      </header>
                      {call.text ? <pre className="cdx-turn-body">{truncateText(call.text, 4500)}</pre> : null}
                    </section>
                  ))}
                  {turn.toolResults.map((result, index) => (
                    <section
                      className="cdx-mobile-msg cdx-mobile-msg--detail"
                      key={`${turn.turnId}-mobile-tool-result-${index}`}
                    >
                      <header className="cdx-mobile-msg-head">
                        <strong>Tool output</strong>
                      </header>
                      <pre className="cdx-turn-body">{truncateText(result, 4500)}</pre>
                    </section>
                  ))}
                </div>
              </details>
            ) : null}

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
