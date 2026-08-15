import { collectOneToOneCandidates, resolveOneToOneGroups } from "./candidate-search.ts";
import { inPeriod } from "./dates.ts";
import { buildFindings } from "./findings.ts";
import { findManyToOneGroups } from "./grouping.ts";
import { findInternalTransferCandidates, transferBankEntryIds } from "./internal-transfers.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  RECON_PERIOD_END,
  RECON_PERIOD_START,
  type ReconEntry,
  type ReconResult,
  type ReconSample,
  type ReconStats,
} from "./types.ts";

function maskId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

function maskFitid(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 4 ? `${id}…` : `${id.slice(0, 4)}…`;
}

function inScope(entry: ReconEntry, start: string, end: string): boolean {
  if (!inPeriod(entry.settlement_date, start, end)) return false;
  if (entry.source_system === "omie") {
    return entry.source_kind === "omie_receivable" || entry.source_kind === "omie_payable";
  }
  if (entry.source_system === "sicredi") {
    return entry.source_kind === "bank_credit" || entry.source_kind === "bank_debit";
  }
  return false;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function samplesFor(
  category: string,
  rows: Array<{
    entryIds: string[];
    amount: number;
    score: number | null;
    party: ReconSample["party_match"];
    distance: number | null;
    fitid: string | null;
  }>,
): ReconSample[] {
  return rows.slice(0, 10).map((row) => ({
    category,
    entry_ids_masked: row.entryIds.map(maskId),
    amount_cents: row.amount,
    score: row.score,
    party_match: row.party,
    date_distance_days: row.distance,
    source_record_id_masked: maskFitid(row.fitid),
  }));
}

export function reconcileOmieSicredi(input: {
  entries: readonly ReconEntry[];
  periodStart?: string;
  periodEnd?: string;
}): ReconResult {
  const periodStart = input.periodStart ?? RECON_PERIOD_START;
  const periodEnd = input.periodEnd ?? RECON_PERIOD_END;
  const entries = [...input.entries]
    .filter((row) => inScope(row, periodStart, periodEnd))
    .sort((a, b) => a.id.localeCompare(b.id));

  const omie = entries.filter((row) => row.source_system === "omie");
  const bank = entries.filter((row) => row.source_system === "sicredi");
  const transfers = findInternalTransferCandidates(entries);
  const transferIds = transferBankEntryIds(transfers);
  const bankForOmie = bank.filter((row) => !transferIds.has(row.id));

  const candidates = collectOneToOneCandidates(omie, bankForOmie, transferIds);
  const resolved = resolveOneToOneGroups(candidates);
  const oneToOne = resolved.groups;
  const ambiguous = resolved.ambiguous;

  const takenOmie = new Set([
    ...oneToOne.flatMap((group) => group.omie_entry_ids),
    ...ambiguous.flatMap((group) => group.omie_entry_ids),
  ]);
  const takenBank = new Set([
    ...oneToOne.flatMap((group) => group.bank_entry_ids),
    ...ambiguous.flatMap((group) => group.bank_entry_ids),
    ...transferIds,
  ]);

  const aggregations = findManyToOneGroups(
    omie.filter((row) => !takenOmie.has(row.id)),
    bankForOmie.filter((row) => !takenBank.has(row.id)),
  );
  for (const group of aggregations) {
    for (const id of group.omie_entry_ids) takenOmie.add(id);
    for (const id of group.bank_entry_ids) takenBank.add(id);
  }

  const groups = [...oneToOne, ...aggregations].sort((a, b) => a.id.localeCompare(b.id));
  const unmatchedOmie = omie.filter((row) => !takenOmie.has(row.id));
  const unmatchedBank = bank.filter((row) => !takenBank.has(row.id));

  const findings = buildFindings({
    entries,
    transfers,
    groups,
    ambiguous,
    unmatchedOmie,
    unmatchedBank,
  });

  const high = groups.filter((group) => group.band === "high");
  const suggested = groups.filter((group) => group.band === "suggested" && group.kind === "one_to_one");
  const arUnmatched = unmatchedOmie.filter((row) => row.source_kind === "omie_receivable");
  const apUnmatched = unmatchedOmie.filter((row) => row.source_kind === "omie_payable");
  const creditUnmatched = unmatchedBank.filter((row) => row.direction === "credit");
  const debitUnmatched = unmatchedBank.filter((row) => row.direction === "debit");

  const histogram: Record<string, number> = { "0-74": 0, "75-89": 0, "90-100": 0 };
  for (const row of candidates) {
    if (row.score >= 90) histogram["90-100"] += 1;
    else if (row.score >= 75) histogram["75-89"] += 1;
    else histogram["0-74"] += 1;
  }

  const stats: ReconStats = {
    period_start: periodStart,
    period_end: periodEnd,
    sicredi_count: bank.length,
    sicredi_credit_count: bank.filter((row) => row.direction === "credit").length,
    sicredi_debit_count: bank.filter((row) => row.direction === "debit").length,
    sicredi_credit_cents: sum(bank.filter((row) => row.direction === "credit").map((row) => bankMatchAmountCents(row) ?? 0)),
    sicredi_debit_cents: sum(bank.filter((row) => row.direction === "debit").map((row) => bankMatchAmountCents(row) ?? 0)),
    omie_ar_count: omie.filter((row) => row.source_kind === "omie_receivable").length,
    omie_ap_count: omie.filter((row) => row.source_kind === "omie_payable").length,
    omie_ar_settled_cents: sum(
      omie.filter((row) => row.source_kind === "omie_receivable").map((row) => omieMatchAmountCents(row) ?? 0),
    ),
    omie_ap_settled_cents: sum(
      omie.filter((row) => row.source_kind === "omie_payable").map((row) => omieMatchAmountCents(row) ?? 0),
    ),
    transfer_count: transfers.length,
    transfer_high_count: transfers.filter((row) => row.confidence === "high").length,
    transfer_ambiguous_count: transfers.filter((row) => row.confidence === "ambiguous").length,
    transfer_cents: sum(transfers.filter((row) => row.confidence === "high").map((row) => row.amount_cents)),
    high_count: high.length,
    high_cents: sum(high.map((group) => group.matched_amount_cents)),
    suggested_count: suggested.length,
    suggested_cents: sum(suggested.map((group) => group.matched_amount_cents)),
    ambiguous_count: ambiguous.length,
    ambiguous_cents: sum(ambiguous.map((group) => group.matched_amount_cents)),
    aggregation_count: aggregations.length,
    aggregation_cents: sum(aggregations.map((group) => group.matched_amount_cents)),
    omie_ar_unmatched_count: arUnmatched.length,
    omie_ar_unmatched_cents: sum(arUnmatched.map((row) => omieMatchAmountCents(row) ?? 0)),
    omie_ap_unmatched_count: apUnmatched.length,
    omie_ap_unmatched_cents: sum(apUnmatched.map((row) => omieMatchAmountCents(row) ?? 0)),
    bank_credit_unmatched_count: creditUnmatched.length,
    bank_credit_unmatched_cents: sum(creditUnmatched.map((row) => bankMatchAmountCents(row) ?? 0)),
    bank_debit_unmatched_count: debitUnmatched.length,
    bank_debit_unmatched_cents: sum(debitUnmatched.map((row) => bankMatchAmountCents(row) ?? 0)),
    score_histogram: histogram,
  };

  const byId = new Map(entries.map((row) => [row.id, row]));
  const samples: ReconSample[] = [
    ...samplesFor(
      "internal_transfer_high",
      transfers
        .filter((row) => row.confidence === "high")
        .map((row) => ({
          entryIds: [row.debit_entry_id, row.credit_entry_id],
          amount: row.amount_cents,
          score: 100,
          party: null,
          distance: row.date_distance_days,
          fitid: byId.get(row.debit_entry_id)?.source_record_id ?? null,
        })),
    ),
    ...samplesFor(
      "high",
      high.map((group) => ({
        entryIds: [...group.omie_entry_ids, ...group.bank_entry_ids],
        amount: group.matched_amount_cents,
        score: group.confidence,
        party: group.score_evidence.party_match ?? null,
        distance: group.score_evidence.date_distance_days ?? null,
        fitid: byId.get(group.bank_entry_ids[0] ?? "")?.source_record_id ?? null,
      })),
    ),
    ...samplesFor(
      "suggested",
      suggested.map((group) => ({
        entryIds: [...group.omie_entry_ids, ...group.bank_entry_ids],
        amount: group.matched_amount_cents,
        score: group.confidence,
        party: group.score_evidence.party_match ?? null,
        distance: group.score_evidence.date_distance_days ?? null,
        fitid: byId.get(group.bank_entry_ids[0] ?? "")?.source_record_id ?? null,
      })),
    ),
    ...samplesFor(
      "ambiguous",
      ambiguous.map((group) => ({
        entryIds: [...group.omie_entry_ids, ...group.bank_entry_ids],
        amount: group.matched_amount_cents,
        score: group.confidence,
        party: group.score_evidence.party_match ?? null,
        distance: group.score_evidence.date_distance_days ?? null,
        fitid: null,
      })),
    ),
    ...samplesFor(
      "aggregation",
      aggregations.map((group) => ({
        entryIds: [...group.omie_entry_ids, ...group.bank_entry_ids],
        amount: group.matched_amount_cents,
        score: group.confidence,
        party: group.score_evidence.party_match ?? null,
        distance: group.score_evidence.date_distance_days ?? null,
        fitid: byId.get(group.bank_entry_ids[0] ?? "")?.source_record_id ?? null,
      })),
    ),
  ];

  return {
    rule_version: OMIE_SICREDI_RULE_VERSION,
    transfers,
    groups,
    findings,
    stats,
    samples,
  };
}
