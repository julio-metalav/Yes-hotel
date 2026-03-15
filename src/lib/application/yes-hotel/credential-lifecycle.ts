/**
 * Ciclo de vida da credencial TTLock (Fase 3).
 * Revogação, alteração de validade, reprovisionamento e handlers por cenário operacional.
 */

import type { TtlockClient } from "../../integrations/ttlock";
import type { CredencialItemRow, CredencialRow, ProvisioningRepository } from "./provisioning-executor";
import { processarCredencialDeAcesso } from "./provisioning-executor";
import type { OperacionalCredencialStatus } from "./types";

export type MotivoRevogacao =
  | "cancelamento"
  | "checkout"
  | "room_change"
  | "ajuste_manual"
  | "encerramento_operacional";

export interface RevokeCredentialResult {
  credencialId: string;
  status: OperacionalCredencialStatus;
  itensRevogados: number;
  itensFalha: number;
  erros: string[];
}

export interface UpdateValidityResult {
  credencialId: string;
  valido_de: string;
  valido_ate: string;
  itensAtualizados: number;
  itensFalha: number;
  erros: string[];
}

export interface ReprovisionResult {
  credencialId: string;
  status: OperacionalCredencialStatus;
  passcode: string | null;
  revogados: number;
  provisionados: number;
  falhas: number;
  erros: string[];
}

export interface LifecycleDeps {
  repository: ProvisioningRepository;
  ttlockClient: TtlockClient;
}

/**
 * Revoga uma credencial: remove passcode remoto em cada item provisionado e atualiza estados.
 */
export async function revokeCredential(
  credencialId: string,
  deps: LifecycleDeps,
  motivo: MotivoRevogacao,
): Promise<RevokeCredentialResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;

  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
  if (credencial.status === "revogada") {
    return {
      credencialId,
      status: "revogada",
      itensRevogados: 0,
      itensFalha: 0,
      erros: ["Credencial ja revogada."],
    };
  }

  const itens = await repo.getItensProvisionados(credencialId);
  const erros: string[] = [];
  let revogados = 0;
  let falhas = 0;
  const now = new Date().toISOString();

  for (const item of itens) {
    if (item.remote_keyboard_pwd_id == null) {
      await repo.updateItem(item.id, {
        status_provisionamento: "revogado",
        revogado_em: now,
      });
      revogados++;
      continue;
    }

    if (client.isAvailable()) {
      try {
        await client.deleteKeyboardPassword({
          lockId: item.lock_id_ttlock,
          keyboardPwdId: item.remote_keyboard_pwd_id,
        });
        await repo.updateItem(item.id, {
          status_provisionamento: "revogado",
          revogado_em: now,
          ultimo_erro: null,
        });
        revogados++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push(`${item.codigo_logico_destino}: ${msg}`);
        await repo.updateItem(item.id, {
          ultimo_erro: msg,
        });
        falhas++;
      }
    } else {
      await repo.updateItem(item.id, {
        status_provisionamento: "revogado",
        revogado_em: now,
        ultimo_erro: "TTLock indisponivel; revogacao apenas local.",
      });
      revogados++;
    }
  }

  await repo.updateCredencial(credencialId, {
    status: "revogada",
    revogado_em: now,
    motivo_revogacao: motivo,
  });

  return {
    credencialId,
    status: "revogada",
    itensRevogados: revogados,
    itensFalha: falhas,
    erros,
  };
}

/**
 * Altera a validade da credencial e sincroniza com TTLock (change passcode).
 * Se a API falhar em algum item, registra erro e continua nos demais.
 */
export async function updateCredentialValidity(
  credencialId: string,
  deps: LifecycleDeps,
  validity: { valido_de: string; valido_ate: string },
): Promise<UpdateValidityResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;

  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
  if (credencial.status === "revogada") {
    throw new Error("Nao e possivel alterar validade de credencial revogada.");
  }

  const validoDeMs = new Date(validity.valido_de).getTime();
  const validoAteMs = new Date(validity.valido_ate).getTime();
  const itens = await repo.getItensProvisionados(credencialId);
  const erros: string[] = [];
  let ok = 0;
  let falhas = 0;

  if (client.isAvailable()) {
    for (const item of itens) {
      if (item.remote_keyboard_pwd_id == null) continue;
      try {
        await client.changeKeyboardPassword({
          lockId: item.lock_id_ttlock,
          keyboardPwdId: item.remote_keyboard_pwd_id,
          startDate: validoDeMs,
          endDate: validoAteMs,
        });
        ok++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push(`${item.codigo_logico_destino}: ${msg}`);
        await repo.updateItem(item.id, { ultimo_erro: msg });
        falhas++;
      }
    }
  } else {
    erros.push("TTLock indisponivel; validade apenas atualizada localmente.");
  }

  await repo.updateCredencial(credencialId, {
    valido_de: validity.valido_de,
    valido_ate: validity.valido_ate,
  });

  return {
    credencialId,
    valido_de: validity.valido_de,
    valido_ate: validity.valido_ate,
    itensAtualizados: ok,
    itensFalha: falhas,
    erros,
  };
}

/**
 * Reprovisiona uma credencial: revoga remoto dos itens atuais e provisiona de novo (mesmo passcode).
 * Estratégia: revogar todos provisionados, marcar como revogado, depois provisionar itens pendentes
 * (não recriamos itens; apenas os que já existem como pendente serão provisionados).
 * Para "reprovisionar" no sentido de mesma credencial com novos itens (ex. room change), use handleRoomChange.
 */
export async function reprovisionCredential(
  credencialId: string,
  deps: LifecycleDeps,
): Promise<ReprovisionResult> {
  const repo = deps.repository;
  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);

  const revokeResult = await revokeCredential(credencialId, deps, "ajuste_manual");
  const itens = await repo.getItens(credencialId);
  const provisionadosAinda = itens.filter((i) => i.status_provisionamento === "provisionado");
  const pendentes = itens.filter((i) => i.status_provisionamento === "pendente");

  if (pendentes.length === 0) {
    return {
      credencialId,
      status: revokeResult.status,
      passcode: credencial.codigo_credencial,
      revogados: revokeResult.itensRevogados,
      provisionados: 0,
      falhas: revokeResult.itensFalha,
      erros: revokeResult.erros,
    };
  }

  await repo.updateCredencial(credencialId, { status: "pendente" });
  const provisionResult = await processarCredencialDeAcesso(credencialId, deps);

  return {
    credencialId,
    status: provisionResult.status,
    passcode: provisionResult.passcode,
    revogados: revokeResult.itensRevogados,
    provisionados: provisionResult.provisionados,
    falhas: revokeResult.itensFalha + provisionResult.falhas,
    erros: [...revokeResult.erros, ...provisionResult.erros],
  };
}

/**
 * Cancelamento da reserva: revoga credencial com motivo cancelamento.
 */
export async function handleCancellation(reservaId: string, deps: LifecycleDeps): Promise<RevokeCredentialResult | null> {
  const credencial = await deps.repository.getCredencialPorReserva(reservaId);
  if (!credencial) return null;
  return revokeCredential(credencial.id, deps, "cancelamento");
}

/**
 * Checkout / encerramento: revoga credencial com motivo checkout.
 */
export async function handleCheckout(reservaId: string, deps: LifecycleDeps): Promise<RevokeCredentialResult | null> {
  const credencial = await deps.repository.getCredencialPorReserva(reservaId);
  if (!credencial) return null;
  return revokeCredential(credencial.id, deps, "checkout");
}

/**
 * Early check-in: antecipa o início da validade.
 */
export async function handleEarlyCheckin(
  credencialId: string,
  deps: LifecycleDeps,
  novoValidoDe: string,
): Promise<UpdateValidityResult> {
  const credencial = await deps.repository.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
  return updateCredentialValidity(credencialId, deps, {
    valido_de: novoValidoDe,
    valido_ate: credencial.valido_ate,
  });
}

/**
 * Late check-out: estende o fim da validade.
 */
export async function handleLateCheckout(
  credencialId: string,
  deps: LifecycleDeps,
  novoValidoAte: string,
): Promise<UpdateValidityResult> {
  const credencial = await deps.repository.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
  return updateCredentialValidity(credencialId, deps, {
    valido_de: credencial.valido_de,
    valido_ate: novoValidoAte,
  });
}

/**
 * Troca de apartamento: revoga itens do apartamento/bloco antigo, insere itens do novo e provisiona.
 * Mantém o mesmo passcode da credencial.
 */
export async function handleRoomChange(
  reservaId: string,
  deps: LifecycleDeps,
  novoApartamento: string,
): Promise<ReprovisionResult & { itensAntigosRevogados: number; itensNovosInseridos: number }> {
  const repo = deps.repository;
  const credencial = await repo.getCredencialPorReserva(reservaId);
  if (!credencial) throw new Error(`Nenhuma credencial encontrada para reserva: ${reservaId}`);

  const apartamentoAntigo = await repo.getReservaApartment(reservaId);
  const numAntigo = apartamentoAntigo ? apartamentoAntigo.padStart(2, "0") : "";
  const numNovo = novoApartamento.trim().replace(/\D/g, "");
  const numNovoNorm = numNovo.length <= 2 ? numNovo.padStart(2, "0") : numNovo.slice(0, 2);

  const itens = await repo.getItens(credencial.id);
  const codigosAntigos = new Set<string>();
  if (numAntigo) {
    codigosAntigos.add(`APT-${numAntigo}`);
    const gateCode = parseInt(numAntigo, 10) <= 20 ? "1947" : "1967";
    codigosAntigos.add(`GATE-${gateCode}-EXTERNAL`);
    codigosAntigos.add(`GATE-${gateCode}-INTERNAL`);
  }

  let itensAntigosRevogados = 0;
  const now = new Date().toISOString();

  for (const item of itens) {
    if (!codigosAntigos.has(item.codigo_logico_destino)) continue;
    if (item.status_provisionamento !== "provisionado" && item.status_provisionamento !== "falhou") continue;

    if (item.remote_keyboard_pwd_id != null && deps.ttlockClient.isAvailable()) {
      try {
        await deps.ttlockClient.deleteKeyboardPassword({
          lockId: item.lock_id_ttlock,
          keyboardPwdId: item.remote_keyboard_pwd_id,
        });
      } catch {
        // registra erro no item mas continua
        await repo.updateItem(item.id, {
          status_provisionamento: "revogado",
          revogado_em: now,
          ultimo_erro: "Erro ao revogar remoto no room change",
        });
        itensAntigosRevogados++;
        continue;
      }
    }
    await repo.updateItem(item.id, {
      status_provisionamento: "revogado",
      revogado_em: now,
      ultimo_erro: null,
    });
    itensAntigosRevogados++;
  }

  const destinos = await repo.getFechadurasForApartment(numNovoNorm);
  if (destinos.length === 0) throw new Error(`Nenhuma fechadura encontrada para apartamento: ${novoApartamento}`);

  const itensExistentes = await repo.getItens(credencial.id);
  const fechadurasJaNaCredencial = new Set(itensExistentes.map((i) => i.fechadura_id));
  let itensNovosInseridos = 0;
  for (const d of destinos) {
    if (fechadurasJaNaCredencial.has(d.fechadura_id)) continue;
    await repo.insertItem(credencial.id, d);
    fechadurasJaNaCredencial.add(d.fechadura_id);
    itensNovosInseridos++;
  }

  const provisionResult = await processarCredencialDeAcesso(credencial.id, deps);

  return {
    credencialId: credencial.id,
    status: provisionResult.status,
    passcode: provisionResult.passcode,
    revogados: itensAntigosRevogados,
    provisionados: provisionResult.provisionados,
    falhas: provisionResult.falhas,
    erros: provisionResult.erros,
    itensAntigosRevogados,
    itensNovosInseridos,
  };
}

/**
 * Ajuste manual: revogar, alterar validade e/ou reprovisionar conforme parâmetros.
 */
export async function handleManualAdjustment(
  credencialId: string,
  deps: LifecycleDeps,
  options: {
    revogar?: boolean;
    valido_de?: string;
    valido_ate?: string;
    reprovisionar?: boolean;
  },
): Promise<RevokeCredentialResult | UpdateValidityResult | ReprovisionResult> {
  if (options.revogar) {
    return revokeCredential(credencialId, deps, "ajuste_manual");
  }
  if (options.valido_de != null || options.valido_ate != null) {
    const credencial = await deps.repository.getCredencial(credencialId);
    if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
    return updateCredentialValidity(credencialId, deps, {
      valido_de: options.valido_de ?? credencial.valido_de,
      valido_ate: options.valido_ate ?? credencial.valido_ate,
    });
  }
  if (options.reprovisionar) {
    return reprovisionCredential(credencialId, deps);
  }
  throw new Error("Nenhuma acao especificada para ajuste manual.");
}
