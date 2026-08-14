import { dateDistanceDays } from "./dates.ts";
import { stableId } from "./internal-transfers.ts";
import { normalizeFinancialPartyName } from "./normalize-party.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import {
  AGGREGATION_DATE_WINDOW_DAYS,
  AGGREGATION_MAX_N,
  OMIE_SICREDI_RULE_VERSION,
  type ReconEntry,
  type ReconGroup,
} from "./types.ts";

function groupKey(entry: ReconEntry): string | null {
  const person = normalizeFinancialPartyName(entry.person_name);
  if (!person) return null;
  return `${entry.source_kind}|${entry.settlement_date}|${person}`;
}

export function findManyToOneGroups(
  remainingOmie: readonly ReconEntry[],
  remainingBank: readonly ReconEntry[],
): ReconGroup[] {
  const buckets = new Map<string, ReconEntry[]>();
  for (const row of remainingOmie) {
    const amount = omieMatchAmountCents(row) ?? 0;
    if (amount <= 0) continue;
    const key = groupKey(row);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  const usedBank = new Set<string>();
  const groups: ReconGroup[] = [];
  const keys = [...buckets.keys()].sort();
  for (const key of keys) {
    const omieRows = (buckets.get(key) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (omieRows.length < 2 || omieRows.length > AGGREGATION_MAX_N) continue;
    const sum = omieRows.reduce((acc, row) => acc + (omieMatchAmountCents(row) ?? 0), 0);
    if (sum <= 0) continue;
    const side = omieRows[0]!.source_kind;
    const date = omieRows[0]!.settlement_date;
    const banks = remainingBank.filter((bank) => {
      if (usedBank.has(bank.id)) return false;
      if (bankMatchAmountCents(bank) !== sum) return false;
      if (side === "omie_receivable" && bank.source_kind !== "bank_credit") return false;
      if (side === "omie_payable" && bank.source_kind !== "bank_debit") return false;
      return dateDistanceDays(date, bank.settlement_date) <= AGGREGATION_DATE_WINDOW_DAYS;
    });
    if (banks.length !== 1) continue;
    const bank = banks[0]!;
    usedBank.add(bank.id);
    const omieIds = omieRows.map((row) => row.id);
    groups.push({
      id: stableId(["agg", ...omieIds, bank.id]),
      kind: "many_to_one",
      band: "suggested",
      status: "suggested",
      rule_version: OMIE_SICREDI_RULE_VERSION,
      confidence: 80,
      matched_amount_cents: sum,
      omie_entry_ids: omieIds,
      bank_entry_ids: [bank.id],
      score_evidence: {
        amount_exact: true,
        amount_cents: sum,
        date_distance_days: dateDistanceDays(date, bank.settlement_date),
        direction_compatible: true,
        direction_match: true,
        candidate_count: 1,
        internal_transfer_excluded: false,
        party_match: "exact_normalized",
        name_match: "normalized_exact",
        rule_id: OMIE_SICREDI_RULE_VERSION,
      },
    });
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}
