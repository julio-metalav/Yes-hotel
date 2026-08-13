/**
 * Executor de provisionamento TTLock (Fase TTLock 2).
 * Processa uma credencial: gera passcode (se necessário), chama TTLock por item,
 * atualiza status de itens e credencial.
 * Não depende do Supabase diretamente; o repositório é injetado.
 */

import {
  allocateNewTtlockPasscode,
  formatTtlockKeyboardPwdName,
  isTtlockSamePasscodeError,
  TTLOCK_PASSCODE_COLLISION_RETRY_MAX,
} from "../../domain/yes-hotel/ttlock-credential-format.ts";
import { resolveProvisionCredentialStatus } from "../../domain/yes-hotel/ttlock-guest-access-gate.ts";
import {
  canRetryWithNewPasscode,
  shouldRollbackPartialPasscodeAttempt,
} from "../../domain/yes-hotel/ttlock-passcode-uniqueness.ts";
import type { TtlockClient } from "../../integrations/ttlock/client.ts";
import { logTtlockLifecycle } from "../../integrations/ttlock/lifecycle-log.ts";
import type { OperacionalCredencialStatus, OperacionalItemProvisionamentoStatus } from "./types.ts";

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

/** Dados da reserva para senha/nome TTLock (origem externa + hóspede; sem acoplamento a PMS). */
export type ReservaTtlockCredentialSource = {
  reserva_id: string;
  apartamento: string | null;
  external_reservation_id: string | null;
  principal_guest_nome: string | null;
  hospede_principal: string | null;
};

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
  getReservaTtlockCredentialSource(reservaId: string): Promise<ReservaTtlockCredentialSource>;
  /**
   * PINs ocupados nos locks (existência na fechadura / risco de -3007).
   * Sem filtro temporal. Preferir implementação conservadora.
   */
  listOccupiedPasscodesOnLocks?(
    lockIds: string[],
    excludeCredencialId: string,
  ): Promise<string[]>;
  /** @deprecated use listOccupiedPasscodesOnLocks */
  listActivePasscodesOnLocks?(
    lockIds: string[],
    excludeCredencialId: string,
  ): Promise<string[]>;
}

export interface ProcessarCredencialResult {
  credencialId: string;
  status: OperacionalCredencialStatus;
  passcode: string | null;
  totalItens: number;
  provisionados: number;
  falhas: number;
  erros: string[];
  /** true somente quando todos os itens obrigatórios estão provisionados com remote id. */
  accessReady: boolean;
  rollbackFailed?: boolean;
}

function itemNeedsProvision(item: CredencialItemRow): boolean {
  if (item.status_provisionamento === "pendente") return true;
  if (
    item.status_provisionamento === "falhou" &&
    item.remote_keyboard_pwd_id == null
  ) {
    return true;
  }
  return false;
}

function hasSuccessfulRemote(itens: CredencialItemRow[]): boolean {
  return itens.some(
    (i) =>
      i.status_provisionamento === "provisionado" && i.remote_keyboard_pwd_id != null,
  );
}

async function loadOccupiedPasscodes(
  repo: ProvisioningRepository,
  lockIds: string[],
  excludeCredencialId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const loader =
    repo.listOccupiedPasscodesOnLocks?.bind(repo) ??
    repo.listActivePasscodesOnLocks?.bind(repo);
  if (!loader || lockIds.length === 0) return out;
  const active = await loader(lockIds, excludeCredencialId);
  for (const p of active) {
    const s = String(p ?? "").trim();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Processa uma credencial: gera passcode se necessário, provisiona cada item pendente na TTLock,
 * atualiza itens e credencial no repositório.
 * Colisão (-3007) em qualquer lock: não segue com o mesmo PIN; compensa parciais; novo PIN nos 3.
 */
export async function processarCredencialDeAcesso(
  credencialId: string,
  deps: {
    repository: ProvisioningRepository;
    ttlockClient: TtlockClient;
    passcodeGenerator?: (exclude?: string | null | Iterable<string>) => string;
  },
): Promise<ProcessarCredencialResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;

  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) {
    throw new Error(`Credencial nao encontrada: ${credencialId}`);
  }

  const ttlockSrc = await repo.getReservaTtlockCredentialSource(credencial.reserva_id);
  const keyboardPwdNameBase = formatTtlockKeyboardPwdName(
    ttlockSrc.apartamento,
    ttlockSrc.principal_guest_nome ?? ttlockSrc.hospede_principal,
  );

  const allItens = await repo.getItens(credencialId);
  const erros: string[] = [];
  const alreadyRemoteOk = hasSuccessfulRemote(allItens);
  const rejectedPins = new Set<string>();

  const lockIds = [
    ...new Set(allItens.map((i) => String(i.lock_id_ttlock || "").trim()).filter(Boolean)),
  ];
  const localBlocked = await loadOccupiedPasscodes(repo, lockIds, credencialId);

  let passcode = credencial.codigo_credencial ? String(credencial.codigo_credencial).trim() : "";
  if (!alreadyRemoteOk) {
    if (!passcode || localBlocked.has(passcode)) {
      if (passcode) rejectedPins.add(passcode);
      const exclude = new Set([...localBlocked, ...rejectedPins]);
      passcode = deps.passcodeGenerator
        ? String(deps.passcodeGenerator(exclude))
        : allocateNewTtlockPasscode(exclude);
      await repo.updateCredencial(credencialId, {
        codigo_credencial: passcode,
        provider_tipo: "ttlock_passcode",
      });
    }
  } else if (!passcode) {
    passcode = deps.passcodeGenerator
      ? String(deps.passcodeGenerator(localBlocked))
      : allocateNewTtlockPasscode(localBlocked);
    await repo.updateCredencial(credencialId, {
      codigo_credencial: passcode,
      provider_tipo: "ttlock_passcode",
    });
  }

  await repo.updateCredencial(credencialId, { status: "provisionando" });

  const validoDeMs = new Date(credencial.valido_de).getTime();
  const validoAteMs = new Date(credencial.valido_ate).getTime();

  let itens = allItens.filter(itemNeedsProvision);
  if (itens.length === 0) {
    const resolved = resolveProvisionCredentialStatus(allItens);
    await repo.updateCredencial(credencialId, { status: resolved.status });
    return {
      credencialId,
      status: resolved.status,
      passcode,
      totalItens: allItens.length,
      provisionados: resolved.provisionados,
      falhas: resolved.falhas,
      erros,
      accessReady: resolved.allReady,
    };
  }

  if (!client.isAvailable()) {
    const msg =
      "TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.";
    erros.push(msg);
    for (const item of itens) {
      await repo.updateItem(item.id, {
        status_provisionamento: "falhou",
        ultimo_erro: msg,
      });
    }
    const after = await repo.getItens(credencialId);
    const resolved = resolveProvisionCredentialStatus(after);
    await repo.updateCredencial(credencialId, { status: resolved.status });
    return {
      credencialId,
      status: resolved.status,
      passcode,
      totalItens: after.length,
      provisionados: resolved.provisionados,
      falhas: resolved.falhas,
      erros,
      accessReady: false,
    };
  }

  let collisionAttempt = 0;
  let rollbackFailed = false;

  while (true) {
    itens = (await repo.getItens(credencialId)).filter(itemNeedsProvision);
    if (itens.length === 0) break;

    let roundCollision = false;
    const provisionedThisRound: Array<{
      item: CredencialItemRow;
      keyboardPwdId: number;
    }> = [];

    for (const item of itens) {
      // Colisão já detectada: não continuar o mesmo PIN nos demais locks.
      if (roundCollision) {
        await repo.updateItem(item.id, {
          status_provisionamento: "falhou",
          ultimo_erro: "Abortado: colisão de passcode em outro lock da mesma tentativa.",
        });
        erros.push(`${item.codigo_logico_destino}: abortado por colisão no mesmo round`);
        continue;
      }

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
        const res = await client.createKeyboardPassword({
          lockId: item.lock_id_ttlock,
          keyboardPwd: passcode,
          keyboardPwdName: keyboardPwdNameBase,
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
        provisionedThisRound.push({ item, keyboardPwdId: res.keyboardPwdId });
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
        if (isTtlockSamePasscodeError(msg)) roundCollision = true;
        await repo.updateItem(item.id, {
          status_provisionamento: "falhou",
          ultimo_erro: msg,
        });
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

    const afterRound = await repo.getItens(credencialId);
    const stillNeeds = afterRound.filter(itemNeedsProvision);
    if (stillNeeds.length === 0 && !roundCollision) break;

    if (!roundCollision) break;

    // Compensação: PIN parcial aceito em alguns locks + -3007 em outro.
    if (
      shouldRollbackPartialPasscodeAttempt({
        collisionOnAnyLock: true,
        provisionedInRound: provisionedThisRound.length,
        credentialNeverFullyProvisioned: !alreadyRemoteOk,
      })
    ) {
      for (const { item, keyboardPwdId } of provisionedThisRound) {
        try {
          await client.deleteKeyboardPassword({
            lockId: item.lock_id_ttlock,
            keyboardPwdId,
          });
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente",
            remote_keyboard_pwd_id: null,
            codigo_enviado: null,
            provisionado_em: null,
            ultimo_erro: null,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          rollbackFailed = true;
          erros.push(`${item.codigo_logico_destino}: rollback falhou: ${msg}`);
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente_limpeza",
            ultimo_erro: `Rollback após colisão -3007 falhou: ${msg}`,
          });
        }
      }
    }

    if (
      !canRetryWithNewPasscode({
        collisionOnAnyLock: true,
        credentialNeverFullyProvisioned: !alreadyRemoteOk,
        collisionAttempt,
        maxAttempts: TTLOCK_PASSCODE_COLLISION_RETRY_MAX,
        rollbackFailed,
      })
    ) {
      break;
    }

    collisionAttempt++;
    rejectedPins.add(passcode);
    localBlocked.add(passcode);
    const exclude = new Set([...localBlocked, ...rejectedPins]);
    const next = deps.passcodeGenerator
      ? String(deps.passcodeGenerator(exclude))
      : allocateNewTtlockPasscode(exclude);
    passcode = next;
    await repo.updateCredencial(credencialId, {
      codigo_credencial: passcode,
      provider_tipo: "ttlock_passcode",
    });

    const pendingAgain = (await repo.getItens(credencialId)).filter(
      (i) =>
        itemNeedsProvision(i) ||
        (i.status_provisionamento === "falhou" && i.remote_keyboard_pwd_id == null),
    );
    for (const item of pendingAgain) {
      await repo.updateItem(item.id, {
        status_provisionamento: "pendente",
        ultimo_erro: null,
        remote_keyboard_pwd_id: null,
        codigo_enviado: null,
        provisionado_em: null,
      });
    }
  }

  const finalItens = await repo.getItens(credencialId);
  let resolved = resolveProvisionCredentialStatus(finalItens);
  if (rollbackFailed) {
    // Nunca marcar provisionada / parcial “pronta” com resíduo inconsistente.
    resolved = {
      ...resolved,
      status: resolved.provisionados > 0 ? "parcial" : "falhou",
      allReady: false,
    };
  }
  await repo.updateCredencial(credencialId, {
    status: resolved.status,
    ...(rollbackFailed
      ? {
          last_sync_error:
            "Rollback após colisão de passcode falhou; intervenção necessária.",
        }
      : {}),
  });

  return {
    credencialId,
    status: resolved.status,
    // PIN final só é “aceito” se accessReady; em falha é último candidato (status=falhou bloqueia envio).
    passcode: resolved.allReady ? passcode : passcode,
    totalItens: finalItens.length,
    provisionados: resolved.provisionados,
    falhas: resolved.falhas,
    erros,
    accessReady: resolved.allReady,
    rollbackFailed,
  };
}

/**
 * Processa todas as credenciais pendentes (status = pendente).
 * Útil para script em lote ou rotina agendada.
 */
export async function processarProvisionamentosPendentes(deps: {
  repository: ProvisioningRepository;
  ttlockClient: TtlockClient;
  passcodeGenerator?: (exclude?: string | null | Iterable<string>) => string;
}): Promise<ProcessarCredencialResult[]> {
  const credenciais = await deps.repository.getCredenciaisPendentes();
  const results: ProcessarCredencialResult[] = [];
  for (const c of credenciais) {
    const r = await processarCredencialDeAcesso(c.id, deps);
    results.push(r);
  }
  return results;
}
