/**
 * DTO de detalhe admin para auditoria Omie ↔ Sicredi.
 * Só review_case. Não altera o motor. Não inclui raw_payload nem secrets.
 * Lista geral continua mascarada em review-view.ts.
 */
import { descriptionLooksLikeTransfer } from "./internal-transfers.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  type ReconEntry,
} from "./types.ts";
import type { ConservativeCandidate } from "./human-review.ts";
import { explainEvidence } from "./human-review.ts";

export const ADMIN_AUDIT_DTO = "admin_audit";

export const ADMIN_AUDIT_FORBIDDEN_KEYS = [
  "raw_payload",
  "person_document_hash",
  "person_document",
  "service_role",
  "serviceRole",
  "SUPABASE_SERVICE_ROLE_KEY",
  "account_number",
  "agencia",
] as const;

export const AUDIT_ENTRY_EXTRA_COLUMNS = [
  "open_amount_cents",
  "tax_cents",
  "source_record_id",
  "source_row",
  "source_import_id",
  "external_reference",
  "document_number",
  "installment",
  "category_source",
  "issue_date",
  "due_date",
  "competence_date",
  "payment_method",
] as const;

export type AuditEntry = ReconEntry & {
  tax_cents: number | null;
  source_row: number | null;
  source_import_id: string | null;
  external_reference: string | null;
  document_number: string | null;
  installment: string | null;
  category_source: string | null;
  issue_date: string | null;
  due_date: string | null;
  competence_date: string | null;
  payment_method: string | null;
};

export type ImportOrigin = {
  id: string;
  source_type: string | null;
  filename: string | null;
  parser_name: string | null;
  parser_version: string | null;
  imported_at: string | null;
};

export type AdminOmieSide = {
  id: string;
  type: "AR" | "AP";
  type_label: string;
  person_name: string | null;
  settlement_date: string;
  gross_amount_cents: number | null;
  settled_amount_cents: number | null;
  open_amount_cents: number | null;
  tax_cents: number | null;
  description: string | null;
  category_source: string | null;
  document_number: string | null;
  installment: string | null;
  issue_date: string | null;
  due_date: string | null;
  competence_date: string | null;
  payment_method: string | null;
  external_reference: string | null;
  source_record_id: string | null;
  source_row: number | null;
};

export type AdminBankSide = {
  id: string;
  settlement_date: string;
  direction: "credit" | "debit";
  direction_label: string;
  amount_cents: number | null;
  account_code: string | null;
  account_label: string | null;
  description: string | null;
  person_name: string | null;
  source_record_id: string | null;
  external_reference: string | null;
  source_row: number | null;
  looks_like_transfer: boolean;
};

export type AdminCandidate = {
  entry_id: string;
  settlement_date: string | null;
  amount_cents: number | null;
  amount_delta_cents: number | null;
  date_distance_days: number;
  description: string | null;
  person_name: string | null;
  account_label: string | null;
  direction_label: string | null;
  source_record_id: string | null;
  score: number | null;
  reason: string;
  status: "provavel" | "possivel" | "diagnostico";
  status_label: string;
  blocked: boolean;
  diagnostic_only: boolean;
};

export type AdminCorrespondence = {
  amount_delta_cents: number | null;
  amount_delta_label: string;
  date_distance_days: number | null;
  date_delta_label: string;
  party_match: string | null;
  party_match_label: string;
  score: number | null;
  score_label: string;
  rule_label: string;
  unique_candidate: boolean | null;
  unique_label: string;
  why_label: string;
  evidence_lines: string[];
};

export type AdminOriginSide = {
  source_type: string | null;
  filename: string | null;
  parser_name: string | null;
  parser_version: string | null;
  imported_at: string | null;
  source_row: number | null;
  source_record_id: string | null;
  account_label: string | null;
};

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function displayImportFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = String(name).replace(/\\/g, "/").split("/").pop()?.trim();
  return base || null;
}

export function accountLabel(code: string | null | undefined): string | null {
  if (code === "sicredi_principal") return "Sicredi principal";
  if (code === "sicredi_0911") return "Sicredi 0911";
  return code ? String(code) : null;
}

export function omieTypeLabel(sourceKind: string | null | undefined): { type: "AR" | "AP"; label: string } | null {
  if (sourceKind === "omie_receivable") return { type: "AR", label: "Conta a receber" };
  if (sourceKind === "omie_payable") return { type: "AP", label: "Conta a pagar" };
  return null;
}

export function directionLabel(direction: string | null | undefined): string | null {
  if (direction === "credit") return "Crédito";
  if (direction === "debit") return "Débito";
  return null;
}

export function partyMatchLabel(party: string | null | undefined): string {
  if (party === "exact_normalized") return "Nome idêntico";
  if (party === "token_exact") return "Nome compatível";
  if (party === "contains_safe") return "Nome parcialmente compatível";
  if (party === "no_match") return "Nome não confirmado";
  return "Sem comparação de nome";
}

export function candidateStatus(
  row: Pick<ConservativeCandidate, "diagnostic_only" | "amount_exact" | "date_distance_days" | "score">,
): { status: AdminCandidate["status"]; status_label: string } {
  if (row.diagnostic_only) return { status: "diagnostico", status_label: "Diagnóstico" };
  if (row.amount_exact && row.date_distance_days === 0 && (row.score ?? 0) >= 85) {
    return { status: "provavel", status_label: "Provável" };
  }
  return { status: "possivel", status_label: "Possível" };
}

export function whyReviewLabel(
  reviewType: string,
  evidence: { party_match?: string | null; candidate_count?: number | null; amount_exact?: boolean | null } | null,
): string {
  if (reviewType === "ambiguous") {
    return "Há mais de um movimento compatível. É preciso escolher o par ou marcar nenhum destes.";
  }
  if (reviewType === "unmatched_omie") {
    return "Omie sem banco automático. Os candidatos abaixo são só para conferência.";
  }
  if (reviewType === "unmatched_bank") {
    return "Movimento bancário sem Omie automático. Os candidatos abaixo são só para conferência.";
  }
  if (evidence?.party_match === "no_match") {
    return "Valor e data coincidem, mas o nome não foi confirmado. Por isso ficou em suggested.";
  }
  if ((evidence?.candidate_count ?? 1) > 1) {
    return "Há mais de um candidato compatível. Por isso não foi conciliado automaticamente.";
  }
  return "Valor e data batem, mas a correspondência não é alta o suficiente para conciliar automaticamente.";
}

export function toAuditEntry(entry: ReconEntry, extra: Record<string, unknown> = {}): AuditEntry {
  return {
    ...entry,
    tax_cents: optionalNumber(extra.tax_cents ?? (entry as AuditEntry).tax_cents),
    source_row: optionalNumber(extra.source_row ?? (entry as AuditEntry).source_row),
    source_import_id: optionalText(extra.source_import_id ?? (entry as AuditEntry).source_import_id),
    external_reference: optionalText(extra.external_reference ?? (entry as AuditEntry).external_reference),
    document_number: optionalText(extra.document_number ?? (entry as AuditEntry).document_number),
    installment: optionalText(extra.installment ?? (entry as AuditEntry).installment),
    category_source: optionalText(extra.category_source ?? (entry as AuditEntry).category_source),
    issue_date: optionalText(extra.issue_date ?? (entry as AuditEntry).issue_date),
    due_date: optionalText(extra.due_date ?? (entry as AuditEntry).due_date),
    competence_date: optionalText(extra.competence_date ?? (entry as AuditEntry).competence_date),
    payment_method: optionalText(extra.payment_method ?? (entry as AuditEntry).payment_method),
  };
}

export function sanitizeImportOrigin(row: Record<string, unknown>): ImportOrigin {
  return {
    id: String(row.id),
    source_type: optionalText(row.source_type),
    filename: displayImportFilename(optionalText(row.original_filename)),
    parser_name: optionalText(row.parser_name),
    parser_version: optionalText(row.parser_version),
    imported_at: optionalText(row.imported_at),
  };
}

export function presentAdminOmie(entry: AuditEntry): AdminOmieSide | null {
  const typed = omieTypeLabel(entry.source_kind);
  if (!typed) return null;
  return {
    id: entry.id,
    type: typed.type,
    type_label: typed.label,
    person_name: entry.person_name,
    settlement_date: entry.settlement_date,
    gross_amount_cents: entry.gross_amount_cents,
    settled_amount_cents: entry.settled_amount_cents,
    open_amount_cents: entry.open_amount_cents,
    tax_cents: entry.tax_cents,
    description: entry.description,
    category_source: entry.category_source,
    document_number: entry.document_number,
    installment: entry.installment,
    issue_date: entry.issue_date,
    due_date: entry.due_date,
    competence_date: entry.competence_date,
    payment_method: entry.payment_method,
    external_reference: entry.external_reference,
    source_record_id: entry.source_record_id,
    source_row: entry.source_row,
  };
}

export function presentAdminBank(entry: AuditEntry | ReconEntry): AdminBankSide | null {
  if (entry.source_system !== "sicredi") return null;
  return {
    id: entry.id,
    settlement_date: entry.settlement_date,
    direction: entry.direction,
    direction_label: directionLabel(entry.direction) ?? entry.direction,
    amount_cents: bankMatchAmountCents(entry),
    account_code: entry.account_code,
    account_label: accountLabel(entry.account_code),
    description: entry.description,
    person_name: entry.person_name,
    source_record_id: entry.source_record_id,
    external_reference: "external_reference" in entry ? (entry as AuditEntry).external_reference : null,
    source_row: "source_row" in entry ? (entry as AuditEntry).source_row : null,
    looks_like_transfer: descriptionLooksLikeTransfer(entry.description || entry.person_name),
  };
}

export function presentAdminCandidates(
  candidates: readonly ConservativeCandidate[],
  pool: readonly ReconEntry[],
  used: ReadonlySet<string>,
  focus: ReconEntry,
): AdminCandidate[] {
  const byId = new Map(pool.map((row) => [row.id, row]));
  const focusAmount =
    focus.source_system === "omie" ? omieMatchAmountCents(focus) : bankMatchAmountCents(focus);
  return candidates.map((row) => {
    const entry = byId.get(row.entry_id);
    const tier = candidateStatus(row);
    const otherAmount = row.amount_cents;
    return {
      entry_id: row.entry_id,
      settlement_date: entry?.settlement_date ?? null,
      amount_cents: otherAmount,
      amount_delta_cents: focusAmount != null && otherAmount != null ? Math.abs(focusAmount - otherAmount) : null,
      date_distance_days: row.date_distance_days,
      description: entry?.description ?? null,
      person_name: entry?.person_name ?? null,
      account_label: accountLabel(entry?.account_code ?? null),
      direction_label: directionLabel(entry?.direction ?? null),
      source_record_id: entry?.source_record_id ?? null,
      score: row.score,
      reason: row.evidence_label,
      status: tier.status,
      status_label: tier.status_label,
      blocked: used.has(row.entry_id),
      diagnostic_only: row.diagnostic_only,
    };
  });
}

export function presentCorrespondence(input: {
  review_type: string;
  omie: ReconEntry | null;
  bank: ReconEntry | null;
  score: number | null;
  evidence: { amount_exact?: boolean | null; date_distance_days?: number | null; party_match?: string | null; candidate_count?: number | null } | null;
  candidate_count: number;
  usable_candidate_count?: number;
}): AdminCorrespondence {
  const ev = input.evidence ?? {};
  const omieAmount = input.omie ? omieMatchAmountCents(input.omie) : null;
  const bankAmount = input.bank ? bankMatchAmountCents(input.bank) : null;
  const amountDelta =
    omieAmount != null && bankAmount != null ? Math.abs(omieAmount - bankAmount) : null;
  const days = ev.date_distance_days ?? null;
  const unique = ev.candidate_count != null ? ev.candidate_count === 1 : input.candidate_count === 1;
  const usable = input.usable_candidate_count ?? input.candidate_count;
  const nameOk = ev.party_match === "exact_normalized" || ev.party_match === "token_exact" || ev.party_match === "contains_safe";
  const evidence_lines: string[] = [];
  if (amountDelta === 0) evidence_lines.push("O valor é exatamente igual.");
  else if (amountDelta != null) evidence_lines.push("O valor é diferente; por isso o sistema não conciliou automaticamente.");
  if (days === 0) evidence_lines.push("A movimentação ocorreu no mesmo dia.");
  else if (days != null) evidence_lines.push(`As datas estão a ${days} dia(s).`);
  if (nameOk) evidence_lines.push("O nome é compatível.");
  else if (ev.party_match === "no_match") evidence_lines.push("O nome não foi confirmado.");
  if (input.candidate_count > 1 || (ev.candidate_count ?? 0) > 1) {
    evidence_lines.push("Há mais de um movimento possível.");
  }
  if (
    (input.review_type === "unmatched_omie" || input.review_type === "unmatched_bank") &&
    usable === 0
  ) {
    evidence_lines.push("Nenhum candidato atingiu confiança suficiente.");
  }
  if (!evidence_lines.length) evidence_lines.push(whyReviewLabel(input.review_type, ev));
  return {
    amount_delta_cents: amountDelta,
    amount_delta_label:
      amountDelta == null ? "Sem par para comparar valor" : amountDelta === 0 ? "O valor é exatamente igual." : "O valor é diferente; por isso o sistema não conciliou automaticamente.",
    date_distance_days: days,
    date_delta_label: days == null ? "Sem par para comparar data" : days === 0 ? "A movimentação ocorreu no mesmo dia." : `As datas estão a ${days} dia(s).`,
    party_match: ev.party_match ?? null,
    party_match_label: nameOk ? "O nome é compatível." : partyMatchLabel(ev.party_match),
    score: input.score,
    score_label: explainEvidence(input.score, ev),
    rule_label: "Regra Omie ↔ Sicredi V1.2",
    unique_candidate: unique,
    unique_label: unique ? "Candidato único" : "Há mais de um movimento possível.",
    why_label: whyReviewLabel(input.review_type, ev),
    evidence_lines,
  };
}

export function presentOriginSide(
  entry: AuditEntry | null,
  imports: ReadonlyMap<string, ImportOrigin>,
): AdminOriginSide | null {
  if (!entry) return null;
  const origin = entry.source_import_id ? imports.get(entry.source_import_id) ?? null : null;
  return {
    source_type: origin?.source_type ?? null,
    filename: origin?.filename ?? null,
    parser_name: origin?.parser_name ?? null,
    parser_version: origin?.parser_version ?? null,
    imported_at: origin?.imported_at ?? null,
    source_row: entry.source_row,
    source_record_id: entry.source_record_id,
    account_label: entry.source_system === "sicredi" ? accountLabel(entry.account_code) : null,
  };
}

export function adminAuditDtoLeaksSensitive(value: unknown): string[] {
  const leaks: string[] = [];
  const json = JSON.stringify(value);
  if (!json) return leaks;
  for (const key of ADMIN_AUDIT_FORBIDDEN_KEYS) {
    if (json.includes(`"${key}"`)) leaks.push(key);
  }
  return leaks;
}

export function assertAdminAuditDtoSafe(value: unknown): void {
  const leaks = adminAuditDtoLeaksSensitive(value);
  if (leaks.length) {
    throw new Error(`DTO admin de auditoria vazou campos sensíveis: ${leaks.join(", ")}`);
  }
}

export function buildAdminReviewCase(input: {
  review_type: string;
  omie: AuditEntry | null;
  bank: AuditEntry | null;
  focus: AuditEntry;
  score: number | null;
  evidence: { amount_exact?: boolean | null; date_distance_days?: number | null; party_match?: string | null; candidate_count?: number | null } | null;
  candidates: readonly ConservativeCandidate[];
  pool: readonly ReconEntry[];
  used: ReadonlySet<string>;
  imports: ReadonlyMap<string, ImportOrigin>;
  allowed_actions: string[];
}) {
  const presentedCandidates = presentAdminCandidates(input.candidates, input.pool, input.used, input.focus);
  const payload = {
    action: "review_case" as const,
    dto: ADMIN_AUDIT_DTO,
    read_only: true,
    rule_version: OMIE_SICREDI_RULE_VERSION,
    review_type: input.review_type,
    omie: input.omie ? presentAdminOmie(input.omie) : null,
    bank: input.bank ? presentAdminBank(input.bank) : null,
    focus_id: input.focus.id,
    correspondence: presentCorrespondence({
      review_type: input.review_type,
      omie: input.omie,
      bank: input.bank,
      score: input.score,
      evidence: input.evidence,
      candidate_count: presentedCandidates.length,
      usable_candidate_count: presentedCandidates.filter((row) => !row.diagnostic_only).length,
    }),
    candidates: presentedCandidates,
    origin: {
      omie: presentOriginSide(input.omie, input.imports),
      sicredi: presentOriginSide(input.bank, input.imports),
    },
    technical: {
      rule_version: OMIE_SICREDI_RULE_VERSION,
      review_type: input.review_type,
      omie_entry_id: input.omie?.id ?? null,
      bank_entry_id: input.bank?.id ?? null,
      score: input.score,
      party_match: input.evidence?.party_match ?? null,
      candidate_count: presentedCandidates.length,
    },
    allowed_actions: input.allowed_actions,
  };
  assertAdminAuditDtoSafe(payload);
  return payload;
}
