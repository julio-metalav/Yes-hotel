/**
 * Proveniência de campos FNRH: prioridade manual > ocr > hits > legacy.
 */

export type FnrhFieldOrigin = "manual" | "ocr" | "hits" | "legacy";

export type FnrhFieldProvenanceMap = Record<string, FnrhFieldOrigin>;

const PRIORITY: Record<FnrhFieldOrigin, number> = {
  manual: 4,
  ocr: 3,
  hits: 2,
  legacy: 1,
};

export function preferFieldOrigin(
  current: FnrhFieldOrigin | null | undefined,
  incoming: FnrhFieldOrigin,
): FnrhFieldOrigin {
  if (!current) return incoming;
  return PRIORITY[incoming] >= PRIORITY[current] ? incoming : current;
}

export function mergeFieldProvenance(
  existing: FnrhFieldProvenanceMap | null | undefined,
  updates: FnrhFieldProvenanceMap,
): FnrhFieldProvenanceMap {
  const out: FnrhFieldProvenanceMap = { ...(existing ?? {}) };
  for (const [field, origin] of Object.entries(updates)) {
    out[field] = preferFieldOrigin(out[field], origin);
  }
  return out;
}

/** Aplica valor sugerido só se o campo atual estiver vazio ou origem permitir overwrite. */
export function shouldApplySuggestedValue(input: {
  currentValue: unknown;
  currentOrigin?: FnrhFieldOrigin | null;
  suggestedOrigin: FnrhFieldOrigin;
}): boolean {
  const empty =
    input.currentValue == null ||
    (typeof input.currentValue === "string" && input.currentValue.trim() === "");
  if (empty) return true;
  if (!input.currentOrigin) return false;
  return PRIORITY[input.suggestedOrigin] > PRIORITY[input.currentOrigin];
}
