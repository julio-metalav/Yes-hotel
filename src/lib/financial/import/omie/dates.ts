/**
 * Datas do pivot Omie. Não usa Date.parse.
 * Aceita Date, serial Excel e dd/mm/yyyy.
 */

export type OmieDateOk = { ok: true; date: string };
export type OmieDateErr = { ok: false; reason: "empty" | "invalid" };
export type OmieDateResult = OmieDateOk | OmieDateErr;

const DMY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function ymd(year: number, month: number, day: number): OmieDateResult {
  if (!isValidYmd(year, month, day)) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Serial Excel (Windows 1900). ExcelJS pode entregar number cru. */
function fromExcelSerial(serial: number): OmieDateResult {
  if (!Number.isFinite(serial) || serial < 1 || serial > 60000) return { ok: false, reason: "invalid" };
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const dt = new Date(utc);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function parseOmieDate(raw: unknown): OmieDateResult {
  if (raw == null || raw === "") return { ok: false, reason: "empty" };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, reason: "invalid" };
    return ymd(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
  }
  if (typeof raw === "number") return fromExcelSerial(raw);
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  const dmy = text.match(DMY_RE);
  if (dmy) return ymd(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  const iso = text.match(ISO_RE);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return { ok: false, reason: "invalid" };
}
