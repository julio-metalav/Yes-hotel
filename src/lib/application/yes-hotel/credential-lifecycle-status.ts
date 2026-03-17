/**
 * Leitura operacional do ciclo de vida da credencial (Fase 3.1).
 * Base para futura integração com o painel — sem UI nesta fase.
 */

import type { CredencialRow, ProvisioningRepository, SyncStatus } from "./provisioning-executor";

export interface CredentialLifecycleStatus {
  credencialId: string;
  reservaId: string;
  status: CredencialRow["status"];
  syncStatus: SyncStatus | null;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  validoDe: string;
  validoAte: string;
  revogadoEm: string | null;
  motivoRevogacao: string | null;
  totalItens: number;
  itensProvisionados: number;
  itensRevogados: number;
  itensPendentesLimpeza: number;
  itensPendentes: number;
  itensFalha: number;
  itensComErro: Array<{ codigoLogico: string; ultimoErro: string | null }>;
}

/**
 * Retorna o status operacional completo de uma credencial (para suporte e futura UI).
 */
export async function getCredentialLifecycleStatus(
  credencialId: string,
  repo: ProvisioningRepository,
): Promise<CredentialLifecycleStatus | null> {
  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) return null;

  const itens = await repo.getItens(credencialId);
  const provisionados = itens.filter((i) => i.status_provisionamento === "provisionado");
  const revogados = itens.filter((i) => i.status_provisionamento === "revogado");
  const pendentesLimpeza = itens.filter((i) => i.status_provisionamento === "pendente_limpeza");
  const pendentes = itens.filter((i) => i.status_provisionamento === "pendente");
  const falha = itens.filter((i) => i.status_provisionamento === "falhou");
  const comErro = itens.filter((i) => i.ultimo_erro != null);

  return {
    credencialId: credencial.id,
    reservaId: credencial.reserva_id,
    status: credencial.status,
    syncStatus: credencial.sync_status ?? null,
    lastSyncAttemptAt: credencial.last_sync_attempt_at ?? null,
    lastSyncError: credencial.last_sync_error ?? null,
    validoDe: credencial.valido_de,
    validoAte: credencial.valido_ate,
    revogadoEm: credencial.revogado_em ?? null,
    motivoRevogacao: credencial.motivo_revogacao ?? null,
    totalItens: itens.length,
    itensProvisionados: provisionados.length,
    itensRevogados: revogados.length,
    itensPendentesLimpeza: pendentesLimpeza.length,
    itensPendentes: pendentes.length,
    itensFalha: falha.length,
    itensComErro: comErro.map((i) => ({
      codigoLogico: i.codigo_logico_destino,
      ultimoErro: i.ultimo_erro,
    })),
  };
}

export interface ReservationCredentialSyncSummary {
  reservaId: string;
  temCredencial: boolean;
  credencialId: string | null;
  status: string | null;
  syncStatus: SyncStatus | null;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  resumo: string;
}

/**
 * Retorna um resumo da sincronização da credencial da reserva (para futura exibição no painel).
 */
export async function getReservationCredentialSyncSummary(
  reservaId: string,
  repo: ProvisioningRepository,
): Promise<ReservationCredentialSyncSummary> {
  const credencial = await repo.getCredencialPorReserva(reservaId);
  if (!credencial) {
    return {
      reservaId,
      temCredencial: false,
      credencialId: null,
      status: null,
      syncStatus: null,
      lastSyncAttemptAt: null,
      lastSyncError: null,
      resumo: "Sem credencial operacional",
    };
  }

  const itens = await repo.getItens(credencial.id);
  const provisionados = itens.filter((i) => i.status_provisionamento === "provisionado");
  const pendentesLimpeza = itens.filter((i) => i.status_provisionamento === "pendente_limpeza");
  const comErro = itens.filter((i) => i.ultimo_erro != null);
  let resumo = `${credencial.status}`;
  if (credencial.sync_status) resumo += ` | sync: ${credencial.sync_status}`;
  if (comErro.length > 0) resumo += ` | ${comErro.length} item(ns) com erro`;
  if (pendentesLimpeza.length > 0) resumo += ` | ${pendentesLimpeza.length} pendente(s) limpeza`;
  if (provisionados.length > 0 && credencial.status !== "revogada") {
    resumo += ` | ${provisionados.length} provisionado(s)`;
  }

  return {
    reservaId,
    temCredencial: true,
    credencialId: credencial.id,
    status: credencial.status,
    syncStatus: credencial.sync_status ?? null,
    lastSyncAttemptAt: credencial.last_sync_attempt_at ?? null,
    lastSyncError: credencial.last_sync_error ?? null,
    resumo,
  };
}
