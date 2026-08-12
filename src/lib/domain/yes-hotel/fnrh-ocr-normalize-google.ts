/**
 * Normalização Google Vision DOCUMENT_TEXT_DETECTION → campos canônicos FNRH v2.
 * Texto livre é sugestão. Não inventa CPF. Reusa política de confidence existente.
 */

import {
  classifyOcrConfidence,
  shouldAutofillFromConfidence,
} from "./fnrh-ocr-confidence.ts";
import type { NormalizedOcrResult } from "./fnrh-ocr-normalize.ts";
import type { FnrhOcrSuggestedFields } from "./fnrh-ocr-port.ts";

/** Confidence conservadora para heurística de texto (MEDIUM → preenche + review). */
export const GOOGLE_OCR_HEURISTIC_CONFIDENCE = 0.7;

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

function onlyDigits(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

/** Validação checksum CPF (11 dígitos). Não aceita sequências repetidas. */
export function isValidCpf(raw: string): boolean {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (factor - i);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}

function mapSex(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "M" || s === "MALE" || s === "MASCULINO" || s === "MASC") return "M";
  if (s === "F" || s === "FEMALE" || s === "FEMININO" || s === "FEM") return "F";
  if (!s) return "";
  return "outro";
}

function normalizeDateBr(raw: string): string {
  const m = String(raw || "").trim().match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
  if (!m) return "";
  const dd = m[1];
  const mm = m[2];
  const yyyy = m[3];
  const d = Number(dd);
  const mo = Number(mm);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${yyyy}-${mm}-${dd}`;
}

function findLabeledValue(text: string, labels: RegExp): string {
  const m = text.match(labels);
  if (!m || !m[1]) return "";
  return String(m[1]).trim();
}

/**
 * Extrai CPF somente se:
 * - formato explícito com rótulo CPF / Cadastro de Pessoas Físicas, OU
 * - máscara ###.###.###-## com contexto CPF na mesma linha;
 * - e checksum válido.
 * Nunca usa 11 dígitos soltos sem rótulo.
 */
export function extractExplicitValidCpf(fullText: string): string | null {
  const text = String(fullText || "");
  const patterns: RegExp[] = [
    /CPF[:\s]*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/i,
    /CADASTRO\s+DE\s+PESSOAS\s+F[IÍ]SICAS[:\s]*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && isValidCpf(m[1])) return onlyDigits(m[1]);
  }
  // Linha com CPF + máscara
  for (const line of text.split(/\r?\n/)) {
    if (!/CPF/i.test(line)) continue;
    const m = line.match(/([0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2})/);
    if (m?.[1] && isValidCpf(m[1])) return onlyDigits(m[1]);
  }
  return null;
}

function extractName(text: string): string {
  const labeled = findLabeledValue(
    text,
    /(?:NOME(?:\s+\/\s+NAME)?|NOME\s+COMPLETO|NOME\s+E\s+SOBRENOME)[:\s]+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s']{4,80})/i,
  );
  if (labeled) return labeled.replace(/\s+/g, " ").trim().toUpperCase();
  return "";
}

function extractDocNumber(text: string, requestedType: string): string {
  if (requestedType === "passport") {
    const p =
      findLabeledValue(text, /(?:PASSPORT\s*NO|N[UÚ]MERO\s+DO\s+PASSAPORTE|PASSPORT)[:\s]*([A-Z0-9]{6,12})/i) ||
      findLabeledValue(text, /\bP[< ]([A-Z]{3}[A-Z0-9]{6,9})\b/);
    return p.toUpperCase();
  }
  if (requestedType === "cnh") {
    return findLabeledValue(
      text,
      /(?:N[UÚ]MERO\s+DE\s+REGISTRO|REGISTRO|N[ºO]\s*REGISTRO)[:\s]*([0-9]{9,12})/i,
    );
  }
  if (requestedType === "rg") {
    return findLabeledValue(
      text,
      /(?:RG|IDENTIDADE|REGISTRO\s+GERAL)[:\s]*([0-9.\-Xx]{5,20})/i,
    );
  }
  return "";
}

/**
 * Normaliza texto OCR Google → suggested_fields FNRH.
 * pages_processed: 1 se houver texto útil, senão 0.
 */
export function normalizeGoogleVisionText(input: {
  fullText?: string | null;
  requested_document_type?: string;
  pagesHint?: number;
}): NormalizedOcrResult {
  const text = String(input.fullText || "").trim();
  const out: NormalizedOcrResult = {
    suggested_fields: {},
    confidence: {},
    field_bands: {},
    needs_review_fields: [],
    pages_processed: text ? Math.max(1, Number(input.pagesHint) || 1) : 0,
  };
  if (!text) return out;

  const conf = GOOGLE_OCR_HEURISTIC_CONFIDENCE;
  const requested = String(input.requested_document_type || "").toLowerCase();

  const name = extractName(text);
  putField(out, "hospede_nome", name, conf);

  const dobRaw =
    findLabeledValue(text, /(?:DATA\s+DE\s+NASCIMENTO|NASCIMENTO|DATE\s+OF\s+BIRTH|DOB)[:\s]*([0-9]{2}[\/\-.][0-9]{2}[\/\-.][0-9]{4})/i) ||
    "";
  putField(out, "data_nascimento", normalizeDateBr(dobRaw), conf);

  const sexRaw = findLabeledValue(text, /(?:SEXO|SEX|G[EÊ]NERO)[:\s]*([A-Za-z]{1,12})/i);
  putField(out, "sexo", mapSex(sexRaw), conf);

  const nat = findLabeledValue(
    text,
    /(?:NACIONALIDADE|NATIONALITY)[:\s]*([A-Za-zÁÉÍÓÚÂÊÔÃÕÇ]{3,40})/i,
  );
  putField(out, "nacionalidade", nat ? nat.toUpperCase() : "", conf);

  const validadeRaw = findLabeledValue(
    text,
    /(?:VALIDADE|DATE\s+OF\s+EXPIRY|EXPIRY|EXPIRA)[:\s]*([0-9]{2}[\/\-.][0-9]{2}[\/\-.][0-9]{4})/i,
  );
  putField(out, "documento_validade", normalizeDateBr(validadeRaw), conf);

  const docNum = extractDocNumber(text, requested);
  putField(out, "documento_numero", docNum, conf);

  const cpf = extractExplicitValidCpf(text);
  if (cpf) {
    // Só promove CPF a documento_numero quando o tipo pedido é CPF (nunca inventa).
    if (requested === "cpf" && !out.suggested_fields.documento_numero) {
      putField(out, "documento_numero", cpf, conf);
    }
    out.suggested_fields.cpf = cpf;
    out.confidence.cpf = conf;
    out.field_bands.cpf = classifyOcrConfidence(conf);
    if (!out.needs_review_fields.includes("cpf")) out.needs_review_fields.push("cpf");
  }

  if (requested) {
    putField(out, "documento_tipo", requested, conf);
  }

  return out;
}
