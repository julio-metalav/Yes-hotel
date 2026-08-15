/**
 * DTO de revisão financeira Omie ↔ Sicredi (PR F).
 * Somente leitura. Não persiste suggested/ambiguous. Não altera o motor.
 */
import { reconReportLeaksPii } from "./report.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  type PossibleAggregationCandidate,
  type ReconEntry,
  type ReconGroup,
  type ReconResult,
  type ReconStats,
} from "./types.ts";
import type { FinancialScoreEvidence } from "../types.ts";

export const REVIEW_PAGE_SIZE = 25;
export const REVIEW_DESCRIPTION_MAX = 28;
export const REVIEW_ALLOWED_ACTIONS = [
  "overview",
  "high_list",
  "group_detail",
  "analysis",
  "possible_aggregations",
] as const;

/** Campos suficientes para o engine V1.2. Sem raw_payload, timestamps, documento ou máscara de conta. */
export const ANALYSIS_ENTRY_COLUMNS = [
  "id",
  "account_id",
  "source_system",
  "source_kind",
  "direction",
  "person_name",
  "description",
  "gross_amount_cents",
  "settled_amount_cents",
  "settlement_date",
] as const;

export const ANALYSIS_SOURCE_KINDS = [
  "omie_receivable",
  "omie_payable",
  "bank_credit",
  "bank_debit",
] as const;

export const ANALYSIS_ENTRY_SELECT = ANALYSIS_ENTRY_COLUMNS.join(", ");
export type ReviewAction = (typeof REVIEW_ALLOWED_ACTIONS)[number];

export const REVIEW_VIEW_TYPES = [
  "high",
  "suggested",
  "ambiguous",
  "unmatched_omie",
  "unmatched_bank",
  "internal_transfer",
  "possible_aggregation",
] as const;
export type ReviewViewType = (typeof REVIEW_VIEW_TYPES)[number];

export const REVIEW_FORBIDDEN_KEYS = [
  "raw_payload",
  "person_document_hash",
  "person_document",
  "service_role",
  "serviceRole",
  "SUPABASE_SERVICE_ROLE_KEY",
  "account_number",
  "agencia",
  "conta",
  "MEMO",
] as const;

export type ReviewKind = "AR" | "AP" | "internal_transfer";

export type ReviewFilters = {
  period_start: string;
  period_end: string;
  origin: "all" | "omie" | "sicredi";
  view: ReviewViewType;
  direction: "all" | "credit" | "debit";
  account_code: string | null;
  page: number;
  page_size: number;
};

export type ReviewKpis = {
  omie_ar_count: number;
  omie_ar_cents: number;
  omie_ap_count: number;
  omie_ap_cents: number;
  sicredi_credit_count: number;
  sicredi_credit_cents: number;
  sicredi_debit_count: number;
  sicredi_debit_cents: number;
  high_count: number;
  high_cents: number;
  transfer_count: number;
  transfer_cents: number;
  persisted_findings: number;
  suggested_count: number | null;
  suggested_cents: number | null;
  ambiguous_count: number | null;
  ambiguous_cents: number | null;
  unmatched_omie_count: number | null;
  unmatched_omie_cents: number | null;
  unmatched_bank_count: number | null;
  unmatched_bank_cents: number | null;
  possible_aggregation_count: number | null;
  possible_aggregation_cents: number | null;
};

export type ReviewListRow = {
  id: string;
  date: string | null;
  kind: ReviewKind | "unmatched";
  amount_cents: number;
  omie_label: string | null;
  bank_label: string | null;
  account_code: string | null;
  direction: "credit" | "debit" | null;
  status: string;
  score: number | null;
  evidence_summary: string[];
  persisted: boolean;
  diagnostic_only: boolean;
  label: string;
};

export type ReviewOmieSide = {
  type: "AR" | "AP";
  settlement_date: string;
  person_name_masked: string | null;
  gross_amount_cents: number | null;
  settled_amount_cents: number | null;
  open_amount_cents: number | null;
};

export type ReviewBankSide = {
  settlement_date: string;
  account_code: string | null;
  account_mask: string | null;
  direction: "credit" | "debit";
  amount_cents: number | null;
  description_redacted: string | null;
  fitid_masked: string | null;
};

export type ReviewGroupDetail = {
  id: string;
  kind: ReviewKind;
  status: string;
  rule_version: string;
  created_at: string | null;
  score: number | null;
  amount_cents: number;
  persisted: boolean;
  omie: ReviewOmieSide | null;
  bank: ReviewBankSide | null;
  transfer_debit: ReviewBankSide | null;
  transfer_credit: ReviewBankSide | null;
  score_evidence: Record<string, string | number | boolean | null>;
  evidence_summary: string[];
};

export type ReviewPage<T> = {
  page: number;
  page_size: number;
  total: number;
  rows: T[];
};

const PII_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;
const LONG_DIGIT_RE = /\d{6,}/g;

export function isReviewAction(value: unknown): value is ReviewAction {
  return typeof value === "string" && (REVIEW_ALLOWED_ACTIONS as readonly string[]).includes(value);
}

export function isReviewViewType(value: unknown): value is ReviewViewType {
  return typeof value === "string" && (REVIEW_VIEW_TYPES as readonly string[]).includes(value);
}

export function normalizeReviewFilters(input: {
  period_start?: string;
  period_end?: string;
  origin?: string;
  view?: string;
  direction?: string;
  account_code?: string | null;
  page?: number;
  page_size?: number;
  defaultStart: string;
  defaultEnd: string;
}): ReviewFilters {
  const origin = input.origin === "omie" || input.origin === "sicredi" ? input.origin : "all";
  const view = isReviewViewType(input.view) ? input.view : "high";
  const direction = input.direction === "credit" || input.direction === "debit" ? input.direction : "all";
  const page = Number.isInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
  const pageSize =
    Number.isInteger(input.page_size) && Number(input.page_size) > 0 && Number(input.page_size) <= 100
      ? Number(input.page_size)
      : REVIEW_PAGE_SIZE;
  const account = String(input.account_code ?? "").trim();
  return {
    period_start: String(input.period_start || input.defaultStart),
    period_end: String(input.period_end || input.defaultEnd),
    origin,
    view,
    direction,
    account_code: account && account !== "all" ? account : null,
    page,
    page_size: pageSize,
  };
}

export function paginateRows<T>(rows: readonly T[], page: number, pageSize: number): ReviewPage<T> {
  const safePage = page > 0 ? page : 1;
  const size = pageSize > 0 ? pageSize : REVIEW_PAGE_SIZE;
  const start = (safePage - 1) * size;
  return {
    page: safePage,
    page_size: size,
    total: rows.length,
    rows: rows.slice(start, start + size),
  };
}

export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 8 ? `${id}…` : `${id.slice(0, 8)}…`;
}

export function maskFitid(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 4 ? `${id}…` : `${id.slice(0, 4)}…`;
}

export function maskPersonName(name: string | null | undefined): string | null {
  if (!name) return null;
  const tokens = String(name)
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^(LTDA|ME|EIRELI|SA|S\/A|S\.A\.)$/i.test(token));
  if (!tokens.length) return null;
  return tokens
    .slice(0, 3)
    .map((token) => `${token.slice(0, 1).toUpperCase()}***`)
    .join(" ");
}

export function redactDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const cleaned = String(description).replace(LONG_DIGIT_RE, "…").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= REVIEW_DESCRIPTION_MAX) return cleaned;
  return `${cleaned.slice(0, REVIEW_DESCRIPTION_MAX).trimEnd()}…`;
}

export function dateDistanceLabel(days: number | null | undefined): string | null {
  if (days == null || !Number.isInteger(days) || days < 0) return null;
  if (days === 0) return "D0";
  return `D+${days}`;
}

export function omieKindFromSource(sourceKind: string | null | undefined): "AR" | "AP" | null {
  if (sourceKind === "omie_receivable") return "AR";
  if (sourceKind === "omie_payable") return "AP";
  return null;
}

export function summarizeScoreEvidence(
  evidence: FinancialScoreEvidence | null | undefined,
  ruleVersion = OMIE_SICREDI_RULE_VERSION,
): string[] {
  const ev = evidence ?? {};
  const parts: string[] = [];
  if (ev.amount_exact) parts.push("valor exato");
  const date = dateDistanceLabel(ev.date_distance_days ?? null);
  if (date) parts.push(date);
  if (ev.party_match) parts.push(`party_match ${ev.party_match}`);
  if (ev.candidate_count != null) parts.push(`candidate_count ${ev.candidate_count}`);
  parts.push(`rule_version ${ev.rule_id ?? ruleVersion}`);
  return parts;
}

export function formatScoreEvidence(
  evidence: FinancialScoreEvidence | null | undefined,
): Record<string, string | number | boolean | null> {
  const ev = evidence ?? {};
  return {
    amount_exact: ev.amount_exact ?? null,
    amount_cents: ev.amount_cents ?? null,
    date_distance_days: ev.date_distance_days ?? null,
    date_label: dateDistanceLabel(ev.date_distance_days ?? null),
    party_match: ev.party_match ?? null,
    name_match: ev.name_match ?? null,
    candidate_count: ev.candidate_count ?? null,
    direction_compatible: ev.direction_compatible ?? null,
    unique_counterpart: ev.unique_counterpart ?? null,
    memo_transfer_signal: ev.memo_transfer_signal ?? null,
    source_account: ev.source_account ?? null,
    target_account: ev.target_account ?? null,
    grouping_layer: ev.grouping_layer ?? null,
    rule_id: ev.rule_id ?? null,
  };
}

export function emptyAnalysisKpis(): Pick<
  ReviewKpis,
  | "suggested_count"
  | "suggested_cents"
  | "ambiguous_count"
  | "ambiguous_cents"
  | "unmatched_omie_count"
  | "unmatched_omie_cents"
  | "unmatched_bank_count"
  | "unmatched_bank_cents"
  | "possible_aggregation_count"
  | "possible_aggregation_cents"
> {
  return {
    suggested_count: null,
    suggested_cents: null,
    ambiguous_count: null,
    ambiguous_cents: null,
    unmatched_omie_count: null,
    unmatched_omie_cents: null,
    unmatched_bank_count: null,
    unmatched_bank_cents: null,
    possible_aggregation_count: null,
    possible_aggregation_cents: null,
  };
}

export function kpisFromPersisted(input: {
  omie_ar_count: number;
  omie_ar_cents: number;
  omie_ap_count: number;
  omie_ap_cents: number;
  sicredi_credit_count: number;
  sicredi_credit_cents: number;
  sicredi_debit_count: number;
  sicredi_debit_cents: number;
  high_count: number;
  high_cents: number;
  transfer_count: number;
  transfer_cents: number;
  persisted_findings: number;
}): ReviewKpis {
  return { ...input, ...emptyAnalysisKpis() };
}

export function mergeAnalysisKpis(base: ReviewKpis, stats: ReconStats): ReviewKpis {
  return {
    ...base,
    suggested_count: stats.suggested_count,
    suggested_cents: stats.suggested_cents,
    ambiguous_count: stats.ambiguous_count,
    ambiguous_cents: stats.ambiguous_cents,
    unmatched_omie_count: stats.omie_ar_unmatched_count + stats.omie_ap_unmatched_count,
    unmatched_omie_cents: stats.omie_ar_unmatched_cents + stats.omie_ap_unmatched_cents,
    unmatched_bank_count: stats.bank_credit_unmatched_count + stats.bank_debit_unmatched_count,
    unmatched_bank_cents: stats.bank_credit_unmatched_cents + stats.bank_debit_unmatched_cents,
    possible_aggregation_count: stats.possible_agg_c_ar.bank_count +
      stats.possible_agg_d_ar.bank_count +
      stats.possible_agg_c_ap.bank_count +
      stats.possible_agg_d_ap.bank_count,
    possible_aggregation_cents: stats.possible_agg_c_ar.amount_cents +
      stats.possible_agg_d_ar.amount_cents +
      stats.possible_agg_c_ap.amount_cents +
      stats.possible_agg_d_ap.amount_cents,
  };
}

export function toReconEntry(row: Record<string, unknown>): ReconEntry {
  const account = row.financial_accounts;
  const accountCode =
    row.account_code ??
    (account && typeof account === "object" && !Array.isArray(account)
      ? (account as { code?: unknown }).code
      : null);
  return {
    id: String(row.id),
    account_id: row.account_id == null ? null : String(row.account_id),
    account_code: accountCode == null ? null : String(accountCode),
    source_system: row.source_system as ReconEntry["source_system"],
    source_kind: row.source_kind as ReconEntry["source_kind"],
    source_import_id: row.source_import_id == null ? null : String(row.source_import_id),
    source_record_id: row.source_record_id == null ? null : String(row.source_record_id),
    direction: row.direction as ReconEntry["direction"],
    person_name: row.person_name == null ? null : String(row.person_name),
    description: row.description == null ? null : String(row.description),
    gross_amount_cents: row.gross_amount_cents == null ? null : Number(row.gross_amount_cents),
    settled_amount_cents: row.settled_amount_cents == null ? null : Number(row.settled_amount_cents),
    open_amount_cents: row.open_amount_cents == null ? null : Number(row.open_amount_cents),
    settlement_date: String(row.settlement_date),
  };
}

function bankSide(entry: ReconEntry, accountMask: string | null = null): ReviewBankSide {
  return {
    settlement_date: entry.settlement_date,
    account_code: entry.account_code,
    account_mask: accountMask,
    direction: entry.direction,
    amount_cents: bankMatchAmountCents(entry),
    description_redacted: redactDescription(entry.description),
    fitid_masked: maskFitid(entry.source_record_id),
  };
}

function omieSide(entry: ReconEntry): ReviewOmieSide | null {
  const type = omieKindFromSource(entry.source_kind);
  if (!type) return null;
  return {
    type,
    settlement_date: entry.settlement_date,
    person_name_masked: maskPersonName(entry.person_name),
    gross_amount_cents: entry.gross_amount_cents,
    settled_amount_cents: entry.settled_amount_cents,
    open_amount_cents: entry.open_amount_cents,
  };
}

export function sanitizePersistedListRow(input: {
  id: string;
  match_method: string | null;
  status: string;
  confidence: number | null;
  matched_amount_cents: number | null;
  score_evidence: FinancialScoreEvidence | null;
  rule_version: string | null;
  omie: ReconEntry | null;
  bank: ReconEntry | null;
  debit: ReconEntry | null;
  credit: ReconEntry | null;
}): ReviewListRow {
  const isTransfer = input.match_method === "internal_transfer";
  const kind: ReviewKind | "unmatched" = isTransfer
    ? "internal_transfer"
    : omieKindFromSource(input.omie?.source_kind) ?? "unmatched";
  const date = isTransfer
    ? input.debit?.settlement_date ?? input.credit?.settlement_date ?? null
    : input.omie?.settlement_date ?? input.bank?.settlement_date ?? null;
  return {
    id: input.id,
    date,
    kind,
    amount_cents: input.matched_amount_cents ?? 0,
    omie_label: isTransfer ? "transferência interna" : maskPersonName(input.omie?.person_name ?? null),
    bank_label: isTransfer
      ? `${input.debit?.account_code ?? "?"} → ${input.credit?.account_code ?? "?"}`
      : redactDescription(input.bank?.description ?? null),
    account_code: isTransfer
      ? input.debit?.account_code ?? input.credit?.account_code ?? null
      : input.bank?.account_code ?? null,
    direction: isTransfer ? input.debit?.direction ?? null : input.bank?.direction ?? input.omie?.direction ?? null,
    status: input.status,
    score: input.confidence,
    evidence_summary: summarizeScoreEvidence(input.score_evidence, input.rule_version ?? OMIE_SICREDI_RULE_VERSION),
    persisted: true,
    diagnostic_only: false,
    label: isTransfer ? "Transferência interna" : "Conciliado high",
  };
}

export function sanitizePersistedDetail(input: {
  id: string;
  match_method: string | null;
  status: string;
  confidence: number | null;
  matched_amount_cents: number | null;
  score_evidence: FinancialScoreEvidence | null;
  rule_version: string | null;
  created_at: string | null;
  omie: ReconEntry | null;
  bank: ReconEntry | null;
  debit: ReconEntry | null;
  credit: ReconEntry | null;
  debit_mask?: string | null;
  credit_mask?: string | null;
  bank_mask?: string | null;
}): ReviewGroupDetail {
  const isTransfer = input.match_method === "internal_transfer";
  const kind: ReviewKind = isTransfer
    ? "internal_transfer"
    : omieKindFromSource(input.omie?.source_kind) ?? "AR";
  return {
    id: input.id,
    kind,
    status: input.status,
    rule_version: input.rule_version ?? OMIE_SICREDI_RULE_VERSION,
    created_at: input.created_at,
    score: input.confidence,
    amount_cents: input.matched_amount_cents ?? 0,
    persisted: true,
    omie: isTransfer || !input.omie ? null : omieSide(input.omie),
    bank: isTransfer || !input.bank ? null : bankSide(input.bank, input.bank_mask ?? null),
    transfer_debit: isTransfer && input.debit ? bankSide(input.debit, input.debit_mask ?? null) : null,
    transfer_credit: isTransfer && input.credit ? bankSide(input.credit, input.credit_mask ?? null) : null,
    score_evidence: formatScoreEvidence(input.score_evidence),
    evidence_summary: summarizeScoreEvidence(input.score_evidence, input.rule_version ?? OMIE_SICREDI_RULE_VERSION),
  };
}

function groupKind(group: ReconGroup, entries: ReadonlyMap<string, ReconEntry>): ReviewKind {
  const omie = entries.get(group.omie_entry_ids[0] ?? "");
  return omieKindFromSource(omie?.source_kind) ?? "AR";
}

export function sanitizeAnalysisGroupRow(
  group: ReconGroup,
  entries: ReadonlyMap<string, ReconEntry>,
): ReviewListRow {
  const omie = entries.get(group.omie_entry_ids[0] ?? "") ?? null;
  const bank = entries.get(group.bank_entry_ids[0] ?? "") ?? null;
  return {
    id: group.id,
    date: omie?.settlement_date ?? bank?.settlement_date ?? null,
    kind: groupKind(group, entries),
    amount_cents: group.matched_amount_cents,
    omie_label: maskPersonName(omie?.person_name ?? null),
    bank_label: redactDescription(bank?.description ?? null),
    account_code: bank?.account_code ?? null,
    direction: bank?.direction ?? omie?.direction ?? null,
    status: group.status,
    score: group.confidence,
    evidence_summary: summarizeScoreEvidence(group.score_evidence, group.rule_version),
    persisted: false,
    diagnostic_only: false,
    label: group.band === "suggested" ? "Suggested — não persistido" : "Ambiguous — não persistido",
  };
}

export function sanitizeUnmatchedRow(entry: ReconEntry, side: "omie" | "bank"): ReviewListRow {
  const kind = omieKindFromSource(entry.source_kind);
  return {
    id: entry.id,
    date: entry.settlement_date,
    kind: kind ?? "unmatched",
    amount_cents: (side === "omie" ? omieMatchAmountCents(entry) : bankMatchAmountCents(entry)) ?? 0,
    omie_label: side === "omie" ? maskPersonName(entry.person_name) : null,
    bank_label: side === "bank" ? redactDescription(entry.description) : null,
    account_code: entry.account_code,
    direction: entry.direction,
    status: "unmatched",
    score: null,
    evidence_summary: ["Não conciliado"],
    persisted: false,
    diagnostic_only: false,
    label: "Não conciliado",
  };
}

export function sanitizePossibleAggregationRow(
  row: PossibleAggregationCandidate,
  entries: ReadonlyMap<string, ReconEntry>,
): ReviewListRow {
  const bank = entries.get(row.bank_entry_id);
  return {
    id: row.bank_entry_id,
    date: bank?.settlement_date ?? null,
    kind: row.direction === "ar_credit" ? "AR" : "AP",
    amount_cents: row.amount_cents,
    omie_label: `${row.omie_count} entries Omie`,
    bank_label: row.unique_combination ? "unique" : "ambiguous",
    account_code: bank?.account_code ?? null,
    direction: bank?.direction ?? null,
    status: "possible_aggregation",
    score: null,
    evidence_summary: [
      "Diagnóstico — não conciliado",
      row.date_window === "same_day" ? "D0" : "D+1",
      row.unique_combination ? "unique" : "ambiguous",
    ],
    persisted: false,
    diagnostic_only: true,
    label: "Diagnóstico — não conciliado",
  };
}

export function filterAnalysisRows(
  rows: readonly ReviewListRow[],
  filters: Pick<ReviewFilters, "origin" | "direction" | "account_code">,
): ReviewListRow[] {
  return rows.filter((row) => {
    if (filters.origin === "omie" && !row.omie_label) return false;
    if (filters.origin === "sicredi" && !row.bank_label) return false;
    if (filters.direction !== "all" && row.direction && row.direction !== filters.direction) return false;
    if (filters.account_code && row.account_code && row.account_code !== filters.account_code) return false;
    return true;
  });
}

function inReviewScope(entry: ReconEntry): boolean {
  if (entry.source_system === "omie") {
    return entry.source_kind === "omie_receivable" || entry.source_kind === "omie_payable";
  }
  if (entry.source_system === "sicredi") {
    return entry.source_kind === "bank_credit" || entry.source_kind === "bank_debit";
  }
  return false;
}

export function buildAnalysisLists(result: ReconResult, entries: readonly ReconEntry[]): {
  suggested: ReviewListRow[];
  ambiguous: ReviewListRow[];
  unmatched_omie: ReviewListRow[];
  unmatched_bank: ReviewListRow[];
  possible_aggregation: ReviewListRow[];
} {
  const byId = new Map(entries.map((row) => [row.id, row]));
  const suggested = result.groups
    .filter((group) => group.kind === "one_to_one" && group.band === "suggested")
    .map((group) => sanitizeAnalysisGroupRow(group, byId));
  const consumed = new Set(result.groups.flatMap((group) => [...group.omie_entry_ids, ...group.bank_entry_ids]));
  for (const transfer of result.transfers) {
    consumed.add(transfer.debit_entry_id);
    consumed.add(transfer.credit_entry_id);
  }
  const ambiguous = result.ambiguous.map((group) => sanitizeAnalysisGroupRow(group, byId)).map((row) => ({
    ...row,
    status: "ambiguous",
    label: "Ambiguous — não persistido",
    evidence_summary: ["Não conciliado", "ambiguous"],
  }));
  const unmatchedOmie = entries
    .filter((row) => inReviewScope(row) && row.source_system === "omie" && !consumed.has(row.id))
    .map((row) => sanitizeUnmatchedRow(row, "omie"));
  const unmatchedBank = entries
    .filter((row) => inReviewScope(row) && row.source_system === "sicredi" && !consumed.has(row.id))
    .map((row) => sanitizeUnmatchedRow(row, "bank"));
  return {
    suggested,
    ambiguous,
    unmatched_omie: unmatchedOmie,
    unmatched_bank: unmatchedBank,
    possible_aggregation: result.possible_aggregations.map((row) => sanitizePossibleAggregationRow(row, byId)),
  };
}

export function reviewDtoLeaksSensitive(value: unknown): string[] {
  const leaks: string[] = [];
  const json = JSON.stringify(value);
  if (!json) return leaks;
  for (const key of REVIEW_FORBIDDEN_KEYS) {
    if (json.includes(`"${key}"`)) leaks.push(key);
  }
  if (PII_RE.test(json) || reconReportLeaksPii(json)) leaks.push("pii");
  return leaks;
}

export function assertReviewDtoSafe(value: unknown): void {
  const leaks = reviewDtoLeaksSensitive(value);
  if (leaks.length) {
    throw new Error(`DTO de revisão vazou campos sensíveis: ${leaks.join(", ")}`);
  }
}
