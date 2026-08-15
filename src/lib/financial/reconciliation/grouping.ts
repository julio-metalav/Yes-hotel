import { dateDistanceDays } from "./dates.ts";
import { stableId } from "./internal-transfers.ts";
import { normalizeFinancialPartyName } from "./normalize-party.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  AGGREGATION_MAX_N,
  GROUPING_MAX_CANDIDATES,
  GROUPING_MAX_COMBINATIONS,
  GROUPING_MAX_MS,
  OMIE_SICREDI_RULE_VERSION,
  type ReconEntry,
  type ReconGroup,
} from "./types.ts";

export type GroupingLayer = "person_date" | "person_window" | "date_batch" | "window_batch";

export type SubsetSearchResult =
  | { status: "unique"; entries: ReconEntry[]; combinations: number }
  | { status: "none"; combinations: number }
  | { status: "ambiguous"; combinations: number }
  | { status: "limit"; combinations: number; reason: "candidates" | "combinations" | "time" };

export function findUniqueSubset(candidates: readonly ReconEntry[], target: number): SubsetSearchResult {
  const items = candidates
    .map((entry) => ({ entry, amount: omieMatchAmountCents(entry) ?? 0 }))
    .filter((row) => row.amount > 0 && row.amount <= target)
    .sort((a, b) => a.entry.id.localeCompare(b.entry.id));
  if (items.length < 2) return { status: "none", combinations: 0 };
  if (items.length > GROUPING_MAX_CANDIDATES) return { status: "limit", combinations: 0, reason: "candidates" };

  const found: number[][] = [];
  let combinations = 0;
  let timedOut = false;
  const started = Date.now();

  const walk = (start: number, chosen: number[], sum: number) => {
    if (found.length > 1) return;
    if (Date.now() - started > GROUPING_MAX_MS) {
      timedOut = true;
      return;
    }
    if (chosen.length >= 2 && sum === target) {
      found.push([...chosen]);
      return;
    }
    if (chosen.length >= AGGREGATION_MAX_N) return;
    for (let i = start; i < items.length; i++) {
      combinations += 1;
      if (combinations > GROUPING_MAX_COMBINATIONS) return;
      const next = sum + items[i]!.amount;
      if (next > target) continue;
      chosen.push(i);
      walk(i + 1, chosen, next);
      chosen.pop();
      if (found.length > 1 || combinations > GROUPING_MAX_COMBINATIONS) return;
    }
  };
  walk(0, [], 0);
  if (timedOut) return { status: "limit", combinations, reason: "time" };
  if (combinations > GROUPING_MAX_COMBINATIONS) return { status: "limit", combinations, reason: "combinations" };
  if (found.length === 0) return { status: "none", combinations };
  if (found.length > 1) return { status: "ambiguous", combinations };
  return {
    status: "unique",
    combinations,
    entries: found[0]!.map((index) => items[index]!.entry),
  };
}

function compatibleOmie(bank: ReconEntry, omie: ReconEntry): boolean {
  if ((omieMatchAmountCents(omie) ?? 0) <= 0) return false;
  if (bank.source_kind === "bank_credit") return omie.source_kind === "omie_receivable";
  if (bank.source_kind === "bank_debit") return omie.source_kind === "omie_payable";
  return false;
}

function toGroup(
  layer: GroupingLayer,
  band: "high" | "suggested" | "ambiguous",
  omieRows: readonly ReconEntry[],
  bank: ReconEntry,
  distance: number,
): ReconGroup {
  const omieIds = omieRows.map((row) => row.id).sort();
  const amount = bankMatchAmountCents(bank) ?? 0;
  return {
    id: stableId(["agg", layer, band, ...omieIds, bank.id]),
    kind: "many_to_one",
    band,
    status: band === "high" ? "auto_matched" : "suggested",
    rule_version: OMIE_SICREDI_RULE_VERSION,
    confidence: band === "high" ? 88 : band === "suggested" ? 80 : 70,
    matched_amount_cents: amount,
    omie_entry_ids: omieIds,
    bank_entry_ids: [bank.id],
    score_evidence: {
      amount_exact: true,
      amount_cents: amount,
      date_distance_days: distance,
      direction_compatible: true,
      direction_match: true,
      candidate_count: band === "ambiguous" ? 2 : 1,
      internal_transfer_excluded: true,
      grouping_layer: layer,
      party_match: layer === "person_date" || layer === "person_window" ? "exact_normalized" : "no_match",
      name_match: layer === "person_date" || layer === "person_window" ? "normalized_exact" : "none",
      rule_id: OMIE_SICREDI_RULE_VERSION,
    },
  };
}

export function findManyToOneGroups(
  remainingOmie: readonly ReconEntry[],
  remainingBank: readonly ReconEntry[],
): {
  groups: ReconGroup[];
  ambiguous: ReconGroup[];
  searchLimits: number;
  searchLimitReasons: { candidates: number; combinations: number; time: number };
} {
  const usedOmie = new Set<string>();
  const usedBank = new Set<string>();
  const groups: ReconGroup[] = [];
  const ambiguous: ReconGroup[] = [];
  const searchLimitReasons = { candidates: 0, combinations: 0, time: 0 };
  let searchLimits = 0;
  const banks = [...remainingBank].sort((a, b) => a.id.localeCompare(b.id));

  const tryLayer = (
    bank: ReconEntry,
    layer: GroupingLayer,
    pool: ReconEntry[],
    bandIfUnique: "high" | "suggested",
  ): "matched" | "ambiguous" | "none" => {
    const target = bankMatchAmountCents(bank);
    if (target == null || target <= 0) return "none";
    const available = pool.filter((row) => !usedOmie.has(row.id) && compatibleOmie(bank, row));
    const result = findUniqueSubset(available, target);
    if (result.status === "limit") {
      searchLimits += 1;
      searchLimitReasons[result.reason] += 1;
      return "none";
    }
    if (result.status === "ambiguous") {
      ambiguous.push(toGroup(layer, "ambiguous", available.slice(0, 8), bank, 0));
      return "ambiguous";
    }
    if (result.status !== "unique") return "none";
    const distance = Math.max(
      ...result.entries.map((row) => dateDistanceDays(row.settlement_date, bank.settlement_date)),
    );
    groups.push(toGroup(layer, bandIfUnique, result.entries, bank, distance));
    usedBank.add(bank.id);
    for (const row of result.entries) usedOmie.add(row.id);
    return "matched";
  };

  for (const bank of banks) {
    const target = bankMatchAmountCents(bank);
    if (target == null) continue;
    const sameDate = remainingOmie.filter(
      (row) => !usedOmie.has(row.id) && compatibleOmie(bank, row) && row.settlement_date === bank.settlement_date,
    );
    const persons = [...new Set(sameDate.map((row) => normalizeFinancialPartyName(row.person_name)).filter(Boolean))].sort();
    let done = false;
    for (const person of persons) {
      const pool = sameDate.filter((row) => normalizeFinancialPartyName(row.person_name) === person);
      const outcome = tryLayer(bank, "person_date", pool, "high");
      if (outcome !== "none") {
        done = true;
        break;
      }
    }
    if (done) continue;

    const windowed = remainingOmie.filter(
      (row) =>
        !usedOmie.has(row.id) &&
        compatibleOmie(bank, row) &&
        dateDistanceDays(row.settlement_date, bank.settlement_date) <= 1,
    );
    const windowPersons = [...new Set(windowed.map((row) => normalizeFinancialPartyName(row.person_name)).filter(Boolean))].sort();
    for (const person of windowPersons) {
      const pool = windowed.filter((row) => normalizeFinancialPartyName(row.person_name) === person);
      const outcome = tryLayer(bank, "person_window", pool, "suggested");
      if (outcome !== "none") {
        done = true;
        break;
      }
    }
    if (done) continue;
    if (tryLayer(bank, "date_batch", sameDate, "suggested") !== "none") continue;
    tryLayer(bank, "window_batch", windowed, "suggested");
  }

  return {
    groups: groups.sort((a, b) => a.id.localeCompare(b.id)),
    ambiguous: ambiguous.sort((a, b) => a.id.localeCompare(b.id)),
    searchLimits,
    searchLimitReasons,
  };
}
