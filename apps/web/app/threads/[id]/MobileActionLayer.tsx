"use client";

import type { ApprovalDecisionRequest, ApprovalType } from "@lcwa/shared-types";

type MinimalApproval = {
  approvalId: string;
  type: ApprovalType;
  reason: string | null;
  commandPreview: string | null;
  fileChangePreview: string | null;
};

type MinimalInteraction = { interactionId: string };

type MobileActionLayerProps = {
  pendingApprovals: MinimalApproval[];
  pendingInteractions: MinimalInteraction[];
  approvalBusy: string | null;
  onDecision: (approvalId: string, decision: ApprovalDecisionRequest["decision"]) => void;
  onOpenQuestion: () => void;
};

export default function MobileActionLayer({
  pendingApprovals,
  pendingInteractions,
  approvalBusy,
  onDecision,
  onOpenQuestion,
}: MobileActionLayerProps) {
  // Interaction (questions) takes priority — they block the turn the same way approvals do
  // but require typed input, which only fits the dedicated sheet form.
  if (pendingInteractions.length > 0) {
    const remaining = pendingInteractions.length;
    return (
      <section
        className="cdx-mobile-action-layer cdx-mobile-action-layer--question"
        data-testid="mobile-action-layer"
        data-kind="question"
      >
        <header className="cdx-mobile-action-head">
          <strong>Codex needs an answer</strong>
          {remaining > 1 ? (
            <span className="cdx-mobile-action-count">{remaining} pending</span>
          ) : null}
        </header>
        <button
          type="button"
          className="cdx-toolbar-btn cdx-toolbar-btn--positive"
          data-testid="mobile-action-open-question"
          onClick={onOpenQuestion}
        >
          Answer
        </button>
      </section>
    );
  }

  const approval = pendingApprovals[0];
  if (!approval) {
    return null;
  }
  const remaining = pendingApprovals.length;
  const busy = approvalBusy !== null;
  const kindLabel = approval.type === "commandExecution" ? "Run command" : "Apply file change";

  return (
    <section
      className="cdx-mobile-action-layer cdx-mobile-action-layer--approval"
      data-testid="mobile-action-layer"
      data-kind="approval"
      data-approval-id={approval.approvalId}
    >
      <header className="cdx-mobile-action-head">
        <strong>{kindLabel}?</strong>
        {remaining > 1 ? (
          <span className="cdx-mobile-action-count">{remaining} pending</span>
        ) : null}
      </header>
      {approval.reason ? <p className="cdx-mobile-action-reason">{approval.reason}</p> : null}
      {approval.commandPreview ? (
        <pre className="cdx-mobile-action-preview">{approval.commandPreview}</pre>
      ) : null}
      {approval.fileChangePreview ? (
        <p className="cdx-mobile-action-target">{approval.fileChangePreview}</p>
      ) : null}
      <div className="cdx-mobile-action-row">
        <button
          type="button"
          className="cdx-toolbar-btn cdx-toolbar-btn--positive"
          data-testid="mobile-action-allow"
          data-approval-id={approval.approvalId}
          disabled={busy}
          onClick={() => onDecision(approval.approvalId, "allow")}
        >
          Allow
        </button>
        <button
          type="button"
          className="cdx-toolbar-btn cdx-toolbar-btn--danger"
          data-testid="mobile-action-deny"
          data-approval-id={approval.approvalId}
          disabled={busy}
          onClick={() => onDecision(approval.approvalId, "deny")}
        >
          Deny
        </button>
      </div>
    </section>
  );
}
