/**
 * Regras de Demandas — Manutenção Predial (ciclo manual).
 * Autorização real permanece no Postgres; este módulo espelha o contrato.
 */

import { hotelLocalParts } from "./cafe-operational-date.ts";
import { telefoneWhatsappIsAssignable } from "./demandas-telefone.ts";

export const DEMANDAS_TIMEZONE = "America/Campo_Grande";
export const DEMANDAS_FOTOS_BUCKET = "demandas-fotos";
export const DEMANDAS_MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const DEMANDAS_PHOTO_MAX_PX = 1600;
export const DEMANDAS_PHOTO_JPEG_QUALITY = 0.8;

export const DEMANDAS_STATUS = [
  "agendada",
  "nao_iniciada",
  "em_andamento",
  "pausada",
  "aguardando_validacao",
  "em_correcao",
  "concluida",
  "cancelada",
] as const;

export type DemandasStatus = (typeof DEMANDAS_STATUS)[number];

export const DEMANDAS_TIPOS = ["corretiva", "programada"] as const;
export type DemandasTipo = (typeof DEMANDAS_TIPOS)[number];

export const DEMANDAS_PRIORIDADES = ["baixa", "media", "alta"] as const;
export type DemandasPrioridade = (typeof DEMANDAS_PRIORIDADES)[number];

export const DEMANDAS_ANEXO_ETAPAS = [
  "antes",
  "durante",
  "finalizacao",
  "correcao",
] as const;
export type DemandasAnexoEtapa = (typeof DEMANDAS_ANEXO_ETAPAS)[number];

export const DEMANDAS_GEO_ETAPAS = ["inicio", "envio_validacao"] as const;
export type DemandasGeoEtapa = (typeof DEMANDAS_GEO_ETAPAS)[number];

export const DEMANDAS_PERFIS_ATIVOS = ["admin", "recepcao", "cafe"] as const;
export type DemandasPerfil = (typeof DEMANDAS_PERFIS_ATIVOS)[number];

export const DEMANDAS_ALLOWED_PHOTO_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const DEMANDAS_MODELOS_PROGRAMADOS_SEED = [
  {
    nome: "Higienização das sete caixas-d’água da laje",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
  {
    nome: "Limpeza e desobstrução dos chuveiros e arejadores",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 1,
  },
  {
    nome: "Limpeza das caixas de gordura",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Inspeção e desobstrução preventiva da rede de esgoto",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Limpeza de calhas e condutores de chuva",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
  {
    nome: "Limpeza dos filtros dos aparelhos de ar-condicionado",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 2,
  },
  {
    nome: "Higienização completa e revisão dos aparelhos de ar-condicionado",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
  {
    nome: "Conferência da automação dos ar-condicionados",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 1,
  },
  {
    nome: "Inspeção de portas, dobradiças, fechaduras e maçanetas",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Revisão das fechaduras TTLock e substituição preventiva de pilhas",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Revisão de rejuntes e silicones dos banheiros",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
  {
    nome: "Inspeção de infiltração, umidade, mofo e pintura",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Teste da iluminação de emergência",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Conferência dos extintores",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
  {
    nome: "Teste dos gateways TTLock",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Inspeção das câmeras, fontes e conexões",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 3,
  },
  {
    nome: "Dedetização e controle de pragas",
    periodicidade_unidade: "anos",
    periodicidade_intervalo: 1,
  },
  {
    nome: "Limpeza e manutenção da coifa e exaustão",
    periodicidade_unidade: "meses",
    periodicidade_intervalo: 6,
  },
] as const;

export type DemandasActor = {
  id: string;
  role: DemandasPerfil | string;
  active: boolean;
  telefone_whatsapp?: string | null;
};

export type DemandasRecord = {
  id: string;
  criador_id: string;
  supervisor_id: string;
  executor_id: string;
  status: DemandasStatus;
  exigir_foto: boolean;
  sem_local_especifico: boolean;
  data_programada_inicio: string;
  data_prevista_conclusao: string;
  last_rejeicao_ou_reabertura_at?: string | null;
};

export const DEMANDAS_TRANSITIONS: Record<string, readonly DemandasStatus[]> = {
  agendada: ["nao_iniciada", "cancelada"],
  nao_iniciada: ["em_andamento", "cancelada"],
  em_andamento: ["pausada", "aguardando_validacao", "cancelada"],
  pausada: ["em_andamento", "cancelada"],
  aguardando_validacao: ["concluida", "em_correcao", "cancelada"],
  em_correcao: ["em_andamento", "cancelada"],
  concluida: ["em_correcao"],
  cancelada: [],
};

export type DemandasAcao =
  | "criar"
  | "editar"
  | "iniciar"
  | "pausar"
  | "retomar"
  | "enviar_validacao"
  | "aprovar"
  | "rejeitar"
  | "cancelar"
  | "reabrir"
  | "incluir_foto"
  | "configurar_geo"
  | "consultar";

export function demandasHotelTodayYmd(now: Date = new Date()): string {
  return hotelLocalParts(now).ymd;
}

export function initialDemandasStatus(
  dataProgramadaInicio: string,
  todayYmd: string,
): DemandasStatus {
  return dataProgramadaInicio > todayYmd ? "agendada" : "nao_iniciada";
}

export function isDemandasOverdue(input: {
  status: DemandasStatus;
  data_prevista_conclusao: string;
  todayYmd: string;
}): boolean {
  if (input.status === "concluida" || input.status === "cancelada") {
    return false;
  }
  return input.data_prevista_conclusao < input.todayYmd;
}

export function isDemandasMinhas(demanda: DemandasRecord, userId: string): boolean {
  return (
    demanda.criador_id === userId ||
    demanda.supervisor_id === userId ||
    demanda.executor_id === userId
  );
}

export function canAccessDemandas(user: DemandasActor | null | undefined): boolean {
  return Boolean(
    user?.active &&
      DEMANDAS_PERFIS_ATIVOS.includes(user.role as DemandasPerfil),
  );
}

export function isDemandasAdmin(user: DemandasActor): boolean {
  return user.active && user.role === "admin";
}

export function transitionIsAllowed(
  from: DemandasStatus,
  to: DemandasStatus,
): boolean {
  return (DEMANDAS_TRANSITIONS[from] ?? []).includes(to);
}

export function assertAssignablePair(input: {
  supervisor: DemandasActor;
  executor: DemandasActor;
}): void {
  if (!input.supervisor.active || !input.executor.active) {
    throw new Error("demandas_usuario_inativo");
  }
  if (input.supervisor.id === input.executor.id) {
    throw new Error("demandas_supervisor_igual_executor");
  }
  if (!telefoneWhatsappIsAssignable(input.supervisor.telefone_whatsapp)) {
    throw new Error("demandas_telefone_obrigatorio");
  }
  if (!telefoneWhatsappIsAssignable(input.executor.telefone_whatsapp)) {
    throw new Error("demandas_telefone_obrigatorio");
  }
}

export function assertDates(inicio: string, conclusao: string): void {
  if (!inicio || !conclusao) {
    throw new Error("demandas_datas_obrigatorias");
  }
  if (conclusao < inicio) {
    throw new Error("demandas_conclusao_antes_inicio");
  }
}

export function canPerformDemandasAction(
  acao: DemandasAcao,
  user: DemandasActor,
  demanda?: DemandasRecord,
): boolean {
  if (!canAccessDemandas(user)) {
    return false;
  }

  if (acao === "consultar" || acao === "criar") {
    return true;
  }

  if (acao === "configurar_geo") {
    return isDemandasAdmin(user);
  }

  if (!demanda) {
    return false;
  }

  const isCriador = demanda.criador_id === user.id;
  const isSupervisor = demanda.supervisor_id === user.id;
  const isExecutor = demanda.executor_id === user.id;
  const admin = isDemandasAdmin(user);

  switch (acao) {
    case "editar":
      return isCriador || admin;
    case "iniciar":
    case "pausar":
    case "retomar":
    case "enviar_validacao":
      return isExecutor || admin;
    case "aprovar":
    case "rejeitar":
      if (isExecutor) {
        return false;
      }
      return isSupervisor || admin;
    case "cancelar":
    case "reabrir":
      return isCriador || admin;
    case "incluir_foto":
      return isExecutor || isCriador || admin;
    default:
      return false;
  }
}

export function statusAposAcao(
  acao: Exclude<DemandasAcao, "consultar" | "criar" | "editar" | "incluir_foto" | "configurar_geo">,
  statusAtual: DemandasStatus,
): DemandasStatus {
  const map: Record<string, DemandasStatus> = {
    iniciar: "em_andamento",
    pausar: "pausada",
    retomar: "em_andamento",
    enviar_validacao: "aguardando_validacao",
    aprovar: "concluida",
    rejeitar: "em_correcao",
    cancelar: "cancelada",
    reabrir: "em_correcao",
  };
  const next = map[acao];
  if (!next || !transitionIsAllowed(statusAtual, next)) {
    throw new Error("demandas_transicao_invalida");
  }
  return next;
}

export function fotoObrigatoriaNoEnvio(input: {
  exigir_foto: boolean;
  anexos: { created_at: string }[];
  last_rejeicao_ou_reabertura_at: string | null;
}): boolean {
  if (!input.exigir_foto) {
    return false;
  }
  if (!input.last_rejeicao_ou_reabertura_at) {
    return input.anexos.length === 0;
  }
  return !input.anexos.some(
    (anexo) => anexo.created_at > input.last_rejeicao_ou_reabertura_at!,
  );
}

export function canStartScheduled(demanda: DemandasRecord, todayYmd: string): boolean {
  if (demanda.status === "agendada" && demanda.data_programada_inicio > todayYmd) {
    return false;
  }
  return true;
}

export function dashboardCardVisible(
  card:
    | "checkin"
    | "cafe"
    | "usuarios"
    | "gestao"
    | "financeiro"
    | "minhas_demandas"
    | "demandas",
  user: DemandasActor,
): boolean {
  if (!user.active) {
    return false;
  }
  switch (card) {
    case "minhas_demandas":
    case "demandas":
    case "cafe":
      return canAccessDemandas(user);
    case "checkin":
    case "gestao":
      return user.role === "admin" || user.role === "recepcao";
    case "usuarios":
    case "financeiro":
      return user.role === "admin";
    default:
      return false;
  }
}
