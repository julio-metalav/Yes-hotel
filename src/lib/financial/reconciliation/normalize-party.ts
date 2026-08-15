import type { FinancialPartyMatch } from "../types.ts";

const LEGAL_SUFFIXES = ["EIRELI", "LTDA", "S/A", "S.A.", "SA", "ME"] as const;

export function stripDiacritics(raw: string): string {
  return raw.normalize("NFKD").replace(/\p{M}/gu, "");
}

export function normalizeFinancialPartyName(raw: string | null | undefined): string {
  let text = stripDiacritics(String(raw ?? "")).toUpperCase();
  text = text.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const tokens = text.split(" ");
  while (tokens.length) {
    if (tokens.length >= 2 && tokens[tokens.length - 2] === "S" && tokens[tokens.length - 1] === "A") {
      tokens.splice(-2);
      continue;
    }
    const last = tokens[tokens.length - 1] ?? "";
    const matched = LEGAL_SUFFIXES.some((suffix) => suffix.replace(/[^\p{L}\p{N}]+/gu, "") === last);
    if (!matched) break;
    tokens.pop();
  }
  return tokens.join(" ").trim();
}

export function partyTokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

const CONTAINS_MIN = 6;

export function compareFinancialParty(
  leftRaw: string | null | undefined,
  rightRaw: string | null | undefined,
): FinancialPartyMatch {
  const left = normalizeFinancialPartyName(leftRaw);
  const right = normalizeFinancialPartyName(rightRaw);
  if (!left || !right) return "no_match";
  if (left === right) return "exact_normalized";

  const leftTokens = partyTokens(left);
  const rightTokens = partyTokens(right);
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  if (shorter.length >= 2 && shorter.every((token) => longer.includes(token))) {
    return "token_exact";
  }

  const compactLeft = left.replace(/\s+/g, "");
  const compactRight = right.replace(/\s+/g, "");
  if (
    compactLeft.length >= CONTAINS_MIN &&
    compactRight.length >= CONTAINS_MIN &&
    (compactRight.includes(compactLeft) || compactLeft.includes(compactRight))
  ) {
    return "contains_safe";
  }
  return "no_match";
}

export function comparePartyAgainstMemo(
  partyRaw: string | null | undefined,
  memoRaw: string | null | undefined,
): FinancialPartyMatch {
  const direct = compareFinancialParty(partyRaw, memoRaw);
  if (direct !== "no_match") return direct;
  const party = normalizeFinancialPartyName(partyRaw);
  const memo = normalizeFinancialPartyName(memoRaw);
  if (!party || !memo) return "no_match";
  const compactParty = party.replace(/\s+/g, "");
  const compactMemo = memo.replace(/\s+/g, "");
  if (compactParty.length >= CONTAINS_MIN && compactMemo.includes(compactParty)) return "contains_safe";
  const tokens = partyTokens(party);
  if (tokens.length >= 2 && tokens.every((token) => partyTokens(memo).includes(token))) return "token_exact";
  return "no_match";
}

export function bestPartyMatch(
  omieName: string | null | undefined,
  bankName: string | null | undefined,
  bankDescription: string | null | undefined,
): FinancialPartyMatch {
  const ranked: FinancialPartyMatch[] = [
    compareFinancialParty(omieName, bankName),
    comparePartyAgainstMemo(omieName, bankDescription),
  ];
  if (ranked.includes("exact_normalized")) return "exact_normalized";
  if (ranked.includes("token_exact")) return "token_exact";
  if (ranked.includes("contains_safe")) return "contains_safe";
  return "no_match";
}
