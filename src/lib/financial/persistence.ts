/**
 * Contratos de persistência financeira V1 (sem I/O).
 * Alinhado a supabase/migrations/20260814220000_financial_foundation_v1.sql.
 */

import { createHash } from "node:crypto";
import type { FinancialScoreEvidence } from "./types.ts";

export const FINANCIAL_IMPORTS_BUCKET = "financial-imports";

export function isSha256Hex(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function importProcessingIdentity(fileSha256: string, parserVersion: string): string {
  const sha = String(fileSha256 ?? "").trim().toLowerCase();
  const ver = String(parserVersion ?? "").trim();
  if (!isSha256Hex(sha)) {
    throw new Error("Identidade de import exige file_sha256 SHA-256 hex");
  }
  if (!ver) {
    throw new Error("Identidade de import exige parser_version");
  }
  return `${sha}:${ver}`;
}

/** Mesmo arquivo só reprocessa se a parser_version for outra. */
export function canReimportSameFile(input: {
  existingParserVersions: readonly string[];
  nextParserVersion: string;
}): boolean {
  const next = String(input.nextParserVersion ?? "").trim();
  if (!next) return false;
  return !input.existingParserVersions.map((v) => String(v).trim()).includes(next);
}

export function accountMaskIsSafe(mask: string | null | undefined): boolean {
  if (mask == null || mask === "") return true;
  return /^[0-9]{2,4}$/.test(mask);
}

export type PersonDocumentKind = "cpf" | "cnpj";

export function hashPersonDocument(kind: PersonDocumentKind, rawDigits: string): string {
  const digits = String(rawDigits ?? "").replace(/\D/g, "");
  const expected = kind === "cpf" ? 11 : 14;
  if (digits.length !== expected) {
    throw new Error(`Documento ${kind} inválido para hash`);
  }
  return createHash("sha256").update(`${kind}:${digits}`).digest("hex");
}

export function moneyCentsIsValid(value: number | null | undefined): boolean {
  return value == null || (Number.isInteger(value) && value >= 0);
}

export function scoreEvidenceIsStructured(value: unknown): value is FinancialScoreEvidence {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if ("amount_exact" in row && typeof row.amount_exact !== "boolean") return false;
  if ("document_match" in row && typeof row.document_match !== "boolean") return false;
  if (
    "date_distance_days" in row &&
    row.date_distance_days != null &&
    (!Number.isInteger(row.date_distance_days) || Number(row.date_distance_days) < 0)
  ) {
    return false;
  }
  if (
    "name_match" in row &&
    row.name_match != null &&
    !["normalized_exact", "token_sort", "none", "unknown"].includes(String(row.name_match))
  ) {
    return false;
  }
  if (
    "party_match" in row &&
    row.party_match != null &&
    !["exact_normalized", "token_exact", "contains_safe", "no_match"].includes(String(row.party_match))
  ) {
    return false;
  }
  if ("amount_cents" in row && row.amount_cents != null && (!Number.isInteger(row.amount_cents) || Number(row.amount_cents) < 0)) {
    return false;
  }
  if ("candidate_count" in row && row.candidate_count != null && (!Number.isInteger(row.candidate_count) || Number(row.candidate_count) < 0)) {
    return false;
  }
  if ("direction_match" in row && typeof row.direction_match !== "boolean") return false;
  if ("internal_transfer_excluded" in row && typeof row.internal_transfer_excluded !== "boolean") return false;
  return true;
}

export function findingStatusIsAllowed(status: string): boolean {
  return status !== "fraude_confirmada";
}
