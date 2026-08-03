/**
 * Regras puras da action lifecycle_update_validity (testáveis sem Deno/TTLock).
 */

import {
  resolveDefaultCredentialValidityIso,
  validityIsoToTtlockMs,
} from "./hotel-timezone.ts";

const FORBIDDEN_PASSCODE_KEYS = [
  "passcode",
  "password",
  "senha",
  "keyboardPwd",
  "keyboard_pwd",
  "newKeyboardPwd",
  "new_keyboard_pwd",
  "codigo_credencial",
] as const;

export type ValidityIsoPair = { valido_de: string; valido_ate: string };

export function rejectPasscodeFields(payload: Record<string, unknown>): void {
  for (const key of FORBIDDEN_PASSCODE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] != null && payload[key] !== "") {
      throw new Error("Payload não pode incluir senha/passcode. Informe apenas credencial_id, valido_de e valido_ate.");
    }
  }
}

export function parseValidityIsoPair(validoDeRaw: unknown, validoAteRaw: unknown): ValidityIsoPair {
  const valido_de = String(validoDeRaw ?? "").trim();
  const valido_ate = String(validoAteRaw ?? "").trim();
  if (!valido_de || !valido_ate) {
    throw new Error("valido_de e valido_ate são obrigatórios (ISO UTC).");
  }
  const { startDateMs, endDateMs } = validityIsoToTtlockMs(valido_de, valido_ate);
  return {
    valido_de: new Date(startDateMs).toISOString(),
    valido_ate: new Date(endDateMs).toISOString(),
  };
}

/**
 * Exige que a janela seja exatamente a padrão do hotel
 * (check-in 13:00 / check-out 11:00 America/Campo_Grande).
 */
export function assertValidityMatchesReservationWindow(
  checkIn: string | Date,
  checkOut: string | Date,
  desired: ValidityIsoPair,
): void {
  const expected = resolveDefaultCredentialValidityIso(checkIn, checkOut);
  const deOk = new Date(desired.valido_de).getTime() === new Date(expected.valido_de).getTime();
  const ateOk = new Date(desired.valido_ate).getTime() === new Date(expected.valido_ate).getTime();
  if (!deOk || !ateOk) {
    throw new Error(
      "Janela informada não coincide com check-in 13:00 / check-out 11:00 America/Campo_Grande da reserva.",
    );
  }
}

export function isValidityAlreadyApplied(
  storedDe: string,
  storedAte: string,
  desired: ValidityIsoPair,
): boolean {
  return (
    new Date(storedDe).getTime() === new Date(desired.valido_de).getTime() &&
    new Date(storedAte).getTime() === new Date(desired.valido_ate).getTime()
  );
}

export type ProvisionedItemForValidity = {
  id: string;
  codigo_logico_destino: string;
  lock_id_ttlock: string | number | null;
  remote_keyboard_pwd_id: number | null;
  status_provisionamento: string;
};

export function selectProvisionedItemsForValidityUpdate(
  itens: ProvisionedItemForValidity[],
): { ok: ProvisionedItemForValidity[]; errors: string[] } {
  const errors: string[] = [];
  const ok: ProvisionedItemForValidity[] = [];
  for (const item of itens) {
    if (item.status_provisionamento !== "provisionado") {
      errors.push(`${item.codigo_logico_destino}: status_provisionamento=${item.status_provisionamento}`);
      continue;
    }
    if (item.lock_id_ttlock == null || String(item.lock_id_ttlock).trim() === "") {
      errors.push(`${item.codigo_logico_destino}: sem lock_id_ttlock`);
      continue;
    }
    if (item.remote_keyboard_pwd_id == null) {
      errors.push(`${item.codigo_logico_destino}: sem remote_keyboard_pwd_id`);
      continue;
    }
    ok.push(item);
  }
  return { ok, errors };
}

export type ValidityItemResult = {
  item_id: string;
  codigo_logico_destino: string;
  remote_keyboard_pwd_id: number;
  lock_id: string;
  ok: boolean;
  error?: string;
};

/**
 * Decide se o banco pode ser atualizado: somente se todos os updates remotos ok.
 */
export function canCommitValidityToDatabase(results: ValidityItemResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}
