import { bandForScore, omieMatchAmountCents, scoreOmieBankPair } from "./score.ts";
import { stableId } from "./internal-transfers.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  type MatchBand,
  type ReconEntry,
  type ReconGroup,
} from "./types.ts";

export type ScoredCandidate = {
  omie: ReconEntry;
  bank: ReconEntry;
  score: number;
  amountExact: boolean;
  dateDistance: number;
  partyMatch: ReconGroup["score_evidence"]["party_match"];
  evidence: ReconGroup["score_evidence"];
};

export function collectOneToOneCandidates(
  omieEntries: readonly ReconEntry[],
  bankEntries: readonly ReconEntry[],
  excludedBankIds: ReadonlySet<string>,
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const omie of omieEntries) {
    if ((omieMatchAmountCents(omie) ?? 0) <= 0) continue;
    for (const bank of bankEntries) {
      if (excludedBankIds.has(bank.id)) continue;
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

export function resolveOneToOneGroups(candidates: readonly ScoredCandidate[]): {
  groups: ReconGroup[];
  ambiguous: ReconGroup[];
} {
  const byOmie = new Map<string, ScoredCandidate[]>();
  for (const row of candidates) {
    const list = byOmie.get(row.omie.id) ?? [];
    list.push(row);
    byOmie.set(row.omie.id, list);
  }

  const usedOmie = new Set<string>();
  const usedBank = new Set<string>();
  const groups: ReconGroup[] = [];
  const ambiguous: ReconGroup[] = [];

  const omieIds = [...byOmie.keys()].sort();
  for (const omieId of omieIds) {
    const list = (byOmie.get(omieId) ?? []).filter((row) => !usedBank.has(row.bank.id));
    if (!list.length) continue;
    const top = list[0]!.score;
    const tied = list.filter((row) => row.score === top);
    const uniqueBanks = new Set(tied.map((row) => row.bank.id));
    if (uniqueBanks.size > 1) {
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
      continue;
    }
    const winner = tied[0]!;
    const bankAlsoWanted = candidates.filter(
      (row) => row.bank.id === winner.bank.id && row.omie.id !== omieId && row.score === top && !usedOmie.has(row.omie.id),
    );
    if (bankAlsoWanted.length) {
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
      continue;
    }
    const band = bandForScore(winner.score, winner.amountExact, 1);
    if (!band || band === "ambiguous") continue;
    groups.push(
      toGroup(band, winner.score, [winner.omie.id], [winner.bank.id], { ...winner.evidence, candidate_count: 1 }),
    );
    usedOmie.add(omieId);
    usedBank.add(winner.bank.id);
  }

  return { groups, ambiguous };
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
