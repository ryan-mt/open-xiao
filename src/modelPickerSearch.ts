type SearchableModel = {
  label: string;
  provider: string;
  providerTitle: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const FAVORITE_SCORE_BOOST = 24;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function scoreSubsequence(value: string, query: string): number | null {
  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatch === -1) firstMatch = valueIndex;
    if (previousMatch !== -1) gapPenalty += valueIndex - previousMatch - 1;
    previousMatch = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatch + 1 - query.length;
      return firstMatch * 2 + gapPenalty * 3 + spanPenalty + Math.min(64, value.length - query.length);
    }
  }

  return null;
}

function scoreField(field: string, token: string, fieldBase: number): number | null {
  if (field === token) return fieldBase;
  const lengthPenalty = Math.min(64, Math.max(0, field.length - token.length));
  if (field.startsWith(token)) return fieldBase + 2 + lengthPenalty;

  const boundaryIndex = [" ", "-", "_", "/"]
    .map((marker) => field.indexOf(`${marker}${token}`))
    .filter((index) => index >= 0)
    .map((index) => index + 1)
    .sort((left, right) => left - right)[0];
  if (boundaryIndex !== undefined) {
    return fieldBase + 4 + boundaryIndex * 2 + lengthPenalty;
  }

  const includesIndex = field.indexOf(token);
  if (includesIndex >= 0) {
    return fieldBase + 6 + includesIndex * 2 + lengthPenalty;
  }

  if (token.length < 3) return null;
  const fuzzyScore = scoreSubsequence(field, token);
  return fuzzyScore === null ? null : fieldBase + 100 + fuzzyScore;
}

export function scoreModelPickerSearch(
  model: SearchableModel,
  query: string,
): number | null {
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return 0;

  const fields = [
    normalize(model.label),
    ...(model.subProvider ? [normalize(model.subProvider)] : []),
    normalize(model.provider),
    normalize(model.providerTitle),
    normalize(
      [model.label, model.subProvider, model.provider, model.providerTitle]
        .filter(Boolean)
        .join(" "),
    ),
  ];

  let score = 0;
  for (const token of tokens) {
    const matches = fields
      .map((field, index) => scoreField(field, token, index * 10))
      .filter((value): value is number => value !== null);
    if (matches.length === 0) return null;
    score += Math.min(...matches);
  }

  return model.isFavorite ? score - FAVORITE_SCORE_BOOST : score;
}
