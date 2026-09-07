/**
 * Utilitário compartilhado para formatação de saída dos scripts TTLock (Fase 3.1).
 * Padroniza exibição: credencial, reserva, itens, operação remota, resultado, inconsistência.
 */

import type { RevokeCredentialResult, UpdateValidityResult, ReprovisionResult, RetrySyncResult } from "../src/lib/application/yes-hotel/credential-lifecycle";

export function formatRevokeResult(
  credencialId: string,
  reservaId: string | null,
  r: RevokeCredentialResult,
): string {
  const lines = [
    "[REVOGACAO]",
    `  Credencial: ${credencialId}`,
    reservaId != null ? `  Reserva: ${reservaId}` : null,
    `  Status: ${r.status}`,
    `  Itens revogados (remoto+local): ${r.itensRevogados}`,
    `  Itens com falha remota: ${r.itensFalha}`,
    r.erros.length > 0 ? `  Erros: ${r.erros.join(" | ")}` : null,
    r.itensFalha > 0 ? "  [DIVERGENCIA] Revogacao local aplicada; remoto falhou em algum(ns) item(ns). Use retry-pending." : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatUpdateValidityResult(
  credencialId: string,
  r: UpdateValidityResult,
): string {
  const lines = [
    "[ALTERACAO VALIDADE]",
    `  Credencial: ${credencialId}`,
    `  Valido de: ${r.valido_de}`,
    `  Valido ate: ${r.valido_ate}`,
    `  Itens atualizados no TTLock: ${r.itensAtualizados}`,
    `  Itens com falha: ${r.itensFalha}`,
    r.erros.length > 0 ? `  Erros: ${r.erros.join(" | ")}` : null,
    r.itensFalha > 0 ? "  [DIVERGENCIA] Validade atualizada localmente; remoto falhou em algum(ns) item(ns). Use retry-pending." : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatReprovisionResult(
  credencialId: string,
  r: ReprovisionResult,
): string {
  const lines = [
    "[REPROVISIONAMENTO]",
    `  Credencial: ${credencialId}`,
    `  Status: ${r.status}`,
    r.passcode ? `  Passcode: ${r.passcode}` : null,
    `  Revogados: ${r.revogados} | Provisionados: ${r.provisionados} | Falhas: ${r.falhas}`,
    r.erros.length > 0 ? `  Erros: ${r.erros.join(" | ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatRetryResult(r: RetrySyncResult): string {
  const lines = [
    "[RETRY SYNC]",
    `  Credencial: ${r.credencialId} | Reserva: ${r.reservaId}`,
    `  Acao: ${r.action}`,
    `  Sync anterior: ${r.previousSyncStatus ?? "—"}`,
    `  Sync apos: ${r.syncStatusAfter}`,
    `  Itens tentados: ${r.itensTentados} | ok: ${r.itensOk} | falha: ${r.itensFalha}`,
    r.erros.length > 0 ? `  Erros: ${r.erros.join(" | ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export function exitCodeRevoke(r: RevokeCredentialResult): number {
  return r.itensFalha > 0 ? 1 : 0;
}

export function exitCodeUpdateValidity(r: UpdateValidityResult): number {
  return r.itensFalha > 0 ? 1 : 0;
}

export function exitCodeReprovision(r: ReprovisionResult): number {
  return r.falhas > 0 ? 1 : 0;
}
