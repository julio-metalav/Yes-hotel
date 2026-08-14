/**
 * Valores Excel/Omie → centavos inteiros. Persistência nunca guarda float.
 */

export type OmieMoneyOk = { ok: true; signedCents: number; absCents: number };
export type OmieMoneyErr = { ok: false; reason: "empty" | "invalid" | "precision" | "overflow" };
export type OmieMoneyResult = OmieMoneyOk | OmieMoneyErr;

const AMOUNT_RE = /^-?\d+(?:\.\d+)?$/;

export function parseOmieAmountToSignedCents(raw: unknown): OmieMoneyResult {
  if (raw == null || raw === "") return { ok: false, reason: "empty" };
  if (typeof raw === "number") return fromNumber(raw);
  if (typeof raw === "string") return fromText(raw.trim());
  return { ok: false, reason: "invalid" };
}

function fromNumber(value: number): OmieMoneyResult {
  if (!Number.isFinite(value)) return { ok: false, reason: "invalid" };
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 1e-6) return { ok: false, reason: "precision" };
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "overflow" };
  return { ok: true, signedCents: cents, absCents: Math.abs(cents) };
}

function fromText(text: string): OmieMoneyResult {
  if (!text) return { ok: false, reason: "empty" };
  const normalized = text
    .replace(/BRL/gi, "")
    .replace(/[R$\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!AMOUNT_RE.test(normalized)) return { ok: false, reason: "invalid" };
  const [wholeRaw, fracRaw = ""] = (normalized.startsWith("-") ? normalized.slice(1) : normalized).split(".");
  if (fracRaw.length > 2) return { ok: false, reason: "precision" };
  const frac2 = `${fracRaw}00`.slice(0, 2);
  let cents: bigint;
  try {
    cents = BigInt(wholeRaw) * 100n + BigInt(frac2);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "overflow" };
  const signed = normalized.startsWith("-") ? -Number(cents) : Number(cents);
  if (!Number.isSafeInteger(signed)) return { ok: false, reason: "overflow" };
  return { ok: true, signedCents: signed, absCents: Math.abs(signed) };
}

export function zeroOmieMoney(): OmieMoneyOk {
  return { ok: true, signedCents: 0, absCents: 0 };
}
