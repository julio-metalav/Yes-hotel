/**
 * Orquestração pura da action lifecycle_update_validity (sem senha, sem Deno).
 * Ports injetáveis para testes e Edge.
 */

import {
  assertValidityMatchesReservationWindow,
  canCommitValidityToDatabase,
  isValidityAlreadyApplied,
  parseValidityIsoPair,
  rejectPasscodeFields,
  selectProvisionedItemsForValidityUpdate,
  type ProvisionedItemForValidity,
  type ValidityIsoPair,
  type ValidityItemResult,
} from "./lifecycle-update-validity-policy.ts";
import { validityIsoToTtlockMs } from "./hotel-timezone.ts";

export type UpdateValidityAuthInput = {
  hasBearerToken: boolean;
  userResolved: boolean;
  perfilUsuario: string | null;
  ativo: boolean;
};

export type UpdateValidityAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

/** Espelha ensureCallerAllowed (JWT + admin/recepção) sem I/O. */
export function evaluateUpdateValidityAuth(input: UpdateValidityAuthInput): UpdateValidityAuthResult {
  if (!input.hasBearerToken) {
    return { ok: false, status: 401, error: "Autenticação obrigatória." };
  }
  if (!input.userResolved) {
    return { ok: false, status: 401, error: "Sessão inválida ou expirada." };
  }
  if (!input.ativo || input.perfilUsuario == null) {
    return { ok: false, status: 403, error: "Usuário sem cadastro interno autorizado." };
  }
  const role = String(input.perfilUsuario).trim().toLowerCase();
  if (role !== "admin" && role !== "recepcao") {
    return { ok: false, status: 403, error: "Apenas admin ou recepção ativos podem executar esta ação." };
  }
  return { ok: true };
}

export type CredencialValidityRow = {
  id: string;
  reserva_id: string;
  status: string;
  valido_de: string;
  valido_ate: string;
  /** Nunca lido nem alterado por esta action; só para assert de invariante nos testes. */
  codigo_credencial?: string | null;
};

export type ReservaValidityContext = {
  check_in_previsto: string;
  check_out_previsto: string;
};

export type UpdateValidityPorts = {
  getCredencial(credencialId: string): Promise<CredencialValidityRow | null>;
  getItens(credencialId: string): Promise<ProvisionedItemForValidity[]>;
  getReserva(reservaId: string): Promise<ReservaValidityContext | null>;
  /** Altera só startDate/endDate no remoto; NÃO envia newKeyboardPwd. */
  changeItemValidity(input: {
    item: ProvisionedItemForValidity;
    startDateMs: number;
    endDateMs: number;
  }): Promise<void>;
  updateCredencialValidity(input: {
    credencialId: string;
    valido_de: string;
    valido_ate: string;
  }): Promise<void>;
};

export type UpdateValiditySuccess = {
  ok: true;
  idempotent?: boolean;
  credencial_id: string;
  valido_de: string;
  valido_ate: string;
  itens_atualizados: number;
  itens: ValidityItemResult[];
  database_updated: boolean;
};

export type UpdateValidityFailure = {
  ok: false;
  error: string;
  status: number;
  credencial_id?: string;
  itens_alterados?: ValidityItemResult[];
  itens_falha?: ValidityItemResult[];
  database_updated: false;
};

export type UpdateValidityResult = UpdateValiditySuccess | UpdateValidityFailure;

export async function executeLifecycleUpdateValidity(
  payload: Record<string, unknown>,
  ports: UpdateValidityPorts,
): Promise<UpdateValidityResult> {
  try {
    rejectPasscodeFields(payload);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status: 400,
      database_updated: false,
    };
  }

  const credencialId = String(payload.credencial_id ?? payload.credencialId ?? "").trim().toLowerCase();
  if (!credencialId) {
    return {
      ok: false,
      error: "credencial_id obrigatório.",
      status: 400,
      database_updated: false,
    };
  }

  let desired: ValidityIsoPair;
  try {
    desired = parseValidityIsoPair(payload.valido_de, payload.valido_ate);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status: 400,
      database_updated: false,
      credencial_id: credencialId,
    };
  }

  const credencial = await ports.getCredencial(credencialId);
  if (!credencial) {
    return {
      ok: false,
      error: "Credencial não encontrada.",
      status: 404,
      credencial_id: credencialId,
      database_updated: false,
    };
  }

  if (credencial.status === "revogada") {
    return {
      ok: false,
      error: "Não é possível alterar validade de credencial revogada.",
      status: 400,
      credencial_id: credencial.id,
      database_updated: false,
    };
  }

  const reserva = await ports.getReserva(credencial.reserva_id);
  if (!reserva?.check_in_previsto || !reserva?.check_out_previsto) {
    return {
      ok: false,
      error: "Reserva da credencial sem check_in_previsto/check_out_previsto.",
      status: 400,
      credencial_id: credencial.id,
      database_updated: false,
    };
  }

  try {
    assertValidityMatchesReservationWindow(
      reserva.check_in_previsto,
      reserva.check_out_previsto,
      desired,
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status: 400,
      credencial_id: credencial.id,
      database_updated: false,
    };
  }

  const itens = await ports.getItens(credencial.id);
  const { ok: eligible, errors: itemErrors } = selectProvisionedItemsForValidityUpdate(itens);
  if (eligible.length === 0) {
    return {
      ok: false,
      error:
        "Nenhum item provisionado com lock_id e remote_keyboard_pwd_id." +
        (itemErrors.length ? " " + itemErrors.join("; ") : ""),
      status: 400,
      credencial_id: credencial.id,
      database_updated: false,
    };
  }
  if (itemErrors.length > 0) {
    return {
      ok: false,
      error: "Itens inválidos para atualização de validade: " + itemErrors.join("; "),
      status: 400,
      credencial_id: credencial.id,
      database_updated: false,
    };
  }

  if (isValidityAlreadyApplied(credencial.valido_de, credencial.valido_ate, desired)) {
    return {
      ok: true,
      idempotent: true,
      credencial_id: credencial.id,
      valido_de: desired.valido_de,
      valido_ate: desired.valido_ate,
      itens_atualizados: 0,
      itens: eligible.map((item) => ({
        item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        remote_keyboard_pwd_id: item.remote_keyboard_pwd_id!,
        lock_id: String(item.lock_id_ttlock),
        ok: true,
      })),
      database_updated: false,
    };
  }

  const { startDateMs, endDateMs } = validityIsoToTtlockMs(desired.valido_de, desired.valido_ate);
  const results: ValidityItemResult[] = [];

  for (const item of eligible) {
    try {
      await ports.changeItemValidity({
        item,
        startDateMs,
        endDateMs,
      });
      results.push({
        item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        remote_keyboard_pwd_id: item.remote_keyboard_pwd_id!,
        lock_id: String(item.lock_id_ttlock),
        ok: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        remote_keyboard_pwd_id: item.remote_keyboard_pwd_id!,
        lock_id: String(item.lock_id_ttlock),
        ok: false,
        error: msg,
      });
      // Continua para reportar quais falharam; não marca banco.
    }
  }

  if (!canCommitValidityToDatabase(results)) {
    const alterados = results.filter((r) => r.ok);
    const falhas = results.filter((r) => !r.ok);
    return {
      ok: false,
      error:
        "Falha parcial ao atualizar validade remota. Banco não foi alterado. " +
        falhas.map((f) => `${f.codigo_logico_destino}: ${f.error ?? "erro"}`).join("; "),
      status: 502,
      credencial_id: credencial.id,
      itens_alterados: alterados,
      itens_falha: falhas,
      database_updated: false,
    };
  }

  await ports.updateCredencialValidity({
    credencialId: credencial.id,
    valido_de: desired.valido_de,
    valido_ate: desired.valido_ate,
  });

  return {
    ok: true,
    credencial_id: credencial.id,
    valido_de: desired.valido_de,
    valido_ate: desired.valido_ate,
    itens_atualizados: results.length,
    itens: results,
    database_updated: true,
  };
}
