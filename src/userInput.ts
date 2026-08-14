export type UserInputOption = {
  label: string;
  description: string;
};

export type UserInputQuestion = {
  header: string;
  question: string;
  options: UserInputOption[];
  multiple: boolean;
  custom: boolean;
};

export type UserInputRequest = {
  requestId: string;
  questions: UserInputQuestion[];
};

export function normalizeUserInputAnswers(
  request: UserInputRequest,
  selected: readonly (readonly string[])[],
  custom: readonly string[],
): string[][] {
  return request.questions.map((question, index) => {
    const customAnswer = (custom[index] ?? "").trim();
    const choices = [...new Set(selected[index] ?? [])]
      .map((value) => value.trim())
      .filter(Boolean);
    if (!question.multiple) {
      return customAnswer ? [customAnswer] : choices.slice(0, 1);
    }
    return customAnswer ? [...new Set([...choices, customAnswer])] : choices;
  });
}

export function userInputAnswersComplete(answers: readonly (readonly string[])[]): boolean {
  return answers.length > 0 && answers.every((answer) => answer.length > 0);
}
