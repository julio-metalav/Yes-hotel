/**
 * Normalização Azure prebuilt-idDocument → campos canônicos FNRH v2.
 * Azure é sugestão. Não inventa CPF a partir de outros números.
 */

import {
  classifyOcrConfidence,
  shouldAutofillFromConfidence,
  type FnrhOcrConfidenceBand,
} from "./fnrh-ocr-confidence.ts";
import type { FnrhOcrSuggestedFields } from "./fnrh-ocr-port.ts";

export type AzureIdFieldValue = {
  value?: unknown;
  content?: string;
  confidence?: number;
  valueString?: string;
  valueDate?: string;
  valueCountryRegion?: string;
};

export type AzureAnalyzeDocument = {
  docType?: string;
  fields?: Record<string, AzureIdFieldValue | undefined>;
  confidence?: number;
};

export type NormalizedOcrField = {
  value: string;
  confidence: number;
  band: FnrhOcrConfidenceBand;
  needs_review: boolean;
};

export type NormalizedOcrResult = {
  suggested_fields: FnrhOcrSuggestedFields;
  confidence: Record<string, number>;
  field_bands: Record<string, FnrhOcrConfidenceBand>;
  needs_review_fields: string[];
  document_doc_type?: string;
  pages_processed: number;
};

function fieldText(f: AzureIdFieldValue | undefined): string {
  if (!f) return "";
  if (typeof f.valueString === "string" && f.valueString.trim()) return f.valueString.trim();
  if (typeof f.valueDate === "string" && f.valueDate.trim()) return f.valueDate.trim().slice(0, 10);
  if (typeof f.valueCountryRegion === "string" && f.valueCountryRegion.trim()) {
    return f.valueCountryRegion.trim();
  }
  if (typeof f.content === "string" && f.content.trim()) return f.content.trim();
  if (typeof f.value === "string" && f.value.trim()) return f.value.trim();
  if (f.value != null && typeof f.value !== "object") return String(f.value).trim();
  return "";
}

function fieldConfidence(f: AzureIdFieldValue | undefined): number | null {
  if (!f || f.confidence == null) return null;
  const n = Number(f.confidence);
  return Number.isFinite(n) ? n : null;
}

function mapSex(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "M" || s === "MALE" || s === "MASCULINO") return "M";
  if (s === "F" || s === "FEMALE" || s === "FEMININO") return "F";
  if (!s) return "";
  return "outro";
}

function mapDocType(azureDocType: string | undefined, requested: string): string {
  const t = String(azureDocType ?? "").toLowerCase();
  if (t.includes("passport")) return "passport";
  if (t.includes("driver") || t.includes("license")) return "cnh";
  if (t.includes("nationalidentity") || t.includes("identitycard") || t.includes("iddocument")) {
    return requested === "rg" || requested === "cnh" || requested === "passport" ? requested : "rg";
  }
  return requested || "other";
}

function composeName(fields: Record<string, AzureIdFieldValue | undefined>): {
  value: string;
  confidence: number | null;
} {
  const first = fields.FirstName;
  const middle = fields.MiddleName;
  const last = fields.LastName;
  const parts = [fieldText(first), fieldText(middle), fieldText(last)].filter(Boolean);
  if (parts.length === 0) return { value: "", confidence: null };
  const confs = [fieldConfidence(first), fieldConfidence(middle), fieldConfidence(last)].filter(
    (c): c is number => c != null,
  );
  const confidence = confs.length ? Math.min(...confs) : null;
  return { value: parts.join(" ").replace(/\s+/g, " ").trim(), confidence };
}

function putField(
  out: NormalizedOcrResult,
  key: keyof FnrhOcrSuggestedFields,
  value: string,
  confidence: number | null,
): void {
  if (!value) return;
  const band = classifyOcrConfidence(confidence);
  const decision = shouldAutofillFromConfidence(band);
  if (!decision.apply) return;
  out.suggested_fields[key] = value;
  if (confidence != null) out.confidence[key] = confidence;
  out.field_bands[key] = band;
  if (decision.needs_review) out.needs_review_fields.push(key);
}

/**
 * Normaliza o primeiro documento útil do analyzeResult.
 * PersonalNumber NÃO vira CPF automaticamente (não inventar CPF).
 */
export function normalizeAzureIdDocumentResult(input: {
  analyzeResult?: {
    documents?: AzureAnalyzeDocument[];
    pages?: unknown[];
  } | null;
  requested_document_type?: string;
}): NormalizedOcrResult {
  const out: NormalizedOcrResult = {
    suggested_fields: {},
    confidence: {},
    field_bands: {},
    needs_review_fields: [],
    pages_processed: Array.isArray(input.analyzeResult?.pages)
      ? input.analyzeResult!.pages!.length
      : 0,
  };

  const docs = input.analyzeResult?.documents ?? [];
  if (!docs.length) return out;

  // Prefer passport/driver/id card by confidence
  const sorted = [...docs].sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  const doc = sorted[0];
  const fields = doc.fields ?? {};
  out.document_doc_type = doc.docType;
  if (!out.pages_processed) out.pages_processed = 1;

  const name = composeName(fields);
  putField(out, "hospede_nome", name.value, name.confidence);

  putField(out, "data_nascimento", fieldText(fields.DateOfBirth), fieldConfidence(fields.DateOfBirth));
  putField(
    out,
    "documento_numero",
    fieldText(fields.DocumentNumber),
    fieldConfidence(fields.DocumentNumber),
  );
  putField(out, "sexo", mapSex(fieldText(fields.Sex)), fieldConfidence(fields.Sex));

  const nationality = fieldText(fields.Nationality) || fieldText(fields.CountryRegion);
  putField(
    out,
    "nacionalidade",
    nationality,
    fieldConfidence(fields.Nationality) ?? fieldConfidence(fields.CountryRegion),
  );
  putField(
    out,
    "pais_emissor",
    fieldText(fields.CountryRegion),
    fieldConfidence(fields.CountryRegion),
  );
  putField(
    out,
    "documento_validade",
    fieldText(fields.DateOfExpiration),
    fieldConfidence(fields.DateOfExpiration),
  );

  const mappedTipo = mapDocType(doc.docType, input.requested_document_type ?? "");
  if (mappedTipo) {
    putField(out, "documento_tipo", mappedTipo, doc.confidence ?? null);
  }

  // MRZ fallback only for empty canonical fields (passport)
  const mrz = fields.MachineReadableZone as
    | (AzureIdFieldValue & { valueObject?: Record<string, AzureIdFieldValue> })
    | undefined;
  const mrzObj = (mrz as { valueObject?: Record<string, AzureIdFieldValue> } | undefined)?.valueObject;
  if (mrzObj) {
    if (!out.suggested_fields.hospede_nome) {
      const mrzName = composeName(mrzObj);
      putField(out, "hospede_nome", mrzName.value, mrzName.confidence);
    }
    if (!out.suggested_fields.documento_numero) {
      putField(
        out,
        "documento_numero",
        fieldText(mrzObj.DocumentNumber),
        fieldConfidence(mrzObj.DocumentNumber),
      );
    }
    if (!out.suggested_fields.data_nascimento) {
      putField(
        out,
        "data_nascimento",
        fieldText(mrzObj.DateOfBirth),
        fieldConfidence(mrzObj.DateOfBirth),
      );
    }
    if (!out.suggested_fields.nacionalidade) {
      putField(
        out,
        "nacionalidade",
        fieldText(mrzObj.Nationality),
        fieldConfidence(mrzObj.Nationality),
      );
    }
    if (!out.suggested_fields.sexo) {
      putField(out, "sexo", mapSex(fieldText(mrzObj.Sex)), fieldConfidence(mrzObj.Sex));
    }
  }

  return out;
}

/** Combina frente/verso: conflito com confidences próximas → needs_review, sem decisão silenciosa. */
export function mergeFrontBackNormalized(
  front: NormalizedOcrResult,
  back: NormalizedOcrResult,
  ambiguityDelta = 0.08,
): NormalizedOcrResult {
  const out: NormalizedOcrResult = {
    suggested_fields: { ...front.suggested_fields },
    confidence: { ...front.confidence },
    field_bands: { ...front.field_bands },
    needs_review_fields: [...front.needs_review_fields],
    document_doc_type: front.document_doc_type || back.document_doc_type,
    pages_processed: (front.pages_processed || 0) + (back.pages_processed || 0),
  };

  for (const [key, backVal] of Object.entries(back.suggested_fields) as Array<
    [keyof FnrhOcrSuggestedFields, string]
  >) {
    const frontVal = out.suggested_fields[key];
    const backConf = back.confidence[key] ?? 0;
    const frontConf = out.confidence[key] ?? 0;
    if (!frontVal) {
      out.suggested_fields[key] = backVal;
      if (back.confidence[key] != null) out.confidence[key] = back.confidence[key]!;
      out.field_bands[key] = back.field_bands[key] ?? "unknown";
      if (back.needs_review_fields.includes(key) && !out.needs_review_fields.includes(key)) {
        out.needs_review_fields.push(key);
      }
      continue;
    }
    if (frontVal === backVal) {
      out.confidence[key] = Math.max(frontConf, backConf);
      continue;
    }
    // Conflito
    if (Math.abs(frontConf - backConf) <= ambiguityDelta) {
      if (!out.needs_review_fields.includes(key)) out.needs_review_fields.push(key);
      // Mantém o de maior confidence sem apagar o conflito (review obrigatório)
      if (backConf > frontConf) {
        out.suggested_fields[key] = backVal;
        out.confidence[key] = backConf;
        out.field_bands[key] = back.field_bands[key] ?? "medium";
      }
    } else if (backConf > frontConf) {
      out.suggested_fields[key] = backVal;
      out.confidence[key] = backConf;
      out.field_bands[key] = back.field_bands[key] ?? "medium";
    }
  }
  return out;
}
