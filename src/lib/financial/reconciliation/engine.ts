import { collectOneToOneCandidates, resolveOneToOneGroups } from "./candidate-search.ts";
import { inPeriod } from "./dates.ts";
import { buildFindings } from "./findings.ts";
import { diagnoseBatchAggregations, findPersonGrouping } from "./grouping.ts";
import { findInternalTransferCandidates, transferBankEntryIds } from "./internal-transfers.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  HIGH_SCORE_MIN,
  OMIE_SICREDI_RULE_VERSION,
  RECON_PERIOD_END,
  RECON_PERIOD_START,
  SUGGESTED_SCORE_MIN,
  type PossibleAggregationBucketStats,
  type PossibleAggregationCandidate,
  type ReconEntry,
  type ReconGroup,
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

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

function bucketStats(rows: readonly PossibleAggregationCandidate[]): PossibleAggregationBucketStats {
  const omieIds = new Set<string>();
  for (const row of rows) for (const id of row.omie_entry_ids) omieIds.add(id);
  return {
    bank_count: rows.length,
    omie_entries: omieIds.size,
    amount_cents: sum(rows.filter((row) => row.unique_combination).map((row) => row.amount_cents)),
    unique_count: rows.filter((row) => row.unique_combination).length,
    ambiguous_count: rows.filter((row) => !row.unique_combination && !row.search_limit).length,
    search_limit: rows.filter((row) => row.search_limit).length,
  };
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

function countReuse(ids: readonly string[]): number {
  const seen = new Set<string>();
  let collisions = 0;
  for (const id of ids) {
    if (seen.has(id)) collisions += 1;
    else seen.add(id);
  }
  return collisions;
}

function omieKind(groups: readonly ReconGroup[], omie: readonly ReconEntry[], kind: ReconEntry["source_kind"]): ReconGroup[] {
  return groups.filter((group) =>
    group.omie_entry_ids.some((id) => omie.find((row) => row.id === id)?.source_kind === kind),
  );
}

function emptyBucket(): PossibleAggregationBucketStats {
  return { bank_count: 0, omie_entries: 0, amount_cents: 0, unique_count: 0, ambiguous_count: 0, search_limit: 0 };
}

export function reconcileOmieSicredi(input: {
  entries: readonly ReconEntry[];
  periodStart?: string;
  periodEnd?: string;
  includePossibleAggregations?: boolean;
  includeReportExtras?: boolean;
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

  const takenOmie = new Set<string>();
  const takenBank = new Set<string>(transferIds);

  const allCandidates = collectOneToOneCandidates(omie, bankForOmie, takenBank, takenOmie);
  const highPass = resolveOneToOneGroups(allCandidates, { minScore: HIGH_SCORE_MIN, allocateTies: false });
  for (const group of highPass.groups) {
    for (const id of group.omie_entry_ids) takenOmie.add(id);
    for (const id of group.bank_entry_ids) takenBank.add(id);
  }

  const suggestedCandidates = collectOneToOneCandidates(omie, bankForOmie, takenBank, takenOmie);
  const suggestedPass = resolveOneToOneGroups(suggestedCandidates, {
    minScore: SUGGESTED_SCORE_MIN,
    maxScore: HIGH_SCORE_MIN - 1,
    allocateTies: false,
  });
  for (const group of suggestedPass.groups) {
    for (const id of group.omie_entry_ids) takenOmie.add(id);
    for (const id of group.bank_entry_ids) takenBank.add(id);
  }

  const stillFree = (id: string, side: "omie" | "bank") => (side === "omie" ? !takenOmie.has(id) : !takenBank.has(id));
  const tieCandidates = [...highPass.leftoverTies, ...suggestedPass.leftoverTies].filter(
    (row) => stillFree(row.omie.id, "omie") && stillFree(row.bank.id, "bank"),
  );
  const ambiguousPass = resolveOneToOneGroups(tieCandidates, { minScore: SUGGESTED_SCORE_MIN, allocateTies: true });

  const remainingOmie = omie.filter((row) => !takenOmie.has(row.id));
  const remainingBank = bankForOmie.filter((row) => !takenBank.has(row.id));
  const grouped = findPersonGrouping(remainingOmie, remainingBank);
  for (const group of grouped.groups) {
    for (const id of group.omie_entry_ids) takenOmie.add(id);
    for (const id of group.bank_entry_ids) takenBank.add(id);
  }

  const includePossibleAggregations = input.includePossibleAggregations !== false;
  const includeReportExtras = input.includeReportExtras !== false;
  const leftoverOmie = omie.filter((row) => !takenOmie.has(row.id));
  const leftoverBank = bankForOmie.filter((row) => !takenBank.has(row.id));
  const diagnostic = includePossibleAggregations
    ? diagnoseBatchAggregations(leftoverOmie, leftoverBank)
    : { candidates: [] as PossibleAggregationCandidate[], searchLimits: 0 };

  const ambiguous = [...ambiguousPass.ambiguous, ...grouped.ambiguous];
  const groups = [...highPass.groups, ...suggestedPass.groups, ...grouped.groups].sort((a, b) => a.id.localeCompare(b.id));
  const unmatchedOmie = omie.filter((row) => !takenOmie.has(row.id));
  const unmatchedBank = bank.filter((row) => !takenBank.has(row.id));

  const findings = includeReportExtras
    ? buildFindings({
        entries,
        transfers,
        groups,
        ambiguous,
        unmatchedOmie,
        unmatchedBank,
      })
    : [];

  const high = groups.filter((group) => group.kind === "one_to_one" && group.band === "high");
  const suggested = groups.filter((group) => group.kind === "one_to_one" && group.band === "suggested");
  const aggregations = grouped.groups;
  const layerA = aggregations.filter((group) => group.score_evidence.grouping_layer === "person_date");
  const layerB = aggregations.filter((group) => group.score_evidence.grouping_layer === "person_window");
  const arAgg = omieKind(aggregations, omie, "omie_receivable");
  const apAgg = omieKind(aggregations, omie, "omie_payable");
  const arUnmatched = unmatchedOmie.filter((row) => row.source_kind === "omie_receivable");
  const apUnmatched = unmatchedOmie.filter((row) => row.source_kind === "omie_payable");
  const creditUnmatched = unmatchedBank.filter((row) => row.direction === "credit");
  const debitUnmatched = unmatchedBank.filter((row) => row.direction === "debit");

  const highOfficial = [...high, ...layerA.filter((group) => group.band === "high")];
  const highAr = omieKind(highOfficial, omie, "omie_receivable");
  const highAp = omieKind(highOfficial, omie, "omie_payable");
  const transferHigh = transfers.filter((row) => row.confidence === "high");
  const highEntryIds = [
    ...highOfficial.flatMap((group) => [...group.omie_entry_ids, ...group.bank_entry_ids]),
    ...transferHigh.flatMap((row) => [row.debit_entry_id, row.credit_entry_id]),
  ];
  const highParty = { exact_normalized: 0, token_exact: 0, contains_safe: 0, no_match: 0 };
  let amountDateOnly = 0;
  for (const group of high) {
    const party = group.score_evidence.party_match ?? "no_match";
    if (party === "exact_normalized") highParty.exact_normalized += 1;
    else if (party === "token_exact") highParty.token_exact += 1;
    else if (party === "contains_safe") highParty.contains_safe += 1;
    else {
      highParty.no_match += 1;
      amountDateOnly += 1;
    }
  }

  const histogram: Record<string, number> = { "0-74": 0, "75-89": 0, "90-100": 0 };
  for (const row of allCandidates) {
    if (row.score >= 90) histogram["90-100"] += 1;
    else if (row.score >= 75) histogram["75-89"] += 1;
    else histogram["0-74"] += 1;
  }

  const possible = diagnostic.candidates;
  const cAr = includePossibleAggregations
    ? possible.filter((row) => row.direction === "ar_credit" && row.date_window === "same_day")
    : [];
  const dAr = includePossibleAggregations
    ? possible.filter((row) => row.direction === "ar_credit" && row.date_window === "d1")
    : [];
  const cAp = includePossibleAggregations
    ? possible.filter((row) => row.direction === "ap_debit" && row.date_window === "same_day")
    : [];
  const dAp = includePossibleAggregations
    ? possible.filter((row) => row.direction === "ap_debit" && row.date_window === "d1")
    : [];

  const omieArSettled = sum(
    omie.filter((row) => row.source_kind === "omie_receivable").map((row) => omieMatchAmountCents(row) ?? 0),
  );
  const omieApSettled = sum(
    omie.filter((row) => row.source_kind === "omie_payable").map((row) => omieMatchAmountCents(row) ?? 0),
  );
  const bankCreditCents = sum(bank.filter((row) => row.direction === "credit").map((row) => bankMatchAmountCents(row) ?? 0));
  const bankDebitCents = sum(bank.filter((row) => row.direction === "debit").map((row) => bankMatchAmountCents(row) ?? 0));
  const highArCents = sum(highAr.map((group) => group.matched_amount_cents));
  const highApCents = sum(highAp.map((group) => group.matched_amount_cents));
  const highBankCreditCents =
    sum(highOfficial.filter((group) => group.bank_entry_ids.some((id) => bank.find((row) => row.id === id)?.direction === "credit")).map((group) => group.matched_amount_cents)) +
    sum(transferHigh.map((row) => row.amount_cents));
  const highBankDebitCents =
    sum(highOfficial.filter((group) => group.bank_entry_ids.some((id) => bank.find((row) => row.id === id)?.direction === "debit")).map((group) => group.matched_amount_cents)) +
    sum(transferHigh.map((row) => row.amount_cents));

  const stats: ReconStats = {
    period_start: periodStart,
    period_end: periodEnd,
    sicredi_count: bank.length,
    sicredi_credit_count: bank.filter((row) => row.direction === "credit").length,
    sicredi_debit_count: bank.filter((row) => row.direction === "debit").length,
    sicredi_credit_cents: bankCreditCents,
    sicredi_debit_cents: bankDebitCents,
    omie_ar_count: omie.filter((row) => row.source_kind === "omie_receivable").length,
    omie_ap_count: omie.filter((row) => row.source_kind === "omie_payable").length,
    omie_ar_settled_cents: omieArSettled,
    omie_ap_settled_cents: omieApSettled,
    transfer_count: transfers.length,
    transfer_high_count: transferHigh.length,
    transfer_ambiguous_count: transfers.filter((row) => row.confidence === "ambiguous").length,
    transfer_cents: sum(transferHigh.map((row) => row.amount_cents)),
    transfer_ambiguous_cents: sum(transfers.filter((row) => row.confidence === "ambiguous").map((row) => row.amount_cents)),
    high_count: high.length,
    high_cents: sum(high.map((group) => group.matched_amount_cents)),
    suggested_count: suggested.length,
    suggested_cents: sum(suggested.map((group) => group.matched_amount_cents)),
    ambiguous_count: ambiguous.length,
    ambiguous_cents: sum(ambiguous.map((group) => group.matched_amount_cents)),
    aggregation_count: aggregations.length,
    aggregation_cents: sum(aggregations.map((group) => group.matched_amount_cents)),
    aggregation_entries: aggregations.reduce((acc, group) => acc + group.omie_entry_ids.length, 0),
    aggregation_high_count: aggregations.filter((group) => group.band === "high").length,
    aggregation_suggested_count: aggregations.filter((group) => group.band === "suggested").length,
    aggregation_ar_count: arAgg.length,
    aggregation_ar_entries: arAgg.reduce((acc, group) => acc + group.omie_entry_ids.length, 0),
    aggregation_ar_cents: sum(arAgg.map((group) => group.matched_amount_cents)),
    aggregation_ap_count: apAgg.length,
    aggregation_ap_entries: apAgg.reduce((acc, group) => acc + group.omie_entry_ids.length, 0),
    aggregation_ap_cents: sum(apAgg.map((group) => group.matched_amount_cents)),
    aggregation_a_count: layerA.length,
    aggregation_a_entries: layerA.reduce((acc, group) => acc + group.omie_entry_ids.length, 0),
    aggregation_a_cents: sum(layerA.map((group) => group.matched_amount_cents)),
    aggregation_b_count: layerB.length,
    aggregation_b_entries: layerB.reduce((acc, group) => acc + group.omie_entry_ids.length, 0),
    aggregation_b_cents: sum(layerB.map((group) => group.matched_amount_cents)),
    grouping_search_limit: grouped.searchLimits,
    grouping_search_limit_candidates: grouped.searchLimitReasons.candidates,
    grouping_search_limit_combinations: grouped.searchLimitReasons.combinations,
    omie_ar_unmatched_count: arUnmatched.length,
    omie_ar_unmatched_cents: sum(arUnmatched.map((row) => omieMatchAmountCents(row) ?? 0)),
    omie_ap_unmatched_count: apUnmatched.length,
    omie_ap_unmatched_cents: sum(apUnmatched.map((row) => omieMatchAmountCents(row) ?? 0)),
    bank_credit_unmatched_count: creditUnmatched.length,
    bank_credit_unmatched_cents: sum(creditUnmatched.map((row) => bankMatchAmountCents(row) ?? 0)),
    bank_debit_unmatched_count: debitUnmatched.length,
    bank_debit_unmatched_cents: sum(debitUnmatched.map((row) => bankMatchAmountCents(row) ?? 0)),
    possible_agg_c_ar: includePossibleAggregations ? bucketStats(cAr) : emptyBucket(),
    possible_agg_d_ar: includePossibleAggregations ? bucketStats(dAr) : emptyBucket(),
    possible_agg_c_ap: includePossibleAggregations ? bucketStats(cAp) : emptyBucket(),
    possible_agg_d_ap: includePossibleAggregations ? bucketStats(dAp) : emptyBucket(),
    high_entries_consumed: new Set(highEntryIds).size,
    high_ar_cents: highArCents,
    high_ap_cents: highApCents,
    high_omie_settled_coverage_pct: pct(highArCents + highApCents, omieArSettled + omieApSettled),
    high_bank_credit_coverage_pct: pct(highBankCreditCents, bankCreditCents),
    high_bank_debit_coverage_pct: pct(highBankDebitCents, bankDebitCents),
    high_collision_count: countReuse(highEntryIds),
    high_amount_date_only_count: amountDateOnly,
    high_party_exact_normalized: highParty.exact_normalized,
    high_party_token_exact: highParty.token_exact,
    high_party_contains_safe: highParty.contains_safe,
    high_party_no_match: highParty.no_match,
    score_histogram: histogram,
  };

  const byId = includeReportExtras ? new Map(entries.map((row) => [row.id, row])) : new Map<string, ReconEntry>();
  const samples: ReconSample[] = includeReportExtras ? [
    ...samplesFor(
      "internal_transfer_high",
      transferHigh.map((row) => ({
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
    ...samplesFor(
      "possible_aggregation",
      possible
        .filter((row) => row.unique_combination)
        .map((row) => ({
          entryIds: [...row.omie_entry_ids, row.bank_entry_id],
          amount: row.amount_cents,
          score: null,
          party: null,
          distance: row.date_window === "same_day" ? 0 : 1,
          fitid: byId.get(row.bank_entry_id)?.source_record_id ?? null,
        })),
    ),
  ] : [];

  return {
    rule_version: OMIE_SICREDI_RULE_VERSION,
    transfers,
    groups,
    ambiguous,
    findings,
    possible_aggregations: possible,
    stats,
    samples,
  };
}
