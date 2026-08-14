/**
 * Datas OFX. Não usa Date.parse.
 * Formatos: YYYYMMDD, YYYYMMDDHHMMSS[.mmm], opcional [offset:TZ].
 * settlement_date = YYYY-MM-DD civil dos 8 primeiros dígitos.
 * Sem offset: assume America/Campo_Grande (metadado).
 */

export const OFX_DEFAULT_TIMEZONE = "America/Campo_Grande";

export type OfxDateOk = {
  ok: true;
  date: string;
  timezone: string;
  offsetHours: number | null;
  original: string;
};
export type OfxDateErr = { ok: false; reason: "empty" | "invalid" };
export type OfxDateResult = OfxDateOk | OfxDateErr;

const OFX_DT_RE =
  /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.\d{1,3})?)?(?:\[([+-]?\d+(?:\.\d+)?)(?::([A-Za-z0-9_/+-]+))?\])?$/;

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export function parseOfxDateTime(raw: string | null | undefined): OfxDateResult {
  const original = String(raw ?? "").trim();
  if (!original) return { ok: false, reason: "empty" };

  const match = original.match(OFX_DT_RE);
  if (!match) return { ok: false, reason: "invalid" };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidYmd(year, month, day)) return { ok: false, reason: "invalid" };

  if (match[4] != null) {
    const hh = Number(match[4]);
    const mm = Number(match[5]);
    const ss = Number(match[6]);
    if (hh > 23 || mm > 59 || ss > 60) return { ok: false, reason: "invalid" };
  }

  const offsetHours = match[7] != null ? Number(match[7]) : null;
  if (offsetHours != null && !Number.isFinite(offsetHours)) return { ok: false, reason: "invalid" };

  const tzName = match[8] ? String(match[8]) : offsetHours == null ? OFX_DEFAULT_TIMEZONE : `utc${offsetHours}`;
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return {
    ok: true,
    date,
    timezone: tzName,
    offsetHours,
    original,
  };
}
