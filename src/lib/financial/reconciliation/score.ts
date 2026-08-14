import type { FinancialNameMatch, FinancialPartyMatch, FinancialScoreEvidence } from "../types.ts";
import { dateDistanceDays } from "./dates.ts";
import { bestPartyMatch } from "./normalize-party.ts";
import {
  HIGH_SCORE_MIN,
  MAX_DATE_WINDOW_DAYS,
  OMIE_SICREDI_RULE_VERSION,
  SUGGESTED_SCORE_MIN,
  type MatchBand,
  type ReconEntry,
} from "./types.ts";

export function omieMatchAmountCents(entry: ReconEntry): number | null {
  if (entry.settled_amount_cents == null) return null;
  if (!Number.isInteger(entry.settled_amount_cents) || entry.settled_amount_cents < 0) return null;
  return entry.settled_amount_cents;
}

export function bankMatchAmountCents(entry: ReconEntry): number | null {
  if (entry.gross_amount_cents == null) return null;
  if (!Number.isInteger(entry.gross_amount_cents) || entry.gross_amount_cents < 0) return null;
  return entry.gross_amount_cents;
}

export function directionCompatible(omie: ReconEntry, bank: ReconEntry): boolean {
  if (omie.source_kind === "omie_receivable") return bank.source_kind === "bank_credit" && bank.direction === "credit";
  if (omie.source_kind === "omie_payable") return bank.source_kind === "bank_debit" && bank.direction === "debit";
  return false;
}

export function partyMatchToNameMatch(party: FinancialPartyMatch): FinancialNameMatch {
  if (party === "exact_normalized") return "normalized_exact";
  if (party === "token_exact") return "token_sort";
  if (party === "contains_safe") return "unknown";
  return "none";
}

export function scoreOmieBankPair(omie: ReconEntry, bank: ReconEntry): {
  score: number;
  amountExact: boolean;
  dateDistance: number;
  partyMatch: FinancialPartyMatch;
  evidence: FinancialScoreEvidence;
} | null {
  if (!directionCompatible(omie, bank)) return null;
  const omieAmount = omieMatchAmountCents(omie);
  const bankAmount = bankMatchAmountCents(bank);
  if (omieAmount == null || bankAmount == null) return null;
  const dateDistance = dateDistanceDays(omie.settlement_date, bank.settlement_date);
  if (dateDistance > MAX_DATE_WINDOW_DAYS) return null;
  const amountExact = omieAmount === bankAmount;
  const partyMatch = bestPartyMatch(omie.person_name, bank.person_name, bank.description);
  let score = 0;
  if (amountExact) score += 50;
  if (dateDistance === 0) score += 25;
  else if (dateDistance === 1) score += 18;
  else if (dateDistance === 2) score += 10;
  if (partyMatch === "exact_normalized") score += 25;
  else if (partyMatch === "token_exact") score += 18;
  else if (partyMatch === "contains_safe") score += 10;
  return {
    score,
    amountExact,
    dateDistance,
    partyMatch,
    evidence: {
      amount_exact: amountExact,
      amount_cents: omieAmount,
      date_distance_days: dateDistance,
      name_match: partyMatchToNameMatch(partyMatch),
      party_match: partyMatch,
      direction_compatible: true,
      direction_match: true,
      candidate_count: 1,
      internal_transfer_excluded: false,
      rule_id: OMIE_SICREDI_RULE_VERSION,
    },
  };
}

export function bandForScore(score: number, amountExact: boolean, candidateCount: number): MatchBand | null {
  if (!amountExact) return null;
  if (candidateCount > 1) return "ambiguous";
  if (score >= HIGH_SCORE_MIN) return "high";
  if (score >= SUGGESTED_SCORE_MIN) return "suggested";
  return null;
}

export function strongIdentityMismatch(omie: ReconEntry, bank: ReconEntry): boolean {
  if (!directionCompatible(omie, bank)) return false;
  const omieAmount = omieMatchAmountCents(omie);
  const bankAmount = bankMatchAmountCents(bank);
  if (omieAmount == null || bankAmount == null || omieAmount === bankAmount) return false;
  const dateDistance = dateDistanceDays(omie.settlement_date, bank.settlement_date);
  if (dateDistance > 1) return false;
  const party = bestPartyMatch(omie.person_name, bank.person_name, bank.description);
  return party === "exact_normalized";
}
