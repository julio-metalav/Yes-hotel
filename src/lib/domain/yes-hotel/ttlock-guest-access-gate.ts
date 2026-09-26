/**
 * Gate: guest_access_ready só após provisioning TTLock confirmado.
 * Portões sozinhos não bastam: tem de haver uma porta de apartamento ativa.
 */

import { canonicalApartmentCode } from "./hits-room-change.ts";

export type TtlockItemReadyRow = {
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | string | null;
  tipo_destino?: string | null;
  codigo_logico_destino?: string | null;
  logical_destination?: string | null;
};

export type TtlockReadyOptions = {
  /** Quando conhecido, a porta ativa precisa ser a deste apartamento (APT-NN). */
  apartamentoAtual?: string | null;
};

export type TtlockCredentialReadyRow = {
  status: string;
  codigo_credencial: string | null;
};

export type TtlockGuestAccessGateResult = {
  ready: boolean;
  passcode: string | null;
  reason: string | null;
};

function logicalDestination(item: TtlockItemReadyRow): string {
  return String(item.codigo_logico_destino ?? item.logical_destination ?? "").trim();
}

function hasDestinationContext(itens: TtlockItemReadyRow[]): boolean {
  return itens.some((item) => String(item.tipo_destino ?? "").trim() !== "" || logicalDestination(item) !== "");
}

function isApartmentDestination(item: TtlockItemReadyRow): boolean {
  if (String(item.tipo_destino ?? "").trim().toLowerCase() === "apartamento") return true;
  return /^APT-\d+/i.test(logicalDestination(item));
}

function isProvisionedWithRemote(item: TtlockItemReadyRow): boolean {
  return (
    item.status_provisionamento === "provisionado" &&
    item.remote_keyboard_pwd_id != null &&
    item.remote_keyboard_pwd_id !== ""
  );
}

/**
 * Uma credencial com destino conhecido só está pronta com exatamente uma porta
 * de apartamento ativa, provisionada e com id remoto. Itens revogados não contam.
 * Sem tipo/código nos itens, o critério antigo (todos os ativos prontos) permanece.
 */
export function apartmentDoorIsReady(
  itens: TtlockItemReadyRow[] | null | undefined,
  options?: TtlockReadyOptions,
): boolean {
  const all = Array.isArray(itens) ? itens : [];
  if (!hasDestinationContext(all)) return true;
  const activeDoors = all.filter(
    (item) => item.status_provisionamento !== "revogado" && isApartmentDestination(item),
  );
  if (activeDoors.length !== 1) return false;
  const door = activeDoors[0]!;
  if (!isProvisionedWithRemote(door)) return false;
  const expected = canonicalApartmentCode(options?.apartamentoAtual);
  if (!expected) return true;
  const match = /^APT-(\d+)/i.exec(logicalDestination(door));
  if (!match) return true;
  return canonicalApartmentCode(match[1]) === expected;
}

export function evaluateTtlockReadyForGuestAccess(
  credencial: TtlockCredentialReadyRow | null | undefined,
  itens: TtlockItemReadyRow[] | null | undefined,
  options?: TtlockReadyOptions,
): TtlockGuestAccessGateResult {
  if (!credencial) {
    return { ready: false, passcode: null, reason: "credencial_ausente" };
  }
  const passcodeStored =
    credencial.codigo_credencial != null && String(credencial.codigo_credencial).trim()
      ? String(credencial.codigo_credencial).trim()
      : null;

  if (credencial.status !== "provisionada") {
    return {
      ready: false,
      passcode: passcodeStored,
      reason: `status_${String(credencial.status || "desconhecido")}`,
    };
  }

  const list = (Array.isArray(itens) ? itens : []).filter(
    (item) => item.status_provisionamento !== "revogado",
  );
  if (list.length === 0) {
    return { ready: false, passcode: passcodeStored, reason: "sem_itens_ttlock" };
  }

  for (const item of list) {
    if (item.status_provisionamento !== "provisionado") {
      return { ready: false, passcode: passcodeStored, reason: "item_nao_provisionado" };
    }
    if (item.remote_keyboard_pwd_id == null || item.remote_keyboard_pwd_id === "") {
      return {
        ready: false,
        passcode: passcodeStored,
        reason: "remote_keyboard_pwd_id_ausente",
      };
    }
  }

  if (!apartmentDoorIsReady(itens, options)) {
    return { ready: false, passcode: passcodeStored, reason: "sem_porta_apartamento" };
  }

  if (!passcodeStored) {
    return { ready: false, passcode: null, reason: "codigo_credencial_ausente" };
  }

  return { ready: true, passcode: passcodeStored, reason: null };
}

/** Resposta de lifecycle_provision tratada como acesso pronto. */
export function isLifecycleProvisionAccessReady(payload: {
  ok?: boolean;
  status?: string | null;
  falhas?: number | null;
}): boolean {
  return (
    payload.ok === true &&
    payload.status === "provisionada" &&
    (payload.falhas == null || Number(payload.falhas) === 0)
  );
}

/**
 * Após tentativa de provisionamento, credencial só fica `provisionada` se TODOS
 * os itens obrigatórios estiverem provisionados com remote id.
 * Itens ainda `pendente`/`provisionando` → status `provisionando` (retry em andamento).
 */
export function resolveProvisionCredentialStatus(itens: TtlockItemReadyRow[], options?: TtlockReadyOptions): {
  status: "provisionada" | "provisionando" | "parcial" | "falhou";
  provisionados: number;
  falhas: number;
  allReady: boolean;
  inProgress: number;
} {
  const list = (Array.isArray(itens) ? itens : []).filter(
    (item) => item.status_provisionamento !== "revogado",
  );
  let provisionados = 0;
  let falhas = 0;
  let inProgress = 0;
  for (const item of list) {
    if (
      item.status_provisionamento === "provisionado" &&
      item.remote_keyboard_pwd_id != null &&
      item.remote_keyboard_pwd_id !== ""
    ) {
      provisionados++;
    } else if (
      item.status_provisionamento === "pendente" ||
      item.status_provisionamento === "provisionando"
    ) {
      inProgress++;
    } else if (item.status_provisionamento === "falhou") {
      falhas++;
    } else if (item.status_provisionamento !== "provisionado") {
      falhas++;
    } else {
      // provisionado sem remote id = não pronto
      falhas++;
    }
  }
  const locksReady = list.length > 0 && provisionados === list.length && falhas === 0 && inProgress === 0;
  const allReady = locksReady && apartmentDoorIsReady(itens, options);
  let status: "provisionada" | "provisionando" | "parcial" | "falhou" = "falhou";
  if (allReady) status = "provisionada";
  else if (inProgress > 0) status = "provisionando";
  else if (provisionados > 0) status = "parcial";
  return { status, provisionados, falhas, allReady, inProgress };
}

/** sync_status coerente com o status operacional. `parcial` não permanece `ok`. */
export function syncStatusForProvisionResult(
  status: "provisionada" | "provisionando" | "parcial" | "falhou",
): "ok" | "pending" | "partial" | "failed" {
  if (status === "provisionada") return "ok";
  if (status === "provisionando") return "pending";
  if (status === "parcial") return "partial";
  return "failed";
}
