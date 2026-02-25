"use client";

import { useEffect, useRef } from "react";

type MobileMessageDetails = {
  turnId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  streaming: boolean;
  toolCalls: number;
  toolResults: number;
  hasThinking: boolean;
};

type MobileMessageDetailsSheetProps = {
  open: boolean;
  details: MobileMessageDetails | null;
  onClose: () => void;
};

export default function MobileMessageDetailsSheet({
  open,
  details,
  onClose,
}: MobileMessageDetailsSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    closeButtonRef.current?.focus();
  }, [open]);

  if (!open || !details) {
    return null;
  }

  return (
    <div
      className="cdx-mobile-sheet-backdrop"
      data-testid="mobile-message-details-sheet"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="cdx-mobile-message-details-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Message details"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cdx-mobile-sheet-header">
          <strong>Message details</strong>
          <button ref={closeButtonRef} type="button" className="cdx-mobile-inline-btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="cdx-mobile-details-grid">
          <div>
            <p className="cdx-helper">Turn</p>
            <p>{details.turnId}</p>
          </div>
          <div>
            <p className="cdx-helper">Status</p>
            <p>{details.status}</p>
          </div>
          <div>
            <p className="cdx-helper">Started</p>
            <p>{details.startedAt}</p>
          </div>
          <div>
            <p className="cdx-helper">Completed</p>
            <p>{details.completedAt}</p>
          </div>
          <div>
            <p className="cdx-helper">Streaming</p>
            <p>{details.streaming ? "yes" : "no"}</p>
          </div>
          <div>
            <p className="cdx-helper">Thinking</p>
            <p>{details.hasThinking ? "yes" : "no"}</p>
          </div>
          <div>
            <p className="cdx-helper">Tool calls</p>
            <p>{details.toolCalls}</p>
          </div>
          <div>
            <p className="cdx-helper">Tool outputs</p>
            <p>{details.toolResults}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
