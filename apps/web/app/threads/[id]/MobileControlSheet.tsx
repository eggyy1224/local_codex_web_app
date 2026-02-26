"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecisionRequest,
  InteractionRespondRequest,
  ThreadControlRequest,
  TurnPermissionMode,
} from "@lcwa/shared-types";

type ControlSheetSection = "controls" | "settings" | "questions" | "approvals";
type ControlSheetSnap = "half" | "full";

type MobileApprovalItem = {
  approvalId: string;
  type: string;
  reason: string | null;
  commandPreview: string | null;
  fileChangePreview: string | null;
};

type MobileInteractionQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

type MobileInteractionItem = {
  interactionId: string;
  questions: MobileInteractionQuestion[];
};

type ModelOptionView = {
  value: string;
  label: string;
};

type MobileControlSheetProps = {
  open: boolean;
  section: ControlSheetSection;
  snap: ControlSheetSnap;
  isDragging: boolean;
  dragOffsetY: number;
  approvalBusy: string | null;
  interactionBusy: string | null;
  controlBusy: ThreadControlRequest["action"] | null;
  pendingApprovals: MobileApprovalItem[];
  pendingInteractions: MobileInteractionItem[];
  model: string;
  modelOptions: ModelOptionView[];
  thinkingEffort: string;
  thinkingEffortOptions: string[];
  permissionMode: TurnPermissionMode;
  onSectionChange: (section: ControlSheetSection) => void;
  onSnapChange: (snap: ControlSheetSnap) => void;
  onClose: () => void;
  onDraggingChange: (dragging: boolean) => void;
  onDragOffsetChange: (offset: number) => void;
  onControl: (action: ThreadControlRequest["action"]) => void;
  onDecision: (approvalId: string, decision: ApprovalDecisionRequest["decision"]) => void;
  onRespondInteraction: (
    interactionId: string,
    answers: InteractionRespondRequest["answers"],
  ) => void;
  onModelChange: (value: string) => void;
  onThinkingEffortChange: (value: string) => void;
  onPermissionModeChange: (value: TurnPermissionMode) => void;
  formatEffortLabel: (value: string) => string;
};

const SHEET_HALF_VISIBLE_VH = 44;
const SHEET_FULL_HEIGHT_VH = 82;
const SHEET_OPEN_DISTANCE_THRESHOLD = 64;
const SHEET_OPEN_VELOCITY_THRESHOLD = 0.35;
const SHEET_CLOSE_DISTANCE_THRESHOLD = 72;
const SHEET_CLOSE_VELOCITY_THRESHOLD = 0.4;

export default function MobileControlSheet({
  open,
  section,
  snap,
  isDragging,
  dragOffsetY,
  approvalBusy,
  interactionBusy,
  controlBusy,
  pendingApprovals,
  pendingInteractions,
  model,
  modelOptions,
  thinkingEffort,
  thinkingEffortOptions,
  permissionMode,
  onSectionChange,
  onSnapChange,
  onClose,
  onDraggingChange,
  onDragOffsetChange,
  onControl,
  onDecision,
  onRespondInteraction,
  onModelChange,
  onThinkingEffortChange,
  onPermissionModeChange,
  formatEffortLabel,
}: MobileControlSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{ startY: number; startTs: number } | null>(null);
  const viewportHeightRef = useRef<number>(844);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(844);
  const [questionDrafts, setQuestionDrafts] = useState<
    Record<string, Record<string, { selected: string | null; other: string; freeform: string }>>
  >({});

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const sync = () => {
      const next = Math.max(320, window.innerHeight);
      viewportHeightRef.current = next;
      setViewportHeight(next);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const offsetHalfPx = useMemo(() => {
    const sheetHeight = viewportHeight * (SHEET_FULL_HEIGHT_VH / 100);
    const visibleHalf = viewportHeight * (SHEET_HALF_VISIBLE_VH / 100);
    return Math.max(0, sheetHeight - visibleHalf);
  }, [viewportHeight]);

  const baseOffsetPx = snap === "full" ? 0 : offsetHalfPx;
  const appliedOffset = Math.max(-baseOffsetPx, dragOffsetY);
  const transformPx = baseOffsetPx + appliedOffset;

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    dragRef.current = {
      startY: event.clientY,
      startTs: performance.now(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onDraggingChange(true);
    onDragOffsetChange(0);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const deltaY = event.clientY - drag.startY;
    onDragOffsetChange(deltaY);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    onDraggingChange(false);

    if (!drag) {
      onDragOffsetChange(0);
      return;
    }

    const deltaY = event.clientY - drag.startY;
    const durationMs = Math.max(1, performance.now() - drag.startTs);
    const velocity = deltaY / durationMs;

    if (deltaY >= SHEET_CLOSE_DISTANCE_THRESHOLD || velocity >= SHEET_CLOSE_VELOCITY_THRESHOLD) {
      onDragOffsetChange(0);
      onClose();
      return;
    }

    if (-deltaY >= SHEET_OPEN_DISTANCE_THRESHOLD || -velocity >= SHEET_OPEN_VELOCITY_THRESHOLD) {
      onSnapChange("full");
      onDragOffsetChange(0);
      return;
    }

    onDragOffsetChange(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }

    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );

    if (focusables.length === 0) {
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  if (!open) {
    return null;
  }

  const updateQuestionDraft = (
    interactionId: string,
    questionId: string,
    updater: (prev: { selected: string | null; other: string; freeform: string }) => {
      selected: string | null;
      other: string;
      freeform: string;
    },
  ) => {
    setQuestionDrafts((prev) => {
      const interaction = prev[interactionId] ?? {};
      const current = interaction[questionId] ?? { selected: null, other: "", freeform: "" };
      const nextQuestion = updater(current);
      return {
        ...prev,
        [interactionId]: {
          ...interaction,
          [questionId]: nextQuestion,
        },
      };
    });
  };

  const answersForInteraction = (
    interactionId: string,
    questions: MobileInteractionQuestion[],
  ): InteractionRespondRequest["answers"] | null => {
    const draft = questionDrafts[interactionId] ?? {};
    const result: InteractionRespondRequest["answers"] = {};

    for (const question of questions) {
      const questionDraft = draft[question.id] ?? { selected: null, other: "", freeform: "" };
      const answers: string[] = [];
      if (question.options && question.options.length > 0) {
        if (questionDraft.selected && questionDraft.selected.trim().length > 0) {
          answers.push(questionDraft.selected.trim());
        }
      } else if (questionDraft.freeform.trim().length > 0) {
        answers.push(questionDraft.freeform.trim());
      }

      if (question.isOther && questionDraft.other.trim().length > 0) {
        answers.push(questionDraft.other.trim());
      }

      if (answers.length === 0) {
        return null;
      }
      result[question.id] = { answers };
    }

    return result;
  };

  return (
    <div
      className="cdx-mobile-sheet-backdrop"
      data-testid="mobile-control-sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className={`cdx-mobile-control-sheet ${isDragging ? "is-dragging" : ""}`}
        data-testid="mobile-control-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Mobile controls"
        style={{
          transform: `translateY(${Math.max(0, transformPx)}px)`,
          transition: isDragging ? "none" : "transform 220ms ease-out",
        }}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className="cdx-mobile-sheet-header"
          data-testid="mobile-control-sheet-drag-handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <span className="cdx-mobile-composer-handle-bar" aria-hidden="true" />
          <button
            ref={closeButtonRef}
            type="button"
            className="cdx-mobile-inline-btn"
            data-testid="mobile-control-sheet-close"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <nav className="cdx-mobile-sheet-tabs">
          <button
            type="button"
            className={`cdx-mobile-sheet-tab ${section === "controls" ? "is-active" : ""}`}
            data-testid="mobile-control-tab-controls"
            onClick={() => onSectionChange("controls")}
          >
            Controls
          </button>
          <button
            type="button"
            className={`cdx-mobile-sheet-tab ${section === "settings" ? "is-active" : ""}`}
            data-testid="mobile-control-tab-settings"
            onClick={() => onSectionChange("settings")}
          >
            Settings
          </button>
          <button
            type="button"
            className={`cdx-mobile-sheet-tab ${section === "questions" ? "is-active" : ""}`}
            data-testid="mobile-control-tab-questions"
            onClick={() => onSectionChange("questions")}
          >
            Questions ({pendingInteractions.length})
          </button>
          <button
            type="button"
            className={`cdx-mobile-sheet-tab ${section === "approvals" ? "is-active" : ""}`}
            data-testid="mobile-control-tab-approvals"
            onClick={() => onSectionChange("approvals")}
          >
            Approvals ({pendingApprovals.length})
          </button>
        </nav>

        <div className="cdx-mobile-sheet-body">
          {section === "controls" ? (
            <div className="cdx-mobile-sheet-block">
              <button
                type="button"
                data-testid="control-stop"
                className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                disabled={controlBusy !== null}
                onClick={() => onControl("stop")}
              >
                {controlBusy === "stop" ? "Stopping..." : "Stop"}
              </button>
              <button
                type="button"
                data-testid="control-retry"
                className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                disabled={controlBusy !== null}
                onClick={() => onControl("retry")}
              >
                {controlBusy === "retry" ? "Retrying..." : "Retry"}
              </button>
              <button
                type="button"
                data-testid="control-cancel"
                className="cdx-toolbar-btn"
                disabled={controlBusy !== null}
                onClick={() => onControl("cancel")}
              >
                {controlBusy === "cancel" ? "Cancelling..." : "Cancel"}
              </button>
            </div>
          ) : null}

          {section === "settings" ? (
            <div className="cdx-mobile-sheet-form">
              <label className="cdx-mobile-sheet-field" htmlFor="mobile-model">
                <span>Model</span>
                <select id="mobile-model" value={model} onChange={(event) => onModelChange(event.target.value)}>
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="cdx-mobile-sheet-field" htmlFor="mobile-thinking-effort">
                <span>Thinking</span>
                <select
                  id="mobile-thinking-effort"
                  value={thinkingEffort}
                  onChange={(event) => onThinkingEffortChange(event.target.value)}
                >
                  {thinkingEffortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {formatEffortLabel(effort)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="cdx-mobile-sheet-field" htmlFor="mobile-permission-mode">
                <span>Permission</span>
                <select
                  id="mobile-permission-mode"
                  value={permissionMode}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "local" || value === "full-access") {
                      onPermissionModeChange(value);
                    }
                  }}
                >
                  <option value="local">Local (on-request)</option>
                  <option value="full-access">Full access (never)</option>
                </select>
              </label>
            </div>
          ) : null}

          {section === "questions" ? (
            <div className="cdx-mobile-approvals-list">
              {pendingInteractions.length === 0 ? <p className="cdx-helper">No pending questions.</p> : null}
              {pendingInteractions.map((interaction) => {
                const answers = answersForInteraction(interaction.interactionId, interaction.questions);
                return (
                  <article key={interaction.interactionId} className="cdx-mobile-approval-item">
                    <div className="cdx-mobile-approval-head">
                      <strong>question</strong>
                      <span className="cdx-status is-pending">pending</span>
                    </div>
                    <div className="cdx-mobile-sheet-form">
                      {interaction.questions.map((question) => {
                        const current =
                          questionDrafts[interaction.interactionId]?.[question.id] ?? {
                            selected: null,
                            other: "",
                            freeform: "",
                          };
                        return (
                          <div key={`${interaction.interactionId}-${question.id}`} className="cdx-mobile-sheet-field">
                            <span>{question.header}</span>
                            <p className="cdx-helper">{question.question}</p>
                            {question.options ? (
                              <div className="cdx-mobile-sheet-block">
                                {question.options.map((option) => (
                                  <label key={option.label} className="cdx-option-row">
                                    <input
                                      type="radio"
                                      name={`mobile-question-${interaction.interactionId}-${question.id}`}
                                      aria-label={`${option.label} - ${option.description}`}
                                      checked={current.selected === option.label}
                                      onChange={(event) => {
                                        updateQuestionDraft(
                                          interaction.interactionId,
                                          question.id,
                                          (prev) => ({
                                            ...prev,
                                            selected: event.target.checked ? option.label : null,
                                          }),
                                        );
                                      }}
                                    />
                                    <span className="cdx-option-text">
                                      <span className="cdx-option-title">{option.label}</span>
                                      <span className="cdx-option-desc">{option.description}</span>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <input
                                type={question.isSecret ? "password" : "text"}
                                value={current.freeform}
                                onChange={(event) => {
                                  updateQuestionDraft(interaction.interactionId, question.id, (prev) => ({
                                    ...prev,
                                    freeform: event.target.value,
                                  }));
                                }}
                              />
                            )}
                            {question.isOther ? (
                              <input
                                type={question.isSecret ? "password" : "text"}
                                value={current.other}
                                placeholder="Other"
                                onChange={(event) => {
                                  updateQuestionDraft(interaction.interactionId, question.id, (prev) => ({
                                    ...prev,
                                    other: event.target.value,
                                  }));
                                }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                      data-testid="interaction-submit"
                      disabled={interactionBusy !== null || !answers}
                      onClick={() => {
                        const finalAnswers = answersForInteraction(
                          interaction.interactionId,
                          interaction.questions,
                        );
                        if (!finalAnswers) {
                          return;
                        }
                        onRespondInteraction(interaction.interactionId, finalAnswers);
                      }}
                    >
                      Submit answers
                    </button>
                  </article>
                );
              })}
            </div>
          ) : null}

          {section === "approvals" ? (
            <div className="cdx-mobile-approvals-list">
              {pendingApprovals.length === 0 ? <p className="cdx-helper">No pending approvals.</p> : null}
              {pendingApprovals.map((approval) => (
                <article key={approval.approvalId} className="cdx-mobile-approval-item">
                  <div className="cdx-mobile-approval-head">
                    <strong>{approval.type}</strong>
                    <span className="cdx-status is-pending">pending</span>
                  </div>
                  <p>{approval.reason ?? "This action requires your decision."}</p>
                  {approval.commandPreview ? <pre className="cdx-turn-body">{approval.commandPreview}</pre> : null}
                  {approval.fileChangePreview ? <p>target: {approval.fileChangePreview}</p> : null}
                  <div className="cdx-mobile-approval-actions">
                    <button
                      type="button"
                      data-testid="approval-allow"
                      data-approval-id={approval.approvalId}
                      className="cdx-toolbar-btn cdx-toolbar-btn--positive"
                      disabled={approvalBusy !== null}
                      onClick={() => onDecision(approval.approvalId, "allow")}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      data-testid="approval-deny"
                      data-approval-id={approval.approvalId}
                      className="cdx-toolbar-btn cdx-toolbar-btn--danger"
                      disabled={approvalBusy !== null}
                      onClick={() => onDecision(approval.approvalId, "deny")}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      data-testid="approval-cancel"
                      data-approval-id={approval.approvalId}
                      className="cdx-toolbar-btn"
                      disabled={approvalBusy !== null}
                      onClick={() => onDecision(approval.approvalId, "cancel")}
                    >
                      Cancel
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
