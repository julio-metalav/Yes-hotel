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
  | "manual";

export interface CredentialReleaseReservationState {
  reservaId: string;
  pagamentoStatus: "pago" | "pendente";
  fnrhStatus: "completa" | "pendente";
  senhaEnviada: boolean;
  dataHoraCheckin: Date | string;
  email?: string | null;
  whatsapp?: string | null;
  acessoLiberado?: boolean;
}

export interface CredentialReleaseSendResult {
  ok: boolean;
  error?: string;
  /** true quando o envio foi pulado por já ter sido feito */
  skipped?: boolean;
}

export interface CredentialReleasePorts {
  loadReservation(reservaId: string): Promise<CredentialReleaseReservationState | null>;
  /** Lista reservas com check-in na data (YYYY-MM-DD). */
  listCheckinsOnDate?(dateYmd: string): Promise<CredentialReleaseReservationState[]>;
  ensureAccessLiberated?(reservaId: string): Promise<{ ok: boolean; error?: string }>;
  sendCredentials(input: {
    reservaId: string;
    manual: boolean;
    origem: CredentialReleaseOrigemRegistro;
    email?: string;
    whatsapp?: string;
    usuarioId?: string;
    gerarNova?: boolean;
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

/**
 * Função chamável por scheduler (sem cron nesta etapa).
 * Idempotente: reservas já enviadas são ignoradas.
 */
export async function aplicarLiberacaoCredenciais13h(
  ports: CredentialReleasePorts,
  options?: { dataHoraAtual?: Date; dateYmd?: string },
): Promise<{
  processadas: number;
  enviadas: number;
  ignoradas: number;
  falhas: number;
  resultados: AplicarLiberacaoCredenciaisResultado[];
}> {
  const agora = options?.dataHoraAtual ?? (ports.now ? ports.now() : new Date());
  const y = agora.getFullYear();
  const m = String(agora.getMonth() + 1).padStart(2, "0");
  const d = String(agora.getDate()).padStart(2, "0");
  const dateYmd = options?.dateYmd ?? `${y}-${m}-${d}`;

  if (!ports.listCheckinsOnDate) {
    return {
      processadas: 0,
      enviadas: 0,
      ignoradas: 0,
      falhas: 0,
      resultados: [],
    };
  }

  const reservas = await ports.listCheckinsOnDate(dateYmd);
  const timedPorts: CredentialReleasePorts = {
    ...ports,
    now: () => agora,
  };
  const resultados: AplicarLiberacaoCredenciaisResultado[] = [];
  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;

  for (const reserva of reservas) {
    const result = await aplicarLiberacaoCredenciais(timedPorts, {
      reservaId: reserva.reservaId,
      origem: "automatico_13h",
      state: reserva,
    });
    resultados.push(result);
    if (result.enviado) enviadas += 1;
    else if (result.error) falhas += 1;
    else ignoradas += 1;
  }

  return {
    processadas: reservas.length,
    enviadas,
    ignoradas,
    falhas,
    resultados,
  };
}
