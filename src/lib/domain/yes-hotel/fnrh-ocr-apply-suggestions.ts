/**
 * Aplica suggested_fields OCR em linha FNRH respeitando provenance.
 * Persistível server-side (fnrh-document-upload) e testável sem I/O.
 */

import {
  mergeFieldProvenance,
  shouldApplySuggestedValue,
  type FnrhFieldOrigin,
  type FnrhFieldProvenanceMap,
} from "./fnrh-field-provenance.ts";
import type { FnrhOcrSuggestedFields } from "./fnrh-ocr-port.ts";

/** Campos FNRH que OCR pode persistir (sem texto bruto / sem CNH-RG extras). */
export const FNRH_OCR_PERSISTABLE_KEYS = [
  "hospede_nome",
  "data_nascimento",
  "nacionalidade",
  "sexo",
  "documento_tipo",
  "documento_numero",
] as const;

export type FnrhOcrPersistableKey = (typeof FNRH_OCR_PERSISTABLE_KEYS)[number];

const CANONICAL_DOC_TYPES = new Set(["cpf", "passport"]);

/** Placeholder técnico do upload / tipos físicos — não são identificador canônico. */
export function isNonCanonicalDocumentoTipo(value: unknown): boolean {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return true;
  if (CANONICAL_DOC_TYPES.has(s)) return false;
  return (
    s === "other" ||
    s === "cnh" ||
    s === "rg" ||
    s === "birth_certificate" ||
    s === "travel_authorization"
  );
}

/**
 * Normaliza suggestions OCR para política canônica CPF/passaporte.
 * Remove other/cnh/rg; promove cpf explícito.
 */
export function canonicalizeOcrSuggestedFields(
  suggested: FnrhOcrSuggestedFields | null | undefined,
): Partial<Record<FnrhOcrPersistableKey, string>> {
  const src = suggested ?? {};
  const out: Partial<Record<FnrhOcrPersistableKey, string>> = {};

  const nome = String(src.hospede_nome ?? "").trim();
  if (nome) out.hospede_nome = nome;

  const dob = String(src.data_nascimento ?? "").trim().slice(0, 10);
  if (dob) out.data_nascimento = dob;

  const nac = String(src.nacionalidade ?? "").trim();
  if (nac) out.nacionalidade = nac;

  const sexo = String(src.sexo ?? "").trim();
  if (sexo) out.sexo = sexo;

  const cpfDigits = String(src.cpf ?? "").replace(/\D/g, "");
  let tipo = String(src.documento_tipo ?? "").trim().toLowerCase();
  let numero = String(src.documento_numero ?? "").trim();

  if (cpfDigits.length === 11) {
    tipo = "cpf";
    numero = cpfDigits;
  }

  if (tipo === "cpf") {
    const digits = numero.replace(/\D/g, "");
    if (digits.length === 11) {
      out.documento_tipo = "cpf";
      out.documento_numero = digits;
    }
  } else if (tipo === "passport") {
    const pass = numero.toUpperCase().replace(/\s+/g, "");
    if (pass.length >= 6 && pass.length <= 12) {
      out.documento_tipo = "passport";
      out.documento_numero = pass;
    }
  }
  // other/cnh/rg → nunca persistem como documento_tipo

  return out;
}

function effectiveCurrentValue(key: string, value: unknown): unknown {
  if (key === "documento_tipo" && isNonCanonicalDocumentoTipo(value)) return "";
  return value;
}

export function buildOcrPersistPatch(input: {
  currentRow: Record<string, unknown>;
  currentProvenance?: FnrhFieldProvenanceMap | null;
  suggested: FnrhOcrSuggestedFields | null | undefined;
}): {
  update: Record<string, unknown>;
  provenanceUpdates: FnrhFieldProvenanceMap;
  appliedKeys: string[];
  fieldProvenance: FnrhFieldProvenanceMap;
} {
  const canonical = canonicalizeOcrSuggestedFields(input.suggested);
  const update: Record<string, unknown> = {};
  const provenanceUpdates: FnrhFieldProvenanceMap = {};
  const appliedKeys: string[] = [];
  const existing = input.currentProvenance ?? {};

  for (const key of FNRH_OCR_PERSISTABLE_KEYS) {
    const suggestedVal = canonical[key];
    if (suggestedVal == null || String(suggestedVal).trim() === "") continue;

    const currentRaw = input.currentRow[key];
    const currentValue = effectiveCurrentValue(key, currentRaw);
    const currentOrigin = (existing[key] as FnrhFieldOrigin | undefined) ?? null;

    if (
      !shouldApplySuggestedValue({
        currentValue,
        currentOrigin,
        suggestedOrigin: "ocr",
      })
    ) {
      continue;
    }

    update[key] = suggestedVal;
    provenanceUpdates[key] = "ocr";
    appliedKeys.push(key);
  }

  if (update.documento_tipo === "cpf" && typeof update.documento_numero === "string") {
    update.documento = update.documento_numero;
    if (!appliedKeys.includes("documento")) {
      // documento legado acompanha CPF sem provenance própria obrigatória
    }
  } else if (update.documento_tipo === "passport" && typeof update.documento_numero === "string") {
    update.documento = update.documento_numero;
  } else if (
    update.documento_numero &&
    !update.documento_tipo &&
    String(input.currentRow.documento_tipo || "").toLowerCase() === "cpf"
  ) {
    update.documento = update.documento_numero;
  }

  return {
    update,
    provenanceUpdates,
    appliedKeys,
    fieldProvenance: mergeFieldProvenance(existing, provenanceUpdates),
  };
}
