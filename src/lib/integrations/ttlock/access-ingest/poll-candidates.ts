/**
 * Locks de apartamento que já têm credencial provisionada e acesso liberado,
 * mesmo quando `valido_de` ainda está no futuro (antes das 13h).
 * A RPC vigente exige a janela já aberta e por isso não vê a abertura da manhã.
 */

export type BroaderPollCandidateInput = {
  lock_id_ttlock: string;
  codigo_logico_destino: string;
  credential_status: string;
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
    if (row.acesso_liberado !== true) continue;
    if (row.entrou_no_apto === true) continue;
    const until = Date.parse(String(row.valido_ate ?? ""));
    if (!Number.isFinite(until) || until < nowMs) continue;
    if (!/^[0-9]+$/.test(String(row.lock_id_ttlock ?? ""))) continue;
    const lockId = Number(row.lock_id_ttlock);
    if (Number.isInteger(lockId) && lockId > 0) ids.add(lockId);
  }
  return [...ids].sort((a, b) => a - b);
}

export function mergePollCandidateLockIds(rpcIds: number[], broaderIds: number[]): number[] {
  return [...new Set([...rpcIds, ...broaderIds])].sort((a, b) => a - b);
}
