import { HIGH_SCORE_MIN, SUGGESTED_SCORE_MIN, OMIE_SICREDI_RULE_VERSION, type MatchBand, type ReconEntry, type ReconGroup } from "./types.ts";
import { bandForScore, bankMatchAmountCents, omieMatchAmountCents, scoreOmieBankPair } from "./score.ts";
import { stableId } from "./internal-transfers.ts";

export type ScoredCandidate = {
  omie: ReconEntry;
  bank: ReconEntry;
  score: number;
  amountExact: boolean;
  dateDistance: number;
  partyMatch: ReconGroup["score_evidence"]["party_match"];
  evidence: ReconGroup["score_evidence"];
};

function bankAmountKey(direction: ReconEntry["direction"], amountCents: number): string {
  return `${direction}|${amountCents}`;
}

/** Mesmos candidatos que o scan completo: só valor exato + direção compatível entram no score. */
export function collectOneToOneCandidates(
  omieEntries: readonly ReconEntry[],
  bankEntries: readonly ReconEntry[],
  excludedBankIds: ReadonlySet<string>,
  excludedOmieIds: ReadonlySet<string> = new Set(),
): ScoredCandidate[] {
  const byAmountDir = new Map<string, ReconEntry[]>();
  for (const bank of bankEntries) {
    if (excludedBankIds.has(bank.id)) continue;
    const amount = bankMatchAmountCents(bank);
    if (amount == null || amount <= 0) continue;
    const key = bankAmountKey(bank.direction, amount);
    const list = byAmountDir.get(key);
    if (list) list.push(bank);
    else byAmountDir.set(key, [bank]);
  }

  const out: ScoredCandidate[] = [];
  for (const omie of omieEntries) {
    if (excludedOmieIds.has(omie.id)) continue;
    const amount = omieMatchAmountCents(omie);
    if (amount == null || amount <= 0) continue;
    const direction = omie.source_kind === "omie_receivable"
      ? "credit"
      : omie.source_kind === "omie_payable"
        ? "debit"
        : null;
    if (!direction) continue;
    const banks = byAmountDir.get(bankAmountKey(direction, amount));
    if (!banks) continue;
    for (const bank of banks) {
      const scored = scoreOmieBankPair(omie, bank);
      if (!scored || !scored.amountExact) continue;
      out.push({
        omie,
        bank,
        score: scored.score,
        amountExact: scored.amountExact,
        dateDistance: scored.dateDistance,
        partyMatch: scored.partyMatch,
        evidence: scored.evidence,
      });
    }
  }
  return out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return `${a.omie.id}|${a.bank.id}`.localeCompare(`${b.omie.id}|${b.bank.id}`);
  });
}

export function resolveOneToOneGroups(
  candidates: readonly ScoredCandidate[],
  input: { minScore: number; maxScore?: number; allocateTies: boolean },
): { groups: ReconGroup[]; ambiguous: ReconGroup[]; leftoverTies: ScoredCandidate[] } {
  const filtered = candidates.filter((row) => {
    if (row.score < input.minScore) return false;
    if (input.maxScore != null && row.score > input.maxScore) return false;
    return true;
  });
  const byOmie = new Map<string, ScoredCandidate[]>();
  for (const row of filtered) {
    const list = byOmie.get(row.omie.id) ?? [];
    list.push(row);
    byOmie.set(row.omie.id, list);
  }

  const usedOmie = new Set<string>();
  const usedBank = new Set<string>();
  const groups: ReconGroup[] = [];
  const ambiguous: ReconGroup[] = [];
  const leftoverTies: ScoredCandidate[] = [];

  const omieIds = [...byOmie.keys()].sort();
  for (const omieId of omieIds) {
    const list = (byOmie.get(omieId) ?? []).filter((row) => !usedBank.has(row.bank.id));
    if (!list.length) continue;
    const top = list[0]!.score;
    const tied = list.filter((row) => row.score === top);
    const uniqueBanks = new Set(tied.map((row) => row.bank.id));
    if (uniqueBanks.size > 1) {
      if (input.allocateTies) {
        const first = tied[0]!;
        ambiguous.push(
          toGroup(
            "ambiguous",
            first.score,
            [first.omie.id],
            tied.map((row) => row.bank.id).sort(),
            { ...first.evidence, candidate_count: uniqueBanks.size },
          ),
        );
        usedOmie.add(omieId);
      } else {
        leftoverTies.push(...tied);
      }
      continue;
    }
    const winner = tied[0]!;
    const bankAlsoWanted = filtered.filter(
      (row) => row.bank.id === winner.bank.id && row.omie.id !== omieId && row.score === top && !usedOmie.has(row.omie.id),
    );
    if (bankAlsoWanted.length) {
      if (input.allocateTies) {
        ambiguous.push(
          toGroup(
            "ambiguous",
            winner.score,
            [omieId, ...bankAlsoWanted.map((row) => row.omie.id)].sort(),
            [winner.bank.id],
            { ...winner.evidence, candidate_count: 1 + bankAlsoWanted.length },
          ),
        );
        usedOmie.add(omieId);
        for (const row of bankAlsoWanted) usedOmie.add(row.omie.id);
      } else {
        leftoverTies.push(winner, ...bankAlsoWanted);
      }
      continue;
    }
    const band = bandForScore(winner.score, winner.amountExact, 1);
    if (!band || band === "ambiguous") continue;
    if (band === "high" && winner.score < HIGH_SCORE_MIN) continue;
    if (band === "suggested" && winner.score >= HIGH_SCORE_MIN) continue;
    groups.push(
      toGroup(band, winner.score, [winner.omie.id], [winner.bank.id], { ...winner.evidence, candidate_count: 1 }),
    );
    usedOmie.add(omieId);
    usedBank.add(winner.bank.id);
  }

  return { groups, ambiguous, leftoverTies };
}

function toGroup(
  band: MatchBand,
  score: number,
  omieIds: string[],
  bankIds: string[],
  evidence: ReconGroup["score_evidence"],
): ReconGroup {
  return {
    id: stableId(["group", band, ...omieIds, ...bankIds]),
    kind: "one_to_one",
    band,
    status: band === "high" ? "auto_matched" : "suggested",
    rule_version: OMIE_SICREDI_RULE_VERSION,
    confidence: score,
    matched_amount_cents: evidence.amount_cents ?? 0,
    omie_entry_ids: omieIds,
    bank_entry_ids: bankIds,
    score_evidence: evidence,
  };
}

export { SUGGESTED_SCORE_MIN };
