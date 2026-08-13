/**
 * Unicidade global de PIN TTLock por fechadura.
 *
 * REGRA: enquanto o keyboardPwd existir na fechadura, o PIN está ocupado —
 * independente de validade, status temporal, ativa/inativa, passada/futura.
 *
 * Fonte local: PINs conhecidos no banco associados aos locks obrigatórios.
 * TTLock (-3007) continua autoridade final.
 */

/** Status de item em que o PIN ainda pode existir na fechadura (conservador). */
const ITEM_STATUSES_PIN_MAY_EXIST_ON_LOCK = new Set([
  "pendente",
  "provisionando",
  "provisionado",
  "falhou",
  "pendente_limpeza",
]);

export type OccupiedPasscodeSourceRow = {
  credencial_id: string;
  codigo_credencial: string | null;
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | string | null;
};

/**
 * True se o item indica que o PIN ainda pode estar cadastrado na TTLock.
 * `revogado` com delete remoto confirmado NÃO ocupa (histórico no banco pode permanecer).
 */
export function itemMayStillHoldPasscodeOnLock(row: {
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | string | null;
}): boolean {
  const st = String(row.status_provisionamento ?? "").trim();
  if (st === "revogado") return false;
  if (ITEM_STATUSES_PIN_MAY_EXIST_ON_LOCK.has(st)) return true;
  // Conservador: remote id sem status conhecido → ocupa.
  if (row.remote_keyboard_pwd_id != null && row.remote_keyboard_pwd_id !== "") return true;
  return false;
}

/**
 * Coleta PINs ocupados a partir de linhas (credencial + item) nos locks alvo.
 * Não filtra por validade, check-in/out, ativa/inativa ou período.
 */
export function collectOccupiedPasscodesFromRows(
  rows: OccupiedPasscodeSourceRow[],
  excludeCredencialId: string,
): Set<string> {
  const out = new Set<string>();
  const exclude = String(excludeCredencialId ?? "").trim();
  for (const row of rows) {
    const cid = String(row.credencial_id ?? "").trim();
    if (!cid || (exclude && cid === exclude)) continue;
    if (!itemMayStillHoldPasscodeOnLock(row)) continue;
    const pin = String(row.codigo_credencial ?? "").trim();
    if (pin) out.add(pin);
  }
  return out;
}

/**
 * Após -3007 em qualquer lock: se houve aceites parciais do mesmo candidato,
 * é obrigatório compensar (rollback) antes de tentar outro PIN.
 */
export function shouldRollbackPartialPasscodeAttempt(input: {
  collisionOnAnyLock: boolean;
  provisionedInRound: number;
  credentialNeverFullyProvisioned: boolean;
}): boolean {
  return (
    input.collisionOnAnyLock &&
    input.provisionedInRound > 0 &&
    input.credentialNeverFullyProvisioned
  );
}

/**
 * Pode tentar novo PIN após colisão (com ou sem rollback bem-sucedido dos parciais).
 */
export function canRetryWithNewPasscode(input: {
  collisionOnAnyLock: boolean;
  credentialNeverFullyProvisioned: boolean;
  collisionAttempt: number;
  maxAttempts: number;
  rollbackFailed: boolean;
}): boolean {
  if (input.rollbackFailed) return false;
  if (!input.collisionOnAnyLock) return false;
  if (!input.credentialNeverFullyProvisioned) return false;
  return input.collisionAttempt < input.maxAttempts - 1;
}
