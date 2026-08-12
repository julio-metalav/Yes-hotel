/**
 * Normalização Google Vision DOCUMENT_TEXT_DETECTION → campos canônicos FNRH v2.
 *
 * Identificadores documentais canônicos:
 * - Brasileiro: CPF
 * - Estrangeiro: Passaporte
 *
 * CNH/RG/CIN são apenas fonte visual; registro CNH/RG nunca vira documento_numero.
 * Placeholder `other` do upload NÃO vira documento_tipo.
 */

import {
  classifyOcrConfidence,
  shouldAutofillFromConfidence,
} from "./fnrh-ocr-confidence.ts";
import type { NormalizedOcrResult } from "./fnrh-ocr-normalize.ts";
import type { FnrhOcrSuggestedFields } from "./fnrh-ocr-port.ts";

/** Confidence conservadora para heurística de texto (MEDIUM → preenche + review). */
export const GOOGLE_OCR_HEURISTIC_CONFIDENCE = 0.7;

const CANONICAL_DOC_TYPES = new Set(["cpf", "passport"]);

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
 * Nunca usa 11 dígitos soltos sem rótulo (ex.: registro CNH).
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

/**
 * Passaporte só com rótulo claro ou linha MRZ P<.
 * Não inventa a partir de alfanumérico solto.
 */
export function extractExplicitPassportNumber(fullText: string): string | null {
  const text = String(fullText || "");
  const patterns: RegExp[] = [
    /PASSPORT\s*(?:NO|N[ºO]|NUMBER)[:\s#]+([A-Z0-9]{6,12})/i,
    /N[UÚ]MERO\s+DO\s+PASSAPORTE[:\s#]+([A-Z0-9]{6,12})/i,
    /PASSAPORTE[:\s#]+([A-Z0-9]{6,12})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = m[1].toUpperCase().replace(/\s+/g, "");
      // Evita capturar o próprio rótulo (ex.: "PASSAPORTE" sozinho).
      if (/^[A-Z0-9]{6,12}$/.test(n) && !/^PASSAPORTE?$/i.test(n) && n !== "PASSPORT") {
        return n;
      }
    }
  }
  const mrz = text.match(/\bP<[A-Z]{3}[A-Z<]+<<[A-Z<]+/);
  if (mrz) {
    // Número costuma estar na linha 2; tenta padrão comum na linha do número
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().toUpperCase();
      if (/^P</.test(t)) continue;
      const num = t.match(/^([A-Z0-9]{6,9})/);
      if (num?.[1] && /[0-9]/.test(num[1])) return num[1];
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!/PASSAPORTE|PASSPORT/i.test(line)) continue;
    if (/^P</i.test(line.trim())) continue;
    const m = line.toUpperCase().match(/\b([A-Z]{1,2}[0-9]{6,9})\b/);
    if (m?.[1] && m[1].length >= 6 && m[1].length <= 12) return m[1];
  }
  return null;
}

function looksLikePassportDocument(text: string): boolean {
  return /PASSAPORTE|PASSPORT|P<[A-Z]{3}/i.test(text);
}

function extractName(text: string): string {
  const labeled = findLabeledValue(
    text,
    /(?:NOME(?:\s+\/\s+NAME)?|NOME\s+COMPLETO|NOME\s+E\s+SOBRENOME|SURNAME\/GIVEN\s+NAMES?)[:\s]+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s']{4,80})/i,
  );
  if (labeled) return labeled.replace(/\s+/g, " ").trim().toUpperCase();
  return "";
}

/**
 * Normaliza texto OCR Google → suggested_fields FNRH.
 * Prioridade: CPF válido → passaporte claro → nenhum identificador.
 * Nunca promove other/cnh/rg como documento_tipo.
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
    findLabeledValue(
      text,
      /(?:DATA\s+DE\s+NASCIMENTO|NASCIMENTO|DATE\s+OF\s+BIRTH|DOB)[:\s]*([0-9]{2}[\/\-.][0-9]{2}[\/\-.][0-9]{4})/i,
    ) || "";
  putField(out, "data_nascimento", normalizeDateBr(dobRaw), conf);

  const sexRaw = findLabeledValue(text, /(?:SEXO|SEX|G[EÊ]NERO)[:\s]*([A-Za-z]{1,12})/i);
  putField(out, "sexo", mapSex(sexRaw), conf);

  const nat = findLabeledValue(
    text,
    /(?:NACIONALIDADE|NATIONALITY)[:\s]*([A-Za-zÁÉÍÓÚÂÊÔÃÕÇ]{3,40})/i,
  );
  putField(out, "nacionalidade", nat ? nat.toUpperCase() : "", conf);

  // 1) CPF válido explícito → canônico brasileiro (mesmo em foto de CNH/RG/CIN)
  const cpf = extractExplicitValidCpf(text);
  if (cpf) {
    putField(out, "documento_tipo", "cpf", conf);
    putField(out, "documento_numero", cpf, conf);
    out.suggested_fields.cpf = cpf;
    out.confidence.cpf = conf;
    out.field_bands.cpf = classifyOcrConfidence(conf);
    if (!out.needs_review_fields.includes("cpf")) out.needs_review_fields.push("cpf");
    return out;
  }

  // 2) Passaporte claramente identificado → canônico estrangeiro
  const passport = extractExplicitPassportNumber(text);
  const passportDoc =
    looksLikePassportDocument(text) || requested === "passport";
  if (passport && passportDoc) {
    putField(out, "documento_tipo", "passport", conf);
    putField(out, "documento_numero", passport, conf);
    return out;
  }

  // 3) Sem identificador seguro — não inventar; não promover other/cnh/rg
  if (CANONICAL_DOC_TYPES.has(requested)) {
    // Só ecoa tipo canônico pedido se já houver número (não inventa número).
    // Sem CPF/passaporte extraído, não força documento_tipo.
  }

  return out;
}
