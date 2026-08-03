/**
 * Política pura de liberação e envio de credenciais operacionais.
 * Sem I/O — TTLock, DigiSac, Resend e Supabase ficam fora desta camada.
 */

export type PagamentoStatusCredencial = "pago" | "pendente";
export type FnrhStatusCredencial = "completa" | "pendente";

export type OrigemLiberacaoCredencial =
  | "automatico_requisitos"
  | "automatico_13h"
  | "manual";

export type AcaoSolicitadaCredencial =
  | "gerar_enviar"
  | "reenviar"
  | "gerar_nova";

export type PendenciaCredencial = "pagamento" | "fnrh";

export type AcaoPainelCredencial =
  | "gerar_e_enviar"
  | "reenviar"
  | "gerar_nova"
  | "nenhuma"
  | "confirmar_manual";

export type MotivoLiberacaoCredencial =
  | "requisitos_ok"
  | "horario_13h"
  | "manual"
  | "manual_aguardando_confirmacao"
  | "ja_enviada"
  | "reenvio"
  | "gerar_nova"
  | "gerar_nova_aguardando_confirmacao"
  | "envio_em_andamento"
  | "origem_incompativel"
  | "sem_acao";

export interface AvaliarLiberacaoCredenciaisInput {
  pagamentoStatus: PagamentoStatusCredencial;
  fnrhStatus: FnrhStatusCredencial;
  senhaEnviada: boolean;
  dataHoraCheckin: Date | string;
  dataHoraAtual: Date | string;
  origem: OrigemLiberacaoCredencial;
  /** Falha de geração mais recente ainda não resolvida. */
  falhaGeracao?: boolean;
  /** Falha de envio mais recente ainda não resolvida. */
  falhaEnvio?: boolean;
  /**
   * Liberação/envio manual já ocorreu com pendências ainda abertas.
   * Usado para o card vermelho recalculável.
   */
  liberacaoManualComPendencias?: boolean;
  /** Confirmação do operador para liberação manual com pendências. */
  confirmacaoManual?: boolean;
  /** Confirmação explícita para gerar nova senha. */
  confirmacaoGerarNova?: boolean;
  acaoSolicitada?: AcaoSolicitadaCredencial;
  /** Trava de concorrência: outro gatilho já está processando o envio. */
  envioEmAndamento?: boolean;
  /** Fuso para avaliação do gatilho 13h (padrão America/Campo_Grande). */
  timeZone?: string;
}

export interface AvaliarLiberacaoCredenciaisResultado {
  deveGerar: boolean;
  deveEnviar: boolean;
  motivo: MotivoLiberacaoCredencial;
  pendenciasAtuais: PendenciaCredencial[];
  alertaOperacional: string | null;
  acaoPainel: AcaoPainelCredencial;
  exigeConfirmacaoManual: boolean;
  exigeConfirmacaoGerarNova: boolean;
}

const CHECKIN_AUTO_HOUR = 13;
const DEFAULT_TIMEZONE = "America/Campo_Grande";

function parseDateTime(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Data/hora inválida: ${String(value)}`);
  }
  return date;
}

function getZonedPartsForPolicy(date: Date, timeZone: string = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function sameZonedDate(a: Date, b: Date, timeZone: string = DEFAULT_TIMEZONE): boolean {
  const za = getZonedPartsForPolicy(a, timeZone);
  const zb = getZonedPartsForPolicy(b, timeZone);
  return za.year === zb.year && za.month === zb.month && za.day === zb.day;
}

export function listarPendenciasCredenciais(
  pagamentoStatus: PagamentoStatusCredencial,
  fnrhStatus: FnrhStatusCredencial,
): PendenciaCredencial[] {
  const pendencias: PendenciaCredencial[] = [];
  if (pagamentoStatus !== "pago") pendencias.push("pagamento");
  if (fnrhStatus !== "completa") pendencias.push("fnrh");
  return pendencias;
}

export function atingiuHorario13hCheckin(
  dataHoraCheckin: Date | string,
  dataHoraAtual: Date | string,
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  const checkin = parseDateTime(dataHoraCheckin);
  const agora = parseDateTime(dataHoraAtual);
  if (!sameZonedDate(checkin, agora, timeZone)) return false;
  const zoned = getZonedPartsForPolicy(agora, timeZone);
  return (
    zoned.hour > CHECKIN_AUTO_HOUR ||
    (zoned.hour === CHECKIN_AUTO_HOUR && zoned.minute >= 0)
  );
}

export function derivarAlertaOperacional(input: {
  pagamentoStatus: PagamentoStatusCredencial;
  fnrhStatus: FnrhStatusCredencial;
  senhaEnviada: boolean;
  falhaGeracao?: boolean;
  falhaEnvio?: boolean;
  liberacaoManualComPendencias?: boolean;
}): string | null {
  const pendencias = listarPendenciasCredenciais(
    input.pagamentoStatus,
    input.fnrhStatus,
  );

  if (input.falhaGeracao) return "Falha ao gerar senha";
  if (input.falhaEnvio) return "Falha ao enviar credenciais";

  if (input.liberacaoManualComPendencias && pendencias.length > 0) {
    if (pendencias.length === 2) {
      return "Acesso liberado manualmente — pagamento e FNRH pendentes";
    }
    if (pendencias[0] === "fnrh") {
      return "Acesso liberado manualmente — FNRH pendente";
    }
    return "Acesso liberado manualmente — pagamento pendente";
  }

  // Com liberação manual resolvida (sem pendências), o card some.
  if (input.liberacaoManualComPendencias && pendencias.length === 0) {
    return null;
  }

  if (pendencias.length === 2) return "Pagamento e FNRH pendentes";
  if (pendencias[0] === "pagamento") return "Pagamento pendente";
  if (pendencias[0] === "fnrh") return "FNRH pendente";

  if (!input.senhaEnviada) return "Senha ainda não enviada";

  return null;
}

export function derivarAcaoPainel(input: {
  senhaEnviada: boolean;
}): Exclude<AcaoPainelCredencial, "confirmar_manual" | "nenhuma" | "gerar_nova"> {
  return input.senhaEnviada ? "reenviar" : "gerar_e_enviar";
}

function requisitosOk(
  pagamentoStatus: PagamentoStatusCredencial,
  fnrhStatus: FnrhStatusCredencial,
): boolean {
  return pagamentoStatus === "pago" && fnrhStatus === "completa";
}

/**
 * Função central: decide se deve gerar/enviar credenciais e qual alerta/CTA exibir.
 */
export function avaliarLiberacaoCredenciais(
  input: AvaliarLiberacaoCredenciaisInput,
): AvaliarLiberacaoCredenciaisResultado {
  const pendenciasAtuais = listarPendenciasCredenciais(
    input.pagamentoStatus,
    input.fnrhStatus,
  );
  const alertaOperacional = derivarAlertaOperacional({
    pagamentoStatus: input.pagamentoStatus,
    fnrhStatus: input.fnrhStatus,
    senhaEnviada: input.senhaEnviada,
    falhaGeracao: input.falhaGeracao,
    falhaEnvio: input.falhaEnvio,
    liberacaoManualComPendencias: input.liberacaoManualComPendencias,
  });

  const acaoPadraoPainel: AcaoPainelCredencial = input.senhaEnviada
    ? "reenviar"
    : "gerar_e_enviar";

  const base = {
    pendenciasAtuais,
    alertaOperacional,
    acaoPainel: acaoPadraoPainel,
    exigeConfirmacaoManual: false,
    exigeConfirmacaoGerarNova: false,
  };

  if (input.envioEmAndamento) {
    return {
      ...base,
      deveGerar: false,
      deveEnviar: false,
      motivo: "envio_em_andamento",
      acaoPainel: "nenhuma",
    };
  }

  const acao = input.acaoSolicitada ?? "gerar_enviar";

  // Gerar nova senha: ação explícita e separada, sempre exige confirmação.
  if (acao === "gerar_nova") {
    if (!input.confirmacaoGerarNova) {
      return {
        ...base,
        deveGerar: false,
        deveEnviar: false,
        motivo: "gerar_nova_aguardando_confirmacao",
        acaoPainel: "gerar_nova",
        exigeConfirmacaoGerarNova: true,
      };
    }
    return {
      ...base,
      deveGerar: true,
      deveEnviar: true,
      motivo: "gerar_nova",
      acaoPainel: "gerar_nova",
    };
  }

  // Reenvio: reutiliza senha existente; nunca regenera automaticamente.
  if (acao === "reenviar") {
    if (!input.senhaEnviada) {
      return {
        ...base,
        deveGerar: true,
        deveEnviar: true,
        motivo: input.origem === "manual" ? "manual" : "requisitos_ok",
        acaoPainel: "gerar_e_enviar",
      };
    }
    return {
      ...base,
      deveGerar: false,
      deveEnviar: true,
      motivo: "reenvio",
      acaoPainel: "reenviar",
    };
  }

  // Credencial já enviada: gatilhos automáticos não disparam de novo.
  if (input.senhaEnviada) {
    return {
      ...base,
      deveGerar: false,
      deveEnviar: false,
      motivo: "ja_enviada",
      acaoPainel: "reenviar",
    };
  }

  if (input.origem === "automatico_requisitos") {
    if (requisitosOk(input.pagamentoStatus, input.fnrhStatus)) {
      return {
        ...base,
        deveGerar: true,
        deveEnviar: true,
        motivo: "requisitos_ok",
      };
    }
    return {
      ...base,
      deveGerar: false,
      deveEnviar: false,
      motivo: "origem_incompativel",
      acaoPainel: "gerar_e_enviar",
    };
  }

  if (input.origem === "automatico_13h") {
    if (
      atingiuHorario13hCheckin(
        input.dataHoraCheckin,
        input.dataHoraAtual,
        input.timeZone || DEFAULT_TIMEZONE,
      )
    ) {
      return {
        ...base,
        deveGerar: true,
        deveEnviar: true,
        motivo: "horario_13h",
      };
    }
    return {
      ...base,
      deveGerar: false,
      deveEnviar: false,
      motivo: "origem_incompativel",
      acaoPainel: "gerar_e_enviar",
    };
  }

  // Manual: pode a qualquer momento; com pendências exige confirmação.
  if (pendenciasAtuais.length > 0 && !input.confirmacaoManual) {
    return {
      ...base,
      deveGerar: false,
      deveEnviar: false,
      motivo: "manual_aguardando_confirmacao",
      acaoPainel: "confirmar_manual",
      exigeConfirmacaoManual: true,
    };
  }

  return {
    ...base,
    deveGerar: true,
    deveEnviar: true,
    motivo: "manual",
    alertaOperacional:
      pendenciasAtuais.length > 0
        ? derivarAlertaOperacional({
            pagamentoStatus: input.pagamentoStatus,
            fnrhStatus: input.fnrhStatus,
            senhaEnviada: false,
            liberacaoManualComPendencias: true,
          })
        : alertaOperacional,
  };
}

export interface MockCredentialReleaseState {
  senhaEnviada: boolean;
  passcode: string | null;
  envios: number;
  geracoes: number;
  falhaGeracao: boolean;
  falhaEnvio: boolean;
  liberacaoManualComPendencias: boolean;
  historico: Array<{
    tipo: string;
    em: string;
    pendencias?: PendenciaCredencial[];
    usuario?: string;
  }>;
}

export interface ExecutarLiberacaoCredenciaisMockInput
  extends AvaliarLiberacaoCredenciaisInput {
  reservaId: string;
  usuario?: string;
  /** Simula falha na geração (TTLock mock). */
  forcarFalhaGeracao?: boolean;
  /** Simula falha no envio (comunicação mock). */
  forcarFalhaEnvio?: boolean;
  /**
   * Callback executado com a trava ativa — útil para simular segundo gatilho concorrente.
   */
  duringLock?: () => void;
}

export interface ExecutarLiberacaoCredenciaisMockResultado {
  decisao: AvaliarLiberacaoCredenciaisResultado;
  state: MockCredentialReleaseState;
  enviadoNestaExecucao: boolean;
  geradoNestaExecucao: boolean;
}

/** Coordenador em memória para idempotência entre gatilhos concorrentes. */
const enviosEmAndamento = new Set<string>();
const estadosMock = new Map<string, MockCredentialReleaseState>();

export function resetCredentialReleaseMockState(): void {
  enviosEmAndamento.clear();
  estadosMock.clear();
}

export function getCredentialReleaseMockState(
  reservaId: string,
): MockCredentialReleaseState {
  const existing = estadosMock.get(reservaId);
  if (existing) return { ...existing, historico: [...existing.historico] };
  return {
    senhaEnviada: false,
    passcode: null,
    envios: 0,
    geracoes: 0,
    falhaGeracao: false,
    falhaEnvio: false,
    liberacaoManualComPendencias: false,
    historico: [],
  };
}

function setState(reservaId: string, state: MockCredentialReleaseState): void {
  estadosMock.set(reservaId, {
    ...state,
    historico: [...state.historico],
  });
}

/**
 * Executor mock: aplica a decisão sem chamar TTLock/comunicação reais.
 * Garante que o primeiro gatilho válido vence (trava por reservaId).
 */
export function executarLiberacaoCredenciaisMock(
  input: ExecutarLiberacaoCredenciaisMockInput,
): ExecutarLiberacaoCredenciaisMockResultado {
  const current = getCredentialReleaseMockState(input.reservaId);
  const decisao = avaliarLiberacaoCredenciais({
    ...input,
    senhaEnviada: input.senhaEnviada || current.senhaEnviada,
    falhaGeracao: input.falhaGeracao ?? current.falhaGeracao,
    falhaEnvio: input.falhaEnvio ?? current.falhaEnvio,
    liberacaoManualComPendencias:
      input.liberacaoManualComPendencias ?? current.liberacaoManualComPendencias,
    envioEmAndamento: enviosEmAndamento.has(input.reservaId),
  });

  if (!decisao.deveEnviar && !decisao.deveGerar) {
    return {
      decisao,
      state: current,
      enviadoNestaExecucao: false,
      geradoNestaExecucao: false,
    };
  }

  if (enviosEmAndamento.has(input.reservaId)) {
    const blocked = avaliarLiberacaoCredenciais({
      ...input,
      senhaEnviada: current.senhaEnviada,
      envioEmAndamento: true,
    });
    return {
      decisao: blocked,
      state: current,
      enviadoNestaExecucao: false,
      geradoNestaExecucao: false,
    };
  }

  enviosEmAndamento.add(input.reservaId);

  try {
    if (input.duringLock) {
      input.duringLock();
    }

    const next: MockCredentialReleaseState = {
      ...current,
      historico: [...current.historico],
    };
    let geradoNestaExecucao = false;
    let enviadoNestaExecucao = false;

    if (decisao.deveGerar) {
      if (input.forcarFalhaGeracao) {
        next.falhaGeracao = true;
        next.falhaEnvio = false;
        next.historico.push({
          tipo: "falha_gerar_senha",
          em: new Date().toISOString(),
        });
        setState(input.reservaId, next);
        return {
          decisao: {
            ...decisao,
            deveGerar: false,
            deveEnviar: false,
            alertaOperacional: "Falha ao gerar senha",
          },
          state: next,
          enviadoNestaExecucao: false,
          geradoNestaExecucao: false,
        };
      }
      next.geracoes += 1;
      next.passcode = `MOCK-${next.geracoes.toString().padStart(4, "0")}`;
      next.falhaGeracao = false;
      geradoNestaExecucao = true;
    }

    if (decisao.deveEnviar) {
      if (input.forcarFalhaEnvio) {
        next.falhaEnvio = true;
        next.historico.push({
          tipo: "falha_enviar_credenciais",
          em: new Date().toISOString(),
        });
        setState(input.reservaId, next);
        return {
          decisao: {
            ...decisao,
            deveGerar: false,
            deveEnviar: false,
            alertaOperacional: "Falha ao enviar credenciais",
          },
          state: next,
          enviadoNestaExecucao: false,
          geradoNestaExecucao,
        };
      }

      // Reenvio reutiliza passcode existente; geração nova já definiu acima.
      if (!next.passcode) {
        next.passcode = `MOCK-REUSE-${input.reservaId.slice(0, 6)}`;
      }
      next.envios += 1;
      next.senhaEnviada = true;
      next.falhaEnvio = false;
      next.falhaGeracao = false;
      enviadoNestaExecucao = true;

      if (
        input.origem === "manual" &&
        decisao.pendenciasAtuais.length > 0
      ) {
        next.liberacaoManualComPendencias = true;
        next.historico.push({
          tipo: "liberacao_manual_com_pendencias",
          em: new Date().toISOString(),
          pendencias: [...decisao.pendenciasAtuais],
          usuario: input.usuario || "operador",
        });
      } else {
        next.historico.push({
          tipo: geradoNestaExecucao ? "credencial_gerada_enviada" : "credencial_reenviada",
          em: new Date().toISOString(),
          usuario: input.usuario,
        });
      }
    }

    // Recalcula flag de liberação manual: some quando não há mais pendências.
    if (
      next.liberacaoManualComPendencias &&
      listarPendenciasCredenciais(input.pagamentoStatus, input.fnrhStatus)
        .length === 0
    ) {
      next.liberacaoManualComPendencias = false;
    }

    setState(input.reservaId, next);
    return {
      decisao: {
        ...decisao,
        alertaOperacional: derivarAlertaOperacional({
          pagamentoStatus: input.pagamentoStatus,
          fnrhStatus: input.fnrhStatus,
          senhaEnviada: next.senhaEnviada,
          falhaGeracao: next.falhaGeracao,
          falhaEnvio: next.falhaEnvio,
          liberacaoManualComPendencias: next.liberacaoManualComPendencias,
        }),
        acaoPainel: next.senhaEnviada ? "reenviar" : "gerar_e_enviar",
      },
      state: next,
      enviadoNestaExecucao,
      geradoNestaExecucao,
    };
  } finally {
    enviosEmAndamento.delete(input.reservaId);
  }
}
