/**
 * Decisão humana de conciliação Omie ↔ Sicredi (PR G).
 * Não altera o motor V1.2. Não muta financial_entries.
 * Status de grupo existente: confirmed = confirmação humana (não inventar human_confirmed).
 */
import { createHash } from "node:crypto";
import { scoreEvidenceIsStructured } from "../persistence.ts";
import { dateDistanceDays } from "./dates.ts";
import { findInternalTransferCandidates } from "./internal-transfers.ts";
import { reconciliationKey } from "./persist-high.ts";
import {
  bankMatchAmountCents,
  directionCompatible,
  omieMatchAmountCents,
  scoreOmieBankPair,
} from "./score.ts";
import {
  MAX_DATE_WINDOW_DAYS,
  OMIE_SICREDI_RULE_VERSION,
  type ReconEntry,
} from "./types.ts";
import type { FinancialScoreEvidence } from "../types.ts";

export type ReviewableRow = {
  id: string;
  amount_cents: number;
  omie_entry_id?: string | null;
  bank_entry_id?: string | null;
};

export const HUMAN_REVIEW_RULE_VERSION = OMIE_SICREDI_RULE_VERSION;
export const NEAR_AMOUNT_CENTS = 5000;
export const NEAR_AMOUNT_RATIO = 0.05;

export const DECIDE_ACTIONS = [
  "review_case",
  "confirm_match",
  "reject_suggestion",
  "reject_ambiguous",
  "mark_unmatched",
  "mark_awaiting_settlement",
  "mark_possible_aggregation",
  "mark_internal_transfer",
  "list_reviews",
] as const;
export type DecideAction = (typeof DECIDE_ACTIONS)[number];

export const REVIEW_TYPES = [
  "suggested",
  "ambiguous",
  "unmatched_omie",
  "unmatched_bank",
  "possible_aggregation",
] as const;
export type HumanReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_DECISION_STATUSES = [
  "confirmed",
  "rejected",
  "kept_unmatched",
  "awaiting_settlement",
  "possible_aggregation",
] as const;
export type HumanReviewStatus = (typeof REVIEW_DECISION_STATUSES)[number];

export type HumanReviewRecord = {
  review_key: string;
  review_type: HumanReviewType;
  status: HumanReviewStatus;
  action: string;
  omie_entry_id: string | null;
  bank_entry_id: string | null;
  candidate_entry_ids: string[];
  resulting_group_id: string | null;
};

export type ConservativeCandidate = {
  entry_id: string;
  score: number | null;
  amount_exact: boolean;
  amount_cents: number;
  date_distance_days: number;
  party_match: string | null;
  diagnostic_only: boolean;
  evidence_label: string;
};

export type ConfirmMatchPlan = {
  review_key: string;
  review_type: HumanReviewType;
  status: "confirmed";
  action: "confirm_match" | "mark_internal_transfer";
  reconciliation_key: string;
  match_method: "one_to_one" | "internal_transfer";
  group_status: "confirmed";
  omie_entry_id: string | null;
  bank_entry_id: string | null;
  debit_entry_id: string | null;
  credit_entry_id: string | null;
  candidate_entry_ids: string[];
  confidence: number;
  matched_amount_cents: number;
  score_evidence: FinancialScoreEvidence;
  previous_state: string;
};

export type ReviewOnlyPlan = {
  review_key: string;
  review_type: HumanReviewType;
  status: Exclude<HumanReviewStatus, "confirmed">;
  action: DecideAction;
  omie_entry_id: string | null;
  bank_entry_id: string | null;
  candidate_entry_ids: string[];
  score: number | null;
  score_evidence: FinancialScoreEvidence;
  previous_state: string;
};

export function isDecideAction(value: unknown): value is DecideAction {
  return typeof value === "string" && (DECIDE_ACTIONS as readonly string[]).includes(value);
}

export const INVALID_FINANCIAL_ENTRY_ID = "Identificador financeiro inválido.";
const FINANCIAL_ENTRY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isFinancialEntryUuid(value: unknown): value is string {
  return typeof value === "string" && FINANCIAL_ENTRY_UUID_RE.test(value.trim());
}

export function parseOptionalFinancialEntryId(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (!isFinancialEntryUuid(trimmed)) {
    throw Object.assign(new Error(INVALID_FINANCIAL_ENTRY_ID), { status: 400 });
  }
  return trimmed;
}

export function resolveReviewCaseIds(input: {
  omie_entry_id?: unknown;
  bank_entry_id?: unknown;
  entry_id?: unknown;
}): { omie_entry_id: string | null; bank_entry_id: string | null; lookup_ids: string[] } {
  const omie_entry_id = parseOptionalFinancialEntryId(input.omie_entry_id);
  const bank_entry_id = parseOptionalFinancialEntryId(input.bank_entry_id);
  let extra: string | null = null;
  if (input.entry_id != null && String(input.entry_id).trim()) {
    const raw = String(input.entry_id).trim();
    if (isFinancialEntryUuid(raw)) extra = raw;
    else if (!omie_entry_id && !bank_entry_id) {
      throw Object.assign(new Error(INVALID_FINANCIAL_ENTRY_ID), { status: 400 });
    }
  }
  const lookup_ids = [...new Set([omie_entry_id, bank_entry_id, extra].filter((id): id is string => !!id))];
  if (!lookup_ids.length) {
    throw Object.assign(new Error(INVALID_FINANCIAL_ENTRY_ID), { status: 400 });
  }
  return { omie_entry_id, bank_entry_id, lookup_ids };
}

export function isRawUuidSqlError(message: string): boolean {
  return /invalid input syntax for type uuid/i.test(message);
}

export function friendlyDecideError(error: unknown): { message: string; status: number } {
  const status = Number((error as { status?: number }).status ?? 400);
  const message = error instanceof Error ? error.message : "Falha na decisao financeira.";
  if (isRawUuidSqlError(message)) {
    return { message: INVALID_FINANCIAL_ENTRY_ID, status: 400 };
  }
  return { message, status };
}

export function humanReviewKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function suggestedReviewKey(omieId: string, bankId: string): string {
  const ids = [omieId, bankId].map(String).sort();
  return humanReviewKey([HUMAN_REVIEW_RULE_VERSION, "suggested", ...ids]);
}

export function ambiguousNoneReviewKey(omieId: string): string {
  return humanReviewKey([HUMAN_REVIEW_RULE_VERSION, "ambiguous_none", omieId]);
}

export function unmatchedReviewKey(entryId: string): string {
  return humanReviewKey([HUMAN_REVIEW_RULE_VERSION, "unmatched", entryId]);
}

export function explainEvidence(
  score: number | null | undefined,
  evidence: FinancialScoreEvidence | null | undefined,
): string {
  const ev = evidence ?? {};
  if (score === 93 && ev.amount_exact && ev.date_distance_days === 0 && ev.party_match === "token_exact") {
    return "Valor exato, mesma data e nome compatível";
  }
  if (score === 75 && ev.amount_exact && ev.party_match === "no_match") {
    return "Valor e data coincidem; nome não confirmado";
  }
  if (ev.amount_exact && ev.date_distance_days === 0 && ev.party_match === "exact_normalized") {
    return "Valor exato, mesma data e nome idêntico";
  }
  if (ev.amount_exact && ev.date_distance_days === 0 && ev.party_match === "contains_safe") {
    return "Valor exato, mesma data e nome parcialmente compatível";
  }
  if (ev.amount_exact && ev.date_distance_days === 0) {
    return "Valor e data coincidem; nome não confirmado";
  }
  if (ev.amount_exact) {
    return `Valor exato, datas a ${ev.date_distance_days ?? "?"} dia(s)`;
  }
  return "Candidato diagnóstico — valor não é exato; sem auto-match";
}

export function uiStatusLabel(status: string): string {
  if (status === "auto_matched") return "auto_matched";
  if (status === "confirmed") return "human_confirmed";
  if (status === "rejected") return "human_rejected";
  if (status === "suggested") return "pending_review";
  if (status === "ambiguous") return "ambiguous";
  if (status === "unmatched") return "unmatched";
  return status;
}

function amountNear(left: number, right: number): boolean {
  const delta = Math.abs(left - right);
  return delta <= NEAR_AMOUNT_CENTS || delta <= Math.round(Math.max(left, right) * NEAR_AMOUNT_RATIO);
}

export function collectConservativeCandidates(
  focus: ReconEntry,
  pool: readonly ReconEntry[],
): ConservativeCandidate[] {
  const focusIsOmie = focus.source_system === "omie";
  const rows: ConservativeCandidate[] = [];
  for (const other of pool) {
    if (other.id === focus.id) continue;
    const omie = focusIsOmie ? focus : other;
    const bank = focusIsOmie ? other : focus;
    if (omie.source_system !== "omie" || bank.source_system !== "sicredi") continue;
    if (!directionCompatible(omie, bank)) continue;
    const distance = dateDistanceDays(omie.settlement_date, bank.settlement_date);
    if (distance > MAX_DATE_WINDOW_DAYS) continue;
    const omieAmount = omieMatchAmountCents(omie);
    const bankAmount = bankMatchAmountCents(bank);
    if (omieAmount == null || bankAmount == null) continue;
    const scored = scoreOmieBankPair(omie, bank);
    const exact = omieAmount === bankAmount;
    if (!exact && !amountNear(omieAmount, bankAmount)) continue;
    rows.push({
      entry_id: other.id,
      score: scored?.score ?? null,
      amount_exact: exact,
      amount_cents: focusIsOmie ? bankAmount : omieAmount,
      date_distance_days: distance,
      party_match: scored?.partyMatch ?? null,
      diagnostic_only: !exact,
      evidence_label: explainEvidence(scored?.score ?? null, scored?.evidence ?? { amount_exact: exact, date_distance_days: distance }),
    });
  }
  return rows.sort((a, b) => {
    if (a.diagnostic_only !== b.diagnostic_only) return a.diagnostic_only ? 1 : -1;
    return (b.score ?? -1) - (a.score ?? -1);
  });
}

export function applyReviewDecisions<T extends ReviewableRow>(
  lists: {
    suggested: T[];
    ambiguous: T[];
    unmatched_omie: T[];
    unmatched_bank: T[];
    possible_aggregation: T[];
  },
  reviews: readonly HumanReviewRecord[],
): typeof lists {
  const pairKeys = new Set<string>();
  const omieNone = new Set<string>();
  const unmatchedIds = new Set<string>();
  for (const review of reviews) {
    if (review.review_type === "suggested" && review.omie_entry_id && review.bank_entry_id) {
      pairKeys.add(suggestedReviewKey(review.omie_entry_id, review.bank_entry_id));
    }
    if (review.review_type === "ambiguous" && review.status === "rejected" && review.omie_entry_id) {
      omieNone.add(review.omie_entry_id);
    }
    if (
      (review.review_type === "unmatched_omie" ||
        review.review_type === "unmatched_bank" ||
        review.review_type === "possible_aggregation") &&
      review.status !== "confirmed"
    ) {
      if (review.omie_entry_id) unmatchedIds.add(review.omie_entry_id);
      if (review.bank_entry_id) unmatchedIds.add(review.bank_entry_id);
    }
  }
  return {
    suggested: lists.suggested.filter((row) => {
      if (!row.omie_entry_id || !row.bank_entry_id) return true;
      return !pairKeys.has(suggestedReviewKey(row.omie_entry_id, row.bank_entry_id));
    }),
    ambiguous: lists.ambiguous.filter((row) => !row.omie_entry_id || !omieNone.has(row.omie_entry_id)),
    unmatched_omie: lists.unmatched_omie.filter((row) => !unmatchedIds.has(row.id)),
    unmatched_bank: lists.unmatched_bank.filter((row) => !unmatchedIds.has(row.id)),
    possible_aggregation: lists.possible_aggregation.filter((row) => !unmatchedIds.has(row.id)),
  };
}

export function sortByAmountDesc<T extends { amount_cents: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.amount_cents - a.amount_cents || a.amount_cents - b.amount_cents);
}

export function pendingCounts(lists: {
  suggested: { amount_cents: number }[];
  ambiguous: { amount_cents: number }[];
  unmatched_omie: { amount_cents: number }[];
  unmatched_bank: { amount_cents: number }[];
  possible_aggregation: { amount_cents: number }[];
}): {
  suggested_count: number;
  suggested_cents: number;
  ambiguous_count: number;
  ambiguous_cents: number;
  unmatched_omie_count: number;
  unmatched_omie_cents: number;
  unmatched_bank_count: number;
  unmatched_bank_cents: number;
  possible_aggregation_count: number;
  possible_aggregation_cents: number;
} {
  const sum = (rows: { amount_cents: number }[]) => rows.reduce((acc, row) => acc + row.amount_cents, 0);
  return {
    suggested_count: lists.suggested.length,
    suggested_cents: sum(lists.suggested),
    ambiguous_count: lists.ambiguous.length,
    ambiguous_cents: sum(lists.ambiguous),
    unmatched_omie_count: lists.unmatched_omie.length,
    unmatched_omie_cents: sum(lists.unmatched_omie),
    unmatched_bank_count: lists.unmatched_bank.length,
    unmatched_bank_cents: sum(lists.unmatched_bank),
    possible_aggregation_count: lists.possible_aggregation.length,
    possible_aggregation_cents: sum(lists.possible_aggregation),
  };
}

function requireOmieBank(omie: ReconEntry | undefined, bank: ReconEntry | undefined): {
  omie: ReconEntry;
  bank: ReconEntry;
} {
  if (!omie || omie.source_system !== "omie") throw Object.assign(new Error("Entry Omie inválida."), { status: 400 });
  if (!bank || bank.source_system !== "sicredi") throw Object.assign(new Error("Entry Sicredi inválida."), { status: 400 });
  if (!directionCompatible(omie, bank)) {
    throw Object.assign(new Error("Direção incompatível (AR↔crédito / AP↔débito)."), { status: 409 });
  }
  return { omie, bank };
}

export function buildConfirmMatchPlan(input: {
  review_type: HumanReviewType;
  omie: ReconEntry;
  bank: ReconEntry;
  candidate_entry_ids?: string[];
  used_entry_ids: ReadonlySet<string>;
  existing_group_keys: ReadonlySet<string>;
  existing_review_keys: ReadonlySet<string>;
}): ConfirmMatchPlan {
  const { omie, bank } = requireOmieBank(input.omie, input.bank);
  if (input.used_entry_ids.has(omie.id) || input.used_entry_ids.has(bank.id)) {
    throw Object.assign(new Error("Entry já pertence a um grupo de conciliação."), { status: 409 });
  }
  const scored = scoreOmieBankPair(omie, bank);
  if (!scored || !scored.amountExact) {
    throw Object.assign(new Error("Só é possível confirmar valor exato. Valor próximo é só diagnóstico."), { status: 409 });
  }
  if (!scoreEvidenceIsStructured(scored.evidence)) {
    throw Object.assign(new Error("score_evidence inválido após recálculo."), { status: 409 });
  }
  const key = reconciliationKey("one_to_one", [omie.id, bank.id]);
  if (input.existing_group_keys.has(key)) {
    throw Object.assign(new Error("Já existe grupo com esta reconciliation_key."), { status: 409 });
  }
  const reviewKey = suggestedReviewKey(omie.id, bank.id);
  return {
    review_key: reviewKey,
    review_type: input.review_type,
    status: "confirmed",
    action: "confirm_match",
    reconciliation_key: key,
    match_method: "one_to_one",
    group_status: "confirmed",
    omie_entry_id: omie.id,
    bank_entry_id: bank.id,
    debit_entry_id: null,
    credit_entry_id: null,
    candidate_entry_ids: input.candidate_entry_ids ?? [bank.id],
    confidence: scored.score,
    matched_amount_cents: scored.evidence.amount_cents ?? omieMatchAmountCents(omie) ?? 0,
    score_evidence: { ...scored.evidence, candidate_count: 1, rule_id: HUMAN_REVIEW_RULE_VERSION },
    previous_state: input.review_type,
  };
}

export function buildInternalTransferPlan(input: {
  debit: ReconEntry;
  credit: ReconEntry;
  pool: readonly ReconEntry[];
  used_entry_ids: ReadonlySet<string>;
  existing_group_keys: ReadonlySet<string>;
}): ConfirmMatchPlan {
  if (input.used_entry_ids.has(input.debit.id) || input.used_entry_ids.has(input.credit.id)) {
    throw Object.assign(new Error("Entry já pertence a um grupo de conciliação."), { status: 409 });
  }
  const found = findInternalTransferCandidates(input.pool).filter(
    (row) =>
      row.confidence === "high" &&
      ((row.debit_entry_id === input.debit.id && row.credit_entry_id === input.credit.id) ||
        (row.debit_entry_id === input.credit.id && row.credit_entry_id === input.debit.id)),
  );
  const pair = found[0];
  if (!pair) {
    throw Object.assign(new Error("Regra de transferência interna não autoriza este par."), { status: 409 });
  }
  const key = reconciliationKey("internal_transfer", [pair.debit_entry_id, pair.credit_entry_id]);
  if (input.existing_group_keys.has(key)) {
    throw Object.assign(new Error("Já existe grupo com esta reconciliation_key."), { status: 409 });
  }
  return {
    review_key: unmatchedReviewKey(pair.debit_entry_id),
    review_type: "unmatched_bank",
    status: "confirmed",
    action: "mark_internal_transfer",
    reconciliation_key: key,
    match_method: "internal_transfer",
    group_status: "confirmed",
    omie_entry_id: null,
    bank_entry_id: pair.credit_entry_id,
    debit_entry_id: pair.debit_entry_id,
    credit_entry_id: pair.credit_entry_id,
    candidate_entry_ids: [pair.debit_entry_id, pair.credit_entry_id],
    confidence: 100,
    matched_amount_cents: pair.amount_cents,
    score_evidence: pair.score_evidence,
    previous_state: "unmatched",
  };
}

export function buildReviewOnlyPlan(input: {
  action: Extract<
    DecideAction,
    "reject_suggestion" | "reject_ambiguous" | "mark_unmatched" | "mark_awaiting_settlement" | "mark_possible_aggregation"
  >;
  review_type: HumanReviewType;
  omie_entry_id?: string | null;
  bank_entry_id?: string | null;
  candidate_entry_ids?: string[];
  score?: number | null;
  score_evidence?: FinancialScoreEvidence;
}): ReviewOnlyPlan {
  const status: ReviewOnlyPlan["status"] =
    input.action === "reject_suggestion" || input.action === "reject_ambiguous"
      ? "rejected"
      : input.action === "mark_awaiting_settlement"
        ? "awaiting_settlement"
        : input.action === "mark_possible_aggregation"
          ? "possible_aggregation"
          : "kept_unmatched";
  const reviewKey =
    input.action === "reject_ambiguous" && input.omie_entry_id
      ? ambiguousNoneReviewKey(input.omie_entry_id)
      : input.action === "reject_suggestion" && input.omie_entry_id && input.bank_entry_id
        ? suggestedReviewKey(input.omie_entry_id, input.bank_entry_id)
        : unmatchedReviewKey(String(input.omie_entry_id ?? input.bank_entry_id ?? ""));
  if (!input.omie_entry_id && !input.bank_entry_id) {
    throw Object.assign(new Error("Decisão exige ao menos uma entry."), { status: 400 });
  }
  return {
    review_key: reviewKey,
    review_type: input.review_type,
    status,
    action: input.action,
    omie_entry_id: input.omie_entry_id ?? null,
    bank_entry_id: input.bank_entry_id ?? null,
    candidate_entry_ids: input.candidate_entry_ids ?? [],
    score: input.score ?? null,
    score_evidence: input.score_evidence ?? {},
    previous_state: input.review_type,
  };
}

export function sameDecision(existing: HumanReviewRecord, planned: { action: string; status: string }): boolean {
  return existing.action === planned.action && existing.status === planned.status;
}
