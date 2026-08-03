/**
 * Fuso operacional do Yes Hotel e conversão civil → UTC para TTLock.
 *
 * America/Campo_Grande = UTC−04:00 o ano todo (sem horário de verão).
 * A API TTLock espera startDate/endDate em milissegundos Unix (UTC absoluto).
 * O app exibe esses instantes no fuso do dispositivo/conta — no hotel, Campo Grande.
 */

export const YES_HOTEL_TIMEZONE = "America/Campo_Grande";

/** Offset fixo de America/Campo_Grande em minutos a partir de UTC (sempre −240). */
export const YES_HOTEL_UTC_OFFSET_MINUTES = -240;

export const DEFAULT_CHECK_IN_HOUR = 13;
export const DEFAULT_CHECK_OUT_HOUR = 11;

/** Extrai YYYY-MM-DD de string/Date (prioriza prefixo civil da string). */
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

/**
 * Converte data civil + horário local do hotel em instante UTC (ms).
 * Ex.: 2026-08-08 13:00 Campo Grande → 2026-08-08T17:00:00.000Z.
 */
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
  // Interpreta (y,mo,d,h,m,s) como horário local CG e converte para UTC:
  // UTC = local − offset; offset = −240 ⇒ UTC = local + 4h.
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

/**
 * Janela padrão de credencial: check-in 13:00 e check-out 11:00 em America/Campo_Grande.
 */
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

/** Timestamps TTLock (ms) a partir da janela ISO UTC. */
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
