/**
 * Data operacional do Café da manhã no fuso do hotel.
 * Até 11:59 → café do próprio dia; a partir de 12:00 → café do dia seguinte.
 */

import { YES_HOTEL_TIMEZONE } from "./hotel-timezone.ts";

export const CAFE_OPERATIONAL_ROLLOVER_HOUR = 12;

export type CafeDateMode = "auto" | "manual";

export type CafeDateHeaderKind = "hoje" | "amanha" | "consulta";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Partes civis (ano/mês/dia/hora/minuto) no fuso do hotel. */
export function hotelLocalParts(
  now: Date = new Date(),
  timeZone: string = YES_HOTEL_TIMEZONE,
): { ymd: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    ymd,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export function addDaysYmd(ymd: string, days: number): string {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`YMD invalido: ${ymd}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * Data do café automática no fuso do hotel.
 * Ex.: 08/08 11:59 → 08/08; 08/08 12:00 → 09/08.
 */
export function resolveCafeOperationalDateYmd(
  now: Date = new Date(),
  timeZone: string = YES_HOTEL_TIMEZONE,
): string {
  const { ymd, hour } = hotelLocalParts(now, timeZone);
  if (hour >= CAFE_OPERATIONAL_ROLLOVER_HOUR) {
    return addDaysYmd(ymd, 1);
  }
  return ymd;
}

/** Data civil "hoje" no hotel (não confundir com data operacional do café). */
export function hotelTodayYmd(
  now: Date = new Date(),
  timeZone: string = YES_HOTEL_TIMEZONE,
): string {
  return hotelLocalParts(now, timeZone).ymd;
}

export function formatCafeDateBr(ymd: string): string {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function resolveCafeDateHeader(
  selectedYmd: string,
  now: Date = new Date(),
  timeZone: string = YES_HOTEL_TIMEZONE,
): { kind: CafeDateHeaderKind; label: string } {
  const today = hotelTodayYmd(now, timeZone);
  const tomorrow = addDaysYmd(today, 1);
  const br = formatCafeDateBr(selectedYmd);
  if (selectedYmd === today) {
    return { kind: "hoje", label: `Café de hoje — ${br}` };
  }
  if (selectedYmd === tomorrow) {
    return { kind: "amanha", label: `Café de amanhã — ${br}` };
  }
  return { kind: "consulta", label: `Consulta — ${br}` };
}

/** Atendimento só é permitido na data do café que já chegou (não futura). */
export function canRegisterCafeAttendanceForDate(
  cafeDateYmd: string,
  now: Date = new Date(),
  timeZone: string = YES_HOTEL_TIMEZONE,
): boolean {
  const today = hotelTodayYmd(now, timeZone);
  return cafeDateYmd <= today;
}

/**
 * Seleção efetiva da tela:
 * - modo auto: segue a data operacional (vira sozinha às 12h e na virada do dia);
 * - modo manual: congela a escolha do usuário.
 */
export function resolveSelectedCafeDateYmd(input: {
  mode: CafeDateMode;
  manualYmd: string | null;
  now?: Date;
  timeZone?: string;
}): string {
  if (input.mode === "manual" && input.manualYmd) {
    return String(input.manualYmd).slice(0, 10);
  }
  return resolveCafeOperationalDateYmd(input.now, input.timeZone);
}
