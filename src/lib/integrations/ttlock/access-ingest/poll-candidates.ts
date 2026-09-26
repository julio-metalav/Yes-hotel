/**
 * Locks de apartamento com credencial provisionada e estadia ainda vigente.
 * A RPC exige acesso liberado e valido_de já aberto, e por isso não vê
 * a abertura da manhã no dia da chegada.
 */

import { hotelCivilYmdFromUtcMs } from "../../../domain/yes-hotel/hotel-timezone.ts";

export type BroaderPollCandidateInput = {
  lock_id_ttlock: string;
  codigo_logico_destino: string;
  credential_status: string;
  valido_de?: string | null;
  valido_ate: string | null;
  acesso_liberado: boolean;
  entrou_no_apto: boolean;
};

export function broaderPollCandidateLockIds(
  rows: BroaderPollCandidateInput[],
  nowMs: number,
): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const dest = String(row.codigo_logico_destino ?? "").trim().toUpperCase();
    if (!dest.startsWith("APT-") && !dest.startsWith("APTO-")) continue;
    if (String(row.credential_status ?? "").toLowerCase() !== "provisionada") continue;
    if (row.entrou_no_apto === true) continue;
    if (row.acesso_liberado !== true && !isArrivalDay(row.valido_de, nowMs)) continue;
    const until = Date.parse(String(row.valido_ate ?? ""));
    if (!Number.isFinite(until) || until < nowMs) continue;
    if (!/^[0-9]+$/.test(String(row.lock_id_ttlock ?? ""))) continue;
    const lockId = Number(row.lock_id_ttlock);
    if (Number.isInteger(lockId) && lockId > 0) ids.add(lockId);
  }
  return [...ids].sort((a, b) => a - b);
}

function isArrivalDay(validFrom: string | null | undefined, nowMs: number): boolean {
  const from = Date.parse(String(validFrom ?? ""));
  if (!Number.isFinite(from)) return false;
  return hotelCivilYmdFromUtcMs(from) === hotelCivilYmdFromUtcMs(nowMs);
}

export function mergePollCandidateLockIds(rpcIds: number[], broaderIds: number[]): number[] {
  return [...new Set([...rpcIds, ...broaderIds])].sort((a, b) => a - b);
}
