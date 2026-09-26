/**
 * Ciclo de vida da credencial TTLock (Fase 3).
 * Revogação, alteração de validade, reprovisionamento e handlers por cenário operacional.
 */

import type { TtlockClient } from "../../integrations/ttlock/client.ts";
import { logTtlockLifecycle } from "../../integrations/ttlock/lifecycle-log.ts";
import { accessCodesForApartment, canonicalApartmentCode } from "../../domain/yes-hotel/hits-room-change.ts";
import { resolveProvisionCredentialStatus } from "../../domain/yes-hotel/ttlock-guest-access-gate.ts";
import { generateRandomTtlockPasscode } from "../../domain/yes-hotel/ttlock-credential-format.ts";
import type { CredencialItemRow, CredencialRow, ProvisioningRepository } from "./provisioning-executor.ts";
import { processarCredencialDeAcesso } from "./provisioning-executor.ts";
import type { OperacionalCredencialStatus } from "./types.ts";

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
  retry?: {
    shortRetryMax?: number;
    shortDelayMs?: number;
    shortBudgetMs?: number;
    phase2Max?: number;
    sleepFn?: (ms: number) => Promise<void>;
  };
}

const NOW = () => new Date().toISOString();

/**
 * Revoga uma credencial: remove passcode remoto em cada item provisionado e atualiza estados.
 * Idempotente: se já revogada, retorna sem alterar. Atualiza sync_status conforme resultado remoto.
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
      erros: ["Credencial ja revogada (idempotente)."],
    };
  }

  const itens = await repo.getItensProvisionados(credencialId);
  const erros: string[] = [];
  let revogados = 0;
  let falhas = 0;
  const now = NOW();

  for (const item of itens) {
    if (item.remote_keyboard_pwd_id == null) {
      // Encerramento apenas local: não há passcode remoto a confirmar; revogado_em = fim local (não é "delete remoto confirmado").
      await repo.updateItem(item.id, {
        status_provisionamento: "revogado",
        revogado_em: now,
      });
      revogados++;
      continue;
    }

    if (client.isAvailable()) {
      logTtlockLifecycle({
        action: "revoke",
        source: "app_client",
        reserva_id: credencial.reserva_id,
        credencial_id: credencialId,
        credencial_item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
        remote_keyboard_pwd_id: item.remote_keyboard_pwd_id,
        lock_id: item.lock_id_ttlock,
        status: "start",
        timestamp: new Date().toISOString(),
      });
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
        logTtlockLifecycle({
          action: "revoke",
          source: "app_client",
          reserva_id: credencial.reserva_id,
          credencial_id: credencialId,
          credencial_item_id: item.id,
          codigo_logico_destino: item.codigo_logico_destino,
          remote_keyboard_pwd_id: item.remote_keyboard_pwd_id,
          lock_id: item.lock_id_ttlock,
          status: "success",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push(`${item.codigo_logico_destino}: ${msg}`);
        await repo.updateItem(item.id, {
          status_provisionamento: "pendente_limpeza",
          ultimo_erro: msg,
        });
        falhas++;
        logTtlockLifecycle({
          action: "revoke",
          source: "app_client",
          reserva_id: credencial.reserva_id,
          credencial_id: credencialId,
          credencial_item_id: item.id,
          codigo_logico_destino: item.codigo_logico_destino,
          remote_keyboard_pwd_id: item.remote_keyboard_pwd_id,
          lock_id: item.lock_id_ttlock,
          status: "error",
          error_message: msg,
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      // TTLock indisponível: encerramento apenas local; não há confirmação remota (não é "delete remoto confirmado").
      await repo.updateItem(item.id, {
        status_provisionamento: "revogado",
        revogado_em: now,
        ultimo_erro: "TTLock indisponivel; revogacao apenas local.",
      });
      revogados++;
    }
  }

  let syncStatus: "ok" | "pending" | "partial" | "failed" = "ok";
  let lastSyncError: string | null = null;
  if (!client.isAvailable() && itens.length > 0) {
    syncStatus = "pending";
    lastSyncError = "TTLock indisponivel; revogacao apenas local.";
  } else if (falhas > 0) {
    syncStatus = revogados > 0 ? "partial" : "failed";
    lastSyncError = erros.slice(0, 3).join("; ");
  }

  await repo.updateCredencial(credencialId, {
    status: "revogada",
    revogado_em: now,
    motivo_revogacao: motivo,
    sync_status: syncStatus,
    last_sync_attempt_at: now,
    last_sync_error: lastSyncError,
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
 * Se a API falhar em algum item, registra erro e continua nos demais; atualiza sync_status.
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
  if (Number.isNaN(validoDeMs) || Number.isNaN(validoAteMs)) {
    throw new Error("Validade invalida: valido_de e valido_ate devem ser datas validas.");
  }
  if (validoAteMs <= validoDeMs) {
    throw new Error("Validade invalida: valido_ate deve ser posterior a valido_de.");
  }

  const itens = await repo.getItensProvisionados(credencialId);
  const erros: string[] = [];
  let ok = 0;
  let falhas = 0;
  const now = NOW();

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

  let syncStatus: "ok" | "pending" | "partial" | "failed" = "ok";
  let lastSyncError: string | null = null;
  if (!client.isAvailable()) {
    syncStatus = "pending";
    lastSyncError = "TTLock indisponivel; validade apenas local.";
  } else if (erros.length > 0) {
    syncStatus = ok > 0 ? "partial" : "failed";
    lastSyncError = erros.slice(0, 3).join("; ");
  }

  await repo.updateCredencial(credencialId, {
    valido_de: validity.valido_de,
    valido_ate: validity.valido_ate,
    sync_status: syncStatus,
    last_sync_attempt_at: now,
    last_sync_error: lastSyncError,
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

export interface ReplacePasscodeResult extends ReprovisionResult {
  passcodeAnterior: string | null;
  limpezaPendente: number;
  /** true quando a geração nova foi bloqueada por limpeza remota pendente. */
  bloqueadoPorLimpeza: boolean;
}

const replacePasscodeInFlight = new Set<string>();

/**
 * Substitui a senha TTLock: revoga a anterior nos locks, gera passcode novo e provisiona.
 * Distinto de `reprovisionCredential` (que mantém o mesmo passcode).
 * Se a revogação remota falhar parcialmente, marca pendente_limpeza, NÃO troca o passcode
 * e NÃO provisiona nova senha (evita estado inconsistente).
 */
export async function replaceCredentialWithNewPasscode(
  credencialId: string,
  deps: LifecycleDeps & { passcodeGenerator?: (exclude?: string | null) => string },
): Promise<ReplacePasscodeResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;

  if (replacePasscodeInFlight.has(credencialId)) {
    return {
      credencialId,
      status: "provisionando",
      passcode: null,
      passcodeAnterior: null,
      revogados: 0,
      provisionados: 0,
      falhas: 0,
      erros: ["Geração de nova senha já em andamento para esta credencial."],
      limpezaPendente: 0,
      bloqueadoPorLimpeza: false,
    };
  }

  replacePasscodeInFlight.add(credencialId);
  try {
    const credencial = await repo.getCredencial(credencialId);
    if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
    if (credencial.status === "revogada") {
      throw new Error("Não é possível gerar nova senha para credencial revogada.");
    }
    if (credencial.status === "provisionando") {
      return {
        credencialId,
        status: "provisionando",
        passcode: credencial.codigo_credencial,
        passcodeAnterior: credencial.codigo_credencial,
        revogados: 0,
        provisionados: 0,
        falhas: 0,
        erros: ["Provisionamento em andamento; tente novamente em instantes."],
        limpezaPendente: 0,
        bloqueadoPorLimpeza: false,
      };
    }

    const passcodeAnterior = credencial.codigo_credencial;
    const now = NOW();
    const erros: string[] = [];
    let revogados = 0;
    let limpezaPendente = 0;

    await repo.updateCredencial(credencialId, { status: "provisionando" });

    const itens = await repo.getItens(credencialId);

    for (const item of itens) {
      const status = item.status_provisionamento;
      const hasRemote = item.remote_keyboard_pwd_id != null;

      if (status === "pendente_limpeza" || (hasRemote && (status === "provisionado" || status === "falhou"))) {
        if (!hasRemote) {
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente",
            remote_keyboard_pwd_id: null,
            codigo_enviado: null,
            ultimo_erro: null,
            provisionado_em: null,
            revogado_em: null,
          });
          continue;
        }
        if (!client.isAvailable()) {
          erros.push(`${item.codigo_logico_destino}: TTLock indisponível para revogar senha anterior.`);
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente_limpeza",
            ultimo_erro: "TTLock indisponível ao gerar nova senha.",
          });
          limpezaPendente++;
          continue;
        }
        try {
          await client.deleteKeyboardPassword({
            lockId: item.lock_id_ttlock,
            keyboardPwdId: item.remote_keyboard_pwd_id!,
          });
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente",
            remote_keyboard_pwd_id: null,
            codigo_enviado: null,
            ultimo_erro: null,
            provisionado_em: null,
            revogado_em: null,
          });
          revogados++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          erros.push(`${item.codigo_logico_destino}: ${msg}`);
          await repo.updateItem(item.id, {
            status_provisionamento: "pendente_limpeza",
            ultimo_erro: msg,
          });
          limpezaPendente++;
        }
        continue;
      }

      if (status === "provisionado" || status === "falhou" || status === "revogado" || status === "provisionando") {
        await repo.updateItem(item.id, {
          status_provisionamento: "pendente",
          remote_keyboard_pwd_id: null,
          codigo_enviado: null,
          ultimo_erro: null,
          provisionado_em: null,
          revogado_em: status === "revogado" ? item.revogado_em : null,
        });
      }
    }

    if (limpezaPendente > 0) {
      await repo.updateCredencial(credencialId, {
        status: passcodeAnterior ? "parcial" : "falhou",
        sync_status: "partial",
        last_sync_attempt_at: now,
        last_sync_error: erros.slice(0, 3).join("; ") || "Limpeza remota pendente.",
      });
      return {
        credencialId,
        status: "parcial",
        passcode: passcodeAnterior,
        passcodeAnterior,
        revogados,
        provisionados: 0,
        falhas: limpezaPendente,
        erros,
        limpezaPendente,
        bloqueadoPorLimpeza: true,
      };
    }

    const novoPasscode = deps.passcodeGenerator
      ? deps.passcodeGenerator(passcodeAnterior)
      : generateRandomTtlockPasscode(passcodeAnterior);

    await repo.updateCredencial(credencialId, {
      codigo_credencial: novoPasscode,
      provider_tipo: "ttlock_passcode",
      status: "pendente",
      revogado_em: null,
      motivo_revogacao: null,
      sync_status: "pending",
      last_sync_attempt_at: now,
      last_sync_error: null,
    });

    const provisionResult = await processarCredencialDeAcesso(credencialId, {
      repository: repo,
      ttlockClient: client,
      passcodeGenerator: () => novoPasscode,
    });

    if (provisionResult.falhas > 0 || provisionResult.provisionados === 0) {
      return {
        credencialId,
        status: provisionResult.status,
        passcode: provisionResult.passcode,
        passcodeAnterior,
        revogados,
        provisionados: provisionResult.provisionados,
        falhas: provisionResult.falhas,
        erros: [...erros, ...provisionResult.erros],
        limpezaPendente: 0,
        bloqueadoPorLimpeza: false,
      };
    }

    return {
      credencialId,
      status: provisionResult.status,
      passcode: provisionResult.passcode,
      passcodeAnterior,
      revogados,
      provisionados: provisionResult.provisionados,
      falhas: 0,
      erros,
      limpezaPendente: 0,
      bloqueadoPorLimpeza: false,
    };
  } finally {
    replacePasscodeInFlight.delete(credencialId);
  }
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

export type RoomChangeMotivo =
  | "noop"
  | "credencial_revogada_so_apartamento"
  | "apenas_local"
  | "reconciliada"
  | "revogacao_pendente"
  | "provisionamento_falhou";

export type RoomChangeResult = ReprovisionResult & {
  itensAntigosRevogados: number;
  itensNovosInseridos: number;
  concluida: boolean;
  motivo: RoomChangeMotivo;
  pinPreservado: boolean;
  apartamentoAnterior: string | null;
  apartamentoNovo: string | null;
};

function itemTemPasscodeRemoto(item: {
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | null;
}): boolean {
  if (item.remote_keyboard_pwd_id != null) return true;
  return item.status_provisionamento === "provisionado" || item.status_provisionamento === "pendente_limpeza";
}

/**
 * Troca de apartamento da mesma reserva.
 *
 * Ordem: revoga só o que não pertence ao apartamento novo; portões do mesmo
 * bloco permanecem. Só então provisiona o destino, com o PIN que já existe.
 * Se a revogação do antigo falhar, não provisiona o novo.
 * Se ainda não havia passcode remoto, só retargeta os itens locais — sem
 * delete na fechadura e sem gerar PIN.
 */
export async function handleRoomChange(
  reservaId: string,
  deps: LifecycleDeps,
  novoApartamento: string,
): Promise<RoomChangeResult> {
  const repo = deps.repository;
  const credencial = await repo.getCredencialPorReserva(reservaId);
  if (!credencial) throw new Error(`Nenhuma credencial encontrada para reserva: ${reservaId}`);

  const apartamentoAntigo = canonicalApartmentCode(await repo.getReservaApartment(reservaId));
  const numNovoNorm = canonicalApartmentCode(novoApartamento);
  const pinAntes = credencial.codigo_credencial ? String(credencial.codigo_credencial).trim() : "";
  const base = {
    credencialId: credencial.id,
    passcode: pinAntes || null,
    itensAntigosRevogados: 0,
    itensNovosInseridos: 0,
    pinPreservado: true,
    apartamentoAnterior: apartamentoAntigo,
    apartamentoNovo: numNovoNorm,
  };

  if (!numNovoNorm) {
    throw new Error(`Nenhuma fechadura encontrada para apartamento: ${novoApartamento}. Verifique se o numero e valido (01-40).`);
  }
  if (apartamentoAntigo === numNovoNorm) {
    return {
      ...base,
      status: credencial.status,
      revogados: 0,
      provisionados: 0,
      falhas: 0,
      erros: [],
      concluida: true,
      motivo: "noop",
    };
  }
  if (credencial.status === "revogada") {
    return {
      ...base,
      status: "revogada",
      revogados: 0,
      provisionados: 0,
      falhas: 0,
      erros: [],
      concluida: true,
      motivo: "credencial_revogada_so_apartamento",
    };
  }

  const destinos = await repo.getFechadurasForApartment(numNovoNorm);
  if (destinos.length === 0) {
    throw new Error(`Nenhuma fechadura encontrada para apartamento: ${novoApartamento}. Verifique se o numero e valido (01-40).`);
  }
  const fechadurasNovas = new Set(destinos.map((d) => d.fechadura_id));
  const codigosAntigos = new Set(apartamentoAntigo ? accessCodesForApartment(apartamentoAntigo) : []);

  const itens = await repo.getItens(credencial.id);
  const haviaRemoto = itens.some(itemTemPasscodeRemoto);
  const agora = new Date().toISOString();
  let itensAntigosRevogados = 0;
  let revogacaoPendente = false;

  for (const item of itens) {
    const antigoSomente =
      codigosAntigos.has(item.codigo_logico_destino) && !fechadurasNovas.has(item.fechadura_id);
    if (!antigoSomente) continue;
    if (item.status_provisionamento === "revogado") continue;

    if (item.remote_keyboard_pwd_id != null) {
      if (!deps.ttlockClient.isAvailable()) {
        await repo.updateItem(item.id, {
          status_provisionamento: "pendente_limpeza",
          ultimo_erro: "TTLock indisponível na troca de apartamento; o apto antigo segue com o PIN.",
        });
        revogacaoPendente = true;
        continue;
      }
      try {
        await deps.ttlockClient.deleteKeyboardPassword({
          lockId: item.lock_id_ttlock,
          keyboardPwdId: item.remote_keyboard_pwd_id,
        });
      } catch {
        await repo.updateItem(item.id, {
          status_provisionamento: "pendente_limpeza",
          ultimo_erro: "Erro ao revogar remoto no room change",
        });
        revogacaoPendente = true;
        continue;
      }
    }

    await repo.updateItem(item.id, {
      status_provisionamento: "revogado",
      revogado_em: agora,
      ultimo_erro: item.remote_keyboard_pwd_id == null ? "substituido_antes_do_provisionamento" : null,
    });
    itensAntigosRevogados++;
  }

  if (revogacaoPendente) {
    const msg = `Troca de apartamento ${apartamentoAntigo ?? "—"} → ${numNovoNorm} pendente: o apto antigo ainda pode ter o PIN. O novo não foi provisionado.`;
    await repo.updateCredencial(credencial.id, {
      last_sync_error: msg,
      last_sync_attempt_at: agora,
      sync_status: "failed",
    });
    return {
      ...base,
      status: credencial.status,
      revogados: itensAntigosRevogados,
      provisionados: 0,
      falhas: 1,
      erros: [msg],
      itensAntigosRevogados,
      concluida: false,
      motivo: "revogacao_pendente",
    };
  }

  const itensExistentes = await repo.getItens(credencial.id);
  const porFechadura = new Map(itensExistentes.map((i) => [i.fechadura_id, i]));
  let itensNovosInseridos = 0;
  for (const destino of destinos) {
    const existente = porFechadura.get(destino.fechadura_id);
    if (!existente) {
      try {
        const criado = await repo.insertItem(credencial.id, destino);
        porFechadura.set(destino.fechadura_id, criado);
        itensNovosInseridos++;
      } catch (e) {
        const detalhe = e instanceof Error ? e.message : String(e);
        const msg = `Troca de apartamento ${apartamentoAntigo ?? "—"} → ${numNovoNorm}: a porta nova não foi criada (${detalhe}). Portões sozinhos não liberam a credencial.`;
        const depois = await repo.getItens(credencial.id);
        const resolved = resolveProvisionCredentialStatus(depois, { apartamentoAtual: numNovoNorm });
        await repo.updateCredencial(credencial.id, {
          status: resolved.status === "provisionada" ? "parcial" : resolved.status,
          last_sync_error: msg,
          last_sync_attempt_at: new Date().toISOString(),
          sync_status: "failed",
        });
        return {
          ...base,
          status: resolved.status === "provisionada" ? "parcial" : resolved.status,
          revogados: itensAntigosRevogados,
          provisionados: resolved.provisionados,
          falhas: Math.max(resolved.falhas, 1),
          erros: [msg],
          itensAntigosRevogados,
          itensNovosInseridos,
          concluida: false,
          motivo: "provisionamento_falhou",
        };
      }
      continue;
    }
    if (existente.status_provisionamento === "revogado") {
      await repo.updateItem(existente.id, {
        status_provisionamento: "pendente",
        ultimo_erro: null,
        revogado_em: null,
        remote_keyboard_pwd_id: null,
        codigo_enviado: null,
        provisionado_em: null,
      });
      itensNovosInseridos++;
    }
  }

  if (!haviaRemoto) {
    return {
      ...base,
      status: credencial.status,
      revogados: itensAntigosRevogados,
      provisionados: 0,
      falhas: 0,
      erros: [],
      itensAntigosRevogados,
      itensNovosInseridos,
      concluida: true,
      motivo: "apenas_local",
    };
  }

  if (!pinAntes) {
    const msg = `Troca de apartamento ${apartamentoAntigo ?? "—"} → ${numNovoNorm}: havia passcode remoto sem PIN local. A troca não gerou senha nova.`;
    await repo.updateCredencial(credencial.id, {
      last_sync_error: msg,
      last_sync_attempt_at: new Date().toISOString(),
      sync_status: "failed",
    });
    return {
      ...base,
      status: credencial.status,
      revogados: itensAntigosRevogados,
      provisionados: 0,
      falhas: 1,
      erros: [msg],
      itensAntigosRevogados,
      itensNovosInseridos,
      concluida: false,
      motivo: "provisionamento_falhou",
    };
  }

  const provisionResult = await processarCredencialDeAcesso(credencial.id, {
    ...deps,
    preserveExistingPasscode: pinAntes.length > 0,
  });
  const pinDepois = provisionResult.passcode ? String(provisionResult.passcode).trim() : "";
  const pinOk = !pinAntes || pinDepois === pinAntes;
  const concluida = provisionResult.falhas === 0 && provisionResult.accessReady === true && pinOk;
  if (!concluida) {
    const msg = pinOk
      ? `Troca de apartamento ${apartamentoAntigo ?? "—"} → ${numNovoNorm}: apto antigo revogado e o novo não ficou provisionado. O PIN foi mantido.`
      : `Troca de apartamento ${apartamentoAntigo ?? "—"} → ${numNovoNorm}: o provisionamento trocaria o PIN. A troca não foi concluída.`;
    await repo.updateCredencial(credencial.id, {
      last_sync_error: msg,
      last_sync_attempt_at: new Date().toISOString(),
      sync_status: "failed",
    });
    return {
      ...base,
      status: provisionResult.status,
      passcode: pinAntes || provisionResult.passcode,
      revogados: itensAntigosRevogados,
      provisionados: provisionResult.provisionados,
      falhas: Math.max(provisionResult.falhas, pinOk ? 0 : 1),
      erros: [...provisionResult.erros, msg],
      itensAntigosRevogados,
      itensNovosInseridos,
      concluida: false,
      motivo: "provisionamento_falhou",
      pinPreservado: pinOk,
    };
  }

  return {
    ...base,
    status: provisionResult.status,
    passcode: pinDepois || pinAntes || null,
    revogados: itensAntigosRevogados,
    provisionados: provisionResult.provisionados,
    falhas: 0,
    erros: [],
    itensAntigosRevogados,
    itensNovosInseridos,
    concluida: true,
    motivo: "reconciliada",
    pinPreservado: true,
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

export interface RetrySyncResult {
  credencialId: string;
  reservaId: string;
  previousSyncStatus: string | null;
  action: "revoke_remaining" | "update_validity" | "none";
  itensTentados: number;
  itensOk: number;
  itensFalha: number;
  syncStatusAfter: "ok" | "pending" | "partial" | "failed";
  erros: string[];
}

/**
 * Tenta concluir a sincronização remota de uma credencial com pendência (sync_status pending/partial/failed).
 * Idempotente: chamar novamente não duplica efeito; itens já revogados/sincronizados são ignorados.
 */
export async function retryCredentialSync(
  credencialId: string,
  deps: LifecycleDeps,
): Promise<RetrySyncResult> {
  const repo = deps.repository;
  const client = deps.ttlockClient;

  const credencial = await repo.getCredencial(credencialId);
  if (!credencial) throw new Error(`Credencial nao encontrada: ${credencialId}`);
  const previousSyncStatus = credencial.sync_status ?? null;
  const erros: string[] = [];
  let itensTentados = 0;
  let itensOk = 0;
  let itensFalha = 0;
  const now = NOW();

  if (credencial.status === "revogada") {
    const itens = await repo.getItensPendentesLimpeza(credencialId);
    for (const item of itens) {
      if (item.remote_keyboard_pwd_id == null) continue;
      itensTentados++;
      if (!client.isAvailable()) {
        erros.push("TTLock indisponivel");
        itensFalha++;
        continue;
      }
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
        itensOk++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push(`${item.codigo_logico_destino}: ${msg}`);
        await repo.updateItem(item.id, { status_provisionamento: "pendente_limpeza", ultimo_erro: msg });
        itensFalha++;
      }
    }
    const syncStatusAfter =
      itensFalha === 0 ? "ok" : itensOk > 0 ? "partial" : "failed";
    await repo.updateCredencial(credencialId, {
      sync_status: syncStatusAfter,
      last_sync_attempt_at: now,
      last_sync_error: erros.length > 0 ? erros.slice(0, 3).join("; ") : null,
    });
    return {
      credencialId,
      reservaId: credencial.reserva_id,
      previousSyncStatus,
      action: "revoke_remaining",
      itensTentados,
      itensOk,
      itensFalha,
      syncStatusAfter,
      erros,
    };
  }

  const itens = await repo.getItensProvisionados(credencialId);
  const validoDeMs = new Date(credencial.valido_de).getTime();
  const validoAteMs = new Date(credencial.valido_ate).getTime();
  for (const item of itens) {
    if (item.remote_keyboard_pwd_id == null) continue;
    itensTentados++;
    if (!client.isAvailable()) {
      erros.push("TTLock indisponivel");
      itensFalha++;
      continue;
    }
    try {
      await client.changeKeyboardPassword({
        lockId: item.lock_id_ttlock,
        keyboardPwdId: item.remote_keyboard_pwd_id,
        startDate: validoDeMs,
        endDate: validoAteMs,
      });
      await repo.updateItem(item.id, { ultimo_erro: null });
      itensOk++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros.push(`${item.codigo_logico_destino}: ${msg}`);
      await repo.updateItem(item.id, { ultimo_erro: msg });
      itensFalha++;
    }
  }
  const syncStatusAfter =
    itensFalha === 0 ? "ok" : itensOk > 0 ? "partial" : "failed";
  await repo.updateCredencial(credencialId, {
    sync_status: syncStatusAfter,
    last_sync_attempt_at: now,
    last_sync_error: erros.length > 0 ? erros.slice(0, 3).join("; ") : null,
  });
  return {
    credencialId,
    reservaId: credencial.reserva_id,
    previousSyncStatus,
    action: itensTentados > 0 ? "update_validity" : "none",
    itensTentados,
    itensOk,
    itensFalha,
    syncStatusAfter,
    erros,
  };
}
