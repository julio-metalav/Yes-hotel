/**
 * Horário operacional de um registro TTLock.
 * lockDate e serverDate já são epoch em milissegundos. Não aplicar fuso de novo.
 *
 * Inconsistente só quando o dia civil do relógio da fechadura diverge do dia
 * civil da nuvem, com mais de 5 minutos de diferença, ou quando lockDate está
 * mais de 5 minutos à frente da referência. Atraso curto de upload permanece
 * no lockDate.
 */

import { hotelCivilYmdFromUtcMs } from "./hotel-timezone.ts";

export const TTLOCK_LOCK_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type TtlockRecordTimeDiagnostic =
  | "lock_date"
  | "server_date_clock_skew"
  | "received_at_clock_skew";

export type TtlockRecordTimeResolution = {
  occurredAtMs: number;
  rawLockDateMs: number;
  rawServerDateMs: number | null;
  usedFallback: boolean;
  diagnostic: TtlockRecordTimeDiagnostic;
};

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function notAheadOfReceipt(ms: number, receivedAtMs: number): boolean {
  return ms <= receivedAtMs + TTLOCK_LOCK_CLOCK_SKEW_TOLERANCE_MS;
}

export function resolveTtlockRecordOccurredAt(input: {
  lockDateMs: number;
  serverDateMs?: number | null;
  receivedAtMs: number;
}): TtlockRecordTimeResolution {
  const lockDateMs = input.lockDateMs;
  const serverDateMs = finiteOrNull(input.serverDateMs);
  const receivedAtMs = input.receivedAtMs;
  const referenceMs = serverDateMs ?? receivedAtMs;
  const dayMismatch =
    serverDateMs != null &&
    Math.abs(serverDateMs - lockDateMs) > TTLOCK_LOCK_CLOCK_SKEW_TOLERANCE_MS &&
    hotelCivilYmdFromUtcMs(lockDateMs) !== hotelCivilYmdFromUtcMs(serverDateMs);
  const lockAhead = lockDateMs > referenceMs + TTLOCK_LOCK_CLOCK_SKEW_TOLERANCE_MS;
  const inconsistent = dayMismatch || lockAhead;

  if (!inconsistent) {
    return {
      occurredAtMs: lockDateMs,
      rawLockDateMs: lockDateMs,
      rawServerDateMs: serverDateMs,
      usedFallback: false,
      diagnostic: "lock_date",
    };
  }

  if (serverDateMs != null && notAheadOfReceipt(serverDateMs, receivedAtMs)) {
    return {
      occurredAtMs: serverDateMs,
      rawLockDateMs: lockDateMs,
      rawServerDateMs: serverDateMs,
      usedFallback: true,
      diagnostic: "server_date_clock_skew",
    };
  }

  return {
    occurredAtMs: receivedAtMs,
    rawLockDateMs: lockDateMs,
    rawServerDateMs: serverDateMs,
    usedFallback: true,
    diagnostic: "received_at_clock_skew",
  };
}
