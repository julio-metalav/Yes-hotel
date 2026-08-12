/**
 * Política centralizada de confidence OCR FNRH.
 * Thresholds configuráveis; UI não deve reinventar.
 */

export const FNRH_OCR_CONFIDENCE_HIGH = 0.85;
export const FNRH_OCR_CONFIDENCE_MEDIUM = 0.6;

export type FnrhOcrConfidenceBand = "high" | "medium" | "low" | "unknown";

export function classifyOcrConfidence(
  score: number | null | undefined,
  thresholds: { high?: number; medium?: number } = {},
): FnrhOcrConfidenceBand {
  if (score == null || Number.isNaN(Number(score))) return "unknown";
  const n = Number(score);
  if (n < 0 || n > 1) return "unknown";
  const high = thresholds.high ?? FNRH_OCR_CONFIDENCE_HIGH;
  const medium = thresholds.medium ?? FNRH_OCR_CONFIDENCE_MEDIUM;
  if (n >= high) return "high";
  if (n >= medium) return "medium";
  return "low";
}

/**
 * HIGH → aplicar; MEDIUM → aplicar + review; LOW/unknown → não aplicar como valor confiável.
 */
export function shouldAutofillFromConfidence(band: FnrhOcrConfidenceBand): {
  apply: boolean;
  needs_review: boolean;
} {
  if (band === "high") return { apply: true, needs_review: false };
  if (band === "medium") return { apply: true, needs_review: true };
  return { apply: false, needs_review: false };
}

export const FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY = 3;

export const FNRH_OCR_AZURE_MODEL = "prebuilt-idDocument";
export const FNRH_OCR_AZURE_API_VERSION = "2024-11-30";
