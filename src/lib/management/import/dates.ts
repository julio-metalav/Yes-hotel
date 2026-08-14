/** Datas dd/mm/aa e dd/mm/aaaa dos relatórios. */

export function parseReportDate(raw: string): string {
  const match = String(raw ?? "").trim().match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!match) throw new Error(`data inválida: ${raw}`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`data inválida: ${raw}`);
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

export function nightsBetween(checkinIso: string, checkoutIso: string): number {
  const a = Date.parse(`${checkinIso}T00:00:00Z`);
  const b = Date.parse(`${checkoutIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}
