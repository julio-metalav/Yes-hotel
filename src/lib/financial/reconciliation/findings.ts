import { dateDistanceDays } from "./dates.ts";
import { stableId } from "./internal-transfers.ts";
import { omieMatchAmountCents, strongIdentityMismatch } from "./score.ts";
import type { InternalTransferCandidate, ReconEntry, ReconFinding, ReconGroup } from "./types.ts";

function importIds(entries: readonly ReconEntry[], ids: readonly string[]): string[] {
  const byId = new Map(entries.map((row) => [row.id, row]));
  return [...new Set(ids.map((id) => byId.get(id)?.source_import_id).filter((id): id is string => Boolean(id)))].sort();
}

function periodOf(entries: readonly ReconEntry[]): { start: string; end: string } {
  const dates = entries.map((row) => row.settlement_date).sort();
  return { start: dates[0] ?? "", end: dates[dates.length - 1] ?? "" };
}

export function buildFindings(input: {
  entries: readonly ReconEntry[];
  transfers: readonly InternalTransferCandidate[];
  groups: readonly ReconGroup[];
  ambiguous: readonly ReconGroup[];
  unmatchedOmie: readonly ReconEntry[];
  unmatchedBank: readonly ReconEntry[];
}): ReconFinding[] {
  const findings: ReconFinding[] = [];
  const byId = new Map(input.entries.map((row) => [row.id, row]));

  for (const transfer of input.transfers) {
    const debit = byId.get(transfer.debit_entry_id);
    const credit = byId.get(transfer.credit_entry_id);
    const related = [debit, credit].filter((row): row is ReconEntry => Boolean(row));
    const period = periodOf(related);
    findings.push({
      id: stableId(["finding", "internal_transfer", transfer.debit_entry_id, transfer.credit_entry_id]),
      finding_type: "internal_transfer",
      signal_class: transfer.confidence === "high" ? "anomaly" : "requires_review",
      severity: transfer.confidence === "high" ? "low" : "medium",
      entry_ids: [transfer.debit_entry_id, transfer.credit_entry_id],
      group_id: null,
      import_ids: importIds(input.entries, [transfer.debit_entry_id, transfer.credit_entry_id]),
      amount_cents: transfer.amount_cents,
      period_start: period.start,
      period_end: period.end,
      note: transfer.confidence === "high" ? "internal_transfer_candidate" : "internal_transfer_ambiguous",
    });
  }

  for (const group of input.ambiguous) {
    const related = [...group.omie_entry_ids, ...group.bank_entry_ids]
      .map((id) => byId.get(id))
      .filter((row): row is ReconEntry => Boolean(row));
    const period = periodOf(related);
    findings.push({
      id: stableId(["finding", "duplicate_possible", group.id]),
      finding_type: "duplicate_possible",
      signal_class: "requires_review",
      severity: "medium",
      entry_ids: [...group.omie_entry_ids, ...group.bank_entry_ids],
      group_id: group.id,
      import_ids: importIds(input.entries, [...group.omie_entry_ids, ...group.bank_entry_ids]),
      amount_cents: group.matched_amount_cents,
      period_start: period.start,
      period_end: period.end,
      note: "ambiguous_match",
    });
  }

  for (const group of input.groups) {
    if (group.kind === "many_to_one") {
      findings.push({
        id: stableId(["finding", "payment_aggregation", group.id]),
        finding_type: "payment_aggregation",
        signal_class: "requires_review",
        severity: "low",
        entry_ids: [...group.omie_entry_ids, ...group.bank_entry_ids],
        group_id: group.id,
        import_ids: importIds(input.entries, [...group.omie_entry_ids, ...group.bank_entry_ids]),
        amount_cents: group.matched_amount_cents,
        period_start: periodOf(
          [...group.omie_entry_ids, ...group.bank_entry_ids]
            .map((id) => byId.get(id))
            .filter((row): row is ReconEntry => Boolean(row)),
        ).start,
        period_end: periodOf(
          [...group.omie_entry_ids, ...group.bank_entry_ids]
            .map((id) => byId.get(id))
            .filter((row): row is ReconEntry => Boolean(row)),
        ).end,
        note: "many_to_one",
      });
    }
    for (const omieId of group.omie_entry_ids) {
      const omie = byId.get(omieId);
      if (!omie || (omie.open_amount_cents ?? 0) <= 0) continue;
      findings.push({
        id: stableId(["finding", "partial_payment", group.id, omieId]),
        finding_type: "partial_payment",
        signal_class: "requires_review",
        severity: "info",
        entry_ids: [omieId, ...group.bank_entry_ids],
        group_id: group.id,
        import_ids: importIds(input.entries, [omieId, ...group.bank_entry_ids]),
        amount_cents: omie.open_amount_cents ?? 0,
        period_start: omie.settlement_date,
        period_end: omie.settlement_date,
        note: "open_amount_remaining",
      });
    }
  }

  const matchedOmie = new Set(input.groups.flatMap((group) => group.omie_entry_ids));
  const matchedBank = new Set(input.groups.flatMap((group) => group.bank_entry_ids));
  for (const omie of input.unmatchedOmie) {
    for (const bank of input.unmatchedBank) {
      if (matchedOmie.has(omie.id) || matchedBank.has(bank.id)) continue;
      if (!strongIdentityMismatch(omie, bank)) continue;
      findings.push({
        id: stableId(["finding", "value_mismatch", omie.id, bank.id]),
        finding_type: "value_mismatch",
        signal_class: "divergence",
        severity: "medium",
        entry_ids: [omie.id, bank.id],
        group_id: null,
        import_ids: importIds(input.entries, [omie.id, bank.id]),
        amount_cents: Math.abs((omieMatchAmountCents(omie) ?? 0) - (bank.gross_amount_cents ?? 0)),
        period_start: omie.settlement_date,
        period_end: bank.settlement_date,
        note: `date_distance=${dateDistanceDays(omie.settlement_date, bank.settlement_date)}`,
      });
    }
  }

  for (const omie of input.unmatchedOmie) {
    findings.push({
      id: stableId(["finding", "omie_without_bank", omie.id]),
      finding_type: "omie_without_bank",
      signal_class: "divergence",
      severity: "medium",
      entry_ids: [omie.id],
      group_id: null,
      import_ids: importIds(input.entries, [omie.id]),
      amount_cents: omieMatchAmountCents(omie) ?? 0,
      period_start: omie.settlement_date,
      period_end: omie.settlement_date,
      note: omie.source_kind,
    });
  }

  for (const bank of input.unmatchedBank) {
    findings.push({
      id: stableId(["finding", "bank_without_omie", bank.id]),
      finding_type: "bank_without_omie",
      signal_class: "divergence",
      severity: "medium",
      entry_ids: [bank.id],
      group_id: null,
      import_ids: importIds(input.entries, [bank.id]),
      amount_cents: bank.gross_amount_cents ?? 0,
      period_start: bank.settlement_date,
      period_end: bank.settlement_date,
      note: bank.source_kind,
    });
  }

  return findings.sort((a, b) => a.id.localeCompare(b.id));
}
