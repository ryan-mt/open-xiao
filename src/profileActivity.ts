const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export type RollingActivityStats = {
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  totalMessages: number;
  totalOpenAITokens: number;
  days: { date: string; count: number; tokenCount: number }[];
};

function activityDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function rollingActivityStats(
  messages: Record<string, number>,
  tokens: Record<string, number>,
  daysBack: number,
  endDate = new Date(),
): RollingActivityStats {
  const end = new Date(endDate);
  end.setHours(12, 0, 0, 0);
  const days = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setDate(end.getDate() - i);
    const key = activityDayKey(date);
    days.push({
      date: key,
      count: messages[key] ?? 0,
      tokenCount: tokens[key] ?? 0,
    });
  }

  const today = activityDayKey(end);
  const active = Array.from(
    new Set([...Object.keys(messages), ...Object.keys(tokens)]),
  )
    .filter(
      (key) =>
        key <= today && ((messages[key] ?? 0) > 0 || (tokens[key] ?? 0) > 0),
    )
    .sort();
  const activeSet = new Set(active);
  let currentStreak = 0;
  const cursor = new Date(end);
  if (!activeSet.has(activityDayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (activeSet.has(activityDayKey(cursor))) {
    currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longestStreak = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const day of active) {
    const current = new Date(`${day}T12:00:00`);
    run =
      previous &&
      Math.round((current.getTime() - previous.getTime()) / 86_400_000) === 1
        ? run + 1
        : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = current;
  }

  return {
    currentStreak,
    longestStreak,
    totalActiveDays: days.filter((day) => day.count > 0 || day.tokenCount > 0)
      .length,
    totalMessages: days.reduce((sum, day) => sum + day.count, 0),
    totalOpenAITokens: days.reduce((sum, day) => sum + day.tokenCount, 0),
    days,
  };
}

export function activityMonthLabels(
  days: { date: string }[],
  padFront: number,
): { label: string; col: number }[] {
  const labels: { label: string; col: number }[] = [];
  let previousMonth = "";
  days.forEach((day, index) => {
    const month = day.date.slice(5, 7);
    const label = MONTH_NAMES[Number(month) - 1] ?? "";
    if (!label || label === previousMonth) return;
    const next = { label, col: Math.floor((index + padFront) / 7) };
    if (labels[labels.length - 1]?.col === next.col) {
      labels[labels.length - 1] = next;
    } else labels.push(next);
    previousMonth = label;
  });
  return labels;
}

export function formatActivityTokens(tokens: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(
    tokens,
  );
}
