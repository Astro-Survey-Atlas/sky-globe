/** Stable categorical colors used when a survey record has no usable color. */
const FALLBACK_SURVEY_COLORS = [
  "#e15759",
  "#f28e2b",
  "#59a14f",
  "#b279a2",
  "#4e79a7",
  "#edc948",
  "#76b7b2",
  "#ff9da7",
  "#9c755f",
  "#af7aa1",
  "#2f8f9d",
  "#d37295",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const GENERIC_SURVEY_COLORS = new Set(["#376b9b", "#82979e"]);

export function fallbackSurveyColor(surveyId: string): string {
  let hash = 2166136261;
  for (const character of surveyId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_SURVEY_COLORS[(hash >>> 0) % FALLBACK_SURVEY_COLORS.length]!;
}

/** Use the survey catalog's color first. Layer colors are compatibility
 * fallbacks for records that are not present in the survey catalog. */
export function surveyColorFor(surveyId: string, ...sources: Array<string | undefined>): string {
  for (const source of sources) {
    const color = source?.trim().toLowerCase();
    if (color && HEX_COLOR.test(color) && !GENERIC_SURVEY_COLORS.has(color)) return color;
  }
  return fallbackSurveyColor(surveyId);
}
