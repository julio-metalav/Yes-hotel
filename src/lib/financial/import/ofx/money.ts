/**
 * Valores OFX → centavos inteiros. Sem Number() sobre o valor completo.
 * Aceita somente ponto decimal e no máximo 2 casas (spec OFX).
 */

export type OfxAmountOk = { ok: true; signedCents: number };
export type OfxAmountErr = { ok: false; reason: "empty" | "invalid" | "precision" | "overflow" };
export type OfxAmountResult = OfxAmountOk | OfxAmountErr;

const AMOUNT_RE = /^-?\d+(?:\.\d+)?$/;

export function parseOfxAmountToSignedCents(raw: string | null | undefined): OfxAmountResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.includes(",") || !AMOUNT_RE.test(text)) return { ok: false, reason: "invalid" };

  const negative = text.startsWith("-");
  const abs = negative ? text.slice(1) : text;
  const [wholeRaw, fracRaw = ""] = abs.split(".");
  if (fracRaw.length > 2) return { ok: false, reason: "precision" };
  if (!/^\d+$/.test(wholeRaw) || (fracRaw.length > 0 && !/^\d+$/.test(fracRaw))) {
    return { ok: false, reason: "invalid" };
  }

  const frac2 = `${fracRaw}00`.slice(0, 2);
  let cents: bigint;
  try {
    cents = BigInt(wholeRaw) * 100n + BigInt(frac2);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "overflow" };
  if (cents === 0n) return { ok: false, reason: "invalid" };

  const signed = negative ? -Number(cents) : Number(cents);
  if (!Number.isSafeInteger(signed)) return { ok: false, reason: "overflow" };
  return { ok: true, signedCents: signed };
}

export function signedCentsToDirection(signedCents: number): {
  direction: "credit" | "debit";
  sourceKind: "bank_credit" | "bank_debit";
  absCents: number;
} {
  if (signedCents > 0) {
    return { direction: "credit", sourceKind: "bank_credit", absCents: signedCents };
  }
  return { direction: "debit", sourceKind: "bank_debit", absCents: Math.abs(signedCents) };
}
