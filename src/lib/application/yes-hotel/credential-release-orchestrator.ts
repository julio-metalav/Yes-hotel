/**
 * Orquestra liberação/envio de credenciais usando a política de domínio
 * e portas injetáveis (TTLock/send-senha reais ou mocks de teste).
 */
import {
  avaliarLiberacaoCredenciais,
  type AvaliarLiberacaoCredenciaisInput,
  type AvaliarLiberacaoCredenciaisResultado,
  type OrigemLiberacaoCredencial,
  type PendenciaCredencial,
} from "../../domain/yes-hotel/credential-release-policy";

export type CredentialReleaseOrigemRegistro =
  | "requisitos"
  | "horario_13h"
  | "manual"
  | "retry_automatico"
  | "retry_manual";

export type CredentialReleaseFalhaTipo = "geracao" | "envio";

export interface CredentialReleaseReservationState {
  reservaId: string;
  pagamentoStatus: "pago" | "pendente";
  fnrhStatus: "completa" | "pendente";
  senhaEnviada: boolean;
  dataHoraCheckin: Date | string;
  email?: string | null;
  whatsapp?: string | null;
  acessoLiberado?: boolean;
  /** Reserva cancelada (PMS) — não processar. */
  cancelada?: boolean;
  /** Check-in concluído / encerrada — não processar. */
  encerrada?: boolean;
  /** Já existe codigo_credencial válido (TTLock provisionado). */
  temCredencialValida?: boolean;
  /** Última falha aberta (mais recente que sucesso). */
  ultimaFalhaTipo?: CredentialReleaseFalhaTipo | null;
}

export interface CredentialReleaseSendResult {
  ok: boolean;
  error?: string;
  /** true quando o envio foi pulado por já ter sido feito */
  skipped?: boolean;
}

export interface CredentialReleasePorts {
  loadReservation(reservaId: string): Promise<CredentialReleaseReservationState | null>;
  /** Lista reservas com check-in na data (YYYY-MM-DD, fuso do hotel). */
  listCheckinsOnDate?(dateYmd: string): Promise<CredentialReleaseReservationState[]>;
  /** Lista reservas com falha aberta de geração/envio (para retry em lote). */
  listFailedReleases?(limit?: number): Promise<CredentialReleaseReservationState[]>;
  ensureAccessLiberated?(reservaId: string): Promise<{ ok: boolean; error?: string }>;
  sendCredentials(input: {
    reservaId: string;
    manual: boolean;
    origem: CredentialReleaseOrigemRegistro;
    email?: string;
    whatsapp?: string;
    usuarioId?: string;
    gerarNova?: boolean;
    /** true = só reenvia; não força regeneração. */
    reutilizarCredencial?: boolean;
  }): Promise<CredentialReleaseSendResult>;
  registerEvent?(input: {
    reservaId: string;
    tipo: string;
    titulo: string;
    detalhe?: string | null;
  }): Promise<void>;
  now?: () => Date;
}

export interface AplicarLiberacaoCredenciaisInput {
  reservaId: string;
  origem: OrigemLiberacaoCredencial;
  confirmacaoManual?: boolean;
  confirmacaoGerarNova?: boolean;
  acaoSolicitada?: AvaliarLiberacaoCredenciaisInput["acaoSolicitada"];
  usuarioId?: string;
  usuarioLabel?: string;
  email?: string;
  whatsapp?: string;
  /** Estado pré-carregado (evita reload em testes / UI). */
  state?: CredentialReleaseReservationState;
  /** Fuso para o gatilho 13h. */
  timeZone?: string;
}

export interface AplicarLiberacaoCredenciaisResultado {
  decisao: AvaliarLiberacaoCredenciaisResultado;
  executado: boolean;
  gerado: boolean;
  enviado: boolean;
  skipped: boolean;
  origemRegistro: CredentialReleaseOrigemRegistro | null;
  error?: string;
  pendenciasRegistradas?: PendenciaCredencial[];
}

const inFlight = new Set<string>();

export function resetCredentialReleaseOrchestratorLocks(): void {
  inFlight.clear();
}

function mapOrigemRegistro(
  origem: OrigemLiberacaoCredencial,
): CredentialReleaseOrigemRegistro {
  if (origem === "automatico_13h") return "horario_13h";
  if (origem === "manual") return "manual";
  return "requisitos";
}

function buildPolicyInput(
  state: CredentialReleaseReservationState,
  input: AplicarLiberacaoCredenciaisInput,
  agora: Date,
  envioEmAndamento: boolean,
): AvaliarLiberacaoCredenciaisInput {
  return {
    pagamentoStatus: state.pagamentoStatus,
    fnrhStatus: state.fnrhStatus,
    senhaEnviada: state.senhaEnviada,
    dataHoraCheckin: state.dataHoraCheckin,
    dataHoraAtual: agora,
    origem: input.origem,
    confirmacaoManual: input.confirmacaoManual,
    confirmacaoGerarNova: input.confirmacaoGerarNova,
    acaoSolicitada: input.acaoSolicitada ?? "gerar_enviar",
    envioEmAndamento,
    timeZone: input.timeZone,
  };
}

/**
 * Aplica a política a uma reserva e, se autorizado, dispara o fluxo real
 * (ou mock via ports) de geração/envio. Idempotente: primeiro gatilho vence.
 */
export async function aplicarLiberacaoCredenciais(
  ports: CredentialReleasePorts,
  input: AplicarLiberacaoCredenciaisInput,
): Promise<AplicarLiberacaoCredenciaisResultado> {
  const agora = ports.now ? ports.now() : new Date();
  const origemRegistro = mapOrigemRegistro(input.origem);

  const state =
    input.state ?? (await ports.loadReservation(input.reservaId));
  if (!state) {
    const decisao = avaliarLiberacaoCredenciais({
      pagamentoStatus: "pendente",
      fnrhStatus: "pendente",
      senhaEnviada: false,
      dataHoraCheckin: agora,
      dataHoraAtual: agora,
      origem: input.origem,
      acaoSolicitada: input.acaoSolicitada ?? "gerar_enviar",
    });
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro: null,
      error: "Reserva não encontrada.",
    };
  }

  if (state.cancelada || state.encerrada) {
    const decisao = avaliarLiberacaoCredenciais(
      buildPolicyInput(state, input, agora, false),
    );
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro,
      error: state.cancelada ? "cancelada" : "encerrada",
    };
  }

  if (inFlight.has(state.reservaId)) {
    const decisao = avaliarLiberacaoCredenciais(
      buildPolicyInput(state, input, agora, true),
    );
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro,
    };
  }

  const decisao = avaliarLiberacaoCredenciais(
    buildPolicyInput(state, input, agora, false),
  );

  if (decisao.exigeConfirmacaoManual && !input.confirmacaoManual) {
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro,
    };
  }

  if (decisao.exigeConfirmacaoGerarNova && !input.confirmacaoGerarNova) {
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro,
    };
  }

  if (!decisao.deveEnviar && !decisao.deveGerar) {
    return {
      decisao,
      executado: false,
      gerado: false,
      enviado: false,
      skipped: true,
      origemRegistro,
    };
  }

  inFlight.add(state.reservaId);
  try {
    // Revalida sob trava (segundo gatilho concorrente).
    const fresh =
      input.state ?? (await ports.loadReservation(input.reservaId));
    if (!fresh) {
      return {
        decisao,
        executado: false,
        gerado: false,
        enviado: false,
        skipped: true,
        origemRegistro,
        error: "Reserva não encontrada.",
      };
    }
    if (fresh.senhaEnviada && (input.acaoSolicitada ?? "gerar_enviar") === "gerar_enviar") {
      const blocked = avaliarLiberacaoCredenciais(
        buildPolicyInput({ ...fresh, senhaEnviada: true }, input, agora, false),
      );
      return {
        decisao: blocked,
        executado: false,
        gerado: false,
        enviado: false,
        skipped: true,
        origemRegistro,
      };
    }

    if (decisao.deveGerar && ports.ensureAccessLiberated && !fresh.acessoLiberado) {
      const liberated = await ports.ensureAccessLiberated(fresh.reservaId);
      if (!liberated.ok) {
        if (ports.registerEvent) {
          await ports.registerEvent({
            reservaId: fresh.reservaId,
            tipo: "falha_gerar_senha",
            titulo: "Falha ao gerar senha",
            detalhe: liberated.error || "Falha ao liberar/provisionar acesso.",
          });
        }
        return {
          decisao: {
            ...decisao,
            alertaOperacional: "Falha ao gerar senha",
          },
          executado: false,
          gerado: false,
          enviado: false,
          skipped: false,
          origemRegistro,
          error: liberated.error || "Falha ao gerar senha",
        };
      }
    }

    if (
      input.origem === "manual" &&
      decisao.pendenciasAtuais.length > 0 &&
      ports.registerEvent
    ) {
      await ports.registerEvent({
        reservaId: fresh.reservaId,
        tipo: "liberacao_manual_com_pendencias",
        titulo: "Acesso/credenciais liberados manualmente com pendências",
        detalhe: JSON.stringify({
          origem: "manual",
          usuario_id: input.usuarioId || null,
          usuario: input.usuarioLabel || null,
          pendencias: decisao.pendenciasAtuais,
          em: agora.toISOString(),
        }),
      });
    }

    const sendResult = await ports.sendCredentials({
      reservaId: fresh.reservaId,
      manual: input.origem === "manual",
      origem: origemRegistro,
      email: input.email ?? fresh.email ?? undefined,
      whatsapp: input.whatsapp ?? fresh.whatsapp ?? undefined,
      usuarioId: input.usuarioId,
      gerarNova: input.acaoSolicitada === "gerar_nova",
    });

    if (!sendResult.ok) {
      const isGenFail =
        (sendResult.error || "").toLowerCase().includes("provision") ||
        (sendResult.error || "").toLowerCase().includes("gerar") ||
        (sendResult.error || "").toLowerCase().includes("credencial");
      if (ports.registerEvent) {
        await ports.registerEvent({
          reservaId: fresh.reservaId,
          tipo: isGenFail ? "falha_gerar_senha" : "falha_enviar_credenciais",
          titulo: isGenFail ? "Falha ao gerar senha" : "Falha ao enviar credenciais",
          detalhe: sendResult.error || null,
        });
      }
      return {
        decisao: {
          ...decisao,
          alertaOperacional: isGenFail
            ? "Falha ao gerar senha"
            : "Falha ao enviar credenciais",
        },
        executado: false,
        gerado: false,
        enviado: false,
        skipped: false,
        origemRegistro,
        error: sendResult.error,
      };
    }

    if (ports.registerEvent) {
      await ports.registerEvent({
        reservaId: fresh.reservaId,
        tipo: "credencial_liberacao_aplicada",
        titulo: "Credenciais geradas/enviadas",
        detalhe: JSON.stringify({
          origem: origemRegistro,
          motivo: decisao.motivo,
          skipped: !!sendResult.skipped,
          em: agora.toISOString(),
        }),
      });
    }

    return {
      decisao,
      executado: !sendResult.skipped,
      gerado: decisao.deveGerar && !sendResult.skipped,
      enviado: !sendResult.skipped,
      skipped: !!sendResult.skipped,
      origemRegistro,
      pendenciasRegistradas:
        input.origem === "manual" && decisao.pendenciasAtuais.length > 0
          ? [...decisao.pendenciasAtuais]
          : undefined,
    };
  } finally {
    inFlight.delete(state.reservaId);
  }
}

/**
 * Gatilho automático por requisitos (pagamento + FNRH).
 * Chamado após confirmação de pagamento ou conclusão de FNRH.
 */
export async function aplicarLiberacaoPorRequisitos(
  ports: CredentialReleasePorts,
  reservaId: string,
  state?: CredentialReleaseReservationState,
): Promise<AplicarLiberacaoCredenciaisResultado> {
  return aplicarLiberacaoCredenciais(ports, {
    reservaId,
    origem: "automatico_requisitos",
    state,
  });
}

export const YES_HOTEL_TIMEZONE = "America/Campo_Grande";
export const CREDENTIAL_RELEASE_AUTO_HOUR = 13;

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateYmd: string;
}

/** Partes de data/hora no fuso oficial do hotel (Campo Grande/MS). */
export function getZonedDateParts(
  date: Date,
  timeZone: string = YES_HOTEL_TIMEZONE,
): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateYmd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function isAtOrAfterLocalHour(
  date: Date,
  hour: number,
  timeZone: string = YES_HOTEL_TIMEZONE,
): boolean {
  const zoned = getZonedDateParts(date, timeZone);
  return zoned.hour > hour || (zoned.hour === hour && zoned.minute >= 0);
}

export interface Liberacao13hResumo {
  encontradas: number;
  processadas: number;
  enviadas: number;
  ignoradas: number;
  falhas: number;
  falhasDetalhe: Array<{ reservaId: string; motivo: string }>;
  resultados: AplicarLiberacaoCredenciaisResultado[];
  timezone: string;
  dateYmd: string;
  horaLocal: string;
  antesDas13h: boolean;
}

function reservaInelegivel13h(
  reserva: CredentialReleaseReservationState,
): string | null {
  if (reserva.cancelada) return "cancelada";
  if (reserva.encerrada) return "encerrada";
  if (reserva.senhaEnviada) return "ja_enviada";
  return null;
}

/**
 * Função chamável por scheduler (sem cron nesta etapa).
 * Usa fuso America/Campo_Grande; idempotente por senhaEnviada + trava.
 */
export async function aplicarLiberacaoCredenciais13h(
  ports: CredentialReleasePorts,
  options?: {
    dataHoraAtual?: Date;
    dateYmd?: string;
    timeZone?: string;
  },
): Promise<Liberacao13hResumo> {
  const timeZone = options?.timeZone || YES_HOTEL_TIMEZONE;
  const agora = options?.dataHoraAtual ?? (ports.now ? ports.now() : new Date());
  const zoned = getZonedDateParts(agora, timeZone);
  const dateYmd = options?.dateYmd ?? zoned.dateYmd;
  const horaLocal = `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`;
  const antesDas13h = !isAtOrAfterLocalHour(
    agora,
    CREDENTIAL_RELEASE_AUTO_HOUR,
    timeZone,
  );

  const empty: Liberacao13hResumo = {
    encontradas: 0,
    processadas: 0,
    enviadas: 0,
    ignoradas: 0,
    falhas: 0,
    falhasDetalhe: [],
    resultados: [],
    timezone: timeZone,
    dateYmd,
    horaLocal,
    antesDas13h,
  };

  if (!ports.listCheckinsOnDate) {
    return empty;
  }

  const reservas = await ports.listCheckinsOnDate(dateYmd);
  empty.encontradas = reservas.length;

  if (antesDas13h) {
    empty.ignoradas = reservas.length;
    empty.processadas = reservas.length;
    return empty;
  }

  const timedPorts: CredentialReleasePorts = {
    ...ports,
    now: () => agora,
  };
  const resultados: AplicarLiberacaoCredenciaisResultado[] = [];
  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;
  const falhasDetalhe: Array<{ reservaId: string; motivo: string }> = [];

  for (const reserva of reservas) {
    const bloqueio = reservaInelegivel13h(reserva);
    if (bloqueio) {
      ignoradas += 1;
      resultados.push({
        decisao: avaliarLiberacaoCredenciais({
          pagamentoStatus: reserva.pagamentoStatus,
          fnrhStatus: reserva.fnrhStatus,
          senhaEnviada: reserva.senhaEnviada,
          dataHoraCheckin: reserva.dataHoraCheckin,
          dataHoraAtual: agora,
          origem: "automatico_13h",
          timeZone,
        }),
        executado: false,
        gerado: false,
        enviado: false,
        skipped: true,
        origemRegistro: "horario_13h",
        error: bloqueio === "ja_enviada" ? undefined : bloqueio,
      });
      continue;
    }

    try {
      const result = await aplicarLiberacaoCredenciais(timedPorts, {
        reservaId: reserva.reservaId,
        origem: "automatico_13h",
        state: reserva,
        timeZone,
      });
      resultados.push(result);
      if (result.enviado) enviadas += 1;
      else if (result.error) {
        falhas += 1;
        falhasDetalhe.push({
          reservaId: reserva.reservaId,
          motivo: String(result.error).slice(0, 120),
        });
      } else ignoradas += 1;
    } catch (error) {
      falhas += 1;
      const motivo =
        error instanceof Error ? error.message.slice(0, 120) : "erro_inesperado";
      falhasDetalhe.push({ reservaId: reserva.reservaId, motivo });
    }
  }

  return {
    encontradas: reservas.length,
    processadas: reservas.length,
    enviadas,
    ignoradas,
    falhas,
    falhasDetalhe,
    resultados,
    timezone: timeZone,
    dateYmd,
    horaLocal,
    antesDas13h: false,
  };
}

export interface AplicarRetryLiberacaoInput {
  reservaId: string;
  modo: "retry_automatico" | "retry_manual";
  usuarioId?: string;
  usuarioLabel?: string;
  state?: CredentialReleaseReservationState;
}

export interface AplicarRetryLiberacaoResultado {
  ok: boolean;
  skipped: boolean;
  enviado: boolean;
  gerado: boolean;
  origem: "retry_automatico" | "retry_manual";
  motivo?: string;
  error?: string;
  reutilizouCredencial: boolean;
}

/**
 * Reprocessa uma reserva com falha aberta de geração/envio.
 * Uma tentativa por execução; reutiliza senha válida se a falha foi só no envio.
 */
export async function aplicarRetryLiberacaoCredenciais(
  ports: CredentialReleasePorts,
  input: AplicarRetryLiberacaoInput,
): Promise<AplicarRetryLiberacaoResultado> {
  const origem = input.modo;
  const state =
    input.state ?? (await ports.loadReservation(input.reservaId));

  if (!state) {
    return {
      ok: false,
      skipped: true,
      enviado: false,
      gerado: false,
      origem,
      motivo: "nao_encontrada",
      reutilizouCredencial: false,
      error: "Reserva não encontrada.",
    };
  }

  if (state.cancelada || state.encerrada) {
    return {
      ok: true,
      skipped: true,
      enviado: false,
      gerado: false,
      origem,
      motivo: state.cancelada ? "cancelada" : "encerrada",
      reutilizouCredencial: false,
    };
  }

  if (state.senhaEnviada) {
    return {
      ok: true,
      skipped: true,
      enviado: false,
      gerado: false,
      origem,
      motivo: "ja_enviada",
      reutilizouCredencial: false,
    };
  }

  if (!state.ultimaFalhaTipo) {
    return {
      ok: true,
      skipped: true,
      enviado: false,
      gerado: false,
      origem,
      motivo: "sem_falha_aberta",
      reutilizouCredencial: false,
    };
  }

  if (inFlight.has(state.reservaId)) {
    return {
      ok: true,
      skipped: true,
      enviado: false,
      gerado: false,
      origem,
      motivo: "envio_em_andamento",
      reutilizouCredencial: false,
    };
  }

  const reutilizarCredencial =
    state.ultimaFalhaTipo === "envio" && !!state.temCredencialValida;
  const precisaGerar = !reutilizarCredencial;

  inFlight.add(state.reservaId);
  try {
    if (ports.registerEvent) {
      await ports.registerEvent({
        reservaId: state.reservaId,
        tipo: "retry_credenciais_iniciado",
        titulo: "Nova tentativa de liberação de credenciais",
        detalhe: JSON.stringify({
          origem,
          falha_anterior: state.ultimaFalhaTipo,
          reutilizar_credencial: reutilizarCredencial,
          usuario_id: input.usuarioId || null,
          usuario: input.usuarioLabel || null,
          em: new Date().toISOString(),
        }),
      });
    }

    if (precisaGerar && ports.ensureAccessLiberated && !state.acessoLiberado) {
      const liberated = await ports.ensureAccessLiberated(state.reservaId);
      if (!liberated.ok) {
        if (ports.registerEvent) {
          await ports.registerEvent({
            reservaId: state.reservaId,
            tipo: "falha_gerar_senha",
            titulo: "Falha ao gerar senha",
            detalhe: JSON.stringify({
              origem,
              erro: liberated.error || "Falha ao liberar/provisionar.",
            }),
          });
        }
        return {
          ok: false,
          skipped: false,
          enviado: false,
          gerado: false,
          origem,
          reutilizouCredencial: false,
          error: liberated.error || "Falha ao gerar senha",
        };
      }
    }

    const sendResult = await ports.sendCredentials({
      reservaId: state.reservaId,
      manual: origem === "retry_manual",
      origem,
      email: state.email ?? undefined,
      whatsapp: state.whatsapp ?? undefined,
      usuarioId: input.usuarioId,
      gerarNova: precisaGerar && !state.temCredencialValida,
      reutilizarCredencial,
    });

    if (!sendResult.ok) {
      const isGen =
        precisaGerar &&
        ((sendResult.error || "").toLowerCase().includes("provision") ||
          (sendResult.error || "").toLowerCase().includes("gerar") ||
          (sendResult.error || "").toLowerCase().includes("credencial"));
      if (ports.registerEvent) {
        await ports.registerEvent({
          reservaId: state.reservaId,
          tipo: isGen ? "falha_gerar_senha" : "falha_enviar_credenciais",
          titulo: isGen ? "Falha ao gerar senha" : "Falha ao enviar credenciais",
          detalhe: JSON.stringify({
            origem,
            erro: sendResult.error || null,
          }),
        });
      }
      return {
        ok: false,
        skipped: false,
        enviado: false,
        gerado: false,
        origem,
        reutilizouCredencial: reutilizarCredencial,
        error: sendResult.error,
      };
    }

    if (ports.registerEvent) {
      await ports.registerEvent({
        reservaId: state.reservaId,
        tipo: "retry_credenciais_sucesso",
        titulo: "Retry de credenciais concluído",
        detalhe: JSON.stringify({
          origem,
          reutilizar_credencial: reutilizarCredencial,
          skipped: !!sendResult.skipped,
          em: new Date().toISOString(),
        }),
      });
    }

    return {
      ok: true,
      skipped: !!sendResult.skipped,
      enviado: !sendResult.skipped,
      gerado: precisaGerar && !sendResult.skipped,
      origem,
      reutilizouCredencial: reutilizarCredencial,
      motivo: sendResult.skipped ? "ja_enviada" : "ok",
    };
  } finally {
    inFlight.delete(state.reservaId);
  }
}

/**
 * Retry em lote: no máximo uma tentativa por reserva por execução.
 */
export async function aplicarRetryLiberacaoCredenciaisEmLote(
  ports: CredentialReleasePorts,
  options?: {
    modo?: "retry_automatico" | "retry_manual";
    limit?: number;
  },
): Promise<{
  encontradas: number;
  processadas: number;
  enviadas: number;
  ignoradas: number;
  falhas: number;
  falhasDetalhe: Array<{ reservaId: string; motivo: string }>;
}> {
  const modo = options?.modo || "retry_automatico";
  if (!ports.listFailedReleases) {
    return {
      encontradas: 0,
      processadas: 0,
      enviadas: 0,
      ignoradas: 0,
      falhas: 0,
      falhasDetalhe: [],
    };
  }
  const lista = await ports.listFailedReleases(options?.limit ?? 50);
  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;
  const falhasDetalhe: Array<{ reservaId: string; motivo: string }> = [];

  for (const reserva of lista) {
    const result = await aplicarRetryLiberacaoCredenciais(ports, {
      reservaId: reserva.reservaId,
      modo,
      state: reserva,
    });
    if (result.enviado) enviadas += 1;
    else if (result.error) {
      falhas += 1;
      falhasDetalhe.push({
        reservaId: reserva.reservaId,
        motivo: String(result.error).slice(0, 120),
      });
    } else ignoradas += 1;
  }

  return {
    encontradas: lista.length,
    processadas: lista.length,
    enviadas,
    ignoradas,
    falhas,
    falhasDetalhe,
  };
}
