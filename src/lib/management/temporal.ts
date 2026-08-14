/**
 * Papéis de data no BI. Não misturar “quando vendeu” com “quando hospedou”.
 * Datas civis: YYYY-MM-DD no fuso do hotel (America/Campo_Grande).
 */

export type CalendarDate = string;

export type DateRole =
  | "booked_at"
  | "arrival_date"
  | "departure_date"
  | "stay_date"
  | "paid_at"
  | "financial_competence";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): boolean {
  if (!YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function assertCalendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new Error(`Data civil inválida (YYYY-MM-DD): ${value}`);
  }
  return value;
}

/** Noites de estadia: checkout exclusivo. 13→15 = 2 noites. */
export function roomNightsBetween(arrival: CalendarDate, departure: CalendarDate): number {
  const a = assertCalendarDate(arrival);
  const b = assertCalendarDate(departure);
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms =
    Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  const nights = Math.round(ms / 86_400_000);
  return nights > 0 ? nights : 0;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const ymd = assertCalendarDate(date);
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Cada data de noite ocupada: [arrival, departure). */
export function stayDates(arrival: CalendarDate, departure: CalendarDate): CalendarDate[] {
  const nights = roomNightsBetween(arrival, departure);
  const out: CalendarDate[] = [];
  for (let i = 0; i < nights; i += 1) {
    out.push(addDays(arrival, i));
  }
  return out;
}

export function datesInclusive(from: CalendarDate, to: CalendarDate): CalendarDate[] {
  assertCalendarDate(from);
  assertCalendarDate(to);
  if (from > to) return [];
  const out: CalendarDate[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
