/**
 * Seleção da retomada assíncrona (fase 2) do provisionamento TTLock.
 * Sem I/O. O worker chama lifecycle_provision / send-senha conforme o kind.
 */

import { parseTransientRetryState } from "./ttlock-provision-retry.ts";
import {
  evaluateTtlockReadyForGuestAccess,
  resolveProvisionCredentialStatus,
  type TtlockItemReadyRow,
} from "./ttlock-guest-access-gate.ts";

export type Phase2CandidateKind = "provision_retry" | "status_heal" | "send_senha";

export type Phase2ClassifyInput = {
  credentialStatus: string;
  codigoCredencial?: string | null;
  items: TtlockItemReadyRow[];
  senhaEnviadaEm: string | null | undefined;
  lastSyncError?: string | null;
  reservaAtiva?: boolean;
  acessoLiberado?: boolean;
  now?: Date;
};

export type Phase2ClassifyResult = {
  run: boolean;
  kind: Phase2CandidateKind | null;
  reason: string;
};

function isReservaElegivel(input: Phase2ClassifyInput): boolean {
  if (input.reservaAtiva === false) return false;
  if (input.acessoLiberado === false) return false;
  return true;
}

export function isPhase2RetryEligibleNow(
  lastSyncError: string | null | undefined,
  now: Date,
): boolean {
  const st = parseTransientRetryState(lastSyncError);
  if (!st?.nextEligibleAt) return true;
  const t = Date.parse(st.nextEligibleAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() >= t;
}

/**
 * Classifica se o worker deve reentrar lifecycle_provision e/ou send-senha.
 * Nunca gera PIN novo aqui. Nunca marca sucesso sem o fluxo oficial.
 */
export function classifyTtlockPhase2Candidate(
  input: Phase2ClassifyInput,
): Phase2ClassifyResult {
  const now = input.now ?? new Date();
  const status = String(input.credentialStatus ?? "").trim();
  if (!isReservaElegivel(input)) {
    return { run: false, kind: null, reason: "reserva_inelegivel" };
  }
  if (status === "revogada") {
    return { run: false, kind: null, reason: "credencial_revogada" };
  }

  const resolved = resolveProvisionCredentialStatus(input.items);
  const gate = evaluateTtlockReadyForGuestAccess(
    { status, codigo_credencial: input.codigoCredencial ?? null },
    input.items,
  );
  const senhaEnviada = Boolean(String(input.senhaEnviadaEm ?? "").trim());

  if (resolved.allReady) {
    if (status !== "provisionada") {
      return { run: true, kind: "status_heal", reason: "itens_3_de_3_status_lag" };
    }
    if (!senhaEnviada) {
      return { run: true, kind: "send_senha", reason: "provisionada_sem_guest_access_ready" };
    }
    return { run: false, kind: null, reason: "completo" };
  }

  if (gate.ready && !senhaEnviada) {
    return { run: true, kind: "send_senha", reason: "gate_pronto_sem_envio" };
  }

  if (resolved.inProgress > 0 || status === "pendente" || status === "provisionando" || status === "pronta") {
    if (!isPhase2RetryEligibleNow(input.lastSyncError, now)) {
      return { run: false, kind: null, reason: "fase2_aguardando_janela" };
    }
    return { run: true, kind: "provision_retry", reason: "itens_pendentes_ou_provisionando" };
  }

  return { run: false, kind: null, reason: "sem_retry_automatico" };
}
