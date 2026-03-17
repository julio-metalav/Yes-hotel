/**
 * Executor de provisionamento TTLock (Fase TTLock 2).
 * Processa uma credencial: gera passcode (se necessário), chama TTLock por item,
 * atualiza status de itens e credencial.
 * Não depende do Supabase diretamente; o repositório é injetado.
 */

import { logTtlockLifecycle } from "../../integrations/ttlock";
import type { TtlockClient } from "../../integrations/ttlock";
import type { OperacionalCredencialStatus, OperacionalItemProvisionamentoStatus } from "./types";

/** Estado de sincronização com TTLock (Fase 3.1). */
export type SyncStatus = "ok" | "pending" | "partial" | "failed";

/** Credencial como lida do banco (mínimo necessário). */
export interface CredencialRow {
  id: string;
  reserva_id: string;
  status: OperacionalCredencialStatus;
  valido_de: string;
  valido_ate: string;
  codigo_credencial: string | null;
  provider_tipo: string | null;
  revogado_em?: string | null;
  motivo_revogacao?: string | null;
  sync_status?: SyncStatus | null;
  last_sync_attempt_at?: string | null;
  last_sync_error?: string | null;
}

/** Item de provisionamento como lido do banco. */
export interface CredencialItemRow {
  id: string;
  credencial_id: string;
  fechadura_id: string;
  lock_id_ttlock: string;
  tipo_destino: string;
  codigo_logico_destino: string;
  status_provisionamento: OperacionalItemProvisionamentoStatus;
  ultimo_erro: string | null;
  provisionado_em: string | null;
  revogado_em: string | null;
  remote_keyboard_pwd_id: number | null;
  codigo_enviado: string | null;
}

/** Destino de fechadura para inserção de novo item (ex.: room change). */
export interface NovoItemDestino {
  fechadura_id: string;
  lock_id_ttlock: string;
  tipo_destino: string;
  codigo_logico_destino: string;
}

export interface ProvisioningRepository {
  getCredencial(id: string): Promise<CredencialRow | null>;
  getCredencialPorReserva(reservaId: string): Promise<CredencialRow | null>;
  getCredenciaisPendentes(): Promise<CredencialRow[]>;
  getItens(credencialId: string): Promise<CredencialItemRow[]>;
  getItensPendentes(credencialId: string): Promise<CredencialItemRow[]>;
  getItensProvisionados(credencialId: string): Promise<CredencialItemRow[]>;
  getItensPendentesLimpeza(credencialId: string): Promise<CredencialItemRow[]>;
  insertItem(credencialId: string, destino: NovoItemDestino): Promise<CredencialItemRow>;
  updateCredencial(
    id: string,
    patch: Partial<
      Pick<
        CredencialRow,
        | "status"
        | "codigo_credencial"
        | "provider_tipo"
        | "valido_de"
        | "valido_ate"
        | "revogado_em"
        | "motivo_revogacao"
        | "sync_status"
        | "last_sync_attempt_at"
        | "last_sync_error"
      >
    >,
  ): Promise<void>;
  getCredenciaisComPendenciaSync(): Promise<CredencialRow[]>;
  updateItem(
    id: string,
    patch: Partial<{
      status_provisionamento: OperacionalItemProvisionamentoStatus;
      ultimo_erro: string | null;
      provisionado_em: string | null;
      revogado_em: string | null;
      remote_keyboard_pwd_id: number | null;
      codigo_enviado: string | null;
    }>,
  ): Promise<void>;
  getReservaApartment(reservaId: string): Promise<string | null>;
  getFechadurasForApartment(apartmentCode: string): Promise<NovoItemDestino[]>;
}

const PASSCODE_LENGTH = 6;
const PASSCODE_MIN = 10 ** (PASSCODE_LENGTH - 1);
const PASSCODE_MAX = 10 ** PASSCODE_LENGTH - 1;

/**
 * Gera um passcode numérico de 6 dígitos (pseudoaleatório).
 * Um único passcode por credencial, reutilizado em todos os itens.
 */
export function generateTemporaryPasscode(): string {
  const n = Math.floor(PASSCODE_MIN + Math.random() * (PASSCODE_MAX - PASSCODE_MIN + 1));
  return String(n).padStart(PASSCODE_LENGTH, "0");
}

export interface ProcessarCredencialResult {
  credencialId: string;
  status: OperacionalCredencialStatus;
  passcode: string | null;
  totalItens: number;
  provisionados: number;
  falhas: number;
  erros: string[];
}

/**
 * Processa uma credencial: gera passcode se necessário, provisiona cada item pendente na TTLock,
 * atualiza itens e credencial no repositório.
 * Se o cliente TTLock não estiver disponível (sem credenciais), falha de forma controlada
 * e atualiza itens/credencial com erro claro.
 */
export async function processarCredencialDeAcesso(
  credencialId: string,
  deps: {
    repository: ProvisioningRepository;
    ttlockClient: TtlockClient;
    passcodeGenerator?: () => string;
  },
): Promise<ProcessarCredencialResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;
  const genPasscode = deps.passcodeGenerator ?? generateTemporaryPasscode;

  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) {
    throw new Error(`Credencial nao encontrada: ${credencialId}`);
  }

  const itens = await repo.getItensPendentes(credencialId);
  const erros: string[] = [];

  let passcode = credencial.codigo_credencial;
  if (!passcode) {
    passcode = genPasscode();
    await repo.updateCredencial(credencialId, {
      codigo_credencial: passcode,
      provider_tipo: "ttlock_passcode",
    });
  }

  await repo.updateCredencial(credencialId, { status: "provisionando" });

  const validoDeMs = new Date(credencial.valido_de).getTime();
  const validoAteMs = new Date(credencial.valido_ate).getTime();
  let provisionados = 0;
  let falhas = 0;

  if (!client.isAvailable()) {
    const msg =
      "TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.";
    erros.push(msg);
    for (const item of itens) {
      await repo.updateItem(item.id, {
        status_provisionamento: "falhou",
        ultimo_erro: msg,
      });
      falhas++;
    }
    const statusFinal: OperacionalCredencialStatus = falhas === itens.length ? "falhou" : "parcial";
    await repo.updateCredencial(credencialId, { status: statusFinal });
    return {
      credencialId,
      status: statusFinal,
      passcode,
      totalItens: itens.length,
      provisionados: 0,
      falhas: itens.length,
      erros,
    };
  }

  for (const item of itens) {
    await repo.updateItem(item.id, { status_provisionamento: "provisionando" });

    logTtlockLifecycle({
      action: "provision",
      source: "app_client",
      reserva_id: credencial.reserva_id,
      credencial_id: credencialId,
      credencial_item_id: item.id,
      codigo_logico_destino: item.codigo_logico_destino,
      lock_id: item.lock_id_ttlock,
      status: "start",
      timestamp: new Date().toISOString(),
    });
    try {
      const lockId = item.lock_id_ttlock;
      const date = Date.now();
      const res = await client.createKeyboardPassword({
        lockId,
        keyboardPwd: passcode,
        keyboardPwdName: `Yes-${item.codigo_logico_destino}`,
        startDate: validoDeMs,
        endDate: validoAteMs,
      });

      await repo.updateItem(item.id, {
        status_provisionamento: "provisionado",
        provisionado_em: new Date().toISOString(),
        ultimo_erro: null,
        remote_keyboard_pwd_id: res.keyboardPwdId,
        codigo_enviado: passcode,
      });
      provisionados++;
      logTtlockLifecycle({
        action: "provision",
        source: "app_client",
        reserva_id: credencial.reserva_id,
        credencial_id: credencialId,
        credencial_item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        remote_keyboard_pwd_id: res.keyboardPwdId,
        lock_id: item.lock_id_ttlock,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros.push(`${item.codigo_logico_destino}: ${msg}`);
      await repo.updateItem(item.id, {
        status_provisionamento: "falhou",
        ultimo_erro: msg,
      });
      falhas++;
      logTtlockLifecycle({
        action: "provision",
        source: "app_client",
        reserva_id: credencial.reserva_id,
        credencial_id: credencialId,
        credencial_item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        lock_id: item.lock_id_ttlock,
        status: "error",
        error_message: msg,
        timestamp: new Date().toISOString(),
      });
    }
  }

  let statusFinal: OperacionalCredencialStatus = "provisionada";
  if (falhas > 0 && provisionados > 0) statusFinal = "parcial";
  else if (falhas === itens.length) statusFinal = "falhou";

  await repo.updateCredencial(credencialId, { status: statusFinal });

  return {
    credencialId,
    status: statusFinal,
    passcode,
    totalItens: itens.length,
    provisionados,
    falhas,
    erros,
  };
}

/**
 * Processa todas as credenciais pendentes (status = pendente).
 * Útil para script em lote ou rotina agendada.
 */
export async function processarProvisionamentosPendentes(deps: {
  repository: ProvisioningRepository;
  ttlockClient: TtlockClient;
  passcodeGenerator?: () => string;
}): Promise<ProcessarCredencialResult[]> {
  const credenciais = await deps.repository.getCredenciaisPendentes();
  const results: ProcessarCredencialResult[] = [];
  for (const c of credenciais) {
    const r = await processarCredencialDeAcesso(c.id, deps);
    results.push(r);
  }
  return results;
}
