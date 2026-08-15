import { createHash } from "node:crypto";
import type { FinancialScoreEvidence } from "../types.ts";
import { dateDistanceDays } from "./dates.ts";
import { normalizeFinancialPartyName } from "./normalize-party.ts";
import { bankMatchAmountCents } from "./score.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  TRANSFER_WINDOW_DAYS,
  YES_HOTEL_BANK_CODES,
  type InternalTransferCandidate,
  type ReconEntry,
  type YesHotelBankCode,
} from "./types.ts";

const TRANSFER_TOKENS = ["TRANSFERENCIA", "TRANSF", "TED", "TEV", "PIX", "DOC", "ENTRECONTAS"];

function isYesAccount(code: string | null): code is YesHotelBankCode {
  return code === "sicredi_principal" || code === "sicredi_0911";
}

export function descriptionLooksLikeTransfer(raw: string | null | undefined): boolean {
  const normalized = normalizeFinancialPartyName(raw).replace(/\s+/g, "");
  if (!normalized) return false;
  return TRANSFER_TOKENS.some((token) => normalized.includes(token));
}

function descriptionCompatible(debit: ReconEntry, credit: ReconEntry): boolean {
  const debitText = debit.description || debit.person_name;
  const creditText = credit.description || credit.person_name;
  const debitHas = Boolean(normalizeFinancialPartyName(debitText));
  const creditHas = Boolean(normalizeFinancialPartyName(creditText));
  if (!debitHas && !creditHas) return true;
  return descriptionLooksLikeTransfer(debitText) || descriptionLooksLikeTransfer(creditText);
}

function evidence(amount: number, distance: number, counterparts: number): FinancialScoreEvidence {
  return {
    amount_exact: true,
    amount_cents: amount,
    date_distance_days: distance,
    direction_compatible: true,
    direction_match: true,
    same_account: false,
    candidate_count: counterparts,
    internal_transfer_excluded: false,
    rule_id: OMIE_SICREDI_RULE_VERSION,
  };
}

export function findInternalTransferCandidates(entries: readonly ReconEntry[]): InternalTransferCandidate[] {
  const bank = entries.filter(
    (row) =>
      row.source_system === "sicredi" &&
      isYesAccount(row.account_code) &&
      bankMatchAmountCents(row) != null &&
      row.settlement_date,
  );
  const debits = bank.filter((row) => row.direction === "debit");
  const credits = bank.filter((row) => row.direction === "credit");
  const rawPairs: Array<Omit<InternalTransferCandidate, "confidence" | "counterpart_count"> & { counterpart_count: number }> =
    [];

  for (const debit of debits) {
    const amount = bankMatchAmountCents(debit);
    if (amount == null || amount === 0) continue;
    const matches = credits.filter((credit) => {
      if (credit.account_code === debit.account_code) return false;
      if (bankMatchAmountCents(credit) !== amount) return false;
      return dateDistanceDays(debit.settlement_date, credit.settlement_date) <= TRANSFER_WINDOW_DAYS;
    });
    for (const credit of matches) {
      rawPairs.push({
        debit_entry_id: debit.id,
        credit_entry_id: credit.id,
        amount_cents: amount,
        date_distance_days: dateDistanceDays(debit.settlement_date, credit.settlement_date),
        debit_account: debit.account_code as YesHotelBankCode,
        credit_account: credit.account_code as YesHotelBankCode,
        description_compatible: descriptionCompatible(debit, credit),
        counterpart_count: matches.length,
        score_evidence: evidence(amount, dateDistanceDays(debit.settlement_date, credit.settlement_date), matches.length),
      });
    }
  }

  const creditCounts = new Map<string, number>();
  for (const pair of rawPairs) {
    creditCounts.set(pair.credit_entry_id, (creditCounts.get(pair.credit_entry_id) ?? 0) + 1);
  }

  const usedDebit = new Set<string>();
  const usedCredit = new Set<string>();
  const out: InternalTransferCandidate[] = [];
  const sorted = [...rawPairs].sort((a, b) =>
    `${a.debit_entry_id}|${a.credit_entry_id}`.localeCompare(`${b.debit_entry_id}|${b.credit_entry_id}`),
  );

  for (const pair of sorted) {
    const creditCount = creditCounts.get(pair.credit_entry_id) ?? 0;
    const counterparts = Math.max(pair.counterpart_count, creditCount);
    const unique = pair.counterpart_count === 1 && creditCount === 1;
    if (!pair.description_compatible) continue;
    if (!unique) {
      out.push({ ...pair, counterpart_count: counterparts, confidence: "ambiguous" });
      continue;
    }
    if (usedDebit.has(pair.debit_entry_id) || usedCredit.has(pair.credit_entry_id)) {
      out.push({ ...pair, counterpart_count: counterparts, confidence: "ambiguous" });
      continue;
    }
    usedDebit.add(pair.debit_entry_id);
    usedCredit.add(pair.credit_entry_id);
    out.push({ ...pair, counterpart_count: 1, confidence: "high" });
  }

  return out.sort((a, b) => `${a.debit_entry_id}|${a.credit_entry_id}`.localeCompare(`${b.debit_entry_id}|${b.credit_entry_id}`));
}

export function transferBankEntryIds(transfers: readonly InternalTransferCandidate[]): Set<string> {
  const ids = new Set<string>();
  for (const row of transfers) {
    if (row.confidence !== "high") continue;
    ids.add(row.debit_entry_id);
    ids.add(row.credit_entry_id);
  }
  return ids;
}

export function stableId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

void YES_HOTEL_BANK_CODES;
