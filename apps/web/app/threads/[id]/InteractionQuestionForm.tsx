"use client";

import type { InteractionRespondRequest } from "@lcwa/shared-types";

export type InteractionQuestionFormQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type InteractionQuestionDraft = {
  selected: string | null;
  other: string;
  freeform: string;
};

export type InteractionQuestionDrafts = Record<string, Record<string, InteractionQuestionDraft>>;

type InteractionQuestionFormProps = {
  interactionId: string;
  namePrefix: string;
  questions: InteractionQuestionFormQuestion[];
  drafts: InteractionQuestionDrafts;
  onDraftChange: (
    interactionId: string,
    questionId: string,
    updater: (prev: InteractionQuestionDraft) => InteractionQuestionDraft,
  ) => void;
};

const EMPTY_DRAFT: InteractionQuestionDraft = {
  selected: null,
  other: "",
  freeform: "",
};

export function updateInteractionQuestionDrafts(
  previous: InteractionQuestionDrafts,
  interactionId: string,
  questionId: string,
  updater: (prev: InteractionQuestionDraft) => InteractionQuestionDraft,
): InteractionQuestionDrafts {
  const interaction = previous[interactionId] ?? {};
  const current = interaction[questionId] ?? EMPTY_DRAFT;
  const nextQuestion = updater(current);
  return {
    ...previous,
    [interactionId]: {
      ...interaction,
      [questionId]: nextQuestion,
    },
  };
}

export function answersForInteractionQuestions(
  drafts: InteractionQuestionDrafts,
  interactionId: string,
  questions: InteractionQuestionFormQuestion[],
): InteractionRespondRequest["answers"] | null {
  const draft = drafts[interactionId] ?? {};
  const result: InteractionRespondRequest["answers"] = {};

  for (const question of questions) {
    const questionDraft = draft[question.id] ?? EMPTY_DRAFT;
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
}

export default function InteractionQuestionForm({
  interactionId,
  namePrefix,
  questions,
  drafts,
  onDraftChange,
}: InteractionQuestionFormProps) {
  return (
    <div className="cdx-interaction-question-form">
      {questions.map((question) => {
        const current = drafts[interactionId]?.[question.id] ?? EMPTY_DRAFT;
        return (
          <div key={`${interactionId}-${question.id}`} className="cdx-interaction-question-field">
            <span>{question.header}</span>
            <p className="cdx-helper">{question.question}</p>
            {question.options && question.options.length > 0 ? (
              <div className="cdx-interaction-question-block">
                {question.options.map((option) => (
                  <label key={option.label} className="cdx-option-row">
                    <input
                      type="radio"
                      name={`${namePrefix}-question-${interactionId}-${question.id}`}
                      aria-label={`${option.label} - ${option.description}`}
                      checked={current.selected === option.label}
                      onChange={(event) => {
                        onDraftChange(interactionId, question.id, (prev) => ({
                          ...prev,
                          selected: event.target.checked ? option.label : null,
                        }));
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
                  onDraftChange(interactionId, question.id, (prev) => ({
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
                  onDraftChange(interactionId, question.id, (prev) => ({
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
  );
}
