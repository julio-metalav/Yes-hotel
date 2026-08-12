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
  // Sem provenance conhecida (ex.: prefill legado): OCR/hits podem sobrescrever;
  // manual explícito nunca é sobrescrito por origem mais fraca.
  if (!input.currentOrigin) {
    return PRIORITY[input.suggestedOrigin] > PRIORITY.legacy;
  }
  return PRIORITY[input.suggestedOrigin] > PRIORITY[input.currentOrigin];
}

export function normalizeComparableFnrhValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim();
}

/**
 * Provenance final no confirm v2.
 * - Preserva mapa existente (nunca zera indevidamente).
 * - Campos enviados com valor diferente do persistido → manual.
 * - Campos inalterados mantêm ocr/hits/legacy.
 * - Nunca rebaixa manual para ocr/hits.
 */
export function buildConfirmFieldProvenance(input: {
  existing: FnrhFieldProvenanceMap | null | undefined;
  previousValues: Record<string, unknown>;
  submittedBody: Record<string, unknown>;
  fieldKeys: readonly string[];
}): FnrhFieldProvenanceMap {
  const updates: FnrhFieldProvenanceMap = {};
  for (const key of input.fieldKeys) {
    if (!(key in input.submittedBody)) continue;
    const prev = normalizeComparableFnrhValue(input.previousValues[key]);
    const next = normalizeComparableFnrhValue(input.submittedBody[key]);
    if (next === prev) continue;
    updates[key] = "manual";
  }
  return mergeFieldProvenance(input.existing ?? {}, updates);
}

/** FNRH confirmada/completa não deve receber overwrite de sync/prefill HITS. */
export function isFnrhLockedAgainstHitsPrefill(input: {
  dataConfirmed?: unknown;
  status?: unknown;
  lifecycleStatus?: unknown;
}): boolean {
  if (input.dataConfirmed === true) return true;
  const st = String(input.status ?? "")
    .trim()
    .toLowerCase();
  if (st === "confirmado_hospede" || st === "confirmado_hotel") return true;
  const life = String(input.lifecycleStatus ?? "")
    .trim()
    .toLowerCase();
  return life === "completed" || life === "waived" || life === "manual_completed";
}
