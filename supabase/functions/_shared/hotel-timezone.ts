/**
 * Espelho de src/lib/domain/yes-hotel/hotel-timezone.ts para a Edge (Deno).
 * Ao alterar regras, mantenha os dois arquivos alinhados.
 */

export const YES_HOTEL_TIMEZONE = "America/Campo_Grande";
export const YES_HOTEL_UTC_OFFSET_MINUTES = -240;
export const DEFAULT_CHECK_IN_HOUR = 13;
export const DEFAULT_CHECK_OUT_HOUR = 11;

export function extractYmd(value: string | Date): string {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Data invalida para extrair YMD: ${String(value)}`);
  }
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export function hotelLocalToUtcMs(
  ymd: string,
  hour: number,
  minute = 0,
  second = 0,
): number {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`YMD invalido (esperado YYYY-MM-DD): ${ymd}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    throw new Error(`Hora invalida: ${hour}`);
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    throw new Error(`Minuto invalido: ${minute}`);
  }
  const asIfUtc = Date.UTC(y, mo - 1, d, hour, minute, second, 0);
  return asIfUtc - YES_HOTEL_UTC_OFFSET_MINUTES * 60 * 1000;
}

export function hotelLocalToUtcIso(
  ymd: string,
  hour: number,
  minute = 0,
  second = 0,
): string {
  return new Date(hotelLocalToUtcMs(ymd, hour, minute, second)).toISOString();
}

export function resolveDefaultCredentialValidityIso(
  checkIn: string | Date,
  checkOut: string | Date,
): { valido_de: string; valido_ate: string } {
  const checkInYmd = extractYmd(checkIn);
  const checkOutYmd = extractYmd(checkOut);
  let validoDeMs = hotelLocalToUtcMs(checkInYmd, DEFAULT_CHECK_IN_HOUR);
  let validoAteMs = hotelLocalToUtcMs(checkOutYmd, DEFAULT_CHECK_OUT_HOUR);
  if (validoAteMs < validoDeMs) {
    validoAteMs = validoDeMs + 24 * 60 * 60 * 1000;
  }
  return {
    valido_de: new Date(validoDeMs).toISOString(),
    valido_ate: new Date(validoAteMs).toISOString(),
  };
}

export function validityIsoToTtlockMs(validoDeIso: string, validoAteIso: string): {
  startDateMs: number;
  endDateMs: number;
} {
  const startDateMs = new Date(validoDeIso).getTime();
  const endDateMs = new Date(validoAteIso).getTime();
  if (Number.isNaN(startDateMs) || Number.isNaN(endDateMs)) {
    throw new Error("valido_de/valido_ate ISO invalidos.");
  }
  if (endDateMs <= startDateMs) {
    throw new Error("valido_ate deve ser posterior a valido_de.");
  }
  return { startDateMs, endDateMs };
}
