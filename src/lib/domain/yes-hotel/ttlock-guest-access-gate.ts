/**
 * Gate: guest_access_ready só após provisioning TTLock confirmado (3/3 locks).
 */

export type TtlockItemReadyRow = {
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | string | null;
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

/**
 * Credencial pronta para comunicação de acesso ao hóspede:
 * - status === provisionada
 * - todos os itens provisionados
 * - remote_keyboard_pwd_id presente em cada item
 */
export function evaluateTtlockReadyForGuestAccess(
  credencial: TtlockCredentialReadyRow | null | undefined,
  itens: TtlockItemReadyRow[] | null | undefined,
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

  const list = Array.isArray(itens) ? itens : [];
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
 */
export function resolveProvisionCredentialStatus(itens: TtlockItemReadyRow[]): {
  status: "provisionada" | "parcial" | "falhou";
  provisionados: number;
  falhas: number;
  allReady: boolean;
} {
  const list = Array.isArray(itens) ? itens : [];
  let provisionados = 0;
  let falhas = 0;
  for (const item of list) {
    if (
      item.status_provisionamento === "provisionado" &&
      item.remote_keyboard_pwd_id != null &&
      item.remote_keyboard_pwd_id !== ""
    ) {
      provisionados++;
    } else if (item.status_provisionamento === "falhou") {
      falhas++;
    } else if (item.status_provisionamento !== "provisionado") {
      falhas++;
    } else {
      // provisionado sem remote id = não pronto
      falhas++;
    }
  }
  const allReady = list.length > 0 && provisionados === list.length && falhas === 0;
  let status: "provisionada" | "parcial" | "falhou" = "falhou";
  if (allReady) status = "provisionada";
  else if (provisionados > 0) status = "parcial";
  return { status, provisionados, falhas, allReady };
}
