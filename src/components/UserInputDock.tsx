import { useEffect, useMemo, useState } from "react";
import {
  normalizeUserInputAnswers,
  userInputAnswersComplete,
  type UserInputRequest,
} from "../userInput";

type Props = {
  request: UserInputRequest;
  busy?: boolean;
  onSubmit: (answers: string[][]) => void;
  onReject: () => void;
};

export function UserInputDock({ request, busy = false, onSubmit, onReject }: Props) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState<string[][]>([]);
  const [custom, setCustom] = useState<string[]>([]);

  useEffect(() => {
    setQuestionIndex(0);
    setSelected(request.questions.map(() => []));
    setCustom(request.questions.map(() => ""));
  }, [request.requestId, request.questions]);

  const answers = useMemo(
    () => normalizeUserInputAnswers(request, selected, custom),
    [custom, request, selected],
  );
  const question = request.questions[questionIndex];
  if (!question) return null;

  const activeSelected = selected[questionIndex] ?? [];
  const activeCustom = custom[questionIndex] ?? "";
  const atLast = questionIndex === request.questions.length - 1;
  const activeAnswered = (answers[questionIndex]?.length ?? 0) > 0;

  const toggleOption = (label: string) => {
    if (!question.multiple) {
      setSelected((current) =>
        request.questions.map((_, index) =>
          index === questionIndex ? [label] : [...(current[index] ?? [])],
        ),
      );
      setCustom((current) =>
        request.questions.map((_, index) =>
          index === questionIndex ? "" : current[index] ?? "",
        ),
      );
      return;
    }
    setSelected((current) => {
      const next = request.questions.map((_, index) => [...(current[index] ?? [])]);
      next[questionIndex] = next[questionIndex].includes(label)
        ? next[questionIndex].filter((item) => item !== label)
        : [...next[questionIndex], label];
      return next;
    });
  };

  return (
    <section className="user-input-dock" aria-label="Agent question">
      <div className="user-input-dock__head">
        <span className="user-input-dock__eyebrow">Input needed</span>
        {request.questions.length > 1 ? (
          <span className="user-input-dock__count">
            {questionIndex + 1}/{request.questions.length}
          </span>
        ) : null}
      </div>
      <div className="user-input-dock__header">{question.header}</div>
      <div className="user-input-dock__question">{question.question}</div>
      {question.options.length > 0 ? (
        <div className="user-input-dock__options">
          {question.options.map((option) => {
            const active = activeSelected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={`user-input-dock__option${active ? " is-active" : ""}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => toggleOption(option.label)}
              >
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {question.custom ? (
        <input
          className="user-input-dock__custom"
          value={activeCustom}
          disabled={busy}
          placeholder="Type another answer"
          aria-label={`Custom answer for ${question.header}`}
          onChange={(event) => {
            const value = event.target.value;
            setCustom((current) =>
              request.questions.map((_, index) =>
                index === questionIndex ? value : current[index] ?? "",
              ),
            );
            if (!question.multiple && value.trim()) {
              setSelected((current) =>
                request.questions.map((_, index) =>
                  index === questionIndex ? [] : [...(current[index] ?? [])],
                ),
              );
            }
          }}
        />
      ) : null}
      <div className="user-input-dock__actions">
        <button type="button" className="user-input-dock__skip" disabled={busy} onClick={onReject}>
          Skip
        </button>
        {questionIndex > 0 ? (
          <button
            type="button"
            className="user-input-dock__back"
            disabled={busy}
            onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          className="user-input-dock__submit"
          disabled={busy || !activeAnswered || (atLast && !userInputAnswersComplete(answers))}
          onClick={() => {
            if (atLast) onSubmit(answers);
            else setQuestionIndex((index) => index + 1);
          }}
        >
          {busy ? "Sending…" : atLast ? "Answer" : "Next"}
        </button>
      </div>
    </section>
  );
}
