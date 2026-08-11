/**
 * Painel de Check-in Operacional — Yes Hotel MVP
 *
 * Estrutura do arquivo (preparado para futura integração com backend):
 * - Constantes / enums: filtros, prioridades, status de hóspede, origem cadastro, etapa funil
 * - Refs DOM: elementos da página
 * - Estado base: lista de reservas (mock; futuramente substituível por API)
 * - Selectors / derivados: leitura de estado (getReservaById, getEtapaFunilReserva, etc.)
 * - Ações de domínio: mutações semânticas que alteram estado e chamam refresh()
 * - Render: atualização da UI (summary, filters, list, detail)
 * - Bindings: init, listeners de filtro e drawer
 */
"use strict";

const auth = window.YesHotelAuthApp;
const operacionalRepository =
  typeof window !== "undefined" ? window.YesHotelOperacionalRepository : null;

/* ---------- Refs DOM ---------- */
const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const sessionUserElement = document.querySelector("#session-user");
const sessionUserNameElement = document.querySelector("#op-session-user-name");
const sessionUserRoleElement = document.querySelector("#op-session-user-role");
const logoutButtonElement = document.querySelector("#op-logout-btn");
const opStatusTabsElement = document.querySelector("#op-status-tabs");
const opSearchInput = document.querySelector("#op-search");
const opToolbarStatusSelect = document.querySelector("#op-toolbar-status");
const opPeriodSelect = document.querySelector("#op-period");
const opRefreshBtn = document.querySelector("#op-refresh-btn");
const opImportLink = document.querySelector("#op-import-link");
const opTableBody = document.querySelector("#op-table-body");
const opMobileList = document.querySelector("#op-mobile-list");
const opEmptyState = document.querySelector("#op-empty");
const opTableCount = document.querySelector("#op-table-count");
const opLoadingEl = document.querySelector("#op-loading");
const excecoesStripElement = document.querySelector("#operacional-excecoes");
const detailPanelElement = document.querySelector("#reservation-detail-panel");
const detailBackdropElement = document.querySelector("#reservation-detail-backdrop");
const detailTitleElement = document.querySelector("#reservation-detail-title");
const detailSubtitleElement = document.querySelector("#reservation-detail-subtitle");
const detailBodyElement = document.querySelector("#reservation-detail-body");
const detailCloseButtonElement = document.querySelector("#reservation-detail-close");
const opDetailEmpty = document.querySelector("#op-detail-empty");
const opDetailFilled = document.querySelector("#op-detail-filled");
const opDetailApto = document.querySelector("#op-detail-apto");
const opDetailBadgeWrap = document.querySelector("#op-detail-badge-wrap");
const opKpiArrivals = document.querySelector("#op-kpi-arrivals");
const opKpiArrivalsNote = document.querySelector("#op-kpi-arrivals-note");
const opKpiCompleted = document.querySelector("#op-kpi-completed");
const opKpiCompletedNote = document.querySelector("#op-kpi-completed-note");
const opKpiFnrh = document.querySelector("#op-kpi-fnrh");
const opKpiFnrhNote = document.querySelector("#op-kpi-fnrh-note");
const opKpiAccess = document.querySelector("#op-kpi-access");
const opKpiOccupiedBtn = document.querySelector("#op-kpi-occupied-btn");
const opKpiOccupiedGuests = document.querySelector("#op-kpi-occupied-guests");
const opKpiOccupiedApts = document.querySelector("#op-kpi-occupied-apts");
const opChegadasPanel = document.querySelector("#op-chegadas-panel");
const opChegadasBody = document.querySelector("#op-chegadas-body");
const opChegadasCount = document.querySelector("#op-chegadas-count");
const opChegadasEmpty = document.querySelector("#op-chegadas-empty");
const opChegadasPager = document.querySelector("#op-chegadas-pager");
const opChegadasPageLabel = document.querySelector("#op-chegadas-page-label");
const opReservasControls = document.querySelector("#op-reservas-controls");
const opReservasMain = document.querySelector("#op-reservas-main");
const opOccupiedDrawer = document.querySelector("#op-occupied-drawer");
const opOccupiedList = document.querySelector("#op-occupied-list");

/* ---------- Utils (data/hora, formatação) ---------- */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getPanelPresentation() {
  return (typeof globalThis !== "undefined" && globalThis.YesHotelCheckinPanelPresentation) || null;
}

function formatHistoricoTimestamp(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  const P = getPanelPresentation();
  if (P && typeof P.formatDateTimeCampoGrande === "function") {
    return P.formatDateTimeCampoGrande(date);
  }
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const h = date.getHours();
  const min = date.getMinutes();
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function addHistoricoEvento(reserva, tipo, titulo, detalhe) {
  if (!reserva) return;
  if (!reserva.historicoOperacional) reserva.historicoOperacional = [];
  const now = new Date();
  reserva.historicoOperacional.push({
    tipo,
    titulo,
    detalhe: detalhe || null,
    em: formatHistoricoTimestamp(now),
    criadoEmIso: now.toISOString(),
  });
}

function maybeRegistrarFnrhCompleta(reserva, confirmadasAntes) {
  if (!reserva || !Array.isArray(reserva.hospedes)) return;
  const total = reserva.hospedes.length;
  const agora = getFnrhConfirmadas(reserva);
  if (total > 0 && agora === total && confirmadasAntes < total) {
    addHistoricoEvento(reserva, "fnrh_completa", "FNRH completa da reserva", null);
  }
}

/* ---------- Constantes / enums ---------- */
const FILTER_ALL = "all";
const FILTER_CHEGANDO_HOJE = "chegando_hoje";
const FILTER_PENDENTE_PAGAMENTO = "pendente_pagamento";
const FILTER_PENDENTE_FNRH = "pendente_fnrh";
const FILTER_ACESSO_LIBERADO = "acesso_liberado";
const FILTER_NAO_ENTROU = "nao_entrou";
const FILTER_ENTROU = "entrou";
const FILTER_PRIORIDADE_ALTA = "prioridade_alta";
const FILTER_PRIORIDADE_MEDIA = "prioridade_media";
const FILTER_PRIORIDADE_BAIXA = "prioridade_baixa";
const FILTER_ETAPA_DADOS_PENDENTES = "etapa_dados_pendentes";
const FILTER_ETAPA_FNRH_EM_ANDAMENTO = "etapa_fnrh_em_andamento";
const FILTER_ETAPA_PRONTA_LIBERAR = "etapa_pronta_liberar";
const FILTER_ETAPA_ACESSO_LIBERADO = "etapa_acesso_liberado";
const FILTER_ETAPA_CHECKIN_CONCLUIDO = "etapa_checkin_concluido";

const PRIORIDADE_ALTA = "alta";
const PRIORIDADE_MEDIA = "media";
const PRIORIDADE_BAIXA = "baixa";

function isChegadaHoje(reserva) {
  return reserva.checkInPrevisto === todayStr();
}

/** Há itens críticos (pendente/falhou sem pwd) em alguma credencial da reserva — usado só para aviso “TTLock incompleto”. */
function ttlockBloqueiaLiberadoNoPainel(reserva) {
  return !!(reserva && reserva.ttlockBloqueiaLiberado);
}

/**
 * Estado agregado para lista/cartão: liberado se a reserva está marcada no banco OU
 * todos os itens da(s) credencial(is) principal(is) ativa(s) estão provisionados no TTLock.
 */
function acessoLiberadoEfetivo(reserva) {
  if (!reserva) return false;
  if (!!reserva.acessoLiberado) return true;
  if (!!reserva.ttlockPrincipalTodosProvisionados) return true;
  return false;
}

function getPrioridadeReserva(reserva) {
  if (isCheckinConcluido(reserva)) return PRIORIDADE_BAIXA;
  if (isProntaParaLiberarAcesso(reserva)) return PRIORIDADE_ALTA;
  if (acessoLiberadoEfetivo(reserva) && !reserva.entrouNoApto) return PRIORIDADE_ALTA;
  if (isChegadaHoje(reserva)) return PRIORIDADE_ALTA;
  return PRIORIDADE_MEDIA;
}

function getPrioridadeLabel(prioridade) {
  const labels = { [PRIORIDADE_ALTA]: "Alta", [PRIORIDADE_MEDIA]: "Média", [PRIORIDADE_BAIXA]: "Baixa" };
  return labels[prioridade] || "";
}

/**
 * Fila operacional da lista: 0 = mais urgente … 4 = concluído.
 * Usa os mesmos predicados do painel (pagamento, FNRH, acesso, senha backend, entrada).
 */
function getFilaOperacionalRank(reserva) {
  if (!isPagamentoOk(reserva)) return 0;
  if (hasFnrhPendente(reserva) || !isFnrhCompleta(reserva)) return 1;
  if (!acessoLiberadoEfetivo(reserva)) return 2;
  if (!reserva.entrouNoApto) {
    if (senhaOperacionalPendenteLista(reserva)) return 2;
    return 3;
  }
  return 4;
}

/** Senha não enviada/registrada com backend, com FNRH completa no sistema e acesso liberado — mesmo recorte da recomendação operacional. */
function senhaOperacionalPendenteLista(reserva) {
  if (PAINEL_DATA_SOURCE !== PAINEL_DATA_SOURCE_BACKEND) return false;
  if (!acessoLiberadoEfetivo(reserva) || reserva.entrouNoApto) return false;
  if (!isFnrhCompleta(reserva)) return false;
  const agg = String(reserva.fnrhStatusAgregado || "").trim();
  if (agg !== "" && agg !== "fnrh_completo") return false;
  if (reserva.senhaEnviadaEm) return false;
  const ob = obterUltimosEventosSenha(reserva);
  if (ob && ob.lastOkSenha) return false;
  return true;
}

function apartmentNumberValue(code) {
  const match = String(code ?? "").trim().match(/(\d+)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function compareApartamentoCrescente(a, b) {
  const sa = String(a.apartamento != null ? a.apartamento : "").trim();
  const sb = String(b.apartamento != null ? b.apartamento : "").trim();
  const na = apartmentNumberValue(sa);
  const nb = apartmentNumberValue(sb);
  if (na !== nb) return na - nb;
  return sa.localeCompare(sb, "pt-BR", { numeric: true, sensitivity: "base" });
}

function sortReservasPorPrioridade(lista) {
  return [...lista].sort((a, b) => {
    const apt = compareApartamentoCrescente(a, b);
    if (apt !== 0) return apt;
    const ra = getFilaOperacionalRank(a);
    const rb = getFilaOperacionalRank(b);
    if (ra !== rb) return ra - rb;
    return String(a.id || "").localeCompare(String(b.id || ""), "pt-BR");
  });
}

const GUEST_STATUS = {
  NAO_IDENTIFICADO: "nao_identificado",
  AGUARDANDO_CONTATO: "aguardando_contato",
  PRONTO_PARA_ENVIO: "pronto_para_envio",
  ENVIADO: "enviado",
  CONFIRMADO: "confirmado",
};

const ORIGEM_CADASTRO = {
  EXISTENTE_COMPLETO: "existente_completo",
  EXISTENTE_INCOMPLETO: "existente_incompleto",
  NOVO: "novo",
  AGENCIA_SEM_DADOS: "agencia_sem_dados",
};

const MODO_COLETA_FNRH = {
  CONFIRMACAO_SIMPLIFICADA: "confirmacao_simplificada",
  PREENCHIMENTO_COMPLETO: "preenchimento_completo",
};

function guestStatusLabel(s) {
  const labels = {
    [GUEST_STATUS.NAO_IDENTIFICADO]: "Não identificado",
    [GUEST_STATUS.AGUARDANDO_CONTATO]: "Aguardando contato",
    [GUEST_STATUS.PRONTO_PARA_ENVIO]: "Pronto para envio",
    [GUEST_STATUS.ENVIADO]: "Link enviado",
    [GUEST_STATUS.CONFIRMADO]: "FNRH confirmada",
  };
  return labels[s] || s;
}

function guestStatusClass(s) {
  const classes = {
    [GUEST_STATUS.NAO_IDENTIFICADO]: "guest-status-nao-identificado",
    [GUEST_STATUS.AGUARDANDO_CONTATO]: "guest-status-aguardando",
    [GUEST_STATUS.PRONTO_PARA_ENVIO]: "guest-status-pronto",
    [GUEST_STATUS.ENVIADO]: "guest-status-enviado",
    [GUEST_STATUS.CONFIRMADO]: "guest-status-confirmado",
  };
  return classes[s] || "";
}

function getOrigemCadastroLabel(origem) {
  const labels = {
    [ORIGEM_CADASTRO.EXISTENTE_COMPLETO]: "Já cadastrado",
    [ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO]: "Cadastrado incompleto",
    [ORIGEM_CADASTRO.NOVO]: "Novo hóspede",
    [ORIGEM_CADASTRO.AGENCIA_SEM_DADOS]: "Veio sem dados da reserva",
  };
  return labels[origem] || "";
}

function getModoColetaLabel(modo) {
  const labels = {
    [MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA]: "Confirmação simplificada",
    [MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO]: "Preenchimento completo",
  };
  return labels[modo] || "";
}

function syncGuestOriginAndCollectionMode(hospede) {
  const origem = hospede.origemCadastro || ORIGEM_CADASTRO.NOVO;
  if (origem === ORIGEM_CADASTRO.EXISTENTE_COMPLETO) {
    hospede.modoColetaFnrh = MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA;
  } else {
    hospede.modoColetaFnrh = MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO;
  }
}

function getGuestOperationalMessage(hospede) {
  const status = hospede.statusOperacional;
  const origem = hospede.origemCadastro || ORIGEM_CADASTRO.NOVO;
  const modo = hospede.modoColetaFnrh || MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO;
  const ident = hasIdentificacaoMinima(hospede);
  const contato = hasContatoSuficiente(hospede);

  if (status === GUEST_STATUS.CONFIRMADO) {
    return "FNRH confirmada";
  }
  if (status === GUEST_STATUS.ENVIADO) {
    return "Link enviado, aguardando confirmação";
  }
  if (!ident) {
    if (origem === ORIGEM_CADASTRO.AGENCIA_SEM_DADOS) return "Dados insuficientes da reserva, completar e enviar FNRH";
    if (origem === ORIGEM_CADASTRO.NOVO) return "Novo hóspede, preencher FNRH completa";
    return "Falta identificar hóspede";
  }
  if (!contato) {
    if (origem === ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO) return "Cadastro incompleto, precisa preenchimento completo";
    return "Falta email ou WhatsApp";
  }
  if (status === GUEST_STATUS.PRONTO_PARA_ENVIO) {
    if (modo === MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA) return "Hóspede já cadastrado, aguardando confirmação simplificada";
    return "Pronto para envio de FNRH completa";
  }
  if (origem === ORIGEM_CADASTRO.EXISTENTE_COMPLETO && modo === MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA) {
    return "Hóspede já cadastrado, aguardando confirmação simplificada";
  }
  if (origem === ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO) return "Cadastro incompleto, precisa preenchimento completo";
  if (origem === ORIGEM_CADASTRO.AGENCIA_SEM_DADOS) return "Dados insuficientes da reserva, completar e enviar FNRH";
  return "Novo hóspede, precisa preencher FNRH completa";
}

/*
 * Modelo interno do painel (fonte da verdade para renderização).
 * Reserva: id, apartamento, hospedePrincipal, checkInPrevisto, checkOutPrevisto, pagamento,
 *   acessoLiberado, entrouNoApto, veiculoPlaca, veiculoCor, hospedes[], historicoOperacional[].
 * Hóspede: id, nome, principal, email, whatsapp, statusOperacional, origemCadastro, modoColetaFnrh,
 *   ultimoEnvioCanal, ultimoEnvioEm, tentativasEnvio.
 * Payloads externos (API/HITS/Supabase) devem ser convertidos por esta camada, não usados direto na UI.
 */

/* ---------- Adaptação de entrada (payload externo → modelo interno) ---------- */
function sanitizeString(val) {
  if (val == null) return "";
  return String(val).trim();
}

function createHospedeId(reservaId, index) {
  return sanitizeString(reservaId) + "-" + (index != null ? Number(index) : 0);
}

function pickEnumValue(val, enumObj, fallback) {
  if (val == null || val === "") return fallback;
  const s = String(val).trim();
  if (Object.values(enumObj).includes(s)) return s;
  const lower = s.toLowerCase();
  const found = Object.values(enumObj).find((v) => String(v).toLowerCase() === lower);
  return found != null ? found : fallback;
}

function ensureHospedeDefaults(payload) {
  if (!payload || typeof payload !== "object") payload = {};
  const id = payload.id != null ? sanitizeString(String(payload.id)) : null;
  const nome = sanitizeString(payload.nome ?? payload.name ?? "");
  const principal = !!(payload.principal ?? payload.is_primary);
  const email = sanitizeString(payload.email ?? "");
  const whatsapp = sanitizeString(payload.whatsapp ?? payload.phone ?? "");
  const statusOperacional = pickEnumValue(payload.statusOperacional ?? payload.status, GUEST_STATUS, GUEST_STATUS.NAO_IDENTIFICADO);
  const origemCadastro = pickEnumValue(payload.origemCadastro ?? payload.origem, ORIGEM_CADASTRO, ORIGEM_CADASTRO.NOVO);
  const modoColetaFnrh = pickEnumValue(payload.modoColetaFnrh ?? payload.modo_coleta, MODO_COLETA_FNRH, MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO);
  const tentativasEnvio = payload.tentativasEnvio != null ? Number(payload.tentativasEnvio) : 0;
  return {
    id,
    nome,
    principal,
    email,
    whatsapp,
    statusOperacional,
    origemCadastro,
    modoColetaFnrh,
    ultimoEnvioCanal: payload.ultimoEnvioCanal != null ? payload.ultimoEnvioCanal : null,
    ultimoEnvioEm: payload.ultimoEnvioEm != null ? payload.ultimoEnvioEm : null,
    tentativasEnvio,
  };
}

function ensureReservaDefaults(payload) {
  if (!payload || typeof payload !== "object") payload = {};
  const id = payload.id != null ? sanitizeString(String(payload.id)) : "";
  const apartamento = sanitizeString(payload.apartamento ?? payload.room_number ?? payload.room ?? "") || "";
  const hospedePrincipal = sanitizeString(payload.hospedePrincipal ?? payload.primary_guest ?? "") || "";
  const checkInPrevisto = sanitizeString(payload.checkInPrevisto ?? payload.check_in ?? payload.checkIn ?? "") || "";
  const checkOutPrevisto = sanitizeString(payload.checkOutPrevisto ?? payload.check_out ?? payload.checkOut ?? "") || "";
  const pagamento = payload.pagamento === "pago" ? "pago" : "pendente";
  const acessoLiberado = !!(payload.acessoLiberado ?? payload.access_granted);
  const entrouNoApto = !!(payload.entrouNoApto ?? payload.checked_in);
  const veiculoPlaca = sanitizeString(payload.veiculoPlaca ?? payload.vehicle_plate ?? "") || "";
  const veiculoCor = sanitizeString(payload.veiculoCor ?? payload.vehicle_color ?? "") || "";
  const historicoOperacional = Array.isArray(payload.historicoOperacional) ? payload.historicoOperacional : [];
  const fnrhStatusAgregado =
    sanitizeString(payload.fnrhStatusAgregado ?? payload.fnrh_status_agregado ?? "fnrh_pendente") || "fnrh_pendente";
  const fnrhCompletoEm = payload.fnrhCompletoEm ?? payload.fnrh_completo_em ?? null;
  const senhaEnviadaEm = payload.senhaEnviadaEm ?? payload.senha_enviada_em ?? null;
  const comunicacaoEnviosOperacional = Array.isArray(payload.comunicacaoEnviosOperacional)
    ? payload.comunicacaoEnviosOperacional
    : [];
  const sourceMode = sanitizeString(payload.sourceMode ?? payload.source_mode ?? "");
  const quantidadeHospedes = Math.max(
    1,
    Number(payload.quantidadeHospedes ?? payload.guestCount) || 1,
  );
  return {
    id,
    sourceMode,
    apartamento,
    hospedePrincipal,
    checkInPrevisto,
    checkOutPrevisto,
    checkInHorario: sanitizeString(payload.checkInHorario ?? payload.checkInTime ?? "14:00") || "14:00",
    checkOutHorario: sanitizeString(payload.checkOutHorario ?? payload.checkOutTime ?? "12:00") || "12:00",
    quantidadeHospedes,
    observacoes: sanitizeString(payload.observacoes ?? payload.observacoesOperacionais ?? ""),
    pagamento,
    acessoLiberado,
    entrouNoApto,
    ttlockStatus: sanitizeString(payload.ttlockStatus ?? "mock") || "mock",
    comunicacaoStatus: sanitizeString(payload.comunicacaoStatus ?? "mock") || "mock",
    veiculoPlaca,
    veiculoCor,
    hospedes: [],
    historicoOperacional,
    fnrhStatusAgregado,
    fnrhCompletoEm,
    senhaEnviadaEm,
    comunicacaoEnviosOperacional,
    createdAt: payload.createdAt ?? null,
    updatedAt: payload.updatedAt ?? null,
  };
}

function normalizarHospedeExterno(payload, reservaId, index) {
  const safePayload = payload != null && typeof payload === "object" ? payload : {};
  const base = ensureHospedeDefaults(safePayload);
  if (!base.id) base.id = createHospedeId(reservaId, index);
  return base;
}

function toGuestArray(val, reservaId) {
  if (Array.isArray(val)) return val;
  if (val != null && typeof val === "object") return [val];
  return [];
}

function normalizarReservaExterna(payload) {
  if (!payload || typeof payload !== "object") {
    if (typeof console !== "undefined" && console.warn) console.warn("[painel] normalizarReservaExterna: payload inválido, ignorado");
    return null;
  }
  const reserva = ensureReservaDefaults(payload);
  const rawHospedes = payload.hospedes ?? payload.guests;
  const rawGuests = toGuestArray(rawHospedes, reserva.id);
  reserva.hospedes = rawGuests.map((g, i) => normalizarHospedeExterno(g, reserva.id || String(i), i + 1));
  if (payload.quantidadeHospedes == null && payload.guestCount == null) {
    reserva.quantidadeHospedes = Math.max(1, reserva.hospedes.length);
  }
  if (!reserva.hospedePrincipal && reserva.hospedes.length > 0) {
    const principal = reserva.hospedes.find((h) => h.principal) || reserva.hospedes[0];
    reserva.hospedePrincipal = (principal && principal.nome) ? principal.nome : "";
  }
  if (reserva.hospedes.length === 0 && typeof console !== "undefined" && console.warn) {
    console.warn("[painel] Reserva sem hóspedes (id=" + (reserva.id || "?") + "), pode precisar adicionar no painel");
  }
  return reserva;
}

function normalizarListaReservasExternas(payloads) {
  if (payloads == null) return [];
  if (!Array.isArray(payloads)) {
    if (typeof payloads === "object" && payloads.reservas) return normalizarListaReservasExternas(payloads.reservas);
    return [];
  }
  const list = payloads
    .map((p) => normalizarReservaExterna(p))
    .filter((r) => r != null);
  if (list.length === 0 && payloads.length > 0 && typeof console !== "undefined" && console.warn) {
    console.warn("[painel] Nenhuma reserva válida após normalização");
  }
  return list;
}

/* ---------- Serialização de saída (modelo interno → formato para backend) ---------- */
function serializarHospedeOperacional(hospede) {
  if (!hospede) return null;
  return {
    id: hospede.id,
    nome: hospede.nome,
    principal: !!hospede.principal,
    email: hospede.email || "",
    whatsapp: hospede.whatsapp || "",
    statusOperacional: hospede.statusOperacional,
    origemCadastro: hospede.origemCadastro,
    modoColetaFnrh: hospede.modoColetaFnrh,
    ultimoEnvioCanal: hospede.ultimoEnvioCanal ?? null,
    ultimoEnvioEm: hospede.ultimoEnvioEm ?? null,
    tentativasEnvio: hospede.tentativasEnvio ?? 0,
  };
}

function serializarReservaOperacional(reserva) {
  if (!reserva) return null;
  return {
    id: reserva.id,
    sourceMode: reserva.sourceMode || "",
    apartamento: reserva.apartamento,
    hospedePrincipal: reserva.hospedePrincipal,
    checkInPrevisto: reserva.checkInPrevisto,
    checkOutPrevisto: reserva.checkOutPrevisto,
    checkInHorario: reserva.checkInHorario || "14:00",
    checkOutHorario: reserva.checkOutHorario || "12:00",
    quantidadeHospedes: reserva.quantidadeHospedes || (reserva.hospedes || []).length || 1,
    observacoes: reserva.observacoes || "",
    pagamento: reserva.pagamento,
    acessoLiberado: !!reserva.acessoLiberado,
    entrouNoApto: !!reserva.entrouNoApto,
    ttlockStatus: reserva.ttlockStatus || "mock",
    comunicacaoStatus: reserva.comunicacaoStatus || "mock",
    veiculoPlaca: reserva.veiculoPlaca || "",
    veiculoCor: reserva.veiculoCor || "",
    hospedes: (reserva.hospedes || []).map(serializarHospedeOperacional),
    historicoOperacional: Array.isArray(reserva.historicoOperacional) ? reserva.historicoOperacional : [],
    fnrhStatusAgregado: reserva.fnrhStatusAgregado || "fnrh_pendente",
    createdAt: reserva.createdAt || null,
    updatedAt: reserva.updatedAt || null,
  };
}

function serializarPainelOperacional(reservasList) {
  if (!Array.isArray(reservasList)) return [];
  return reservasList.map(serializarReservaOperacional);
}

/*
 * Pré-integração HITS: contrato e adaptador sem credenciais reais.
 * Pipeline: HITS futuro → adaptador HITS → payload externo padronizado → normalização → modelo interno → UI.
 * O que depende de credenciais: fetch real, auth headers, baseUrl. Interface do adaptador já é definitiva.
 */
/* ---------- Config / contrato esperado do HITS ---------- */
const HITS_CONFIG = {
  baseUrl: "",
  authType: "bearer",
  reservationsListPath: "/reservations",
  reservationDetailPath: "/reservations/:id",
  hasCredentials: false,
  available: false,
};

function getHitsAdapterInfo() {
  return {
    available: HITS_CONFIG.available && HITS_CONFIG.hasCredentials,
    hasCredentials: HITS_CONFIG.hasCredentials,
    baseUrl: HITS_CONFIG.baseUrl || "(não configurado)",
  };
}

/** Mapeia um hóspede no formato HITS para o payload externo do painel. Placeholder até contrato real. */
function mapHitsGuestToExternalPayload(hitsGuest, index) {
  if (!hitsGuest || typeof hitsGuest !== "object") return null;
  const g = hitsGuest;
  return {
    id: g.id ?? g.guestId ?? null,
    nome: sanitizeString(g.nome ?? g.name ?? g.guestName ?? ""),
    principal: !!(g.principal ?? g.isPrimary ?? g.primary ?? index === 0),
    email: sanitizeString(g.email ?? g.mail ?? ""),
    whatsapp: sanitizeString(g.whatsapp ?? g.phone ?? g.cellPhone ?? ""),
    statusOperacional: pickEnumValue(g.statusOperacional ?? g.status ?? g.fnrhStatus, GUEST_STATUS, GUEST_STATUS.NAO_IDENTIFICADO),
    origemCadastro: pickEnumValue(g.origemCadastro ?? g.origin, ORIGEM_CADASTRO, ORIGEM_CADASTRO.NOVO),
    modoColetaFnrh: pickEnumValue(g.modoColetaFnrh ?? g.collectionMode, MODO_COLETA_FNRH, MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO),
    ultimoEnvioCanal: g.ultimoEnvioCanal ?? g.lastSendChannel ?? null,
    ultimoEnvioEm: g.ultimoEnvioEm ?? g.lastSentAt ?? null,
    tentativasEnvio: g.tentativasEnvio != null ? Number(g.tentativasEnvio) : (g.sendAttempts != null ? Number(g.sendAttempts) : 0),
  };
}

/** Mapeia uma reserva no formato HITS para o payload externo consumível pela normalização do painel. */
function mapHitsReservationToExternalPayload(hitsReservation) {
  if (!hitsReservation || typeof hitsReservation !== "object") return null;
  const r = hitsReservation;
  const rawGuests = Array.isArray(r.hospedes) ? r.hospedes : Array.isArray(r.guests) ? r.guests : Array.isArray(r.guestList) ? r.guestList : [];
  const hospedes = rawGuests.map((g, i) => mapHitsGuestToExternalPayload(g, i)).filter(Boolean);
  return {
    id: r.id ?? r.reservationId ?? r.reservation_id ?? "",
    apartamento: sanitizeString(r.apartamento ?? r.roomNumber ?? r.room_number ?? r.room ?? ""),
    hospedePrincipal: sanitizeString(r.hospedePrincipal ?? r.primaryGuest ?? r.primary_guest ?? (hospedes[0] && hospedes[0].nome) ? hospedes[0].nome : ""),
    checkInPrevisto: sanitizeString(r.checkInPrevisto ?? r.checkIn ?? r.check_in ?? r.arrivalDate ?? ""),
    checkOutPrevisto: sanitizeString(r.checkOutPrevisto ?? r.checkOut ?? r.check_out ?? r.departureDate ?? ""),
    pagamento:
      r.pagamento === "pago" || r.paymentStatus === "paid" || r.paymentStatus === "pago"
        ? "pago"
        : r.pagamento === "parcial" || r.paymentStatus === "parcial"
          ? "parcial"
          : r.pagamento === "desconhecido" || r.paymentStatus === "desconhecido" || r.paymentStatus === "unknown"
            ? "desconhecido"
            : r.pagamento === "pendente" || r.paymentStatus === "pending" || r.paymentStatus === "pendente"
              ? "pendente"
              : "desconhecido",
    statusReserva: r.statusReserva === "cancelada" || r.status === 2 || r.status === "cancelada" ? "cancelada" : "ativa",
    externalReservationId: sanitizeString(r.externalReservationId ?? r.external_reservation_id ?? r.idReservation ?? "") || null,
    acessoLiberado: !!(r.acessoLiberado ?? r.accessGranted ?? r.access_granted),
    entrouNoApto: !!(r.entrouNoApto ?? r.checkedIn ?? r.checked_in),
    veiculoPlaca: sanitizeString(r.veiculoPlaca ?? r.vehiclePlate ?? r.vehicle_plate ?? ""),
    veiculoCor: sanitizeString(r.veiculoCor ?? r.vehicleColor ?? r.vehicle_color ?? ""),
    hospedes,
    historicoOperacional: Array.isArray(r.historicoOperacional) ? r.historicoOperacional : Array.isArray(r.history) ? r.history : [],
  };
}

/** Carrega reservas via adaptador HITS. Sem credenciais: faz fallback json-local → mock-local. */
function loadReservasFromHitsAdapter() {
  if (!HITS_CONFIG.available || !HITS_CONFIG.hasCredentials) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[painel] HITS: sem credenciais/config. Fallback: json-local → mock-local.");
    }
    return fetch(PAINEL_JSON_LOCAL_URL)
      .then((r) => {
        if (!r.ok) throw new Error("JSON local não encontrado");
        return r.json();
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : (data && data.reservas) ? data.reservas : [];
        return normalizarListaReservasExternas(list);
      })
      .catch(() => loadReservasOperacionais());
  }
  return Promise.reject(new Error("HITS real não implementado nesta fase"));
}

/* ---------- Provider de dados / origem do painel ---------- */
const PAINEL_DATA_SOURCE_MOCK_LOCAL = "mock-local";
const PAINEL_DATA_SOURCE_JSON_LOCAL = "json-local";
const PAINEL_DATA_SOURCE_HITS_ADAPTER = "hits-adapter";
const PAINEL_DATA_SOURCE_BACKEND = "backend";
const PAINEL_DATA_SOURCE_LOCAL_REPOSITORY = "local-repository";
/** Origem operacional em produção: backend Supabase. */
const PAINEL_DATA_SOURCE = PAINEL_DATA_SOURCE_BACKEND;
const PAINEL_JSON_LOCAL_URL = "./data/checkin-operacional-reservas.json";

/* ---------- Backend Supabase (Bloco 02/04) ---------- */
function getSupabase() {
  return (typeof auth !== "undefined" && auth && auth.getSupabaseClient) ? auth.getSupabaseClient() : null;
}

function formatDateForDb(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s || null;
}

function mapDbEventoToHistorico(row) {
  if (!row) return null;
  const iso = row.criado_em || null;
  const d = iso ? new Date(iso) : null;
  return {
    tipo: row.tipo || "",
    titulo: row.titulo || "",
    detalhe: row.detalhe || null,
    em: d && !isNaN(d.getTime()) ? formatHistoricoTimestamp(d) : "",
    criadoEmIso: iso,
  };
}

function mapDbHospedeToInternal(row, fnrhRow) {
  if (!row) return null;
  const base = {
    id: row.id || "",
    nome: (row.nome || "").trim(),
    principal: !!row.principal,
    email: (row.email || "").trim(),
    whatsapp: (row.whatsapp || "").trim(),
    statusOperacional: row.status_operacional || GUEST_STATUS.NAO_IDENTIFICADO,
    origemCadastro: row.origem_cadastro || ORIGEM_CADASTRO.NOVO,
    modoColetaFnrh: row.modo_coleta_fnrh || MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO,
    ultimoEnvioCanal: row.ultimo_envio_canal || null,
    ultimoEnvioEm: row.ultimo_envio_em || null,
    tentativasEnvio: row.tentativas_envio != null ? Number(row.tentativas_envio) : 0,
  };
  if (fnrhRow && fnrhRow.link_token && fnrhRow.id) {
    base.fnrhLink = "./fnrh-preenchimento.html?v=2&guest_id=" + encodeURIComponent(fnrhRow.id) + "&token=" + encodeURIComponent(fnrhRow.link_token);
    base.fnrhStatus = fnrhRow.status || "pendente";
  }
  return base;
}

function mapDbComunicacaoEnviosToInternal(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(function (row) {
    return {
      proposito: row.proposito || "",
      canal: row.canal || "",
      status: row.status || "",
      corpoPreview: row.corpo_preview || null,
      erro: row.erro || null,
      createdAt: row.created_at || null,
    };
  });
}

function mapPagamentoStatusFromDb(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "pago" || s === "pendente" || s === "parcial" || s === "desconhecido") return s;
  // Sem sinal confiável: desconhecido (nunca colapsar para pendente).
  return "desconhecido";
}

function mapDbReservaToInternal(r, hospedesRows, eventosRows, fnrhRows, enviosRows) {
  const checkIn = r.check_in_previsto;
  const checkOut = r.check_out_previsto;
  const fnrhMap = (fnrhRows || []).reduce(function (acc, f) {
    acc[f.hospede_id] = f;
    return acc;
  }, {});
  const hospedes = (hospedesRows || []).map(function (row) {
    return mapDbHospedeToInternal(row, fnrhMap[row.id]);
  }).filter(Boolean);
  const historico = (eventosRows || []).map(mapDbEventoToHistorico).filter(Boolean);
  const extId = (r.external_reservation_id || "").trim() || null;
  return {
    id: r.id,
    apartamento: (r.apartamento || "").trim(),
    hospedePrincipal: (r.hospede_principal || "").trim(),
    externalReservationId: extId,
    checkInPrevisto: checkIn ? (typeof checkIn === "string" ? checkIn.slice(0, 10) : checkIn) : "",
    checkOutPrevisto: checkOut ? (typeof checkOut === "string" ? checkOut.slice(0, 10) : checkOut) : "",
    pagamento: mapPagamentoStatusFromDb(r.pagamento_status),
    statusReserva: r.status_reserva === "cancelada" ? "cancelada" : "ativa",
    acessoLiberado: !!r.acesso_liberado,
    entrouNoApto: !!r.entrou_no_apto,
    veiculoPlaca: (r.veiculo_placa || "").trim(),
    veiculoCor: (r.veiculo_cor || "").trim(),
    fnrhStatusAgregado: r.fnrh_status_agregado || "fnrh_pendente",
    fnrhCompletoEm: r.fnrh_completo_em || null,
    senhaEnviadaEm: r.senha_enviada_em || null,
    classificacaoComissionamento: mapClassificacaoComissionamentoFromDb(
      r.classificacao_comissionamento,
    ),
    classificacaoComissionamentoOrigem: (r.classificacao_comissionamento_origem || "").trim() || null,
    classificacaoComissionamentoAtualizadoEm: r.classificacao_comissionamento_atualizado_em || null,
    cobrancasPagarme: [],
    pagamentosPagarme: [],
    hospedes,
    historicoOperacional: historico,
    comunicacaoEnviosOperacional: mapDbComunicacaoEnviosToInternal(enviosRows || []),
  };
}

function mapClassificacaoComissionamentoFromDb(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase();
  if (s === "nao_comissionada" || s === "comissionada" || s === "desconhecida") return s;
  return "desconhecida";
}

/** Perfil do operador logado (admin|recepcao). Cafe não chega nesta tela. */
let painelOperadorRole = "";

function getPagarmePaymentUiApi() {
  return typeof YesPagarmePaymentUi !== "undefined" && YesPagarmePaymentUi
    ? YesPagarmePaymentUi
    : null;
}

/** Lê YES_HOTEL_SUPABASE_CONFIG.pagarmeUiEnabled — somente boolean true habilita (fail-closed). */
function readPagarmeUiEnabledFlag() {
  try {
    const cfg =
      typeof window !== "undefined" && window.YES_HOTEL_SUPABASE_CONFIG
        ? window.YES_HOTEL_SUPABASE_CONFIG
        : null;
    const api = getPagarmePaymentUiApi();
    const raw = cfg ? cfg.pagarmeUiEnabled : undefined;
    if (api && typeof api.isPagarmeUiEnabled === "function") {
      return api.isPagarmeUiEnabled(raw) === true;
    }
    return raw === true;
  } catch (_e) {
    return false;
  }
}

function isPagarmeUiEnabledInPainel() {
  return readPagarmeUiEnabledFlag() === true;
}

function resolvePaymentUiForReserva(reserva) {
  if (!isPagarmeUiEnabledInPainel()) return null;
  const api = getPagarmePaymentUiApi();
  if (!api) return null;
  const resolveFn =
    typeof api.resolveOperacionalPaymentUi === "function"
      ? api.resolveOperacionalPaymentUi
      : typeof api.resolvePaymentUiState === "function"
        ? api.resolvePaymentUiState
        : null;
  if (!resolveFn) return null;
  return resolveFn({
    pagamentoStatus: reserva && reserva.pagamento,
    classificacaoComissionamento: reserva && reserva.classificacaoComissionamento,
    cobrancas: reserva && reserva.cobrancasPagarme,
    pagamentos: reserva && reserva.pagamentosPagarme,
    perfilUsuario: painelOperadorRole || "recepcao",
    pagarmeUiEnabled: true,
  });
}

async function attachPagarmeCobrancasBatch(supabase, reservasList) {
  // Fail-closed: sem flag explícita true, zero queries às tabelas Pagar.me.
  if (!isPagarmeUiEnabledInPainel()) return;
  if (!supabase || !Array.isArray(reservasList) || reservasList.length === 0) return;
  const ids = reservasList.map(function (r) {
    return r.id;
  }).filter(Boolean);
  if (!ids.length) return;

  const { data: cobrancasRows, error: errCob } = await supabase
    .from("operacional_cobrancas_pagarme")
    .select(
      "id, reserva_id, metodo, status, valor_centavos, moeda, pagarme_payment_link_id, pagarme_payment_link_url, pagarme_order_id, pagarme_charge_id, pagarme_status_raw, requer_revisao_operacional, requer_revisao_motivo, requer_revisao_detectado_em, created_at, updated_at",
    )
    .in("reserva_id", ids);
  if (errCob) {
    console.warn("[pagarme] falha ao carregar cobrancas em lote");
    return;
  }

  const byReserva = {};
  (cobrancasRows || []).forEach(function (row) {
    const rid = String(row.reserva_id || "");
    if (!byReserva[rid]) byReserva[rid] = [];
    byReserva[rid].push({
      id: row.id,
      reserva_id: row.reserva_id,
      metodo: row.metodo,
      status: row.status,
      valor_centavos: row.valor_centavos,
      moeda: row.moeda,
      pagarme_payment_link_id: row.pagarme_payment_link_id,
      pagarme_payment_link_url: row.pagarme_payment_link_url,
      payment_link_url: row.pagarme_payment_link_url,
      pagarme_order_id: row.pagarme_order_id,
      pagarme_charge_id: row.pagarme_charge_id,
      pagarme_status_raw: row.pagarme_status_raw,
      requer_revisao_operacional: !!row.requer_revisao_operacional,
      requer_revisao_motivo: row.requer_revisao_motivo,
      requer_revisao_detectado_em: row.requer_revisao_detectado_em,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });

  const cobrancaIds = (cobrancasRows || []).map(function (c) {
    return c.id;
  });
  let pagamentosByCobranca = {};
  if (cobrancaIds.length) {
    const { data: pagRows, error: errPag } = await supabase
      .from("operacional_pagamentos_pagarme")
      .select(
        "id, cobranca_id, valor_centavos_recebido, pago_em, sincronizacao_hits_status, pagarme_charge_id, pagarme_status_raw, created_at",
      )
      .in("cobranca_id", cobrancaIds);
    if (!errPag && Array.isArray(pagRows)) {
      pagRows.forEach(function (p) {
        const cid = String(p.cobranca_id || "");
        if (!pagamentosByCobranca[cid]) pagamentosByCobranca[cid] = [];
        pagamentosByCobranca[cid].push(p);
      });
    }
  }

  reservasList.forEach(function (reserva) {
    const cobrs = byReserva[String(reserva.id)] || [];
    reserva.cobrancasPagarme = cobrs;
    const pags = [];
    cobrs.forEach(function (c) {
      const list = pagamentosByCobranca[String(c.id)] || [];
      list.forEach(function (p) {
        pags.push(p);
      });
    });
    reserva.pagamentosPagarme = pags;
  });
}

/** Reservas com credencial ativa e item pendente/falho sem remote_keyboard_pwd_id (mesma regra do painel). */
async function fetchReservaIdsComTtlockPendenteCritico(supabase) {
  const { data, error } = await supabase
    .from("operacional_credencial_itens")
    .select("status_provisionamento, remote_keyboard_pwd_id, operacional_credenciais_acesso(reserva_id, status)")
    .in("status_provisionamento", ["pendente", "falhou"])
    .is("remote_keyboard_pwd_id", null);
  if (error || !Array.isArray(data)) return new Set();
  const ids = new Set();
  for (const row of data) {
    const cred = row.operacional_credenciais_acesso;
    const c = Array.isArray(cred) ? cred[0] : cred;
    if (!c || c.status === "revogada") continue;
    const rid = c.reserva_id;
    if (rid) ids.add(String(rid));
  }
  return ids;
}

/**
 * Reservas em que cada credencial principal ativa tem pelo menos um item e todos os itens estão provisionados.
 */
async function fetchReservaIdsPrincipalTtlockTodosProvisionados(supabase) {
  const { data: creds, error } = await supabase
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status")
    .eq("tipo_credencial", "principal")
    .neq("status", "revogada");
  if (error || !Array.isArray(creds) || creds.length === 0) return new Set();
  const credIds = creds.map((c) => c.id);
  const { data: itens, error: errItens } = await supabase
    .from("operacional_credencial_itens")
    .select("credencial_id, status_provisionamento")
    .in("credencial_id", credIds);
  if (errItens || !Array.isArray(itens)) return new Set();
  const itemsByCred = new Map();
  for (const c of creds) itemsByCred.set(c.id, []);
  for (const it of itens) {
    if (itemsByCred.has(it.credencial_id)) itemsByCred.get(it.credencial_id).push(it);
  }
  const reservaToCredIds = new Map();
  for (const c of creds) {
    const rid = c.reserva_id != null ? String(c.reserva_id) : "";
    if (!rid) continue;
    if (!reservaToCredIds.has(rid)) reservaToCredIds.set(rid, []);
    reservaToCredIds.get(rid).push(c.id);
  }
  const out = new Set();
  for (const [rid, credList] of reservaToCredIds) {
    let allOk = true;
    for (const cid of credList) {
      const list = itemsByCred.get(cid) || [];
      if (list.length === 0) {
        allOk = false;
        break;
      }
      if (!list.every((i) => i.status_provisionamento === "provisionado")) {
        allOk = false;
        break;
      }
    }
    if (allOk) out.add(rid);
  }
  return out;
}

/** Uma reserva: todas as credenciais principais ativas com itens, todos provisionados (para pular lifecycle_provision). */
async function principalTtlockTodosProvisionadosParaReserva(supabase, reservaId) {
  const rid = String(reservaId ?? "").trim();
  if (!rid) return false;
  const { data: creds } = await supabase
    .from("operacional_credenciais_acesso")
    .select("id")
    .eq("reserva_id", rid)
    .eq("tipo_credencial", "principal")
    .neq("status", "revogada");
  if (!Array.isArray(creds) || creds.length === 0) return false;
  for (const c of creds) {
    const { data: itens } = await supabase
      .from("operacional_credencial_itens")
      .select("status_provisionamento")
      .eq("credencial_id", c.id);
    if (!Array.isArray(itens) || itens.length === 0) return false;
    if (!itens.every((i) => i.status_provisionamento === "provisionado")) return false;
  }
  return true;
}

async function loadReservasFromBackend() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: reservasRows, error: errReservas } = await supabase
    .from("operacional_reservas")
    .select("*")
    .order("created_at", { ascending: true });
  if (errReservas || !Array.isArray(reservasRows)) return [];
  const ttlockCritico = await fetchReservaIdsComTtlockPendenteCritico(supabase);
  const principalTtlockOk = await fetchReservaIdsPrincipalTtlockTodosProvisionados(supabase);
  const out = [];
  for (const r of reservasRows) {
    const { data: hospedesRows } = await supabase
      .from("operacional_hospedes")
      .select("*")
      .eq("reserva_id", r.id)
      .order("created_at", { ascending: true });
    const { data: eventosRows } = await supabase
      .from("operacional_reserva_eventos")
      .select("*")
      .eq("reserva_id", r.id)
      .order("criado_em", { ascending: false });
    const { data: fnrhRows } = await supabase
      .from("fnrh_hospedes")
      .select("id, hospede_id, status, link_token")
      .eq("reserva_id", r.id);
    const { data: enviosRows } = await supabase
      .from("operacional_comunicacao_envios")
      .select("proposito, canal, status, corpo_preview, erro, created_at")
      .eq("reserva_id", r.id)
      .order("created_at", { ascending: false })
      .limit(80);
    const { data: tolRows } = await supabase
      .from("operacional_acesso_tolerancias")
      .select(
        "id, grace_status, suspension_due_at, current_payment_pending, current_fnrh_pending, last_error",
      )
      .eq("reservation_id", r.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: outboxFail } = await supabase
      .from("operacional_acesso_outbox")
      .select("id")
      .eq("reservation_id", r.id)
      .eq("status", "failed")
      .is("processed_at", null)
      .limit(1);
    const internal = mapDbReservaToInternal(r, hospedesRows || [], eventosRows || [], fnrhRows || [], enviosRows || []);
    const ridKey = String(r.id);
    internal.ttlockBloqueiaLiberado = ttlockCritico.has(ridKey);
    internal.ttlockPrincipalTodosProvisionados = principalTtlockOk.has(ridKey);
    if (Array.isArray(tolRows) && tolRows[0]) {
      internal.acessoTolerancia = {
        id: tolRows[0].id,
        grace_status: tolRows[0].grace_status,
        suspension_due_at: tolRows[0].suspension_due_at,
        current_payment_pending: !!tolRows[0].current_payment_pending,
        current_fnrh_pending: !!tolRows[0].current_fnrh_pending,
        last_error: tolRows[0].last_error || null,
        payment_unconfirmed:
          String(tolRows[0].last_error || "").indexOf("payment_unknown") >= 0 ||
          String(tolRows[0].last_error || "").indexOf("desconhecido") >= 0,
        communication_failed: Array.isArray(outboxFail) && outboxFail.length > 0,
      };
    }
    out.push(internal);
  }
  await attachPagarmeCobrancasBatch(supabase, out);
  return out;
}

function internalHospedeToDbPayload(h) {
  return {
    nome: (h.nome || "").trim(),
    principal: !!h.principal,
    email: (h.email || "").trim(),
    whatsapp: (h.whatsapp || "").trim(),
    status_operacional: h.statusOperacional || "nao_identificado",
    origem_cadastro: h.origemCadastro || "novo",
    modo_coleta_fnrh: h.modoColetaFnrh || "preenchimento_completo",
    ultimo_envio_canal: h.ultimoEnvioCanal || null,
    ultimo_envio_em: h.ultimoEnvioEm || null,
    tentativas_envio: h.tentativasEnvio != null ? Number(h.tentativasEnvio) : 0,
  };
}

async function backendUpdateHospedeCampo(reservaId, guestIndex, campo, valor) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const hospede = getHospede(reserva, guestIndex);
  if (!hospede || !hospede.id) return false;
  const keyMap = { nome: "nome", email: "email", whatsapp: "whatsapp", principal: "principal", statusOperacional: "status_operacional", origemCadastro: "origem_cadastro", modoColetaFnrh: "modo_coleta_fnrh" };
  const col = keyMap[campo] || campo;
  const payload = col === "principal" ? { principal: !!valor } : col === "status_operacional" ? { status_operacional: valor } : col === "origem_cadastro" ? { origem_cadastro: valor } : col === "modo_coleta_fnrh" ? { modo_coleta_fnrh: valor } : { [col]: valor };
  const { error } = await supabase.from("operacional_hospedes").update(payload).eq("id", hospede.id);
  return !error;
}

async function backendAddHospede(reservaId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const count = getHospedesTotal(reserva);
  const { data: inserted, error } = await supabase
    .from("operacional_hospedes")
    .insert({ reserva_id: reservaId, nome: "Novo hóspede", principal: false, status_operacional: GUEST_STATUS.NAO_IDENTIFICADO, origem_cadastro: ORIGEM_CADASTRO.NOVO, modo_coleta_fnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO, tentativas_envio: 0 })
    .select("id")
    .single();
  if (error || !inserted) return false;
  await supabase.from("operacional_reserva_eventos").insert({ reserva_id: reservaId, tipo: "hospede_adicionado", titulo: "Hóspede adicionado", detalhe: "Novo hóspede incluído manualmente." });
  return true;
}

async function backendRemoveHospede(reservaId, guestIndex) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const hospede = getHospede(reserva, guestIndex);
  if (!hospede || !hospede.id) return false;
  const { error } = await supabase.from("operacional_hospedes").delete().eq("id", hospede.id);
  if (error) return false;
  await supabase.from("operacional_reserva_eventos").insert({ reserva_id: reservaId, tipo: "hospede_removido", titulo: "Hóspede removido", detalhe: hospede.nome || "Hóspede" });
  return true;
}

async function backendSetPrincipal(reservaId, guestIndex) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const hospede = getHospede(reserva, guestIndex);
  if (!hospede || !hospede.id) return false;
  await supabase.from("operacional_hospedes").update({ principal: false }).eq("reserva_id", reservaId);
  const { error } = await supabase.from("operacional_hospedes").update({ principal: true }).eq("id", hospede.id);
  if (!error) {
    const principalNome = (hospede.nome || "").trim() || "Hóspede";
    await supabase.from("operacional_reservas").update({ hospede_principal: principalNome }).eq("id", reservaId);
    await supabase.from("operacional_reserva_eventos").insert({ reserva_id: reservaId, tipo: "principal_alterado", titulo: "Principal alterado", detalhe: principalNome });
  }
  return !error;
}

async function backendAddEvento(reservaId, tipo, titulo, detalhe) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("operacional_reserva_eventos").insert({ reserva_id: reservaId, tipo: tipo || "evento", titulo: titulo || "", detalhe: detalhe || null });
  return !error;
}

async function backendSetPagamentoOk(reservaId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("operacional_reservas").update({ pagamento_status: "pago" }).eq("id", reservaId);
  if (error) return false;
  await backendAddEvento(reservaId, "pagamento", "Pagamento aprovado", "Simulação de pagamento aprovado.");
  return true;
}

async function backendConfirmarFnrh(reservaId, guestIndex) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const h = guestIndex != null ? getHospede(reserva, guestIndex) : reserva.hospedes.find((x) => x.statusOperacional !== GUEST_STATUS.CONFIRMADO);
  if (!h || !h.id) return false;
  const { error } = await supabase.from("operacional_hospedes").update({ status_operacional: GUEST_STATUS.CONFIRMADO }).eq("id", h.id);
  if (error) return false;
  await backendAddEvento(reservaId, "fnrh_confirmada", "FNRH confirmada", (h.nome || "Hóspede") + " confirmou FNRH.");
  return true;
}

async function backendEnviarLinks(reservaId) {
  const supabase = getSupabase();
  if (!supabase || !auth?.getEdgeFunctionFetchHeaders) return false;
  let headers;
  try {
    headers = await auth.getEdgeFunctionFetchHeaders();
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[backendEnviarLinks] auth headers", e);
    }
    return false;
  }
  const functionsUrl = (typeof supabase.supabaseUrl === "string" ? supabase.supabaseUrl : "")?.replace(/\/$/, "") + "/functions/v1";
  const baseUrl = (typeof window !== "undefined" && window.location?.origin) ? window.location.origin : "";
  const res = await fetch(functionsUrl + "/send-fnrh-links", {
    method: "POST",
    headers,
    body: JSON.stringify({ reserva_id: reservaId, tipo_evento: "manual", base_url: baseUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.warn("[backendEnviarLinks]", data.error || res.statusText);
    return false;
  }
  return true;
}

async function backendLiberarAcesso(reservaId) {
  const supabase = getSupabase();
  if (!supabase) {
    return {
      ok: false,
      error: "Cliente Supabase indisponível. Confirme login e configuração (url/anonKey) do painel.",
    };
  }
  const rid = String(reservaId ?? "").trim();
  if (!rid) {
    return { ok: false, error: "ID da reserva inválido." };
  }

  const usarProvisionTtlock =
    PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && typeof auth?.invokeLifecycleAction === "function";

  /**
   * A credencial principal + itens são criados pelo trigger em operacional_reservas
   * só na transição acesso_liberado false → true (migration 0006).
   * lifecycle_provision precisa dessa linha em operacional_credenciais_acesso; por isso
   * o UPDATE da reserva vem antes do invoke, não depois.
   */
  const { error: updateError } = await supabase
    .from("operacional_reservas")
    .update({ acesso_liberado: true })
    .eq("id", rid);
  if (updateError) {
    return { ok: false, error: updateError.message || "Falha ao atualizar operacional_reservas." };
  }
  const { data: row, error: selectError } = await supabase
    .from("operacional_reservas")
    .select("id, acesso_liberado")
    .eq("id", rid)
    .maybeSingle();
  if (selectError) {
    return { ok: false, error: selectError.message || "Não foi possível confirmar acesso_liberado após o update." };
  }
  if (!row) {
    return {
      ok: false,
      error: "Reserva não encontrada após o update (id sem correspondência ou sem permissão de leitura).",
    };
  }
  if (row.acesso_liberado !== true) {
    return {
      ok: false,
      error: "Update não aplicou acesso_liberado=true (valor no banco permanece diferente).",
    };
  }

  if (usarProvisionTtlock) {
    const jaProvisionado = await principalTtlockTodosProvisionadosParaReserva(supabase, rid);
    if (jaProvisionado) {
      await backendAddEvento(rid, "acesso_liberado", "Acesso liberado", "Acesso ao apartamento liberado (TTLock já provisionado nos itens).");
      return { ok: true };
    }
    try {
      const data = await auth.invokeLifecycleAction("lifecycle_provision", { reservaId: rid });
      if (data && data.error) {
        await supabase.from("operacional_reservas").update({ acesso_liberado: false }).eq("id", rid);
        return { ok: false, error: String(data.error) };
      }
      if (data && data.ok === false) {
        await supabase.from("operacional_reservas").update({ acesso_liberado: false }).eq("id", rid);
        return { ok: false, error: data.error ? String(data.error) : "Provisionamento TTLock recusado." };
      }
      const falhas = Number(data?.falhas ?? 0);
      const st = String(data?.status ?? "");
      if (falhas > 0 || st === "falhou" || st === "parcial") {
        const erros = Array.isArray(data?.erros) ? data.erros.filter(Boolean).join("; ") : "";
        await supabase.from("operacional_reservas").update({ acesso_liberado: false }).eq("id", rid);
        return {
          ok: false,
          error:
            "TTLock não concluiu o provisionamento de todos os itens. " +
            (erros || `status=${st || "—"}, falhas=${falhas}.`) +
            " Corrija e tente liberar de novo.",
        };
      }
    } catch (e) {
      await supabase.from("operacional_reservas").update({ acesso_liberado: false }).eq("id", rid);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  await backendAddEvento(rid, "acesso_liberado", "Acesso liberado", "Acesso ao apartamento liberado.");
  return { ok: true };
}

async function backendMarcarEntrada(reservaId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data: row, error: errSelect } = await supabase.from("operacional_reservas").select("entrou_no_apto").eq("id", reservaId).maybeSingle();
  if (errSelect || !row) return false;
  if (row.entrou_no_apto === true) return true;
  const { error } = await supabase.from("operacional_reservas").update({ entrou_no_apto: true }).eq("id", reservaId);
  if (error) return false;
  await backendAddEvento(reservaId, "entrada_apto", "Entrada no apartamento", "Hóspede marcado como entrado no apartamento.");
  return true;
}

async function backendUpdateHospedeFull(reservaId, guestIndex, hospedePayload) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const reserva = getReservaById(reservaId);
  const hospede = getHospede(reserva, guestIndex);
  if (!hospede || !hospede.id) return false;
  const payload = internalHospedeToDbPayload(hospedePayload);
  const { error } = await supabase.from("operacional_hospedes").update(payload).eq("id", hospede.id);
  return !error;
}

function getMockReservasExternas() {
  return mockReservasExternasRaw;
}

function loadReservasOperacionais() {
  const payloads = getMockReservasExternas();
  return normalizarListaReservasExternas(payloads);
}

function loadReservasFromLocalRepository() {
  if (!operacionalRepository) {
    return Promise.reject(
      new Error("Repositório operacional local não foi carregado."),
    );
  }
  return Promise.resolve(
    normalizarListaReservasExternas(
      operacionalRepository.listReservations(),
    ),
  );
}

function loadReservasOperacionaisFromProvider() {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_LOCAL_REPOSITORY) {
    return loadReservasFromLocalRepository();
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    return loadReservasFromBackend();
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_HITS_ADAPTER) {
    return loadReservasFromHitsAdapter();
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_JSON_LOCAL) {
    return fetch(PAINEL_JSON_LOCAL_URL)
      .then((r) => {
        if (!r.ok) throw new Error("JSON local não encontrado");
        return r.json();
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : (data && data.reservas) ? data.reservas : [];
        return normalizarListaReservasExternas(list);
      })
      .catch(() => loadReservasOperacionais());
  }
  return Promise.resolve(loadReservasOperacionais());
}

function getPainelDataSourceInfo() {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_LOCAL_REPOSITORY) {
    return {
      type: PAINEL_DATA_SOURCE_LOCAL_REPOSITORY,
      description: "Repositório local (não usado em produção)",
      available: !!operacionalRepository,
    };
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    return { type: PAINEL_DATA_SOURCE_BACKEND, description: "Backend Yes (Supabase)", available: !!getSupabase() };
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_HITS_ADAPTER) {
    const info = getHitsAdapterInfo();
    return {
      type: PAINEL_DATA_SOURCE_HITS_ADAPTER,
      description: info.available ? "HITS (adaptador)" : "Pré-integração HITS (sem credenciais reais)",
      available: info.available,
    };
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_JSON_LOCAL) {
    return { type: PAINEL_DATA_SOURCE_JSON_LOCAL, description: "JSON local (data/checkin-operacional-reservas.json)" };
  }
  return { type: PAINEL_DATA_SOURCE_MOCK_LOCAL, description: "Mock local normalizado" };
}

function exportReservasOperacionais(reservasList) {
  return serializarPainelOperacional(reservasList || reservas);
}

/** Fonte externa simulada (mock). Trocar por API/adaptador no futuro. */
const mockReservasExternasRaw = [
  {
    id: "1",
    apartamento: "12",
    hospedePrincipal: "Julio Cesar",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    acessoLiberado: false,
    entrouNoApto: false,
    veiculoPlaca: "ABC1D23",
    veiculoCor: "Prata",
    hospedes: [
      { id: "1-1", nome: "Julio Cesar", principal: true, email: "julio@email.com", whatsapp: "11999990001", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_COMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA },
      { id: "1-2", nome: "Sandra Maria", principal: false, email: "sandra@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_COMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA },
      { id: "1-3", nome: "Hospede 3", principal: false, email: "", whatsapp: "11999990003", statusOperacional: GUEST_STATUS.ENVIADO, origemCadastro: ORIGEM_CADASTRO.NOVO, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
      { id: "1-4", nome: "Hospede 4", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.AGUARDANDO_CONTATO, origemCadastro: ORIGEM_CADASTRO.AGENCIA_SEM_DADOS, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
      { id: "1-5", nome: "Hospede 5", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO, origemCadastro: ORIGEM_CADASTRO.AGENCIA_SEM_DADOS, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
    ],
  },
  {
    id: "2",
    apartamento: "18",
    hospedePrincipal: "Sandra Maria",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pendente",
    acessoLiberado: false,
    entrouNoApto: false,
    veiculoPlaca: "",
    veiculoCor: "",
    hospedes: [
      { id: "2-1", nome: "Sandra Maria", principal: true, email: "sandra@email.com", whatsapp: "11988880000", statusOperacional: GUEST_STATUS.AGUARDANDO_CONTATO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
      { id: "2-2", nome: "Hospede 2", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO, origemCadastro: ORIGEM_CADASTRO.AGENCIA_SEM_DADOS, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
    ],
  },
  {
    id: "3",
    apartamento: "24",
    hospedePrincipal: "Joao Pedro",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    acessoLiberado: true,
    entrouNoApto: true,
    veiculoPlaca: "XYZ9K99",
    veiculoCor: "Preto",
    hospedes: [
      { id: "3-1", nome: "Joao Pedro", principal: true, email: "joao@email.com", whatsapp: "11977770000", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_COMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA },
      { id: "3-2", nome: "Maria Silva", principal: false, email: "maria@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_COMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA },
      { id: "3-3", nome: "Hospede 3", principal: false, email: "", whatsapp: "11977770002", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.NOVO, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
    ],
  },
  {
    id: "4",
    apartamento: "07",
    hospedePrincipal: "Ana Souza",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    acessoLiberado: false,
    entrouNoApto: false,
    veiculoPlaca: "",
    veiculoCor: "",
    hospedes: [
      { id: "4-1", nome: "Ana Souza", principal: true, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO, origemCadastro: ORIGEM_CADASTRO.AGENCIA_SEM_DADOS, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
      { id: "4-2", nome: "Hospede 2", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO, origemCadastro: ORIGEM_CADASTRO.AGENCIA_SEM_DADOS, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
    ],
  },
  {
    id: "5",
    apartamento: "31",
    hospedePrincipal: "Carlos Mendes",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    acessoLiberado: true,
    entrouNoApto: false,
    veiculoPlaca: "JKL4M55",
    veiculoCor: "Branco",
    hospedes: [
      { id: "5-1", nome: "Carlos Mendes", principal: true, email: "carlos@email.com", whatsapp: "11966660000", statusOperacional: GUEST_STATUS.CONFIRMADO, origemCadastro: ORIGEM_CADASTRO.EXISTENTE_COMPLETO, modoColetaFnrh: MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA },
      { id: "5-2", nome: "Hospede 2", principal: false, email: "h2@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.PRONTO_PARA_ENVIO, origemCadastro: ORIGEM_CADASTRO.NOVO, modoColetaFnrh: MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO },
    ],
  },
];

/* ---------- Estado base (preenchido pelo provider no init) ---------- */
let reservas = [];

/* ---------- Selectors / estado derivado ---------- */
function getReservaById(id) {
  if (!Array.isArray(reservas)) return null;
  return reservas.find((r) => r.id === id) || null;
}

function getHospede(reserva, guestIndex) {
  if (!reserva || !Array.isArray(reserva.hospedes)) return null;
  const idx = typeof guestIndex === "number" ? guestIndex : parseInt(guestIndex, 10);
  return reserva.hospedes[idx] != null ? reserva.hospedes[idx] : null;
}

function getHospedesTotal(reserva) {
  return Array.isArray(reserva.hospedes) ? reserva.hospedes.length : 0;
}

function getFnrhConfirmadas(reserva) {
  if (!Array.isArray(reserva.hospedes)) return 0;
  return reserva.hospedes.filter((h) => h.statusOperacional === GUEST_STATUS.CONFIRMADO).length;
}

function getFnrhPreenchidas(reserva) {
  return getFnrhConfirmadas(reserva);
}

function hasFnrhPendente(reserva) {
  const total = getHospedesTotal(reserva);
  const confirmadas = getFnrhConfirmadas(reserva);
  return total > 0 && confirmadas < total;
}

function getFnrhStatus(reserva) {
  const total = getHospedesTotal(reserva);
  const confirmadas = getFnrhConfirmadas(reserva);
  if (total === 0) return { class: "fnrh-neutral", label: "—" };
  if (confirmadas === 0) return { class: "fnrh-0", label: `FNRH 0/${total}` };
  if (confirmadas < total) return { class: "fnrh-partial", label: `FNRH ${confirmadas}/${total}` };
  return { class: "fnrh-ok", label: `FNRH ${total}/${total}` };
}

function registrarProximaFnrh(reserva) {
  if (!Array.isArray(reserva.hospedes)) return false;
  const pendente = reserva.hospedes.find((h) => h.statusOperacional !== GUEST_STATUS.CONFIRMADO);
  if (!pendente) return false;
  pendente.statusOperacional = GUEST_STATUS.CONFIRMADO;
  return true;
}

function hasContatoSuficiente(hospede) {
  const e = (hospede.email || "").trim();
  const w = (hospede.whatsapp || "").trim();
  return e.length > 0 || w.length > 0;
}

const NOMES_GENERICOS = [
  "hospede 2", "hospede 3", "hospede 4", "hospede 5", "hospede 6", "hospede 7", "hospede 8", "hospede 9",
  "acompanhante", "nao informado", "não informado", "nao identificado", "não identificado",
];

function hasIdentificacaoMinima(hospede) {
  const n = (hospede.nome || "").trim();
  if (n.length === 0) return false;
  const lower = n.toLowerCase();
  return !NOMES_GENERICOS.includes(lower);
}

function syncGuestStatus(hospede) {
  if (hospede.statusOperacional === GUEST_STATUS.ENVIADO || hospede.statusOperacional === GUEST_STATUS.CONFIRMADO) {
    return;
  }
  const ident = hasIdentificacaoMinima(hospede);
  const contato = hasContatoSuficiente(hospede);
  if (!ident) {
    hospede.statusOperacional = GUEST_STATUS.NAO_IDENTIFICADO;
    return;
  }
  if (!contato) {
    hospede.statusOperacional = GUEST_STATUS.AGUARDANDO_CONTATO;
    return;
  }
  hospede.statusOperacional = GUEST_STATUS.PRONTO_PARA_ENVIO;
}

function guestPendencyMessage(hospede) {
  switch (hospede.statusOperacional) {
    case GUEST_STATUS.NAO_IDENTIFICADO:
      return "Falta identificar hóspede";
    case GUEST_STATUS.AGUARDANDO_CONTATO:
      return "Falta email ou WhatsApp";
    case GUEST_STATUS.PRONTO_PARA_ENVIO:
      return "Pronto para envio";
    case GUEST_STATUS.ENVIADO:
      return "Link enviado, aguardando confirmação";
    case GUEST_STATUS.CONFIRMADO:
      return "FNRH confirmada";
    default:
      return "";
  }
}

function getNaoIdentificados(reserva) {
  if (!Array.isArray(reserva.hospedes)) return [];
  return reserva.hospedes.filter((h) => !hasIdentificacaoMinima(h));
}

function isPagamentoOk(reserva) {
  return reserva.pagamento === "pago";
}

function isFnrhCompleta(reserva) {
  const total = getHospedesTotal(reserva);
  if (total === 0) return false;
  return getFnrhConfirmadas(reserva) === total;
}

function isProntaParaLiberarAcesso(reserva) {
  return isPagamentoOk(reserva) && isFnrhCompleta(reserva) && !acessoLiberadoEfetivo(reserva);
}

function isCheckinConcluido(reserva) {
  return acessoLiberadoEfetivo(reserva) === true && reserva.entrouNoApto === true;
}

const ETAPA_FUNIL = {
  CHECKIN_CONCLUIDO: "checkin_concluido",
  ACESSO_LIBERADO: "acesso_liberado",
  PRONTA_LIBERAR: "pronta_liberar",
  DADOS_PENDENTES: "dados_pendentes",
  FNRH_EM_ANDAMENTO: "fnrh_em_andamento",
};

function isDadosPendentes(reserva) {
  if (!Array.isArray(reserva.hospedes)) return false;
  if (getNaoIdentificados(reserva).length > 0) return true;
  if (getFaltamContato(reserva).length > 0) return true;
  const hasExistenteIncompletoPendente = reserva.hospedes.some(
    (h) =>
      h.origemCadastro === ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO &&
      h.statusOperacional !== GUEST_STATUS.CONFIRMADO &&
      h.statusOperacional !== GUEST_STATUS.ENVIADO,
  );
  if (hasExistenteIncompletoPendente) return true;
  const hasAgenciaSemDadosPendente = reserva.hospedes.some(
    (h) =>
      h.origemCadastro === ORIGEM_CADASTRO.AGENCIA_SEM_DADOS &&
      (!hasIdentificacaoMinima(h) || !hasContatoSuficiente(h)),
  );
  return !!hasAgenciaSemDadosPendente;
}

function getEtapaFunilReserva(reserva) {
  if (isCheckinConcluido(reserva)) return ETAPA_FUNIL.CHECKIN_CONCLUIDO;
  if (acessoLiberadoEfetivo(reserva) === true && reserva.entrouNoApto !== true) return ETAPA_FUNIL.ACESSO_LIBERADO;
  if (isProntaParaLiberarAcesso(reserva)) return ETAPA_FUNIL.PRONTA_LIBERAR;
  if (isDadosPendentes(reserva)) return ETAPA_FUNIL.DADOS_PENDENTES;
  return ETAPA_FUNIL.FNRH_EM_ANDAMENTO;
}

function getResumoFunil(reservas) {
  const hoje = todayStr();
  const resumo = {
    dadosPendentes: 0,
    fnrhEmAndamento: 0,
    prontaLiberar: 0,
    acessoLiberado: 0,
    checkinConcluido: 0,
    chegadasHoje: 0,
  };
  reservas.forEach((r) => {
    const etapa = getEtapaFunilReserva(r);
    if (etapa === ETAPA_FUNIL.DADOS_PENDENTES) resumo.dadosPendentes += 1;
    else if (etapa === ETAPA_FUNIL.FNRH_EM_ANDAMENTO) resumo.fnrhEmAndamento += 1;
    else if (etapa === ETAPA_FUNIL.PRONTA_LIBERAR) resumo.prontaLiberar += 1;
    else if (etapa === ETAPA_FUNIL.ACESSO_LIBERADO) resumo.acessoLiberado += 1;
    else if (etapa === ETAPA_FUNIL.CHECKIN_CONCLUIDO) resumo.checkinConcluido += 1;
    if (r.checkInPrevisto === hoje) resumo.chegadasHoje += 1;
  });
  return resumo;
}

function getBloqueiosReserva(reserva) {
  const bloqueios = [];
  if (!isPagamentoOk(reserva)) bloqueios.push("Pagamento pendente");
  if (!isFnrhCompleta(reserva)) bloqueios.push("FNRH pendente");
  return bloqueios;
}

function getStatusOperacionalReservaTexto(reserva) {
  const bloqueios = getBloqueiosReserva(reserva);
  if (bloqueios.length > 0) return "Bloqueios: " + bloqueios.join("; ");
  if (
    ttlockBloqueiaLiberadoNoPainel(reserva) &&
    reserva.acessoLiberado &&
    !reserva.ttlockPrincipalTodosProvisionados &&
    isPagamentoOk(reserva) &&
    isFnrhCompleta(reserva)
  ) {
    return "Acesso marcado; TTLock ainda não provisionado nos itens.";
  }
  if (isProntaParaLiberarAcesso(reserva)) return "Pronta para liberar acesso";
  if (acessoLiberadoEfetivo(reserva) && !reserva.entrouNoApto) return "Acesso liberado, aguardando chegada";
  if (isCheckinConcluido(reserva)) return "Check-in concluído";
  return "—";
}

function getProximaAcaoReserva(reserva) {
  if (!Array.isArray(reserva.hospedes)) return "";
  const hospedes = reserva.hospedes;
  const naoIdent = hospedes.filter((h) => !hasIdentificacaoMinima(h)).length;
  const agenciaSemDados = hospedes.filter((h) => h.origemCadastro === ORIGEM_CADASTRO.AGENCIA_SEM_DADOS && !hasIdentificacaoMinima(h)).length;
  const existenteIncompleto = hospedes.filter((h) => h.origemCadastro === ORIGEM_CADASTRO.EXISTENTE_INCOMPLETO && h.statusOperacional !== GUEST_STATUS.CONFIRMADO && h.statusOperacional !== GUEST_STATUS.ENVIADO).length;
  const aguardandoContato = hospedes.filter(
    (h) => hasIdentificacaoMinima(h) && h.statusOperacional === GUEST_STATUS.AGUARDANDO_CONTATO,
  ).length;
  const prontos = hospedes.filter(
    (h) => h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO && hasIdentificacaoMinima(h) && hasContatoSuficiente(h),
  );
  const prontosSimplificada = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA).length;
  const prontosCompleto = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO).length;
  const prontosCount = prontos.length;
  const enviados = hospedes.filter((h) => h.statusOperacional === GUEST_STATUS.ENVIADO).length;
  const confirmados = getFnrhConfirmadas(reserva);
  const total = hospedes.length;

  if (agenciaSemDados > 0 || naoIdent > 0) return "Completar dados dos hóspedes";
  if (existenteIncompleto > 0) return "Completar cadastro dos hóspedes";
  if (aguardandoContato > 0) return "Completar contatos";
  if (prontosCount > 0) {
    if (prontosSimplificada > 0 && prontosCompleto === 0) return "Enviar confirmações simplificadas";
    if (prontosCompleto > 0 && prontosSimplificada === 0) return "Enviar FNRHs completas";
    return "Enviar confirmações e FNRHs";
  }
  if (enviados > 0) return "Aguardar confirmação das FNRHs";
  if (!isPagamentoOk(reserva)) return "Regularizar pagamento";
  if (isProntaParaLiberarAcesso(reserva)) return "Liberar acesso";
  if (acessoLiberadoEfetivo(reserva) && !reserva.entrouNoApto) return "Aguardar entrada no apartamento";
  if (isCheckinConcluido(reserva)) return "Check-in concluído";
  return "";
}

function getProntosParaEnvio(reserva) {
  if (!Array.isArray(reserva.hospedes)) return [];
  return reserva.hospedes.filter(
    (h) =>
      h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO &&
      hasIdentificacaoMinima(h) &&
      hasContatoSuficiente(h),
  );
}

function getFaltamContato(reserva) {
  if (!Array.isArray(reserva.hospedes)) return [];
  return reserva.hospedes.filter(
    (h) =>
      hasIdentificacaoMinima(h) &&
      h.statusOperacional !== GUEST_STATUS.CONFIRMADO &&
      h.statusOperacional !== GUEST_STATUS.ENVIADO &&
      !hasContatoSuficiente(h),
  );
}

function derivarStatusOperacional(reserva) {
  const payUi = resolvePaymentUiForReserva(reserva);
  if (payUi && payUi.kind === "pago_pagarme_hits_pendente") {
    return {
      label: payUi.statusBadgeLabel || "Pago Pagar.me · HITS pendente",
      type: "pagarme-pago-hits-pendente",
    };
  }
  if (isPagamentoPendenteOperacional(reserva)) {
    return { label: "Pendente pagamento", type: "pendente-pagamento" };
  }
  if (hasFnrhPendente(reserva)) {
    return { label: "Pendente FNRH", type: "pendente-fnrh" };
  }
  if (!acessoLiberadoEfetivo(reserva)) {
    if (ttlockBloqueiaLiberadoNoPainel(reserva) && reserva.acessoLiberado && !reserva.ttlockPrincipalTodosProvisionados) {
      return { label: "TTLock pendente (liberação incompleta)", type: "pronto-liberar" };
    }
    return { label: "Pronto para liberar acesso", type: "pronto-liberar" };
  }
  if (acessoLiberadoEfetivo(reserva) && !reserva.entrouNoApto) {
    return { label: "Acesso liberado, aguardando chegada", type: "aguardando-chegada" };
  }
  if (reserva.entrouNoApto) {
    return { label: "Entrou no apto", type: "entrou" };
  }
  return { label: "—", type: "neutral" };
}

function filtrarReservas(lista, filtroAtivo) {
  if (filtroAtivo === FILTER_ALL) return lista;
  const hoje = todayStr();
  if (filtroAtivo === FILTER_CHEGANDO_HOJE) {
    return lista.filter((r) => r.checkInPrevisto === hoje);
  }
  if (filtroAtivo === FILTER_PENDENTE_PAGAMENTO) {
    return lista.filter((r) => isPagamentoPendenteOperacional(r));
  }
  if (filtroAtivo === FILTER_PENDENTE_FNRH) {
    return lista.filter((r) => hasFnrhPendente(r));
  }
  if (filtroAtivo === FILTER_ACESSO_LIBERADO) {
    return lista.filter((r) => acessoLiberadoEfetivo(r));
  }
  if (filtroAtivo === FILTER_NAO_ENTROU) {
    return lista.filter((r) => acessoLiberadoEfetivo(r) && r.entrouNoApto === false);
  }
  if (filtroAtivo === FILTER_ENTROU) {
    return lista.filter((r) => r.entrouNoApto === true);
  }
  if (filtroAtivo === FILTER_PRIORIDADE_ALTA) return lista.filter((r) => getPrioridadeReserva(r) === PRIORIDADE_ALTA);
  if (filtroAtivo === FILTER_PRIORIDADE_MEDIA) return lista.filter((r) => getPrioridadeReserva(r) === PRIORIDADE_MEDIA);
  if (filtroAtivo === FILTER_PRIORIDADE_BAIXA) return lista.filter((r) => getPrioridadeReserva(r) === PRIORIDADE_BAIXA);
  if (filtroAtivo === FILTER_ETAPA_DADOS_PENDENTES) return lista.filter((r) => getEtapaFunilReserva(r) === ETAPA_FUNIL.DADOS_PENDENTES);
  if (filtroAtivo === FILTER_ETAPA_FNRH_EM_ANDAMENTO) return lista.filter((r) => getEtapaFunilReserva(r) === ETAPA_FUNIL.FNRH_EM_ANDAMENTO);
  if (filtroAtivo === FILTER_ETAPA_PRONTA_LIBERAR) return lista.filter((r) => getEtapaFunilReserva(r) === ETAPA_FUNIL.PRONTA_LIBERAR);
  if (filtroAtivo === FILTER_ETAPA_ACESSO_LIBERADO) return lista.filter((r) => getEtapaFunilReserva(r) === ETAPA_FUNIL.ACESSO_LIBERADO);
  if (filtroAtivo === FILTER_ETAPA_CHECKIN_CONCLUIDO) return lista.filter((r) => getEtapaFunilReserva(r) === ETAPA_FUNIL.CHECKIN_CONCLUIDO);
  return lista;
}

function calcularResumo(lista) {
  return getResumoFunil(lista);
}

function renderOperationalMetrics() {
  const list = Array.isArray(reservas) ? reservas : [];
  const summary = calcularResumo(list);
  const completedToday = list.filter(
    (reservation) =>
      isChegadaHoje(reservation) && isCheckinConcluido(reservation),
  ).length;
  const fnrhPending = list.filter((reservation) =>
    hasFnrhPendente(reservation),
  ).length;
  const completionPercent = summary.chegadasHoje
    ? Math.round((completedToday / summary.chegadasHoje) * 100)
    : 0;

  if (opKpiArrivals) opKpiArrivals.textContent = String(summary.chegadasHoje);
  if (opKpiArrivalsNote) {
    opKpiArrivalsNote.textContent =
      summary.chegadasHoje === 1
        ? "1 chegada prevista"
        : `${summary.chegadasHoje} chegadas previstas`;
  }
  if (opKpiCompleted) {
    opKpiCompleted.textContent = String(completedToday);
  }
  if (opKpiCompletedNote) {
    opKpiCompletedNote.textContent = `${completionPercent}% das chegadas`;
  }
  if (opKpiFnrh) opKpiFnrh.textContent = String(fnrhPending);
  if (opKpiFnrhNote) {
    opKpiFnrhNote.textContent =
      fnrhPending > 0 ? "Requer atenção" : "Sem pendências";
  }
  // Mesmo universo da aba "Acesso liberado": lista operacional (busca/período + ocultação pós-corte).
  // Antes o KPI usava todas as reservas carregadas e podia divergir (ex.: 5 no KPI × 4 na aba).
  const Pcount = getPanelPresentation();
  const baseLista = listaBaseContagens();
  const accessGrantedOperacional =
    Pcount && typeof Pcount.countAcessosLiberados === "function"
      ? Pcount.countAcessosLiberados(baseLista)
      : baseLista.filter((r) => acessoLiberadoEfetivo(r)).length;
  if (opKpiAccess) opKpiAccess.textContent = String(accessGrantedOperacional);
  renderOccupiedGuestsCard();
}

const MAPA_FILTRO_ETAPA = {
  [ETAPA_FUNIL.DADOS_PENDENTES]: FILTER_ETAPA_DADOS_PENDENTES,
  [ETAPA_FUNIL.FNRH_EM_ANDAMENTO]: FILTER_ETAPA_FNRH_EM_ANDAMENTO,
  [ETAPA_FUNIL.PRONTA_LIBERAR]: FILTER_ETAPA_PRONTA_LIBERAR,
  [ETAPA_FUNIL.ACESSO_LIBERADO]: FILTER_ETAPA_ACESSO_LIBERADO,
  [ETAPA_FUNIL.CHECKIN_CONCLUIDO]: FILTER_ETAPA_CHECKIN_CONCLUIDO,
};

/* ---------- Estado de UI (filtro ativo, drawer aberto) ---------- */
let filtroAtivo = FILTER_ALL;
let periodoAtivo = "all";
let buscaLista = "";
let detailReservaId = null;

const OP_TAB_DEFS = [
  [FILTER_ALL, "Todos"],
  [FILTER_CHEGANDO_HOJE, "Chegando hoje"],
  [FILTER_PENDENTE_PAGAMENTO, "Pendente pagamento"],
  [FILTER_PENDENTE_FNRH, "Pendente FNRH"],
  [FILTER_ACESSO_LIBERADO, "Acesso liberado"],
  [FILTER_NAO_ENTROU, "Não entrou"],
  [FILTER_ENTROU, "Concluído"],
];

function filtrarPorBusca(lista, q) {
  const t = (q || "").trim().toLowerCase();
  if (!t) return lista;
  return lista.filter((r) => {
    const apt = String(r.apartamento || "").toLowerCase();
    const nome = String(r.hospedePrincipal || "").toLowerCase();
    const id = String(r.id || "").toLowerCase();
    return apt.includes(t) || nome.includes(t) || id.includes(t);
  });
}

function filtrarPorPeriodo(lista, periodo) {
  if (periodo === "all" || !periodo) return lista;
  const todayYMD = todayStr();
  const hoje = new Date();
  return lista.filter((r) => {
    const ci = r.checkInPrevisto;
    if (!ci || String(ci).length < 10) return false;
    const ymd = String(ci).slice(0, 10);
    if (periodo === "checkin_today") return ymd === todayYMD;
    if (periodo === "checkin_week") {
      const d = new Date(ymd + "T12:00:00");
      const start = new Date(todayYMD + "T12:00:00");
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return !isNaN(d.getTime()) && d >= start && d <= end;
    }
    if (periodo === "checkin_month") {
      const d = new Date(ymd + "T12:00:00");
      return !isNaN(d.getTime()) && d.getMonth() === hoje.getMonth() && d.getFullYear() === hoje.getFullYear();
    }
    return true;
  });
}

/**
 * Instantâneo local: 11:00 do dia **seguinte** ao check-in previsto.
 * Após esse momento, a reserva pode sair da lista padrão se não houver pendência relevante.
 */
function getCutoffOcultarListaPadraoAposCheckin(checkInPrevisto) {
  const ymd = String(checkInPrevisto || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(ymd + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 1);
  d.setHours(11, 0, 0, 0);
  return d;
}

/** Pendência que mantém reserva “viva” na lista padrão (fila operacional + exceções já reconhecidas pelo painel). */
function temPendenciaOperacionalRelevanteParaListaPadrao(reserva) {
  if (!reserva) return true;
  if (getFilaOperacionalRank(reserva) < 4) return true;
  if (derivarExcecaoOperacionalReserva(reserva)) return true;
  return false;
}

/** Ocultar da lista padrão: já passou o corte após check-in e não há pendência operacional relevante. */
function reservaOcultaDaListaPadraoOperacional(reserva) {
  if (temPendenciaOperacionalRelevanteParaListaPadrao(reserva)) return false;
  const cutoff = getCutoffOcultarListaPadraoAposCheckin(reserva.checkInPrevisto);
  if (!cutoff) return false;
  return Date.now() >= cutoff.getTime();
}

/** Base para contadores das abas: aplica busca + período, não o filtro da aba */
function listaBaseContagens() {
  let L = Array.isArray(reservas) ? reservas.slice() : [];
  L = filtrarPorPeriodo(L, periodoAtivo);
  const buscaAtiva = String(buscaLista || "").trim().length > 0;
  if (!buscaAtiva) {
    L = L.filter((r) => !reservaOcultaDaListaPadraoOperacional(r));
  }
  L = filtrarPorBusca(L, buscaLista);
  return L;
}

function listaParaExibicao() {
  let L = listaBaseContagens();
  L = filtrarReservas(L, filtroAtivo);
  return sortReservasPorPrioridade(L);
}

function formatDataBR(ymd) {
  if (!ymd || String(ymd).length < 10) return "—";
  const p = String(ymd).slice(0, 10).split("-");
  if (p.length !== 3) return "—";
  return `${p[2]}/${p[1]}`;
}

function noitesEntre(checkIn, checkOut) {
  const a = new Date(String(checkIn).slice(0, 10) + "T12:00:00");
  const b = new Date(String(checkOut).slice(0, 10) + "T12:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const ms = b.getTime() - a.getTime();
  const n = Math.round(ms / (86400000));
  return n > 0 ? n : null;
}

function badgeClassFromStatusType(type) {
  const map = {
    "pendente-pagamento": "op-badge op-badge--pend-pag",
    "pagarme-pago-hits-pendente": "op-badge op-badge--pagarme-hits",
    "pendente-fnrh": "op-badge op-badge--pend-fnrh",
    "pronto-liberar": "op-badge op-badge--pronto",
    "aguardando-chegada": "op-badge op-badge--aguardando",
    entrou: "op-badge op-badge--concluido",
    neutral: "op-badge op-badge--neutral",
  };
  return map[type] || "op-badge op-badge--neutral";
}

function syncToolbarSelectFromFiltro() {
  if (opToolbarStatusSelect instanceof HTMLSelectElement) {
    const v = filtroAtivo;
    const opt = Array.from(opToolbarStatusSelect.options).some((o) => o.value === v);
    opToolbarStatusSelect.value = opt ? v : FILTER_ALL;
  }
}

function renderStatusTabs() {
  if (!(opStatusTabsElement instanceof HTMLElement)) return;
  const base = listaBaseContagens();
  const tabsHtml = OP_TAB_DEFS.map(([key, label]) => {
    const count = filtrarReservas(base, key).length;
    const selected = filtroAtivo === key;
    return `<button type="button" role="tab" class="op-tab" data-filter="${key}" aria-selected="${selected}" aria-label="${escapeHtml(label + ", " + count + " reservas")}">
      <span>${escapeHtml(label)}</span>
      <span class="op-tab__count">${count}</span>
    </button>`;
  }).join("");
  opStatusTabsElement.innerHTML = tabsHtml;
  opStatusTabsElement.querySelectorAll(".op-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      filtroAtivo = btn.getAttribute("data-filter") || FILTER_ALL;
      syncToolbarSelectFromFiltro();
      renderStatusTabs();
      renderOperacionalLista();
      if (opTableCount) {
        const list = listaParaExibicao();
        opTableCount.textContent = list.length === 1 ? "1 reserva" : `${list.length} reservas`;
      }
    });
  });
  syncToolbarSelectFromFiltro();
}

/* ---------- Render ---------- */

/* ---------- Ações de domínio (mutam estado e chamam refresh) ---------- */
/* Aliases semânticos para futura integração: simularPagamentoAprovado=acaoMarcarPagamentoOk,
   simularConfirmacaoFnrh=acaoAvançarFnrh (ou por hóspede no drawer), enviarLinksFnrh=botão Enviar no detail,
   reenviarLinkFnrh=reenviarHospede, liberarAcessoReserva=acaoLiberarAcesso, marcarEntradaReserva=acaoConfirmarCheckin,
   adicionarHospedeReserva=adicionarHospede, removerHospedeReserva=removerHospede,
   definirHospedePrincipalReserva=definirPrincipal, atualizarHospedeCampo=atualizarHospedeCampo. */
async function atualizarHospedeCampo(reservaId, guestIndex, campo, valor) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
  if (campo === "nome") {
    h.nome = String(valor == null ? "" : valor).trim();
    if (h.principal) r.hospedePrincipal = h.nome;
  } else if (campo === "email") {
    h.email = String(valor == null ? "" : valor).trim();
  } else if (campo === "whatsapp") {
    h.whatsapp = String(valor == null ? "" : valor).trim();
  }
  syncGuestStatus(h);
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendUpdateHospedeFull(reservaId, guestIndex, h);
    if (ok) await refreshFromSource();
    return;
  }
  refresh();
}

async function acaoMarcarPagamentoOk(id) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendSetPagamentoOk(id);
    if (ok) {
      await refreshFromSource();
      await tentarLiberacaoPorRequisitos(id);
      await refreshFromSource();
    }
    return;
  }
  const r = getReservaById(id);
  if (r) {
    r.pagamento = "pago";
    addHistoricoEvento(r, "pagamento_aprovado", "Pagamento aprovado", null);
  }
  refresh();
  await tentarLiberacaoPorRequisitos(id);
}

async function acaoAvançarFnrh(id) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendConfirmarFnrh(id, null);
    if (ok) {
      await refreshFromSource();
      await tentarLiberacaoPorRequisitos(id);
      await refreshFromSource();
    }
    return;
  }
  const r = getReservaById(id);
  if (!r) return;
  const antes = getFnrhConfirmadas(r);
  if (registrarProximaFnrh(r)) {
    addHistoricoEvento(r, "fnrh_confirmada", "FNRH confirmada (próxima pendente)", null);
    maybeRegistrarFnrhCompleta(r, antes);
  }
  refresh();
  if (isFnrhCompleta(getReservaById(id))) {
    await tentarLiberacaoPorRequisitos(id);
  }
}

async function acaoLiberarAcesso(id) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const result = await backendLiberarAcesso(id);
    if (result.ok) {
      await refreshFromSource();
    } else {
      alert(result.error || "Não foi possível liberar o acesso.");
    }
    return;
  }
  const r = getReservaById(id);
  if (r && r.pagamento === "pago" && !hasFnrhPendente(r)) {
    r.acessoLiberado = true;
    addHistoricoEvento(r, "acesso_liberado", "Acesso liberado", null);
  }
  refresh();
}

let _confirmarCheckinInProgress = false;
async function acaoConfirmarCheckin(id) {
  if (_confirmarCheckinInProgress) return;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    _confirmarCheckinInProgress = true;
    try {
      const ok = await backendMarcarEntrada(id);
      if (ok) await refreshFromSource();
    } finally {
      _confirmarCheckinInProgress = false;
    }
    return;
  }
  const r = getReservaById(id);
  if (r) {
    r.entrouNoApto = true;
    addHistoricoEvento(r, "entrada_apartamento", "Entrada no apartamento registrada", null);
  }
  refresh();
}

/** Texto curto + destaque/CTA para coluna Próxima ação — alinhado a derivarRecomendacaoOperacional. */
function listaProximaAcaoOperacional(reserva) {
  const ctx = buildRecomendacaoOperacionalCtx(reserva);
  const rec = derivarRecomendacaoOperacional(reserva, ctx);
  const raw = rec && rec.listaLabel != null ? String(rec.listaLabel).trim() : "";
  const texto = raw || "—";
  const cta = rec && rec.cta && rec.cta.kind ? rec.cta : null;
  return { texto, destaque: !!cta, cta: cta };
}

/** Resumo curto para coluna Fluxo (lista): PAGO/NÃO PAGO em destaque + FNRH + no máximo um terceiro sinal. Retorna HTML seguro. */
function linhaFluxoResumo(reserva) {
  const total = getHospedesTotal(reserva);
  const confirmadas = getFnrhConfirmadas(reserva);
  const pago = isPagamentoOk(reserva);

  const pagClass = pago ? "op-flux-pag op-flux-pag--paid" : "op-flux-pag op-flux-pag--unpaid";
  const pagText = pago ? "PAGO" : "NÃO PAGO";
  const pagHtml = `<span class="${pagClass}">${escapeHtml(pagText)}</span>`;

  let fnrh;
  if (total === 0) fnrh = "FNRH —";
  else if (confirmadas === 0) fnrh = `FNRH 0/${total}`;
  else if (confirmadas < total) fnrh = "FNRH parcial";
  else fnrh = `FNRH ${total}/${total}`;

  const rest = [fnrh];

  if (!pago) {
    const payUi = resolvePaymentUiForReserva(reserva);
    if (payUi && payUi.kind === "pago_pagarme_hits_pendente") {
      rest.unshift("Pagar.me OK");
    } else if (payUi && payUi.kind === "aguardando") {
      rest.unshift("Aguard. pag.");
    } else if (payUi && payUi.kind === "comissionada") {
      rest.unshift("Comissionada");
    }
  }

  if (pago) {
    if (reserva.entrouNoApto) {
      rest.push("Entrou");
    } else if (total > 0 && confirmadas === total) {
      rest.push(acessoLiberadoEfetivo(reserva) ? "Acesso ok" : "Sem acesso");
    } else if (total > 0) {
      rest.push(`${total} hósp.`);
    }
  }

  const restHtml = rest.map((t) => escapeHtml(t)).join(" · ");
  return `${pagHtml} · ${restHtml}`;
}

/** Título HTML seguro para tooltip do nome na lista. */
function titleAttrEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateRowSelectionUi() {
  const sel = detailReservaId || "";
  document.querySelectorAll("tr.op-tr").forEach((tr) => {
    const id = tr.getAttribute("data-id");
    tr.setAttribute("aria-selected", id === sel ? "true" : "false");
  });
  document.querySelectorAll("button.op-mcard").forEach((btn) => {
    const id = btn.getAttribute("data-id");
    btn.setAttribute("aria-selected", id === sel ? "true" : "false");
  });
}

function renderOperacionalLista() {
  const ordenadas = listaParaExibicao();

  if (opTableCount instanceof HTMLElement) {
    opTableCount.textContent = ordenadas.length === 1 ? "1 reserva" : `${ordenadas.length} reservas`;
  }

  if (ordenadas.length === 0) {
    if (opTableBody instanceof HTMLElement) opTableBody.innerHTML = "";
    if (opMobileList instanceof HTMLElement) opMobileList.innerHTML = "";
    if (opEmptyState instanceof HTMLElement) opEmptyState.classList.remove("hidden");
    updateRowSelectionUi();
    return;
  }
  if (opEmptyState instanceof HTMLElement) opEmptyState.classList.add("hidden");

  const rowsHtml = ordenadas
    .map((reserva) => {
      const status = derivarStatusOperacional(reserva);
      const badgeCls = badgeClassFromStatusType(status.type);
      const ci = formatDataBR(reserva.checkInPrevisto);
      const co = formatDataBR(reserva.checkOutPrevisto);
      const n = noitesEntre(reserva.checkInPrevisto, reserva.checkOutPrevisto);
      const noitesTxt = n != null ? `${n} ${n === 1 ? "noite" : "noites"}` : "";
      const proxInfo = listaProximaAcaoOperacional(reserva);
      const prox = proxInfo.texto;
      const proxCls = proxInfo.destaque ? "op-next-action" : "op-next-action op-next-action--muted";
      const flux = linhaFluxoResumo(reserva);
      const rid = escapeHtml(String(reserva.id));
      const guestName = reserva.hospedePrincipal || "—";
      const guestTitle = titleAttrEscape(guestName);
      const proxHtml =
        proxInfo.cta && proxInfo.cta.kind
          ? `<button type="button" class="op-next-action-btn" data-id="${rid}" data-cta-kind="${escapeHtml(proxInfo.cta.kind)}" title="${titleAttrEscape(prox)}">${escapeHtml(prox)}</button>`
          : `<span class="${proxCls}">${escapeHtml(prox)}</span>`;
      return `<tr class="op-tr" data-id="${rid}" tabindex="0" role="row">
        <td class="op-td op-td--apt"><span class="op-apt-num">${escapeHtml(String(reserva.apartamento || "—"))}</span></td>
        <td class="op-td op-td--guest">
          <span class="op-guest-name" title="${guestTitle}">${escapeHtml(guestName)}</span>
          <span class="op-guest-sub" title="${guestTitle}">${escapeHtml(String(reserva.id || "").slice(0, 12))}${reserva.id && String(reserva.id).length > 12 ? "…" : ""}</span>
        </td>
        <td class="op-td">
          <div class="op-period-line">${ci} → ${co}</div>
          ${noitesTxt ? `<div class="op-period-sub">${escapeHtml(noitesTxt)}</div>` : ""}
        </td>
        <td class="op-td op-td--flux"><div class="op-flux">${flux}</div></td>
        <td class="op-td op-td--status"><span class="${badgeCls}">${escapeHtml(status.label)}</span></td>
        <td class="op-td op-td--next">${proxHtml}</td>
        <td class="op-td op-td--actions">
          <div class="op-actions-cell">
            <button type="button" class="op-btn-table op-btn-ver" data-id="${rid}">Ver</button>
            <button type="button" class="op-btn-icon op-btn-more" data-id="${rid}" title="Detalhes" aria-label="Abrir detalhes">⋯</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  if (opTableBody instanceof HTMLElement) opTableBody.innerHTML = rowsHtml;

  const mobileHtml = ordenadas
    .map((reserva) => {
      const status = derivarStatusOperacional(reserva);
      const badgeCls = badgeClassFromStatusType(status.type);
      const ci = formatDataBR(reserva.checkInPrevisto);
      const co = formatDataBR(reserva.checkOutPrevisto);
      const proxInfoM = listaProximaAcaoOperacional(reserva);
      const prox = proxInfoM.texto;
      const rid = escapeHtml(String(reserva.id));
      const mGuest = reserva.hospedePrincipal || "—";
      const mGuestTitle = titleAttrEscape(mGuest);
      const proxMobileHtml =
        proxInfoM.cta && proxInfoM.cta.kind
          ? `<button type="button" class="op-next-action-btn op-next-action-btn--mcard" data-id="${rid}" data-cta-kind="${escapeHtml(proxInfoM.cta.kind)}" data-stop="1">${escapeHtml(prox)}</button>`
          : `<span class="op-next-action${proxInfoM.destaque ? "" : " op-next-action--muted"}">${escapeHtml(prox)}</span>`;
      return `<button type="button" class="op-mcard" data-id="${rid}">
        <div class="op-mcard__r1">
          <span class="op-mcard__apt">${escapeHtml(String(reserva.apartamento || "—"))}</span>
          <span class="${badgeCls}">${escapeHtml(status.label)}</span>
        </div>
        <div class="op-mcard__name" title="${mGuestTitle}">${escapeHtml(mGuest)}</div>
        <div class="op-mcard__meta">${ci} → ${co}</div>
        <div class="op-mcard__flux">${linhaFluxoResumo(reserva)}</div>
        <div class="op-mcard__row5">
          ${proxMobileHtml}
          <span class="op-btn-table op-btn-ver-inline" data-stop="1">Ver</span>
        </div>
      </button>`;
    })
    .join("");
  if (opMobileList instanceof HTMLElement) opMobileList.innerHTML = mobileHtml;

  function bindRowOpen(tr) {
    const id = tr.getAttribute("data-id");
    if (!id) return;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetail(id);
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(id);
      }
    });
  }

  opTableBody?.querySelectorAll("tr.op-tr").forEach(bindRowOpen);
  opTableBody?.querySelectorAll(".op-btn-ver, .op-btn-more").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      if (id) openDetail(id);
    });
  });
  opTableBody?.querySelectorAll(".op-next-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      const kind = btn.getAttribute("data-cta-kind") || "";
      if (id && kind) openDetailAndRunCta(id, kind);
    });
  });

  opMobileList?.querySelectorAll(".op-mcard").forEach((card) => {
    card.addEventListener("click", (e) => {
      const id = card.getAttribute("data-id");
      if (!id) return;
      const ctaBtn = e.target && e.target.closest ? e.target.closest(".op-next-action-btn") : null;
      if (ctaBtn) {
        e.stopPropagation();
        const kind = ctaBtn.getAttribute("data-cta-kind") || "";
        if (kind) openDetailAndRunCta(id, kind);
        return;
      }
      if (e.target.closest && e.target.closest("[data-stop]")) {
        e.stopPropagation();
        openDetail(id);
        return;
      }
      openDetail(id);
    });
  });

  updateRowSelectionUi();
}

/** Abre o painel e reutiliza o mesmo roteador de CTA do detalhe. */
function openDetailAndRunCta(reservaId, kind) {
  if (!reservaId || !kind) return;
  openDetail(reservaId);
  window.setTimeout(function () {
    executeRecomendacaoCta(reservaId, kind);
  }, 40);
}

function executeRecomendacaoCta(reservaId, kind) {
  if (!reservaId || !kind) return;
  const reserva = getReservaById(reservaId);
  if (!reserva) return;
  if (kind === "enviar_fnrh") {
    const el = detailBodyElement && detailBodyElement.querySelector("#detail-enviar-links-btn");
    if (el) el.click();
    else openTopContatoPanel(reservaId, "fnrh");
    return;
  }
  if (kind === "reenviar_fnrh") {
    const el = detailBodyElement && detailBodyElement.querySelector("#detail-reenviar-fnrh-topo-btn");
    if (el) el.click();
    else openTopContatoPanel(reservaId, "fnrh_reenviar");
    return;
  }
  if (kind === "gerar_senha") {
    const enviarBtnCred = detailBodyElement && detailBodyElement.querySelector("#detail-enviar-senha-btn");
    if (enviarBtnCred) enviarBtnCred.click();
    else openTopContatoPanel(reservaId, "senha");
    return;
  }
  if (kind === "liberar_acesso") {
    acaoLiberarAcesso(reservaId);
    return;
  }
  if (kind === "marcar_entrada") {
    acaoConfirmarCheckin(reservaId);
    return;
  }
  if (kind === "simular_pagamento") {
    acaoMarcarPagamentoOk(reservaId);
    return;
  }
  if (
    kind === "pagarme_classificar" ||
    kind === "pagarme_cobrar" ||
    kind === "pagarme_ver" ||
    kind === "pagarme_revisao"
  ) {
    openPagarmeCobrancaModal(reservaId);
    return;
  }
  if (kind === "ir_hospedes") {
    const sec = document.getElementById("detail-hospedes-section");
    if (sec) {
      sec.classList.add("detail-section-highlight");
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(function () {
        sec.classList.remove("detail-section-highlight");
      }, 2200);
      const editBtn = sec.querySelector(".guest-edit-toggle-btn");
      if (editBtn) editBtn.focus();
    }
    return;
  }
  if (kind === "ir_ttlock") {
    const tw = document.getElementById("detail-ttlock-wrap");
    if (tw) {
      tw.classList.add("detail-section-highlight");
      tw.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(function () {
        tw.classList.remove("detail-section-highlight");
      }, 2200);
    }
  }
}

function syncDetailPanelChrome(reserva) {
  const has = !!(reserva && reserva.id);
  if (opDetailEmpty instanceof HTMLElement) {
    opDetailEmpty.classList.toggle("hidden", has);
  }
  if (opDetailFilled instanceof HTMLElement) {
    opDetailFilled.classList.toggle("hidden", !has);
  }
  if (!has) {
    if (opDetailApto instanceof HTMLElement) opDetailApto.textContent = "—";
    if (opDetailBadgeWrap instanceof HTMLElement) opDetailBadgeWrap.innerHTML = "";
    if (detailTitleElement instanceof HTMLElement) detailTitleElement.textContent = "Reserva";
    if (detailSubtitleElement instanceof HTMLElement) detailSubtitleElement.textContent = "";
    return;
  }
  // Cabeçalho: identidade (apto + hóspede). Situação operacional fica no card Situação.
  if (opDetailBadgeWrap instanceof HTMLElement) {
    opDetailBadgeWrap.innerHTML = "";
  }
  if (opDetailApto instanceof HTMLElement) {
    opDetailApto.textContent = String(reserva.apartamento || "—");
  }
  if (detailTitleElement instanceof HTMLElement) {
    detailTitleElement.textContent = (reserva.hospedePrincipal || "").trim() || "—";
  }
  if (detailSubtitleElement instanceof HTMLElement) {
    const ci = formatDataBR(reserva.checkInPrevisto);
    const co = formatDataBR(reserva.checkOutPrevisto);
    const idShort = String(reserva.id || "").trim();
    const pri = getPrioridadeLabel(getPrioridadeReserva(reserva));
    const parts = [`${ci} → ${co}`, idShort ? `Reserva ${idShort}` : "", pri ? `Prioridade ${pri}` : ""].filter(Boolean);
    detailSubtitleElement.textContent = parts.join(" · ");
  }
}

/* ---------- Chegadas + card hospedados ---------- */
let painelView = "reservas";
let arrivalsFilter = "hoje";
let arrivalsPage = 0;
const ARRIVALS_PAGE_SIZE = 20;
let arrivalsDatasetCache = null;
let occupiedSummaryCache = null;

function isPagamentoPendenteOperacional(reserva) {
  return reserva.pagamento === "pendente" || reserva.pagamento === "parcial";
}

function recentChangeLabelsFromHistorico(historico) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const labels = [];
  (historico || []).forEach(function (ev) {
    const tipo = String(ev.tipo || "");
    if (tipo.indexOf("hits_") !== 0) return;
    const iso = ev.criadoEmIso || null;
    if (iso) {
      const t = Date.parse(iso);
      if (!Number.isFinite(t) || t < cutoff) return;
    }
    const detalhe = String(ev.detalhe || ev.titulo || "").trim();
    if (!detalhe) return;
    // Resumos curtos para a lista
    if (tipo === "hits_apartamento_alterado") {
      const m = detalhe.match(/:\s*(.+)$/);
      labels.push(m ? "Apto. " + m[1] : "Apartamento alterado");
    } else if (tipo === "hits_quantidade_hospedes_alterada") {
      const m = detalhe.match(/:\s*(.+)$/);
      labels.push(m ? "Hóspedes " + m[1] : "Quantidade alterada");
    } else if (tipo === "hits_reserva_cancelada") {
      labels.push("Reserva cancelada");
    } else if (
      tipo === "hits_checkin_alterado" ||
      tipo === "hits_checkout_alterado" ||
      tipo === "hits_chegada_alterada" ||
      tipo === "hits_saida_alterada"
    ) {
      labels.push("Datas alteradas");
    } else if (tipo === "hits_pagamento_alterado") {
      labels.push("Pagamento alterado");
    }
  });
  return labels.slice(0, 3);
}

function buildArrivalsInputFromInternal(r) {
  const guests = Array.isArray(r.hospedes) ? r.hospedes.filter(function (h) {
    return !h.removed_from_reservation && !h.removedFromReservation;
  }) : [];
  const tol = r.acessoTolerancia || {};
  return {
    id: r.id,
    external_reservation_id: r.externalReservationId || null,
    apartamento: r.apartamento || "",
    hospede_principal: r.hospedePrincipal || "",
    check_in_previsto: r.checkInPrevisto || "",
    check_out_previsto: r.checkOutPrevisto || "",
    status_reserva: r.statusReserva || "ativa",
    pagamento_status: r.pagamento || "desconhecido",
    entrou_no_apto: !!r.entrouNoApto,
    acesso_liberado: !!r.acessoLiberado,
    total_hospedes: Math.max(guests.length, 1),
    fnrh_pendente: hasFnrhPendente(r),
    recent_change_labels: recentChangeLabelsFromHistorico(r.historicoOperacional),
    recent_cancel_event: (r.historicoOperacional || []).some(function (ev) {
      return String(ev.tipo || "") === "hits_reserva_cancelada";
    }),
    tolerancia_ativa: tol.grace_status === "active",
    senha_suspensa: tol.grace_status === "suspended",
    comunicacao_falha: !!tol.communication_failed,
    credencial_ausente: !r.acessoLiberado && !r.ttlockPrincipalTodosProvisionados,
  };
}

/**
 * Pendência de FNRH agregada para a aba Chegadas.
 * Só `fnrh_completo` encerra a pendência (grafia do schema; nunca `fnrh_completa`).
 */
function isFnrhAggregatePending(value) {
  return String(value || "").trim() !== "fnrh_completo";
}

/**
 * Consulta em lote para Chegadas (sem N+1 por reserva).
 * Fallback defensivo se status_reserva ainda não existir (migration não aplicada).
 */
async function loadArrivalsDatasetFromBackend() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const colsBase =
    "id, apartamento, hospede_principal, check_in_previsto, check_out_previsto, pagamento_status, entrou_no_apto, acesso_liberado, external_reservation_id, fnrh_status_agregado, origem_externa";
  let rows = null;
  let error = null;
  let truncated = false;
  ({ data: rows, error } = await supabase
    .from("operacional_reservas")
    .select(colsBase + ", status_reserva, synced_at")
    .order("check_in_previsto", { ascending: true })
    .order("apartamento", { ascending: true })
    .limit(500));
  if (error) {
    ({ data: rows, error } = await supabase
      .from("operacional_reservas")
      .select(colsBase)
      .order("check_in_previsto", { ascending: true })
      .limit(500));
  }
  if (error || !Array.isArray(rows)) return { items: [], truncated: false };
  truncated = rows.length >= 500;

  const ids = rows.map(function (r) { return r.id; }).filter(Boolean);
  const guestsByReserva = {};
  const eventsByReserva = {};
  const tolByReserva = {};
  const outboxFail = {};

  if (ids.length > 0) {
    const { data: guestRows } = await supabase
      .from("operacional_hospedes")
      .select("id, reserva_id, nome, principal, removed_from_reservation")
      .in("reserva_id", ids);
    (guestRows || []).forEach(function (g) {
      if (g.removed_from_reservation) return;
      const rid = g.reserva_id;
      if (!guestsByReserva[rid]) guestsByReserva[rid] = [];
      guestsByReserva[rid].push(g);
    });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: eventRows } = await supabase
      .from("operacional_reserva_eventos")
      .select("reserva_id, tipo, titulo, detalhe, criado_em")
      .in("reserva_id", ids)
      .gte("criado_em", cutoff)
      .like("tipo", "hits_%")
      .order("criado_em", { ascending: false });
    (eventRows || []).forEach(function (ev) {
      const rid = ev.reserva_id;
      if (!eventsByReserva[rid]) eventsByReserva[rid] = [];
      eventsByReserva[rid].push({
        tipo: ev.tipo,
        titulo: ev.titulo,
        detalhe: ev.detalhe,
        criadoEmIso: ev.criado_em,
      });
    });

    const { data: tolRows } = await supabase
      .from("operacional_acesso_tolerancias")
      .select("reservation_id, grace_status")
      .in("reservation_id", ids);
    (tolRows || []).forEach(function (t) {
      tolByReserva[t.reservation_id] = t;
    });

    const { data: failRows } = await supabase
      .from("operacional_acesso_outbox")
      .select("reservation_id")
      .in("reservation_id", ids)
      .eq("status", "failed")
      .is("processed_at", null);
    (failRows || []).forEach(function (f) {
      outboxFail[f.reservation_id] = true;
    });
  }

  const items = rows.map(function (r) {
    const guests = guestsByReserva[r.id] || [];
    const hist = eventsByReserva[r.id] || [];
    const tol = tolByReserva[r.id] || {};
    const hasRecentCancel = hist.some(function (ev) {
      return ev.tipo === "hits_reserva_cancelada";
    });
    return {
      id: r.id,
      external_reservation_id: (r.external_reservation_id || "").trim() || null,
      apartamento: (r.apartamento || "").trim(),
      hospede_principal: (r.hospede_principal || "").trim(),
      check_in_previsto: String(r.check_in_previsto || "").slice(0, 10),
      check_out_previsto: String(r.check_out_previsto || "").slice(0, 10),
      status_reserva: r.status_reserva === "cancelada" ? "cancelada" : "ativa",
      pagamento_status: mapPagamentoStatusFromDb(r.pagamento_status),
      entrou_no_apto: !!r.entrou_no_apto,
      acesso_liberado: !!r.acesso_liberado,
      total_hospedes: Math.max(guests.length, 1),
      fnrh_pendente: isFnrhAggregatePending(r.fnrh_status_agregado),
      recent_change_labels: recentChangeLabelsFromHistorico(hist),
      recent_cancel_event: hasRecentCancel,
      tolerancia_ativa: tol.grace_status === "active",
      senha_suspensa: tol.grace_status === "suspended",
      comunicacao_falha: !!outboxFail[r.id],
      credencial_ausente: !r.acesso_liberado,
    };
  });
  return { items: items, truncated: truncated };
}

function getArrivalsPolicy() {
  return typeof window !== "undefined" ? window.YesHotelArrivalsPolicy : null;
}

let arrivalsTruncatedWarning = false;

async function ensureArrivalsDataset() {
  if (arrivalsDatasetCache) return arrivalsDatasetCache;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && getSupabase()) {
    const loaded = await loadArrivalsDatasetFromBackend();
    arrivalsDatasetCache = loaded.items || [];
    arrivalsTruncatedWarning = !!loaded.truncated;
  } else {
    arrivalsDatasetCache = (reservas || []).map(buildArrivalsInputFromInternal);
    arrivalsTruncatedWarning = false;
  }
  return arrivalsDatasetCache;
}

function invalidateArrivalsCache() {
  arrivalsDatasetCache = null;
  occupiedSummaryCache = null;
  arrivalsTruncatedWarning = false;
}

function renderOccupiedGuestsCard() {
  const policy = getArrivalsPolicy();
  const raw = arrivalsDatasetCache || (reservas || []).map(buildArrivalsInputFromInternal);
  const items = Array.isArray(raw) ? raw : [];
  occupiedSummaryCache = policy
    ? policy.summarizeOccupiedGuests(items)
    : { total_guests: 0, occupied_apartments: 0, stays: [] };
  if (opKpiOccupiedGuests) {
    const n = occupiedSummaryCache.total_guests;
    opKpiOccupiedGuests.textContent = n + (n === 1 ? " hóspede" : " hóspedes");
  }
  if (opKpiOccupiedApts) {
    const a = occupiedSummaryCache.occupied_apartments;
    opKpiOccupiedApts.textContent =
      a + (a === 1 ? " apartamento ocupado" : " apartamentos ocupados");
  }
}

function setPainelView(view) {
  painelView = view === "chegadas" ? "chegadas" : "reservas";
  document.querySelectorAll(".op-view-tab").forEach(function (btn) {
    const active = btn.getAttribute("data-op-view") === painelView;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  const showReservas = painelView === "reservas";
  opReservasControls?.classList.toggle("hidden", !showReservas);
  opReservasMain?.classList.toggle("hidden", !showReservas);
  document.querySelector("#operacional-excecoes")?.classList.toggle("hidden", !showReservas);
  opChegadasPanel?.classList.toggle("hidden", showReservas);
  if (!showReservas) renderChegadasPanel();
}

async function renderChegadasPanel() {
  const policy = getArrivalsPolicy();
  if (!policy || !opChegadasBody) return;
  const dataset = await ensureArrivalsDataset();
  const truncatedEl = document.querySelector("#op-chegadas-truncated");
  if (truncatedEl) truncatedEl.classList.toggle("hidden", !arrivalsTruncatedWarning);
  const rows = policy.filterArrivals(dataset, arrivalsFilter);
  let pageRows = rows;
  let pageInfo = null;
  if (arrivalsFilter === "todas_futuras") {
    pageInfo = policy.paginateRows(rows, arrivalsPage, ARRIVALS_PAGE_SIZE);
    pageRows = pageInfo.items;
  }
  if (opChegadasCount) {
    opChegadasCount.textContent =
      rows.length === 1 ? "1 reserva" : rows.length + " reservas";
  }
  opChegadasEmpty?.classList.toggle("hidden", pageRows.length > 0);
  opChegadasBody.innerHTML = pageRows
    .map(function (row) {
      const alerts = (row.alerts || [])
        .slice(0, 3)
        .map(function (a) {
          return '<span class="op-chegadas__alert">' + escapeHtml(a.label) + "</span>";
        })
        .join("");
      return (
        "<tr data-reserva-id=\"" +
        escapeHtml(row.id) +
        "\">" +
        "<td>" +
        escapeHtml(formatDataBR(row.check_in)) +
        "</td>" +
        "<td>" +
        escapeHtml(row.external_reservation_id) +
        "</td>" +
        "<td>" +
        escapeHtml(row.apartamento) +
        "</td>" +
        "<td>" +
        escapeHtml(row.hospede_principal) +
        "</td>" +
        "<td>" +
        escapeHtml(String(row.total_hospedes)) +
        "</td>" +
        "<td class=\"op-chegadas__alerts\">" +
        (alerts || "—") +
        "</td>" +
        "</tr>"
      );
    })
    .join("");

  if (opChegadasPager && pageInfo) {
    opChegadasPager.classList.toggle("hidden", pageInfo.total <= ARRIVALS_PAGE_SIZE);
    if (opChegadasPageLabel) {
      opChegadasPageLabel.textContent =
        "Página " + (pageInfo.page + 1) + " · " + pageInfo.total + " no total";
    }
    const prev = document.querySelector("#op-chegadas-prev");
    const next = document.querySelector("#op-chegadas-next");
    if (prev) prev.disabled = pageInfo.page <= 0;
    if (next) next.disabled = !pageInfo.hasMore;
  } else {
    opChegadasPager?.classList.add("hidden");
  }

  opChegadasBody.querySelectorAll("tr[data-reserva-id]").forEach(function (tr) {
    tr.addEventListener("click", function () {
      const id = tr.getAttribute("data-reserva-id");
      if (id && getReservaById(id)) openDetail(id);
    });
  });
}

function openOccupiedDrawer() {
  if (!occupiedSummaryCache) renderOccupiedGuestsCard();
  const stays = (occupiedSummaryCache && occupiedSummaryCache.stays) || [];
  if (opOccupiedList) {
    opOccupiedList.innerHTML = stays.length
      ? stays
          .map(function (s) {
            const alerts = (s.alerts || [])
              .slice(0, 2)
              .map(function (a) {
                return escapeHtml(a.label);
              })
              .join(" · ");
            return (
              "<li>" +
              "<strong>Apto " +
              escapeHtml(s.apartamento) +
              "</strong>" +
              "<span>" +
              escapeHtml(s.hospede_principal) +
              " · " +
              escapeHtml(String(s.total_hospedes)) +
              " hóspede(s)</span>" +
              "<span>Saída " +
              escapeHtml(formatDataBR(s.check_out)) +
              "</span>" +
              (alerts ? "<em>" + alerts + "</em>" : "") +
              "</li>"
            );
          })
          .join("")
      : "<li class=\"op-occupied-drawer__empty\">Nenhuma hospedagem atual</li>";
  }
  opOccupiedDrawer?.classList.remove("hidden");
  opOccupiedDrawer?.setAttribute("aria-hidden", "false");
}

function closeOccupiedDrawer() {
  opOccupiedDrawer?.classList.add("hidden");
  opOccupiedDrawer?.setAttribute("aria-hidden", "true");
}

function persistLocalPanelState() {
  if (
    PAINEL_DATA_SOURCE !== PAINEL_DATA_SOURCE_LOCAL_REPOSITORY ||
    !operacionalRepository
  ) {
    return;
  }
  operacionalRepository.replaceReservations(
    serializarPainelOperacional(reservas),
  );
}

function refresh() {
  persistLocalPanelState();
  renderOperationalMetrics();
  renderExcecoesOperacionais();
  renderStatusTabs();
  renderOperacionalLista();
  if (painelView === "chegadas") {
    renderChegadasPanel();
  }
  if (detailReservaId) {
    const r = getReservaById(detailReservaId);
    if (r) {
      syncDetailPanelChrome(r);
      renderDetail(r);
      if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && document.getElementById("detail-ttlock-section")) {
        loadAndRenderTtlockSection(detailReservaId);
      }
    } else {
      closeDetail();
    }
  } else {
    syncDetailPanelChrome(null);
  }
}

async function refreshFromSource() {
  invalidateArrivalsCache();
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_LOCAL_REPOSITORY) {
    reservas = await loadReservasFromLocalRepository();
  } else if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    reservas = await loadReservasFromBackend();
  }
  refresh();
}

function renderAll() {
  refresh();
}

function escapeHtml(s) {
  if (s == null || s === "") return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Tradução visual do status TTLock (PR #14).
 * Preferência: módulo YesHotelCheckinPanelPresentation (mesma regra).
 */
function presentTtlockPasswordStatus(data) {
  const P = getPanelPresentation();
  if (P && typeof P.presentTtlockPasswordStatus === "function") {
    return P.presentTtlockPasswordStatus(data);
  }
  const status = data && data.status != null ? String(data.status) : null;
  const syncStatus = data && data.syncStatus != null ? String(data.syncStatus) : null;
  const resumoRaw = data && data.resumo != null ? String(data.resumo) : "";
  if (status === "provisionada") {
    return { statusClass: "sync-ok", statusLabel: "Senha pronta", resumoText: "" };
  }
  if (status === "falhou" || syncStatus === "failed") {
    return { statusClass: "sync-failed", statusLabel: "Falha no envio", resumoText: resumoRaw };
  }
  if (status === "parcial" || syncStatus === "partial") {
    return { statusClass: "sync-partial", statusLabel: "Envio pendente", resumoText: resumoRaw };
  }
  if (
    status === "pendente" ||
    status === "pronta" ||
    status === "provisionando" ||
    syncStatus === "pending"
  ) {
    return { statusClass: "sync-pending", statusLabel: "Envio pendente", resumoText: "" };
  }
  if (status === "revogada") {
    if (syncStatus === "failed") {
      return { statusClass: "sync-failed", statusLabel: "Falha no envio", resumoText: resumoRaw };
    }
    if (syncStatus === "pending" || syncStatus === "partial") {
      return {
        statusClass: syncStatus === "partial" ? "sync-partial" : "sync-pending",
        statusLabel: "Envio pendente",
        resumoText: resumoRaw,
      };
    }
    return { statusClass: "sync-ok", statusLabel: "Revogada", resumoText: "" };
  }
  if (!status && !syncStatus) {
    return { statusClass: "sync-pending", statusLabel: "Status não informado", resumoText: "" };
  }
  if (syncStatus === "ok") {
    return { statusClass: "sync-ok", statusLabel: "Status não informado", resumoText: resumoRaw };
  }
  return { statusClass: "sync-pending", statusLabel: "Status não informado", resumoText: resumoRaw };
}

async function loadAndRenderTtlockSection(reservaId) {
  const loadingEl = document.getElementById("detail-ttlock-loading");
  const contentEl = document.getElementById("detail-ttlock-content");
  const hasInvoke = !!auth?.invokeLifecycleAction;
  if (typeof console !== "undefined" && console.log) {
    console.log("[TTLock] loadAndRenderTtlockSection reservaId=" + reservaId + " invokeLifecycleAction=" + hasInvoke);
  }
  if (!loadingEl || !contentEl || !hasInvoke) return;
  try {
    const data = await auth.invokeLifecycleAction("sync_summary", { reservaId });
    const presented = presentTtlockPasswordStatus(data);
    const statusClass = presented.statusClass;
    const statusLabel = presented.statusLabel;
    let html = `<div class="ttlock-panel-stack">`;
    html += `<div class="ttlock-card-status-block ttlock-card-status-block--${statusClass}">`;
    html += `<p class="ttlock-card-status-label">Status da senha</p>`;
    html += `<div class="ttlock-status-row"><span class="ttlock-sync-badge ${statusClass}" role="status">${escapeHtml(statusLabel)}</span></div>`;
    if (presented.resumoText) {
      html += `<p class="reservation-detail-ttlock-resumo">${escapeHtml(presented.resumoText)}</p>`;
    }
    html += `</div>`;
    if (data.lastSyncAttemptAt) {
      html += `<p class="reservation-detail-ttlock-meta">Última tentativa: ${escapeHtml(data.lastSyncAttemptAt)}</p>`;
    }
    if (data.lastSyncError) {
      html += `<div class="ttlock-card-attention ttlock-card-attention--error"><p class="ttlock-card-attention-kicker">Atenção</p><p class="reservation-detail-ttlock-error">${escapeHtml(data.lastSyncError)}</p></div>`;
    }
    if (data.temCredencial && data.status !== "revogada") {
      html += `<div class="reservation-detail-ttlock-actions">
        <button type="button" class="secondary-button detail-ttlock-btn detail-ttlock-btn--danger detail-ttlock-cancel-btn" data-reserva-id="${escapeHtml(reservaId)}">Revogar acesso TTLock (exceção — não cancela no PMS)</button>
        <button type="button" class="secondary-button detail-ttlock-btn detail-ttlock-btn--neutral detail-ttlock-checkout-btn" data-reserva-id="${escapeHtml(reservaId)}">Checkout (revogar acesso TTLock)</button>
      </div>`;
    }
    if (data.temCredencial && data.status === "revogada" && data.syncStatus && data.syncStatus !== "ok") {
      html += `<div class="reservation-detail-ttlock-actions">
        <button type="button" class="secondary-button detail-ttlock-btn detail-ttlock-btn--accent detail-ttlock-retry-btn" data-reserva-id="${escapeHtml(reservaId)}">Reprocessar sincronização</button>
      </div>`;
    }
    if (data.temCredencial === false) {
      html += `<div class="ttlock-card-attention ttlock-card-attention--muted"><p class="reservation-detail-ttlock-muted">Sem credencial operacional para esta reserva.</p></div>`;
    }
    html += `</div>`;
    contentEl.innerHTML = html;
    loadingEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    contentEl.querySelectorAll(".detail-ttlock-cancel-btn").forEach((btn) => {
      btn.addEventListener("click", () => acaoLifecycleCancel(btn.dataset.reservaId));
    });
    contentEl.querySelectorAll(".detail-ttlock-checkout-btn").forEach((btn) => {
      btn.addEventListener("click", () => acaoLifecycleCheckout(btn.dataset.reservaId));
    });
    contentEl.querySelectorAll(".detail-ttlock-retry-btn").forEach((btn) => {
      btn.addEventListener("click", () => acaoLifecycleRetry(btn.dataset.reservaId));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (typeof console !== "undefined" && console.warn) console.warn("[TTLock] loadAndRenderTtlockSection error", msg);
    contentEl.innerHTML = `<div class="ttlock-panel-stack"><p class="reservation-detail-ttlock-error reservation-detail-ttlock-error--banner">Erro ao carregar status: ${escapeHtml(msg)}</p></div>`;
    loadingEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
  }
}

async function acaoLifecycleCancel(reservaId) {
  if (!reservaId || !auth?.invokeLifecycleAction) return;
  if (!confirm("Revogar credencial TTLock (exceção operacional)? Não altera a reserva no PMS. Ação irreversível para a credencial.")) return;
  try {
    const data = await auth.invokeLifecycleAction("lifecycle_cancel", { reservaId });
    const msg = data.idempotente
      ? "Credencial já estava revogada."
      : data.divergencia
        ? `Cancelamento aplicado. Atenção: sync ${data.syncStatus}. ${data.lastSyncError || ""} Use "Reprocessar sincronização" se necessário.`
        : "Cancelamento aplicado. Acesso revogado.";
    alert(msg);
    await refreshFromSource();
    if (detailReservaId === reservaId) await loadAndRenderTtlockSection(reservaId);
    refresh();
  } catch (e) {
    alert("Erro: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function acaoLifecycleCheckout(reservaId) {
  if (!reservaId || !auth?.invokeLifecycleAction) return;
  if (!confirm("Fazer checkout e revogar acesso TTLock desta reserva?")) return;
  try {
    const data = await auth.invokeLifecycleAction("lifecycle_checkout", { reservaId });
    const msg = data.idempotente
      ? "Credencial já estava revogada."
      : data.divergencia
        ? `Checkout aplicado. Atenção: sync ${data.syncStatus}. ${data.lastSyncError || ""} Use "Reprocessar sincronização" se necessário.`
        : "Checkout aplicado. Acesso revogado.";
    alert(msg);
    await refreshFromSource();
    if (detailReservaId === reservaId) await loadAndRenderTtlockSection(reservaId);
    refresh();
  } catch (e) {
    alert("Erro: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function acaoLifecycleRetry(reservaId) {
  if (!reservaId || !auth?.invokeLifecycleAction) return;
  try {
    const data = await auth.invokeLifecycleAction("retry_sync", { reservaId });
    const msg = data.itensFalha > 0
      ? `Retry executado. ${data.itensOk} ok, ${data.itensFalha} falha(s). ${data.lastSyncError || ""}`
      : "Sincronização reprocessada com sucesso.";
    alert(msg);
    await refreshFromSource();
    if (detailReservaId === reservaId) await loadAndRenderTtlockSection(reservaId);
    refresh();
  } catch (e) {
    alert("Erro: " + (e instanceof Error ? e.message : String(e)));
  }
}

function openDetail(reservaId) {
  const reserva = getReservaById(reservaId);
  if (!reserva) return;
  detailReservaId = reservaId;
  syncDetailPanelChrome(reserva);
  renderDetail(reserva);
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && document.getElementById("detail-ttlock-section")) {
    loadAndRenderTtlockSection(reservaId);
  }
  // Em ≥768px o CSS esconde .op-detail até .op-detail--open (drawer overlay).
  // Sem esta classe, Ver/⋯ atualizam o DOM mas o painel permanece invisível.
  detailPanelElement?.classList.add("op-detail--open");
  detailBackdropElement?.classList.remove("hidden");
  updateRowSelectionUi();
}

function closeDetail() {
  detailReservaId = null;
  syncDetailPanelChrome(null);
  detailPanelElement?.classList.remove("op-detail--open");
  detailBackdropElement?.classList.add("hidden");
  updateRowSelectionUi();
}

const CANAL_ENVIO = {
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  AMBOS: "ambos",
};

function getCanalEnvioMock(hospede) {
  if (!hasContatoSuficiente(hospede)) return null;
  const e = (hospede.email || "").trim().length > 0;
  const w = (hospede.whatsapp || "").trim().length > 0;
  if (e && w) return CANAL_ENVIO.AMBOS;
  if (w) return CANAL_ENVIO.WHATSAPP;
  if (e) return CANAL_ENVIO.EMAIL;
  return null;
}

function getCanalEnvioLabel(canal) {
  if (!canal) return "Não enviado";
  const labels = { [CANAL_ENVIO.EMAIL]: "E-mail", [CANAL_ENVIO.WHATSAPP]: "WhatsApp", [CANAL_ENVIO.AMBOS]: "Ambos" };
  return labels[canal] || canal;
}

function formatEnvioTimestamp(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const h = date.getHours();
  const min = date.getMinutes();
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function registrarEnvioHospede(hospede) {
  if (!hasContatoSuficiente(hospede)) return;
  const canal = getCanalEnvioMock(hospede);
  if (!canal) return;
  hospede.ultimoEnvioCanal = canal;
  hospede.ultimoEnvioEm = formatEnvioTimestamp(new Date());
  hospede.tentativasEnvio = (hospede.tentativasEnvio || 0) + 1;
}

async function reenviarHospede(reservaId, guestIndex) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
  if (h.statusOperacional !== GUEST_STATUS.ENVIADO && h.statusOperacional !== GUEST_STATUS.PRONTO_PARA_ENVIO) return;
  if (!hasContatoSuficiente(h)) return;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    await backendEnviarLinks(reservaId);
    await refreshFromSource();
    return;
  }
  registrarEnvioHospede(h);
  addHistoricoEvento(r, "reenvio", "Link reenviado para " + (h.nome || "hóspede"), null);
  refresh();
}

/** Reenvio em nível de reserva (topo do painel): mesmo efeito do backend `send` links; no mock, um único refresh. */
async function reenviarLinksFnrhTopo(reservaId) {
  const r = getReservaById(reservaId);
  if (!r || !Array.isArray(r.hospedes)) return;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendEnviarLinks(reservaId);
    if (ok) await refreshFromSource();
    return;
  }
  let n = 0;
  r.hospedes.forEach((h) => {
    if (h.statusOperacional === GUEST_STATUS.ENVIADO && hasContatoSuficiente(h)) {
      registrarEnvioHospede(h);
      n++;
    }
  });
  if (n > 0) {
    addHistoricoEvento(r, "reenvio", "Link(s) FNRH reenviado(s) (" + n + " hóspede(s))", null);
  }
  refresh();
}

var _detailTopContatoModo = null;

function getPrincipalGuestIndexForReserva(reserva) {
  if (!reserva || !Array.isArray(reserva.hospedes) || reserva.hospedes.length === 0) return -1;
  const i = reserva.hospedes.findIndex((h) => h.principal);
  return i >= 0 ? i : 0;
}

async function persistirContatoPrincipalSemRefresh(reservaId, guestIndex, email, whatsapp) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return false;
  h.email = String(email || "").trim();
  h.whatsapp = String(whatsapp || "").trim();
  syncGuestStatus(h);
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    return await backendUpdateHospedeFull(reservaId, guestIndex, h);
  }
  return true;
}

async function executarEnvioLinksFnrhReserva(reservaId) {
  const r = getReservaById(reservaId);
  if (!r || !Array.isArray(r.hospedes)) return;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendEnviarLinks(reservaId);
    if (ok) await refreshFromSource();
    return;
  }
  let porEmail = 0;
  let porWhatsapp = 0;
  let porAmbos = 0;
  r.hospedes.forEach((h) => {
    if (h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO && hasContatoSuficiente(h)) {
      h.statusOperacional = GUEST_STATUS.ENVIADO;
      registrarEnvioHospede(h);
      const canal = getCanalEnvioMock(h);
      if (canal === CANAL_ENVIO.EMAIL) porEmail++;
      else if (canal === CANAL_ENVIO.WHATSAPP) porWhatsapp++;
      else if (canal === CANAL_ENVIO.AMBOS) porAmbos++;
    }
  });
  const totalEnviados = porEmail + porWhatsapp + porAmbos;
  if (totalEnviados > 0) {
    const parts = [];
    if (porWhatsapp > 0) parts.push(porWhatsapp + " por WhatsApp");
    if (porEmail > 0) parts.push(porEmail + " por e-mail");
    if (porAmbos > 0) parts.push(porAmbos + " por ambos");
    addHistoricoEvento(r, "links_enviados", "Links de FNRH enviados", parts.join("; "));
  }
  refresh();
}

function openTopContatoPanel(reservaId, modo) {
  const panel = document.getElementById("detail-top-contato-panel");
  if (!panel) return;
  const r = getReservaById(reservaId);
  if (!r) return;
  const idx = getPrincipalGuestIndexForReserva(r);
  if (idx < 0) return;
  const h = r.hospedes[idx];
  _detailTopContatoModo = modo;
  panel.dataset.reservaId = String(reservaId);
  panel.dataset.guestIndex = String(idx);
  panel.classList.remove("hidden");
  const emailEl = document.getElementById("detail-top-contato-email");
  const waEl = document.getElementById("detail-top-contato-whatsapp");
  const titleEl = document.getElementById("detail-top-contato-title");
  if (emailEl) emailEl.value = (h.email || "").trim();
  if (waEl) waEl.value = (h.whatsapp || "").trim();
  if (titleEl) {
    titleEl.textContent =
      modo === "senha" || modo === "senha_reenviar" || modo === "senha_nova"
        ? modo === "senha_reenviar"
          ? "Confirme o contato e reenvie as credenciais"
          : modo === "senha_nova"
            ? "Confirme o contato e gere uma nova senha"
            : "Confirme o contato e envie as credenciais"
        : modo === "fnrh_reenviar"
          ? "Confirme o contato e reenvie o link FNRH"
          : "Confirme o contato e envie o link FNRH";
  }
  const msgEl = document.getElementById("detail-top-contato-msg");
  if (msgEl) {
    msgEl.textContent = "";
    msgEl.classList.add("hidden");
    msgEl.classList.remove("is-error", "is-success");
  }
}

function closeTopContatoPanel() {
  _detailTopContatoModo = null;
  const panel = document.getElementById("detail-top-contato-panel");
  if (panel) panel.classList.add("hidden");
}

async function submitDetailTopContatoPanel() {
  const panel = document.getElementById("detail-top-contato-panel");
  if (!panel) return;
  const rid = panel.dataset.reservaId;
  const idx = parseInt(panel.dataset.guestIndex || "-1", 10);
  const modo = _detailTopContatoModo;
  const email = (document.getElementById("detail-top-contato-email")?.value || "").trim();
  const whatsapp = (document.getElementById("detail-top-contato-whatsapp")?.value || "").trim();
  const msgEl = document.getElementById("detail-top-contato-msg");
  const confirmBtn = document.getElementById("detail-top-contato-confirm");
  if (!rid || idx < 0 || !modo) return;
  if (!email && !whatsapp) {
    if (msgEl) {
      msgEl.textContent = "Informe pelo menos e-mail ou WhatsApp.";
      msgEl.classList.remove("hidden", "is-success");
      msgEl.classList.add("is-error");
    }
    return;
  }
  if (msgEl) {
    msgEl.classList.add("hidden");
    msgEl.textContent = "";
    msgEl.classList.remove("is-error", "is-success");
  }
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const okPersist = await persistirContatoPrincipalSemRefresh(rid, idx, email, whatsapp);
    if (!okPersist) {
      if (msgEl) {
        msgEl.textContent = "Não foi possível salvar o contato. Tente novamente.";
        msgEl.classList.remove("hidden", "is-success");
        msgEl.classList.add("is-error");
      }
      return;
    }
    if (modo === "senha" || modo === "senha_reenviar" || modo === "senha_nova") {
      const origemRegistro = "manual";
      const reservaAtual = getReservaById(rid);
      if (
        reservaAtual &&
        !acessoLiberadoEfetivo(reservaAtual) &&
        modo !== "senha_reenviar"
      ) {
        const liberar = await backendLiberarAcesso(rid);
        if (!liberar.ok) {
          if (msgEl) {
            msgEl.textContent = humanizarMensagemModalEnviarSenha(
              liberar.error || "Falha ao gerar senha",
            );
            msgEl.classList.remove("hidden", "is-success");
            msgEl.classList.add("is-error");
          }
          return;
        }
      }
      const result = await backendEnviarSenha(rid, email, whatsapp, {
        manual: true,
        origem: origemRegistro,
        gerarNova: modo === "senha_nova",
        confirmacaoGerarNova: modo === "senha_nova",
      });
      if (result.ok) {
        if (modo === "senha_nova" && reservaAtual) {
          const usuario =
            (sessionUserElement && sessionUserElement.textContent) || "operador";
          addHistoricoEvento(
            reservaAtual,
            "gerar_nova_senha_enviada",
            "Nova senha gerada e enviada",
            "Usuário: " +
              usuario +
              " · " +
              formatHistoricoTimestamp(new Date()) +
              " · origem=manual · credencial anterior substituída",
          );
        }
        const okText =
          (result.data && result.data.mensagem) ||
          (result.data && result.data.message) ||
          (result.skipped
            ? "Credenciais já haviam sido enviadas."
            : modo === "senha_nova"
              ? "Nova senha gerada e enviada."
              : "Operação concluída.");
        if (msgEl) {
          msgEl.textContent = okText;
          msgEl.classList.remove("hidden", "is-error");
          msgEl.classList.add("is-success");
        }
        await refreshFromSource();
        closeTopContatoPanel();
      } else {
        if (msgEl) {
          msgEl.textContent = humanizarMensagemModalEnviarSenha(result.error || "Não foi possível enviar a senha.");
          msgEl.classList.remove("hidden", "is-success");
          msgEl.classList.add("is-error");
        }
      }
      return;
    }
    if (modo === "fnrh_reenviar") {
      await reenviarLinksFnrhTopo(rid);
    } else {
      await executarEnvioLinksFnrhReserva(rid);
    }
    closeTopContatoPanel();
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

function getResumoComunicacaoReserva(reserva) {
  if (!Array.isArray(reserva.hospedes)) return { porWhatsapp: 0, porEmail: 0, porAmbos: 0, naoEnviado: 0 };
  let porWhatsapp = 0;
  let porEmail = 0;
  let porAmbos = 0;
  let naoEnviado = 0;
  reserva.hospedes.forEach((h) => {
    const canal = h.ultimoEnvioCanal || null;
    if (!canal) {
      naoEnviado++;
      return;
    }
    if (canal === CANAL_ENVIO.AMBOS) porAmbos++;
    else if (canal === CANAL_ENVIO.WHATSAPP) porWhatsapp++;
    else if (canal === CANAL_ENVIO.EMAIL) porEmail++;
    else naoEnviado++;
  });
  return { porWhatsapp, porEmail, porAmbos, naoEnviado };
}

function formatResumoComunicacao(reserva) {
  const r = getResumoComunicacaoReserva(reserva);
  const allConfirmed =
    Array.isArray(reserva.hospedes) &&
    reserva.hospedes.length > 0 &&
    reserva.hospedes.every((h) => h.statusOperacional === GUEST_STATUS.CONFIRMADO);
  const P = getPanelPresentation();
  if (P && typeof P.formatResumoComunicacaoApresentacao === "function") {
    const presented = P.formatResumoComunicacaoApresentacao(r, { allFnrhConfirmed: allConfirmed });
    if (allConfirmed) return presented;
    return presented || "Nenhum envio.";
  }
  const parts = [];
  if (r.porWhatsapp > 0) parts.push(`${r.porWhatsapp} com envio por WhatsApp`);
  if (r.porEmail > 0) parts.push(`${r.porEmail} com envio por e-mail`);
  if (r.porAmbos > 0) parts.push(`${r.porAmbos} com envio por ambos`);
  if (!allConfirmed && r.naoEnviado > 0) parts.push(`${r.naoEnviado} ainda não enviado`);
  if (allConfirmed) return "";
  return parts.length ? parts.join("; ") : "Nenhum envio.";
}

function formatIsoOperacional(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return formatHistoricoTimestamp(d);
}

function tryParseEventoDetalheJson(detalhe) {
  if (detalhe == null) return null;
  const t = String(detalhe).trim();
  if (!t || t.charAt(0) !== "{") return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

var RESUMO_FNRH_REMINDER_TIPOS = { "d-1": true, "d0-07h": true, "d0-checkin": true };

function labelTipoEventoFnrh(te) {
  const t = String(te || "").trim();
  if (t === "reserva_criada") return "envio inicial";
  if (t === "d-1") return "lembrete (24h antes do check-in)";
  if (t === "d0-07h") return "lembrete (07h no dia do check-in)";
  if (t === "d0-checkin") return "lembrete (horário de check-in)";
  if (t === "manual") return "envio manual (painel)";
  return t || "outro";
}

function labelFnrhAgregadoPainel(agg) {
  const a = String(agg || "").trim();
  if (a === "fnrh_completo") return "Completa (todas as FNRH no fluxo digital)";
  if (a === "fnrh_parcial") return "Parcial";
  return "Pendente";
}

function labelPropositoComunicacao(p) {
  if (p === "fnrh_links") return "links FNRH";
  if (p === "senha_acesso") return "senha de acesso";
  if (p === "chat_operador") return "chat operador";
  if (p === "generico") return "genérico";
  return p || "—";
}

function labelCanalComunicacaoPainel(c) {
  if (c === "whatsapp") return "WhatsApp";
  if (c === "email") return "E-mail";
  return c || "—";
}

function labelStatusEnvioComunicacao(s) {
  if (s === "enviada") return "sucesso";
  if (s === "falha") return "falha";
  if (s === "simulado") return "simulado";
  return s || "—";
}

function coletaEventosOrdenadosPorTempo(historico, tiposSet) {
  var list = (historico || []).filter(function (e) {
    return e && e.criadoEmIso && tiposSet[e.tipo];
  });
  list.sort(function (a, b) {
    return new Date(a.criadoEmIso).getTime() - new Date(b.criadoEmIso).getTime();
  });
  return list;
}

function agregarEnviosFnrhDoHistorico(historico) {
  var evs = (historico || [])
    .filter(function (e) {
      return e && e.tipo === "envio_auto_fnrh" && e.criadoEmIso;
    })
    .map(function (e) {
      return { at: e.criadoEmIso, p: tryParseEventoDetalheJson(e.detalhe) };
    })
    .sort(function (a, b) {
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  function ok(p) {
    return !!(p && (p.enviado_email || p.enviado_whatsapp));
  }
  var firstOk = null;
  var lastOk = null;
  var lastAny = evs.length ? evs[evs.length - 1] : null;
  for (var i = 0; i < evs.length; i++) {
    if (ok(evs[i].p)) {
      if (!firstOk) firstOk = evs[i];
      lastOk = evs[i];
    }
  }
  var reminderOk = [];
  for (var j = 0; j < evs.length; j++) {
    var te = evs[j].p && evs[j].p.tipo_evento;
    if (te && RESUMO_FNRH_REMINDER_TIPOS[te] && ok(evs[j].p)) reminderOk.push(evs[j]);
  }
  var lastReminder = reminderOk.length ? reminderOk[reminderOk.length - 1] : null;
  return {
    evs: evs,
    firstOk: firstOk,
    lastOk: lastOk,
    lastAny: lastAny,
    lastReminder: lastReminder,
    reminderCount: reminderOk.length,
  };
}

function coletaEventosSenhaOrdenados(historico) {
  return (historico || [])
    .filter(function (e) {
      return (
        e &&
        e.criadoEmIso &&
        (e.tipo === "envio_manual_senha" || e.tipo === "envio_auto_senha")
      );
    })
    .sort(function (a, b) {
      return new Date(b.criadoEmIso).getTime() - new Date(a.criadoEmIso).getTime();
    });
}

/** Último sucesso e primeira falha mais recente na lista (ordenada do mais novo ao mais antigo). */
function obterUltimosEventosSenha(reserva) {
  var senhaSorted = coletaEventosSenhaOrdenados((reserva && reserva.historicoOperacional) || []);
  var lastOkSenha = null;
  var lastFailSenha = null;
  for (var s = 0; s < senhaSorted.length; s++) {
    var pS = tryParseEventoDetalheJson(senhaSorted[s].detalhe);
    if (pS && pS.sucesso === true && !lastOkSenha) lastOkSenha = { e: senhaSorted[s], p: pS };
    if (pS && pS.sucesso === false && !lastFailSenha) lastFailSenha = { e: senhaSorted[s], p: pS };
  }
  return { lastOkSenha: lastOkSenha, lastFailSenha: lastFailSenha };
}

function falhaSenhaMaisRecenteQueSucesso(lastOkSenha, lastFailSenha) {
  if (!lastFailSenha) return false;
  if (!lastOkSenha) return true;
  return new Date(lastFailSenha.e.criadoEmIso).getTime() > new Date(lastOkSenha.e.criadoEmIso).getTime();
}

function obterUltimoEventoEnvioAutoFnrh(reserva) {
  var hist = (reserva && reserva.historicoOperacional) || [];
  var evs = hist.filter(function (e) {
    return e && e.tipo === "envio_auto_fnrh" && e.criadoEmIso;
  });
  evs.sort(function (a, b) {
    return new Date(b.criadoEmIso).getTime() - new Date(a.criadoEmIso).getTime();
  });
  return evs[0] || null;
}

/** Último envio_auto_fnrh sem sucesso nos canais, com erro ou tentativa a hóspedes com canal (dados do JSON do evento). */
function ultimoEnvioFnrhTeveFalhaRegistrada(reserva) {
  var ev = obterUltimoEventoEnvioAutoFnrh(reserva);
  if (!ev) return false;
  var p = tryParseEventoDetalheJson(ev.detalhe);
  if (!p) return false;
  if (p.enviado_email || p.enviado_whatsapp) return false;
  var errosT = Number(p.erros_total);
  if (Number.isFinite(errosT) && errosT > 0) return true;
  var gc = Number(p.guests_com_canal);
  return Number.isFinite(gc) && gc > 0;
}

var OPERACIONAL_EXCECOES_MAX_ITENS = 14;

/**
 * Uma exceção por reserva (a mais prioritária). null se nada aplicável.
 */
function buildCredentialReleaseInputFromReserva(reserva, overrides) {
  const pagamentoStatus = isPagamentoOk(reserva) ? "pago" : "pendente";
  const fnrhStatus = isFnrhCompleta(reserva) ? "completa" : "pendente";
  const senhaEnviada = !!(reserva && (reserva.senhaEnviadaEm || (obterUltimosEventosSenha(reserva).lastOkSenha)));
  const checkInDate = reserva?.checkInPrevisto
    ? String(reserva.checkInPrevisto).slice(0, 10) + "T14:00:00"
    : new Date().toISOString();
  const ob = obterUltimosEventosSenha(reserva);
  const failRecente = falhaSenhaMaisRecenteQueSucesso(ob.lastOkSenha, ob.lastFailSenha);
  let falhaGeracao = false;
  let falhaEnvio = false;
  if (failRecente && ob.lastFailSenha && ob.lastFailSenha.p) {
    const tipo = ob.lastFailSenha.p.tipo_bloqueio;
    if (tipo === "provisionamento") falhaGeracao = true;
    else falhaEnvio = true;
  }
  const liberacaoManualComPendencias = !!(
    reserva?.liberacaoManualComPendencias ||
    (Array.isArray(reserva?.historicoOperacional) &&
      reserva.historicoOperacional.some(
        (ev) =>
          ev &&
          ev.tipo === "liberacao_manual_com_pendencias" &&
          (pagamentoStatus !== "pago" || fnrhStatus !== "completa"),
      ))
  );

  return Object.assign(
    {
      pagamentoStatus,
      fnrhStatus,
      senhaEnviada,
      dataHoraCheckin: checkInDate,
      dataHoraAtual: new Date(),
      origem: "manual",
      falhaGeracao,
      falhaEnvio,
      liberacaoManualComPendencias,
      acaoSolicitada: senhaEnviada ? "reenviar" : "gerar_enviar",
    },
    overrides || {},
  );
}

function avaliarPoliticaCredenciaisReserva(reserva, overrides) {
  const policy = window.YesHotelCredentialReleasePolicy;
  if (!policy || typeof policy.avaliarLiberacaoCredenciais !== "function") {
    return null;
  }
  return policy.avaliarLiberacaoCredenciais(
    buildCredentialReleaseInputFromReserva(reserva, overrides),
  );
}

function labelAcaoCredenciaisPainel(reserva) {
  const decisao = avaliarPoliticaCredenciaisReserva(reserva);
  if (!decisao) {
    return reserva?.senhaEnviadaEm
      ? "Reenviar credenciais"
      : "Gerar e enviar credenciais";
  }
  if (decisao.acaoPainel === "reenviar") return "Reenviar credenciais";
  return "Gerar e enviar credenciais";
}

function confirmarLiberacaoManualComPendencias(reserva, decisao) {
  const pendencias = (decisao && decisao.pendenciasAtuais) || [];
  if (pendencias.length === 0) return true;
  const labels = pendencias.map((p) =>
    p === "pagamento" ? "pagamento" : "FNRH",
  );
  const texto =
    "Há pendência(s) ainda aberta(s): " +
    labels.join(" e ") +
    ".\n\nDeseja gerar e enviar as credenciais mesmo assim?\n(O evento será registrado no histórico.)";
  return window.confirm(texto);
}

function registrarLiberacaoManualComPendencias(reserva, pendencias) {
  if (!reserva) return;
  reserva.liberacaoManualComPendencias = pendencias.length > 0;
  const now = new Date();
  const usuario =
    (sessionUserElement && sessionUserElement.textContent) || "operador";
  addHistoricoEvento(
    reserva,
    "liberacao_manual_com_pendencias",
    "Acesso/credenciais liberados manualmente com pendências",
    "Usuário: " +
      usuario +
      " · " +
      formatHistoricoTimestamp(now) +
      " · Pendências: " +
      pendencias.join(", ") +
      " · origem=manual",
  );
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    backendAddEvento(
      reserva.id,
      "liberacao_manual_com_pendencias",
      "Acesso/credenciais liberados manualmente com pendências",
      JSON.stringify({
        origem: "manual",
        pendencias,
        usuario,
        em: now.toISOString(),
      }),
    );
  }
}

/** Trava UI para primeiro gatilho válido vencer. */
const _liberacaoCredencialInFlight = new Set();

/**
 * Dispara o fluxo real existente (liberar acesso se preciso + send-senha)
 * após avaliar a política. Idempotente por reservaId.
 */
async function aplicarLiberacaoCredenciaisNoPainel(reservaId, options) {
  const opts = options && typeof options === "object" ? options : {};
  const origem = opts.origem || "automatico_requisitos";
  const reserva = getReservaById(reservaId);
  if (!reserva) {
    return { ok: false, skipped: true, error: "Reserva não encontrada." };
  }

  if (_liberacaoCredencialInFlight.has(String(reservaId))) {
    return { ok: true, skipped: true, motivo: "envio_em_andamento" };
  }

  const decisao = avaliarPoliticaCredenciaisReserva(reserva, {
    origem,
    confirmacaoManual: !!opts.confirmacaoManual,
    confirmacaoGerarNova: !!opts.confirmacaoGerarNova,
    acaoSolicitada: opts.acaoSolicitada || "gerar_enviar",
  });

  if (!decisao) {
    return { ok: false, skipped: true, error: "Política indisponível." };
  }

  if (decisao.exigeConfirmacaoManual && !opts.confirmacaoManual) {
    return {
      ok: false,
      skipped: true,
      exigeConfirmacaoManual: true,
      decisao,
    };
  }

  if (!decisao.deveEnviar && !decisao.deveGerar) {
    return { ok: true, skipped: true, motivo: decisao.motivo, decisao };
  }

  _liberacaoCredencialInFlight.add(String(reservaId));
  try {
    // Revalida senha sob trava.
    const fresh = getReservaById(reservaId);
    if (
      fresh &&
      (fresh.senhaEnviadaEm || obterUltimosEventosSenha(fresh).lastOkSenha) &&
      (opts.acaoSolicitada || "gerar_enviar") === "gerar_enviar"
    ) {
      return { ok: true, skipped: true, motivo: "ja_enviada" };
    }

    if (origem === "manual" && decisao.pendenciasAtuais.length > 0) {
      registrarLiberacaoManualComPendencias(reserva, decisao.pendenciasAtuais);
    }

    if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
      if (!acessoLiberadoEfetivo(reserva) && decisao.deveGerar) {
        const liberar = await backendLiberarAcesso(reservaId);
        if (!liberar.ok) {
          await backendAddEvento(
            reservaId,
            "falha_gerar_senha",
            "Falha ao gerar senha",
            liberar.error || null,
          );
          return {
            ok: false,
            skipped: false,
            error: liberar.error || "Falha ao gerar senha",
            decisao,
          };
        }
      }

      const origemRegistro =
        origem === "automatico_13h"
          ? "horario_13h"
          : origem === "manual"
            ? "manual"
            : "requisitos";
      const principal = Array.isArray(reserva.hospedes)
        ? reserva.hospedes.find((h) => h.principal) || reserva.hospedes[0]
        : null;
      const result = await backendEnviarSenha(
        reservaId,
        opts.email || principal?.email || "",
        opts.whatsapp || principal?.whatsapp || "",
        {
          manual: origem === "manual",
          origem: origemRegistro,
          gerarNova: (opts.acaoSolicitada || "") === "gerar_nova",
          confirmacaoGerarNova:
            (opts.acaoSolicitada || "") === "gerar_nova" &&
            !!opts.confirmacaoGerarNova,
        },
      );
      if (!result.ok) {
        await backendAddEvento(
          reservaId,
          "falha_enviar_credenciais",
          "Falha ao enviar credenciais",
          result.error || null,
        );
        return { ok: false, skipped: false, error: result.error, decisao };
      }
      return {
        ok: true,
        skipped: !!result.skipped,
        enviado: !result.skipped,
        origem: origemRegistro,
        decisao,
      };
    }

    // Fallback local/mock: marca enviado sem TTLock/comunicação reais.
    reserva.senhaEnviadaEm = new Date().toISOString();
    addHistoricoEvento(
      reserva,
      origem === "manual" ? "envio_manual_senha" : "envio_auto_senha",
      "Credenciais enviadas (simulação local)",
      "origem=" +
        (origem === "automatico_13h"
          ? "horario_13h"
          : origem === "manual"
            ? "manual"
            : "requisitos"),
    );
    refresh();
    return { ok: true, skipped: false, enviado: true, decisao };
  } finally {
    _liberacaoCredencialInFlight.delete(String(reservaId));
  }
}

async function tentarLiberacaoPorRequisitos(reservaId) {
  const reserva = getReservaById(reservaId);
  if (!reserva) return { ok: true, skipped: true };
  if (!isPagamentoOk(reserva) || !isFnrhCompleta(reserva)) {
    return { ok: true, skipped: true, motivo: "requisitos_incompletos" };
  }
  if (reserva.senhaEnviadaEm || obterUltimosEventosSenha(reserva).lastOkSenha) {
    return { ok: true, skipped: true, motivo: "ja_enviada" };
  }
  return aplicarLiberacaoCredenciaisNoPainel(reservaId, {
    origem: "automatico_requisitos",
  });
}

function detectarUltimaFalhaCredencial(reserva) {
  const input = buildCredentialReleaseInputFromReserva(reserva);
  if (input.falhaGeracao) return "geracao";
  if (input.falhaEnvio) return "envio";
  return null;
}

/**
 * Retry manual a partir do painel — uma tentativa; reutiliza senha se falha foi de envio.
 */
async function aplicarRetryCredenciaisNoPainel(reservaId) {
  const reserva = getReservaById(reservaId);
  if (!reserva) return { ok: false, error: "Reserva não encontrada." };
  if (reserva.senhaEnviadaEm || obterUltimosEventosSenha(reserva).lastOkSenha) {
    return { ok: true, skipped: true, motivo: "ja_enviada" };
  }
  if (isCheckinConcluido(reserva)) {
    return { ok: true, skipped: true, motivo: "encerrada" };
  }
  const falha = detectarUltimaFalhaCredencial(reserva);
  if (!falha) {
    return { ok: true, skipped: true, motivo: "sem_falha_aberta" };
  }

  if (_liberacaoCredencialInFlight.has(String(reservaId))) {
    return { ok: true, skipped: true, motivo: "envio_em_andamento" };
  }

  _liberacaoCredencialInFlight.add(String(reservaId));
  try {
    addHistoricoEvento(
      reserva,
      "retry_credenciais_iniciado",
      "Nova tentativa de liberação de credenciais",
      "origem=retry_manual · falha_anterior=" + falha,
    );
    if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
      await backendAddEvento(
        reservaId,
        "retry_credenciais_iniciado",
        "Nova tentativa de liberação de credenciais",
        JSON.stringify({
          origem: "retry_manual",
          falha_anterior: falha,
        }),
      );
    }

    const reutilizar = falha === "envio";
    if (!reutilizar && !acessoLiberadoEfetivo(reserva)) {
      const liberar = await backendLiberarAcesso(reservaId);
      if (!liberar.ok) {
        addHistoricoEvento(
          reserva,
          "falha_gerar_senha",
          "Falha ao gerar senha",
          liberar.error || null,
        );
        if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
          await backendAddEvento(
            reservaId,
            "falha_gerar_senha",
            "Falha ao gerar senha",
            liberar.error || null,
          );
        }
        refresh();
        return { ok: false, error: liberar.error || "Falha ao gerar senha" };
      }
    }

    if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
      const principal = Array.isArray(reserva.hospedes)
        ? reserva.hospedes.find((h) => h.principal) || reserva.hospedes[0]
        : null;
      const result = await backendEnviarSenha(
        reservaId,
        principal?.email || "",
        principal?.whatsapp || "",
        { manual: true, origem: "retry_manual" },
      );
      if (!result.ok) {
        const tipo =
          falha === "geracao" ? "falha_gerar_senha" : "falha_enviar_credenciais";
        await backendAddEvento(
          reservaId,
          tipo,
          tipo === "falha_gerar_senha"
            ? "Falha ao gerar senha"
            : "Falha ao enviar credenciais",
          result.error || null,
        );
        await refreshFromSource();
        return { ok: false, error: result.error };
      }
      await backendAddEvento(
        reservaId,
        "retry_credenciais_sucesso",
        "Retry de credenciais concluído",
        JSON.stringify({
          origem: "retry_manual",
          reutilizar_credencial: reutilizar,
          skipped: !!result.skipped,
        }),
      );
      await refreshFromSource();
      return { ok: true, skipped: !!result.skipped, enviado: !result.skipped };
    }

    reserva.senhaEnviadaEm = new Date().toISOString();
    addHistoricoEvento(
      reserva,
      "retry_credenciais_sucesso",
      "Retry de credenciais concluído",
      "origem=retry_manual (simulação local)",
    );
    refresh();
    return { ok: true, enviado: true };
  } finally {
    _liberacaoCredencialInFlight.delete(String(reservaId));
  }
}

/**
 * Gatilho das 13h — chamável por scheduler (sem cron nesta etapa).
 * Expõe window.YesHotelAplicarLiberacaoCredenciais13h.
 */
async function aplicarLiberacaoCredenciais13hNoPainel(options) {
  const opts = options && typeof options === "object" ? options : {};
  const agora = opts.dataHoraAtual instanceof Date ? opts.dataHoraAtual : new Date();
  const ymd =
    opts.dateYmd ||
    agora.getFullYear() +
      "-" +
      String(agora.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(agora.getDate()).padStart(2, "0");
  const lista = (Array.isArray(reservas) ? reservas : []).filter(
    (r) => String(r.checkInPrevisto || "").slice(0, 10) === ymd,
  );
  const policy = window.YesHotelCredentialReleasePolicy;
  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;
  const resultados = [];
  for (let i = 0; i < lista.length; i++) {
    const r = lista[i];
    if (!policy || !policy.atingiuHorario13hCheckin) {
      ignoradas += 1;
      continue;
    }
    const checkinDt = String(r.checkInPrevisto).slice(0, 10) + "T14:00:00";
    if (!policy.atingiuHorario13hCheckin(checkinDt, agora)) {
      ignoradas += 1;
      continue;
    }
    if (r.senhaEnviadaEm || obterUltimosEventosSenha(r).lastOkSenha) {
      ignoradas += 1;
      continue;
    }
    const result = await aplicarLiberacaoCredenciaisNoPainel(r.id, {
      origem: "automatico_13h",
    });
    resultados.push(result);
    if (result.enviado) enviadas += 1;
    else if (result.error) falhas += 1;
    else ignoradas += 1;
  }
  return {
    processadas: lista.length,
    enviadas,
    ignoradas,
    falhas,
    resultados,
  };
}

if (typeof window !== "undefined") {
  window.YesHotelAplicarLiberacaoCredenciais13h =
    aplicarLiberacaoCredenciais13hNoPainel;
}

function derivarExcecaoToleranciaAcesso(reserva) {
  const tolPolicy = window.YesHotelAccessTolerancePolicy;
  if (!tolPolicy || !reserva || !reserva.acessoTolerancia) return null;
  const t = reserva.acessoTolerancia;
  const alert = tolPolicy.summarizeAccessToleranceAlert({
    reservation_id: reserva.id,
    apartment_number: reserva.apartamento || "",
    guest_main_name: reserva.hospedePrincipal || "",
    external_reservation_id: reserva.externalReservationId || null,
    grace_status: t.grace_status,
    suspension_due_at: t.suspension_due_at,
    current_payment_pending: !!t.current_payment_pending && !t.payment_unconfirmed,
    payment_unconfirmed: !!t.payment_unconfirmed,
    current_fnrh_pending: !!t.current_fnrh_pending,
    last_error: t.last_error || null,
    communication_failed: !!t.communication_failed,
  });
  if (!alert) return null;
  const items = tolPolicy.deriveAccessToleranceExceptions({
    reservation_id: reserva.id,
    apartment_number: reserva.apartamento || "",
    guest_main_name: reserva.hospedePrincipal || "",
    grace_status: t.grace_status,
    suspension_due_at: t.suspension_due_at,
    current_payment_pending: !!t.current_payment_pending && !t.payment_unconfirmed,
    payment_unconfirmed: !!t.payment_unconfirmed,
    current_fnrh_pending: !!t.current_fnrh_pending,
    communication_failed: !!t.communication_failed,
  });
  const critica = items.some(function (i) {
    return i.severity === "critica";
  });
  var motivo = items
    .slice(0, 3)
    .map(function (i) {
      return i.label;
    })
    .join(" · ");
  return {
    severidade: critica ? "critica" : "moderada",
    prioridade: critica ? 2 : 8,
    motivo: motivo || alert,
    ctaHint: "Ver reserva",
    codigo: items[0] ? items[0].code : "tolerancia",
    toleranciaId: t.id || null,
  };
}

function derivarExcecaoOperacionalReserva(reserva) {
  if (!reserva || isCheckinConcluido(reserva)) return null;

  const tolEx = derivarExcecaoToleranciaAcesso(reserva);
  if (tolEx) return tolEx;

  const policy = window.YesHotelCredentialReleasePolicy;
  if (policy && typeof policy.derivarAlertaOperacional === "function") {
    const input = buildCredentialReleaseInputFromReserva(reserva);
    const alerta = policy.derivarAlertaOperacional(input);
    if (
      input.liberacaoManualComPendencias &&
      policy.listarPendenciasCredenciais(
        input.pagamentoStatus,
        input.fnrhStatus,
      ).length === 0
    ) {
      reserva.liberacaoManualComPendencias = false;
    }
    if (!alerta) return null;

    const isFalha =
      alerta.indexOf("Falha") === 0 ||
      alerta.indexOf("Acesso liberado manualmente") === 0;
    const isSenha = alerta === "Senha ainda não enviada";
    let ctaHint = "Ver reserva";
    if (alerta.indexOf("Falha") === 0) {
      ctaHint = "Tentar novamente";
    } else if (isSenha) {
      ctaHint = input.senhaEnviada
        ? "Reenviar credenciais"
        : "Gerar e enviar credenciais";
    } else if (alerta.indexOf("Acesso liberado manualmente") === 0) {
      ctaHint = "Resolver pendências";
    } else if (alerta.indexOf("Pagamento") >= 0 || alerta.indexOf("FNRH") >= 0) {
      ctaHint = "Ver pendências";
    }

    return {
      severidade: isFalha ? "critica" : isSenha ? "critica" : "moderada",
      prioridade: isFalha ? 1 : isSenha ? 5 : 10,
      motivo: alerta,
      ctaHint,
      codigo:
        alerta.indexOf("Falha") === 0
          ? "credencial_falha_retry"
          : "credencial_politica",
    };
  }

  return null;
}

function renderExcecoesOperacionais() {
  if (!(excecoesStripElement instanceof HTMLElement)) return;
  if (!Array.isArray(reservas)) {
    excecoesStripElement.classList.add("hidden");
    excecoesStripElement.innerHTML = "";
    return;
  }
  var itens = [];
  for (var i = 0; i < reservas.length; i++) {
    var r = reservas[i];
    var ex = derivarExcecaoOperacionalReserva(r);
    if (ex) itens.push({ reserva: r, ex: ex });
  }
  itens.sort(function (a, b) {
    var sa = a.ex.severidade === "critica" ? 0 : 1;
    var sb = b.ex.severidade === "critica" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.ex.prioridade - b.ex.prioridade;
  });
  var total = itens.length;
  if (total === 0) {
    excecoesStripElement.classList.add("hidden");
    excecoesStripElement.innerHTML = "";
    return;
  }
  var slice = itens.slice(0, OPERACIONAL_EXCECOES_MAX_ITENS);
  var omitidos = total - slice.length;
  var crit = itens.filter(function (x) {
    return x.ex.severidade === "critica";
  }).length;
  var mod = itens.filter(function (x) {
    return x.ex.severidade === "moderada";
  }).length;
  var rows = slice
    .map(function (row) {
      var apt = (row.reserva.apartamento || "—").trim() || "—";
      var guest = (row.reserva.hospedePrincipal || "—").trim() || "—";
      var resNum =
        (row.reserva.externalReservationId && String(row.reserva.externalReservationId).trim()) ||
        "—";
      var sev = row.ex.severidade === "critica" ? "critica" : "moderada";
      var rid = row.reserva.id;
      return (
        '<li class="operacional-excecao-item" tabindex="0" role="button" data-reserva-id="' +
        escapeHtml(String(rid)) +
        '">' +
        '<span class="operacional-excecao-sev operacional-excecao-sev--' +
        sev +
        '" title="' +
        (sev === "critica" ? "Crítica" : "Moderada") +
        '"></span>' +
        '<div class="operacional-excecao-main">' +
        '<div class="operacional-excecao-line">' +
        '<span class="operacional-excecao-reserva">Reserva <strong>' +
        escapeHtml(resNum) +
        "</strong></span>" +
        '<span class="operacional-excecao-sep" aria-hidden="true"> · </span>' +
        '<span class="operacional-excecao-apt">Apto <strong>' +
        escapeHtml(apt) +
        "</strong></span>" +
        '<span class="operacional-excecao-sep" aria-hidden="true"> · </span>' +
        '<span class="operacional-excecao-guest">' +
        escapeHtml(guest) +
        "</span>" +
        "</div>" +
        '<div class="operacional-excecao-line">' +
        '<span class="operacional-excecao-motivo">' +
        escapeHtml(row.ex.motivo) +
        "</span>" +
        "</div></div>" +
        (row.ex.ctaHint
          ? '<span class="operacional-excecao-cta">' + escapeHtml(row.ex.ctaHint) + "</span>"
          : "") +
        "</li>"
      );
    })
    .join("");
  var maisTxt =
    omitidos > 0
      ? '<p class="operacional-excecoes-mais">' + escapeHtml("E mais " + omitidos + " reserva(s) na lista abaixo.") + "</p>"
      : "";
  // Apresentação: <details> compacto (padrão v0). Lógica e itens intactos.
  // Não forçar open: faixa compacta libera altura para a tabela (7+ linhas em 1440×900).
  var wasOpen = !!(
    excecoesStripElement.querySelector("details.operacional-excecoes-inner") &&
    excecoesStripElement.querySelector("details.operacional-excecoes-inner").open
  );
  var firstMotivo = slice[0] && slice[0].ex && slice[0].ex.motivo ? String(slice[0].ex.motivo) : "";
  var firstApt =
    slice[0] && slice[0].reserva && slice[0].reserva.apartamento
      ? String(slice[0].reserva.apartamento).trim()
      : "";
  var summaryHint = firstApt
    ? " · Apto " + firstApt + (firstMotivo ? " — " + firstMotivo : "")
    : firstMotivo
      ? " · " + firstMotivo
      : "";
  excecoesStripElement.classList.remove("hidden");
  excecoesStripElement.innerHTML =
    '<details class="operacional-excecoes-inner"' +
    (wasOpen ? " open" : "") +
    ">" +
    '<summary class="operacional-excecoes-head">' +
    '<span class="operacional-excecoes-title"><strong>' +
    escapeHtml(String(total)) +
    (total === 1 ? " exceção" : " exceções") +
    "</strong>" +
    escapeHtml(summaryHint) +
    "</span>" +
    '<span class="operacional-excecoes-counts">' +
    escapeHtml(String(crit)) +
    (crit === 1 ? " crítica" : " críticas") +
    " · " +
    escapeHtml(String(mod)) +
    (mod === 1 ? " moderada" : " moderadas") +
    " · Ver todas</span></summary>" +
    '<div class="operacional-excecoes-body">' +
    '<ul class="operacional-excecoes-list">' +
    rows +
    "</ul>" +
    maisTxt +
    "</div></details>";

  excecoesStripElement.querySelectorAll(".operacional-excecao-item").forEach(function (el) {
    function abrir() {
      var id = el.getAttribute("data-reserva-id");
      if (id) openDetail(id);
    }
    el.addEventListener("click", abrir);
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        abrir();
      }
    });
  });
}

function legendaMotivoEnvioSenha(motivo) {
  var m = String(motivo || "").trim();
  if (m === "senha_reenviada_manual") return "Reenvio (manual)";
  if (m === "senha_gerada_e_enviada_manual") return "Geração e envio (manual)";
  if (m === "senha_enviada_apos_validacao_tardia") return "Automático (após validação tardia da FNRH)";
  if (m === "senha_enviada_24h_antes") return "Automático (janela 24h antes do check-in)";
  if (m === "senha_enviada_manual") return "Manual (legado)";
  return m || "—";
}

/** Mesmas contagens/flags do detalhe, para recomendação e coluna da lista. */
function buildRecomendacaoOperacionalCtx(reserva) {
  const hospedes = Array.isArray(reserva.hospedes) ? reserva.hospedes : [];
  const naoIdentificados = getNaoIdentificados(reserva);
  const faltamContato = getFaltamContato(reserva);
  const prontos = getProntosParaEnvio(reserva);
  const prontosCount = prontos.length;
  const prontosSimplificada = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA).length;
  const prontosCompleto = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO).length;
  const naoIdentCount = naoIdentificados.length;
  const faltamCount = faltamContato.length;
  const enviadosCount = hospedes.filter((h) => h.statusOperacional === GUEST_STATUS.ENVIADO).length;
  function getEnviarButtonLabel() {
    if (prontosSimplificada > 0 && prontosCompleto === 0) {
      return `Enviar confirmação${prontosSimplificada > 1 ? "ões" : ""} simplificada${prontosSimplificada > 1 ? "s" : ""} (${prontosCount})`;
    }
    if (prontosCompleto > 0 && prontosSimplificada === 0) {
      return `Enviar FNRH${prontosCompleto > 1 ? "s" : ""} completa${prontosCompleto > 1 ? "s" : ""} (${prontosCount})`;
    }
    return `Enviar confirmações e FNRHs (${prontosCount})`;
  }
  const enviarButtonLabel = prontosCount > 0 ? getEnviarButtonLabel() : "";
  const temBotaoEnviarLinks = prontosCount > 0 && naoIdentCount === 0;
  const temBotaoSenhaBackend = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
  return {
    naoIdentCount,
    faltamCount,
    prontosCount,
    enviadosCount,
    enviarButtonLabel,
    temBotaoEnviarLinks,
    temBotaoSenhaBackend,
    prontosSimplificada,
    prontosCompleto,
  };
}

function enviarFnrhListaCurta(ctx) {
  const ps = ctx.prontosSimplificada || 0;
  const pc = ctx.prontosCompleto || 0;
  if (ps > 0 && pc === 0) return "Enviar confirmações simplificadas";
  if (pc > 0 && ps === 0) return "Enviar FNRHs completas";
  return "Enviar confirmações e FNRHs";
}

function listaLabelBloqueioCurto(motivo) {
  const m = String(motivo || "").trim();
  if (!m) return "Envio bloqueado";
  if (m.length <= 52) return m;
  return m.slice(0, 49) + "…";
}

/**
 * Próxima ação recomendada no detalhe: baseada em pagamento, FNRH, contatos, eventos de senha e flags da reserva.
 * ctx vem de buildRecomendacaoOperacionalCtx (detalhe e lista).
 */
function derivarRecomendacaoOperacional(reserva, ctx) {
  var naoIdentCount = ctx.naoIdentCount;
  var faltamCount = ctx.faltamCount;
  var prontosCount = ctx.prontosCount;
  var enviadosCount = ctx.enviadosCount;
  var enviarButtonLabel = ctx.enviarButtonLabel;
  var temBotaoEnviarLinks = ctx.temBotaoEnviarLinks;
  var temBotaoSenhaBackend = ctx.temBotaoSenhaBackend;

  var ob = obterUltimosEventosSenha(reserva);
  var lastOk = ob.lastOkSenha;
  var lastFail = ob.lastFailSenha;
  var failRecente = falhaSenhaMaisRecenteQueSucesso(lastOk, lastFail);

  if (isCheckinConcluido(reserva)) {
    return { variant: "success", texto: "Check-in concluído nesta reserva.", listaLabel: "Check-in concluído", cta: null };
  }

  if (lastFail && lastFail.p && lastFail.p.tipo_bloqueio === "credencial_revogada" && failRecente) {
    return {
      variant: "danger",
      texto: lastFail.p.motivo_bloqueio || "Envio bloqueado: credencial revogada.",
      listaLabel: listaLabelBloqueioCurto(lastFail.p.motivo_bloqueio || "Credencial revogada"),
      cta: null,
    };
  }

  if (!isPagamentoOk(reserva)) {
    var payUi = resolvePaymentUiForReserva(reserva);
    if (payUi && payUi.kind && payUi.kind !== "none" && payUi.kind !== "hidden_perfil") {
      var variantMap = {
        warn: "warn",
        info: "info",
        success: "success",
        danger: "danger",
        amber: "warn",
        neutral: "neutral",
      };
      return {
        variant: variantMap[payUi.variant] || "warn",
        texto: payUi.detalheTexto || payUi.listaLabel || "Pagamento pendente.",
        listaLabel: payUi.listaLabel || "Pagamento",
        cta:
          payUi.ctaKind && payUi.ctaLabel
            ? { kind: payUi.ctaKind, label: payUi.ctaLabel }
            : null,
      };
    }
    var pagamentoEhPms = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
    return {
      variant: "warn",
      texto: pagamentoEhPms
        ? "Pagamento ainda não consta como confirmado nos dados sincronizados do PMS. O Yes não altera pagamento; aguarde a atualização no PMS ou trate diretamente lá."
        : "Pagamento ainda não está confirmado (modo local/demo). Em produção, o status vem do PMS.",
      listaLabel: pagamentoEhPms ? "Não pago (PMS)" : "Regularizar pagamento",
      cta: pagamentoEhPms ? null : { kind: "simular_pagamento", label: "Simular pagamento (demo)" },
    };
  }

  if (naoIdentCount > 0) {
    return {
      variant: "warn",
      texto: "Complete a identificação dos hóspedes (nome adequado) antes de enviar links.",
      listaLabel: "Completar dados dos hóspedes",
      cta: { kind: "ir_hospedes", label: "Ir para hóspedes" },
    };
  }

  if (faltamCount > 0 && prontosCount === 0) {
    return {
      variant: "warn",
      texto: "Não há telefone nem e-mail válidos para comunicação com hóspede(s) que ainda precisam de FNRH.",
      listaLabel: "Corrigir contatos",
      cta: { kind: "ir_hospedes", label: "Corrigir contatos" },
    };
  }

  if (prontosCount > 0 && temBotaoEnviarLinks) {
    return {
      variant: "neutral",
      texto:
        faltamCount > 0
          ? "Há hóspedes prontos para receber o link; ainda falta contato em " +
            faltamCount +
            ". Envie para os que já têm e-mail ou WhatsApp."
          : "Envie os links ou confirmações de FNRH para os hóspedes prontos.",
      listaLabel: enviarFnrhListaCurta(ctx),
      cta: { kind: "enviar_fnrh", label: enviarButtonLabel },
    };
  }

  if (prontosCount > 0 && !temBotaoEnviarLinks) {
    return {
      variant: "neutral",
      texto: "Há hóspedes elegíveis para envio; use a seção de ações abaixo.",
      listaLabel: "Ver hóspedes",
      cta: { kind: "ir_hospedes", label: "Ver hóspedes" },
    };
  }

  if (enviadosCount > 0 && !isFnrhCompleta(reserva)) {
    return {
      variant: "neutral",
      texto: "FNRH ainda pendente. Reenvie o link ao hóspede pelo cartão abaixo, se necessário.",
      listaLabel: "Reenviar FNRH",
      cta: { kind: "reenviar_fnrh", label: "Reenviar FNRH" },
    };
  }

  if (isProntaParaLiberarAcesso(reserva)) {
    return {
      variant: "info",
      texto: "FNRH validada e pagamento ok. Libere o acesso para seguir com a senha.",
      listaLabel: "Liberar acesso",
      cta: { kind: "liberar_acesso", label: "Liberar acesso" },
    };
  }

  var senhaJaRegistrada = !!(
    reserva.senhaEnviadaEm ||
    lastOk ||
    reserva.ttlockPrincipalTodosProvisionados
  );

  var precisaSenhaBackend =
    PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND &&
    temBotaoSenhaBackend &&
    (reserva.fnrhStatusAgregado || "") === "fnrh_completo" &&
    acessoLiberadoEfetivo(reserva) &&
    !senhaJaRegistrada;

  if (precisaSenhaBackend) {
    return {
      variant: "info",
      texto: "FNRH validada no sistema e acesso liberado. A senha ainda não foi registrada como enviada.",
      listaLabel: labelAcaoCredenciaisPainel(reserva),
      cta: { kind: "gerar_senha", label: labelAcaoCredenciaisPainel(reserva) },
    };
  }

  if (failRecente && lastFail && lastFail.p && !senhaJaRegistrada) {
    var tb = lastFail.p.tipo_bloqueio;
    if (tb === "sem_contato" || tb === "falha_canais") {
      return {
        variant: "warn",
        texto: lastFail.p.motivo_bloqueio || "Falha no envio da senha (contato ou canal).",
        listaLabel: listaLabelBloqueioCurto(lastFail.p.motivo_bloqueio) || "Corrigir contatos",
        cta: { kind: "ir_hospedes", label: "Corrigir contatos" },
      };
    }
    if (tb === "sem_credencial") {
      var ctaSemCred = isProntaParaLiberarAcesso(reserva)
        ? { kind: "liberar_acesso", label: "Liberar acesso" }
        : { kind: "ir_hospedes", label: "Ver hóspedes" };
      return {
        variant: "warn",
        texto: lastFail.p.motivo_bloqueio || "Libere o acesso na reserva antes de enviar a senha.",
        listaLabel: ctaSemCred.label,
        cta: ctaSemCred,
      };
    }
    if (tb === "provisionamento") {
      return {
        variant: "warn",
        texto: lastFail.p.motivo_bloqueio || "Falha ao provisionar senha no TTLock.",
        listaLabel: listaLabelBloqueioCurto(lastFail.p.motivo_bloqueio) || "Conferir TTLock",
        cta: { kind: "ir_ttlock", label: "Ver status TTLock" },
      };
    }
  }

  if (acessoLiberadoEfetivo(reserva) && !reserva.entrouNoApto) {
    if (senhaJaRegistrada) {
      return {
        variant: "success",
        texto: "Reserva pronta. Aguarde a chegada do hóspede.",
        listaLabel: "Aguardar chegada",
        cta: null,
      };
    }
    return {
      variant: "neutral",
      texto:
        "Acesso liberado. A senha pode sair automaticamente na janela definida; use o envio manual abaixo se fizer sentido.",
      listaLabel: temBotaoSenhaBackend ? labelAcaoCredenciaisPainel(reserva) : "Aguardar envio da senha",
      cta: temBotaoSenhaBackend
        ? { kind: "gerar_senha", label: labelAcaoCredenciaisPainel(reserva) }
        : null,
    };
  }

  var prox = getProximaAcaoReserva(reserva);
  if (prox) {
    var listaProx = prox === "Aguardar entrada no apartamento" ? "Aguardar chegada" : prox;
    return { variant: "neutral", texto: prox, listaLabel: listaProx, cta: null };
  }
  return { variant: "neutral", texto: "Nenhuma ação urgente neste momento.", listaLabel: "—", cta: null };
}

/**
 * @param {{ omitCta?: boolean, wrapInDetails?: boolean }} [opts]
 */
function buildRecomendacaoDetalheHtml(reserva, ctx, opts) {
  opts = opts || {};
  var rec = derivarRecomendacaoOperacional(reserva, ctx);
  if (!rec || !rec.texto) return "";
  var mod = rec.variant || "neutral";
  var ctaHtml = "";
  if (!opts.omitCta && rec.cta && rec.cta.kind && rec.cta.label) {
    ctaHtml =
      '<div class="reservation-detail-recomendacao-cta">' +
      '<button type="button" class="primary-button detail-recomendacao-cta-btn" data-recomendacao-cta="' +
      escapeHtml(rec.cta.kind) +
      '">' +
      escapeHtml(rec.cta.label) +
      "</button></div>";
  }
  var inner =
    '<div class="reservation-detail-section reservation-detail-recomendacao reservation-detail-recomendacao--' +
    escapeHtml(mod) +
    '">' +
    '<p class="reservation-detail-recomendacao-kicker">Orientação</p>' +
    '<p class="reservation-detail-recomendacao-texto">' +
    escapeHtml(rec.texto) +
    "</p>" +
    ctaHtml +
    "</div>";
  if (opts.wrapInDetails) {
    return (
      '<details class="detail-collapsible detail-collapsible--orientacao">' +
      '<summary class="detail-collapsible-summary">Orientação detalhada</summary>' +
      inner +
      "</details>"
    );
  }
  return inner;
}

/** Topo do detalhe: situação, orientação curta, ação + botões, e contexto operacional (envios etc.) tudo no mesmo card. */
function buildSituacaoAcaoTopoHtml(
  reserva,
  ctx,
  enviarLinksBtnHtml,
  reenviarFnrhTopoBtnHtml,
  enviarSenhaBtnHtml,
  temBotaoSenhaBackend,
  topContextInnerHtml,
) {
  var st = derivarStatusOperacional(reserva);
  var rec = derivarRecomendacaoOperacional(reserva, ctx);
  var rid = escapeHtml(String(reserva.id));

  var primaryRow = "";
  var usedSenhaAsPrimary = false;
  var aguardarChegada = !!(rec && rec.listaLabel === "Aguardar chegada" && !rec.cta);

  if (!aguardarChegada) {
    if (enviarLinksBtnHtml && String(enviarLinksBtnHtml).indexOf("detail-enviar-links-btn") !== -1) {
      primaryRow = enviarLinksBtnHtml;
    } else if (reenviarFnrhTopoBtnHtml && String(reenviarFnrhTopoBtnHtml).indexOf("detail-reenviar-fnrh-topo-btn") !== -1) {
      primaryRow = reenviarFnrhTopoBtnHtml;
    } else if (rec.cta && rec.cta.kind === "gerar_senha" && temBotaoSenhaBackend && enviarSenhaBtnHtml) {
      primaryRow = enviarSenhaBtnHtml;
      usedSenhaAsPrimary = true;
    } else if (rec.cta && rec.cta.kind && rec.cta.kind !== "ir_hospedes" && rec.cta.label) {
      primaryRow =
        '<button type="button" class="primary-button detail-recomendacao-cta-btn" data-recomendacao-cta="' +
        escapeHtml(rec.cta.kind) +
        '">' +
        escapeHtml(rec.cta.label) +
        "</button>";
    }
  }

  var secondaryRow = "";
  if (temBotaoSenhaBackend && enviarSenhaBtnHtml && !usedSenhaAsPrimary) {
    // Reenviar/gerar senha é excepcional quando a próxima ação é aguardar chegada.
    secondaryRow =
      '<details class="detail-mais-acoes">' +
      '<summary class="detail-mais-acoes-sum">Mais ações</summary>' +
      '<div class="detail-mais-acoes-body">' +
      enviarSenhaBtnHtml +
      "</div></details>";
  }

  var situacaoLinha = escapeHtml(st.label);
  var situacaoSubHtml = "";
  var acaoHint = "";
  var payUiTopo = resolvePaymentUiForReserva(reserva);
  if (payUiTopo && payUiTopo.kind === "pago_pagarme_hits_pendente") {
    situacaoLinha = escapeHtml(payUiTopo.situacaoLabel || "Pago no Pagar.me");
    if (payUiTopo.situacaoSubtexto) {
      situacaoSubHtml =
        '<p class="detail-situacao-sub">' + escapeHtml(payUiTopo.situacaoSubtexto) + "</p>";
    }
  } else {
    acaoHint =
      rec.listaLabel && String(rec.listaLabel).trim() && rec.listaLabel !== "—"
        ? escapeHtml(rec.listaLabel)
        : "";
  }

  var contatoPanelHtml = "";
  if (primaryRow || secondaryRow) {
    contatoPanelHtml =
      '<div class="detail-top-contato-panel hidden" id="detail-top-contato-panel" data-reserva-id="' +
      rid +
      '">' +
      '<p class="detail-top-contato-title" id="detail-top-contato-title"></p>' +
      '<div class="detail-top-contato-fields">' +
      '<label class="detail-top-contato-label" for="detail-top-contato-email">E-mail</label>' +
      '<input type="email" id="detail-top-contato-email" class="detail-top-contato-input" placeholder="email@exemplo.com" autocomplete="email" />' +
      '<label class="detail-top-contato-label" for="detail-top-contato-whatsapp">WhatsApp</label>' +
      '<input type="text" id="detail-top-contato-whatsapp" class="detail-top-contato-input" placeholder="11999990000" inputmode="tel" />' +
      "</div>" +
      '<p class="detail-top-contato-msg hidden" id="detail-top-contato-msg" role="status"></p>' +
      '<div class="detail-top-contato-actions">' +
      '<button type="button" class="primary-button detail-top-acao-btn detail-top-contato-confirm" id="detail-top-contato-confirm">Confirmar envio</button>' +
      '<button type="button" class="secondary-button detail-top-contato-cancel" id="detail-top-contato-cancel">Cancelar</button>' +
      "</div></div>";
  }

  var acaoBlock = "";
  if (primaryRow || secondaryRow) {
    acaoBlock =
      '<p class="detail-acao-kicker">Ação</p>' +
      '<div class="detail-top-actions">' +
      (primaryRow || "") +
      secondaryRow +
      "</div>" +
      contatoPanelHtml;
  }

  var contextBlock = "";
  if (topContextInnerHtml && String(topContextInnerHtml).trim()) {
    contextBlock = '<div class="detail-top-context">' + topContextInnerHtml + "</div>";
  }

  return (
    '<div class="reservation-detail-section reservation-detail-top-hero">' +
    '<p class="detail-situacao-kicker">Situação</p>' +
    '<p class="detail-situacao-valor">' +
    situacaoLinha +
    "</p>" +
    situacaoSubHtml +
    (acaoHint ? '<p class="detail-acao-hint">' + acaoHint + "</p>" : "") +
    acaoBlock +
    contextBlock +
    "</div>"
  );
}

function buildResumoOperacionalDetalheHtml(reserva) {
  var hist = reserva.historicoOperacional || [];
  var isBackend = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
  var agg = reserva.fnrhStatusAgregado || "fnrh_pendente";
  var fnrhA = agregarEnviosFnrhDoHistorico(hist);

  var primeiroEnvioTxt = "Não registrado";
  if (fnrhA.firstOk) {
    primeiroEnvioTxt =
      formatIsoOperacional(fnrhA.firstOk.at) +
      " · " +
      labelTipoEventoFnrh(fnrhA.firstOk.p && fnrhA.firstOk.p.tipo_evento);
  } else if (fnrhA.lastAny) {
    primeiroEnvioTxt =
      "Sem sucesso registrado; primeira tentativa em " +
      formatIsoOperacional(fnrhA.lastAny.at) +
      " (" +
      labelTipoEventoFnrh(fnrhA.lastAny.p && fnrhA.lastAny.p.tipo_evento) +
      ")";
  }

  var ultimoEnvioTxt = "Não registrado";
  if (fnrhA.lastOk) {
    ultimoEnvioTxt =
      formatIsoOperacional(fnrhA.lastOk.at) +
      " · " +
      labelTipoEventoFnrh(fnrhA.lastOk.p && fnrhA.lastOk.p.tipo_evento);
  } else if (fnrhA.lastAny) {
    ultimoEnvioTxt =
      formatIsoOperacional(fnrhA.lastAny.at) +
      " · " +
      labelTipoEventoFnrh(fnrhA.lastAny.p && fnrhA.lastAny.p.tipo_evento) +
      " (sem sucesso de canal)";
  }

  var ultimoLembreteTxt =
    fnrhA.lastReminder && fnrhA.lastReminder.p
      ? formatIsoOperacional(fnrhA.lastReminder.at) +
        " · " +
        labelTipoEventoFnrh(fnrhA.lastReminder.p.tipo_evento)
      : fnrhA.reminderCount === 0
        ? "Nenhum lembrete com sucesso registrado"
        : "—";

  var evValidada = coletaEventosOrdenadosPorTempo(hist, { fnrh_validada: true });
  var ultimaValidada = evValidada.length ? evValidada[evValidada.length - 1] : null;
  var completoEmDb = reserva.fnrhCompletoEm ? formatIsoOperacional(reserva.fnrhCompletoEm) : "";
  var completoTxt = completoEmDb
    ? completoEmDb + " (marco na reserva)"
    : ultimaValidada
      ? formatIsoOperacional(ultimaValidada.criadoEmIso) + " (evento na linha do tempo)"
      : agg === "fnrh_completo"
        ? "Completo no sistema, sem data registrada"
        : "—";

  var _evS = obterUltimosEventosSenha(reserva);
  var lastOkSenha = _evS.lastOkSenha;
  var lastFailSenha = _evS.lastFailSenha;

  var statusSenha = "Não enviada";
  if (reserva.senhaEnviadaEm) {
    statusSenha = "Enviada (há registro de primeiro envio)";
    if (lastFailSenha && lastOkSenha) {
      if (new Date(lastFailSenha.e.criadoEmIso).getTime() > new Date(lastOkSenha.e.criadoEmIso).getTime()) {
        statusSenha = "Enviada antes; última tentativa falhou";
      }
    } else if (lastFailSenha && !lastOkSenha) {
      statusSenha = "Falhou (sem sucesso registrado)";
    }
  } else if (lastFailSenha && (!lastOkSenha || lastFailSenha.e.criadoEmIso >= lastOkSenha.e.criadoEmIso)) {
    statusSenha = "Falhou (sem primeiro envio registrado)";
  }

  if (lastFailSenha && lastFailSenha.p && lastFailSenha.p.tipo_bloqueio === "credencial_revogada") {
    statusSenha = reserva.senhaEnviadaEm
      ? "Credencial revogada — reenvio bloqueado"
      : "Credencial revogada — envio bloqueado";
  }

  var enviadaEmTxt = reserva.senhaEnviadaEm
    ? formatIsoOperacional(reserva.senhaEnviadaEm)
    : lastOkSenha
      ? formatIsoOperacional(lastOkSenha.e.criadoEmIso) + " (apenas evento)"
      : "Não registrado";

  var tipoUltimoTxt = "—";
  var acaoUltimoTxt = "—";
  if (lastOkSenha && lastOkSenha.p) {
    if (lastOkSenha.p.manual === true) {
      tipoUltimoTxt = "Manual";
      var am = lastOkSenha.p.acao_manual;
      if (am === "geracao_via_provisionamento" || am === "geracao_provisionamento") {
        acaoUltimoTxt = "Geração (provisionamento)";
      } else if (am === "reenvio_senha_existente" || am === "reenvio_senha") {
        acaoUltimoTxt = "Reenvio";
      } else {
        acaoUltimoTxt = legendaMotivoEnvioSenha(lastOkSenha.p.motivo_envio);
      }
    } else {
      tipoUltimoTxt = "Automática";
      acaoUltimoTxt = legendaMotivoEnvioSenha(lastOkSenha.p.motivo_envio);
    }
  }

  var erroBloqueioTxt = "—";
  if (lastFailSenha && lastFailSenha.p) {
    var failT = new Date(lastFailSenha.e.criadoEmIso).getTime();
    var okT = lastOkSenha ? new Date(lastOkSenha.e.criadoEmIso).getTime() : 0;
    if (!lastOkSenha || failT > okT) {
      var mot = lastFailSenha.p.motivo_bloqueio || lastFailSenha.p.erro;
      var tb = lastFailSenha.p.tipo_bloqueio;
      erroBloqueioTxt = (tb ? tb + ": " : "") + (mot || "falha registrada");
      erroBloqueioTxt += " · " + formatIsoOperacional(lastFailSenha.e.criadoEmIso);
    }
  }

  if (
    agg === "fnrh_completo" &&
    reserva.acessoLiberado &&
    !reserva.senhaEnviadaEm &&
    !lastOkSenha &&
    isBackend
  ) {
    erroBloqueioTxt =
      erroBloqueioTxt === "—"
        ? "Sem evento de envio de senha ainda (automático pode aguardar janela ou ter falhado sem trilha)."
        : erroBloqueioTxt;
  }

  var envios = Array.isArray(reserva.comunicacaoEnviosOperacional) ? reserva.comunicacaoEnviosOperacional : [];
  var ultimoDisp = envios.length ? envios[0] : null;
  var ultComCanal = ultimoDisp ? labelCanalComunicacaoPainel(ultimoDisp.canal) : "—";
  var ultComStatus = ultimoDisp ? labelStatusEnvioComunicacao(ultimoDisp.status) : "—";
  var ultComQuando = ultimoDisp && ultimoDisp.createdAt ? formatIsoOperacional(ultimoDisp.createdAt) : "—";
  var ultComProp = ultimoDisp ? labelPropositoComunicacao(ultimoDisp.proposito) : "—";
  var ultComPreview = ultimoDisp && ultimoDisp.corpoPreview ? String(ultimoDisp.corpoPreview).trim() : "";
  if (ultComPreview.length > 160) ultComPreview = ultComPreview.slice(0, 157) + "...";
  var ultComErro = ultimoDisp && ultimoDisp.erro ? String(ultimoDisp.erro).trim() : "";

  if (!ultimoDisp && isBackend) {
    ultComCanal = "—";
    ultComStatus = "Sem registros em operacional_comunicacao_envios";
    ultComQuando = "—";
    ultComProp = "—";
    ultComPreview = "";
  } else if (!ultimoDisp && !isBackend) {
    ultComStatus = "Indisponível nesta origem (use backend Supabase)";
  }

  var dicaParts = [];
  if (agg !== "fnrh_completo" && fnrhA.reminderCount > 0) {
    dicaParts.push("FNRH ainda não completa; já houve lembrete(s) registrado(s) com sucesso.");
  }
  if (agg === "fnrh_completo" && !reserva.senhaEnviadaEm && isBackend) {
    dicaParts.push("FNRH completa no banco; confira senha e janela automática se nada foi enviado.");
  }
  if (lastFailSenha && lastFailSenha.p && lastFailSenha.p.tipo_bloqueio === "credencial_revogada") {
    dicaParts.push("Credencial revogada: envio manual não deve prosseguir até nova credencial.");
  }
  var dicaHtml =
    dicaParts.length > 0
      ? '<p class="resumo-op-dica">' + escapeHtml(dicaParts.join(" ")) + "</p>"
      : "";

  return (
    '<details class="detail-collapsible detail-collapsible--fluxo">' +
    '<summary class="detail-collapsible-summary">Ver detalhes do fluxo operacional (FNRH, senha, comunicação)</summary>' +
    '<div class="reservation-detail-section reservation-detail-resumo-operacional">' +
    '<p class="reservation-detail-section-title reservation-detail-section-title--inner">Fluxo operacional (FNRH, senha, comunicação)</p>' +
    '<div class="resumo-op-wrap">' +
    '<div class="resumo-op-subgrid">' +
    '<div class="resumo-op-block">' +
    "<h4>Status FNRH</h4>" +
    "<ul class=\"resumo-op-list\">" +
    "<li><strong>Agregado no sistema:</strong> " +
    escapeHtml(labelFnrhAgregadoPainel(agg)) +
    "</li>" +
    "<li><strong>Primeiro envio com sucesso:</strong> " +
    escapeHtml(primeiroEnvioTxt) +
    "</li>" +
    "<li><strong>Último envio com sucesso:</strong> " +
    escapeHtml(ultimoEnvioTxt) +
    "</li>" +
    "<li><strong>Lembretes (sucesso):</strong> " +
    escapeHtml(String(fnrhA.reminderCount)) +
    " · <strong>Último lembrete:</strong> " +
    escapeHtml(ultimoLembreteTxt) +
    "</li>" +
    "<li><strong>FNRH completa / marco:</strong> " +
    escapeHtml(completoTxt) +
    "</li>" +
    "</ul></div>" +
    '<div class="resumo-op-block">' +
    "<h4>Status senha</h4>" +
    "<ul class=\"resumo-op-list\">" +
    "<li><strong>Resumo:</strong> " +
    escapeHtml(statusSenha) +
    "</li>" +
    "<li><strong>Primeiro envio (campo reserva):</strong> " +
    escapeHtml(enviadaEmTxt) +
    "</li>" +
    "<li><strong>Último envio bem-sucedido:</strong> " +
    escapeHtml(
      lastOkSenha ? formatIsoOperacional(lastOkSenha.e.criadoEmIso) + " · " + tipoUltimoTxt + " · " + acaoUltimoTxt : "Não registrado",
    ) +
    "</li>" +
    "<li><strong>Último erro / bloqueio:</strong> " +
    escapeHtml(erroBloqueioTxt) +
    "</li>" +
    "</ul></div></div>" +
    '<div class="resumo-op-block resumo-op-block-full">' +
    "<h4>Última comunicação (disparo registrado)</h4>" +
    "<ul class=\"resumo-op-list\">" +
    "<li><strong>Finalidade:</strong> " +
    escapeHtml(ultComProp) +
    " · <strong>Canal:</strong> " +
    escapeHtml(ultComCanal) +
    "</li>" +
    "<li><strong>Status:</strong> " +
    escapeHtml(ultComStatus) +
    " · <strong>Quando:</strong> " +
    escapeHtml(ultComQuando) +
    "</li>" +
    (ultComPreview
      ? "<li><strong>Preview:</strong> " + escapeHtml(ultComPreview) + "</li>"
      : "<li><strong>Preview:</strong> não registrado</li>") +
    (ultComErro ? "<li><strong>Erro (provedor):</strong> " + escapeHtml(ultComErro) + "</li>" : "") +
    "</ul></div>" +
    dicaHtml +
    "</div></div></details>"
  );
}

function createNovoHospede(reserva) {
  const next = Array.isArray(reserva.hospedes) ? reserva.hospedes.length + 1 : 1;
  const h = ensureHospedeDefaults({});
  h.id = createHospedeId(reserva.id, next);
  return h;
}

async function adicionarHospede(reservaId) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendAddHospede(reservaId);
    if (ok) await refreshFromSource();
    return;
  }
  const r = getReservaById(reservaId);
  if (!r || !Array.isArray(r.hospedes)) return;
  r.hospedes.push(createNovoHospede(r));
  addHistoricoEvento(r, "hospede_adicionado", "Hóspede adicionado à reserva", null);
  refresh();
}

async function removerHospede(reservaId, guestIndex) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
  if (h.principal) {
    alert("Defina outro hóspede como principal antes de remover este.");
    return;
  }
  if (r.hospedes.length <= 1) {
    alert("A reserva precisa ter pelo menos um hóspede.");
    return;
  }
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendRemoveHospede(reservaId, guestIndex);
    if (ok) await refreshFromSource();
    return;
  }
  const nomeRemovido = h.nome || "Hóspede";
  r.hospedes.splice(guestIndex, 1);
  addHistoricoEvento(r, "hospede_removido", "Hóspede removido da reserva", nomeRemovido);
  refresh();
}

async function definirPrincipal(reservaId, guestIndex) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendSetPrincipal(reservaId, guestIndex);
    if (ok) await refreshFromSource();
    return;
  }
  r.hospedes.forEach((g) => {
    g.principal = false;
  });
  h.principal = true;
  r.hospedePrincipal = (h.nome || "").trim() || "Hóspede principal";
  addHistoricoEvento(r, "principal_alterado", "Hóspede principal alterado", (h.nome || "").trim() || null);
  refresh();
}

function buildLocalModeDetailHtml(reserva) {
  if (reserva.sourceMode !== "local-demo") return "";
  const observation = (reserva.observacoes || "").trim();
  return `
    <div class="reservation-detail-section reservation-detail-local-summary">
      <p class="reservation-detail-section-title">Dados da reserva local</p>
      <dl class="detail-local-grid">
        <div><dt>Período</dt><dd>${escapeHtml(formatDataBR(reserva.checkInPrevisto))} ${escapeHtml(reserva.checkInHorario || "14:00")} → ${escapeHtml(formatDataBR(reserva.checkOutPrevisto))} ${escapeHtml(reserva.checkOutHorario || "12:00")}</dd></div>
        <div><dt>Ocupação</dt><dd>${escapeHtml(String(reserva.quantidadeHospedes || reserva.hospedes?.length || 1))} hóspede(s)</dd></div>
        <div><dt>FNRH</dt><dd>${escapeHtml(isFnrhCompleta(reserva) ? "Completa (simulação local)" : "Pendente (simulação local)")}</dd></div>
        <div><dt>Acesso</dt><dd>TTLock mock · nenhuma credencial real</dd></div>
        <div><dt>Comunicação</dt><dd>Mock · nenhum envio real</dd></div>
        <div class="detail-local-grid__full"><dt>Observações</dt><dd>${escapeHtml(observation || "Sem observações")}</dd></div>
      </dl>
      <button type="button" class="secondary-button detail-copy-access-btn" id="detail-copy-access-btn" data-reserva-id="${escapeHtml(reserva.id)}">Copiar dados de acesso</button>
      <p class="detail-copy-access-status hidden" id="detail-copy-access-status" role="status"></p>
    </div>
  `;
}

function buildLocalAccessClipboardText(reserva) {
  return [
    "YES HOTEL — DADOS DE ACESSO (DEMONSTRAÇÃO)",
    `Apartamento: ${reserva.apartamento || "—"}`,
    `Hóspede: ${reserva.hospedePrincipal || "—"}`,
    `Check-in: ${formatDataBR(reserva.checkInPrevisto)} às ${reserva.checkInHorario || "14:00"}`,
    `Check-out: ${formatDataBR(reserva.checkOutPrevisto)} às ${reserva.checkOutHorario || "12:00"}`,
    "TTLock: modo mock — nenhuma senha ou credencial real foi gerada.",
    "Comunicação: modo mock — mensagem não enviada.",
  ].join("\n");
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Cópia não suportada neste navegador.");
}

function renderDetail(reserva) {
  if (!(detailBodyElement instanceof HTMLElement) || !reserva) return;
  const hospedes = Array.isArray(reserva.hospedes) ? reserva.hospedes : [];
  const naoIdentificados = getNaoIdentificados(reserva);
  const faltamContato = getFaltamContato(reserva);
  const prontos = getProntosParaEnvio(reserva);

  const Ppres = getPanelPresentation();
  const guestMgmt =
    Ppres && typeof Ppres.presentGuestManagementEntry === "function"
      ? Ppres.presentGuestManagementEntry(hospedes.length)
      : {
          mode: hospedes.length <= 1 ? "add" : "manage",
          label: hospedes.length <= 1 ? "Adicionar acompanhante" : "Gerenciar hóspedes (" + hospedes.length + ")",
          showHeaderAdd: hospedes.length <= 1,
          showPerGuestManage: hospedes.length > 1,
        };
  const guestsHtml = hospedes
    .map((h, index) => {
      syncGuestOriginAndCollectionMode(h);
      const presented =
        Ppres && typeof Ppres.presentGuestCardState === "function"
          ? Ppres.presentGuestCardState(h)
          : null;
      const confirmed = h.statusOperacional === GUEST_STATUS.CONFIRMADO;
      const statusClass = guestStatusClass(h.statusOperacional);
      const cadastroOk = confirmed
        ? presented && presented.cadastroOkLabel
          ? presented.cadastroOkLabel
          : "Cadastro do hóspede: OK"
        : "";
      const statusLabelPending = confirmed ? "" : guestStatusLabel(h.statusOperacional);
      const origemLabel = getOrigemCadastroLabel(h.origemCadastro);
      const modoLabel = getModoColetaLabel(h.modoColetaFnrh);
      const operationalMsg = confirmed
        ? ""
        : presented && presented.pendencyText
          ? presented.pendencyText
          : getGuestOperationalMessage(h);
      const vehicleHtml =
        h.principal && reserva.veiculoPlaca && reserva.veiculoPlaca.trim()
          ? `<div class="guest-detail-vehicle">Veículo: ${escapeHtml(reserva.veiculoPlaca.trim())}${reserva.veiculoCor ? " • " + escapeHtml(reserva.veiculoCor.trim()) : ""}</div>`
          : "";
      const onlyConfirmarEnviado = h.statusOperacional === GUEST_STATUS.ENVIADO;
      const confirmarBtn =
        PAINEL_DATA_SOURCE !== PAINEL_DATA_SOURCE_BACKEND && onlyConfirmarEnviado
          ? `<button type="button" class="secondary-button guest-confirmar-fnrh-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Simular confirmação (demo)</button>`
          : "";
      const setPrincipalBtn = !h.principal
        ? `<button type="button" class="guest-link-btn guest-set-principal-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Definir como principal</button>`
        : "";
      const removeBtn = `<button type="button" class="guest-link-btn guest-remove-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Remover</button>`;
      const compositionActions = `<div class="guest-detail-composition">${setPrincipalBtn}${setPrincipalBtn ? " " : ""}${removeBtn}</div>`;

      const canalLabel = getCanalEnvioLabel(h.ultimoEnvioCanal || null);
      const enviadoEm = h.ultimoEnvioEm || null;
      const tentativas = h.tentativasEnvio != null ? h.tentativasEnvio : 0;
      const showSendNoise = !(presented && presented.showSendNoise === false) && !confirmed;
      const comunicacaoHtml = showSendNoise
        ? `<p class="guest-detail-comunicacao guest-detail-comunicacao--muted">Último resultado: ${escapeHtml(canalLabel)}${enviadoEm ? ` · ${escapeHtml(String(enviadoEm))}` : ""}${tentativas > 0 ? ` · ${tentativas} tentativa(s)` : ""}</p>`
        : "";
      const fnrhLinkApoioHtml = h.fnrhLink
        ? `<p class="guest-detail-fnrh-apoio"><a href="${escapeHtml(h.fnrhLink)}" target="_blank" rel="noopener" class="guest-fnrh-apoio-link">Abrir link FNRH</a></p>`
        : "";
      const metaDetalhesHtml =
        `<details class="guest-detail-meta-collapsible">` +
        `<summary class="guest-detail-meta-sum">Origem dos dados</summary>` +
        `<p class="guest-detail-origin-mode">${escapeHtml(origemLabel)} · ${escapeHtml(modoLabel)}</p>` +
        `${vehicleHtml}` +
        `${comunicacaoHtml}` +
        `${fnrhLinkApoioHtml}` +
        `</details>`;

      const nomeVal = escapeHtml((h.nome || "").trim());
      const emailVal = escapeHtml((h.email || "").trim());
      const waRaw = (h.whatsapp || "").trim();

      // Ações de composição ficam no bloco único da seção (evita duplicar "Gerenciar hóspedes").
      const maisOpcoesHtml = confirmarBtn
        ? `<div class="guest-detail-actions">${confirmarBtn}</div>`
        : "";
      const manageRowHtml = guestMgmt.showPerGuestManage
        ? `<div class="guest-manage-row" data-guest-manage="${index}">` +
          `<span class="guest-manage-name">${nomeVal || "Hóspede"}</span>` +
          compositionActions +
          `</div>`
        : "";
      const waDisplay = escapeHtml(
        presented && presented.whatsappDisplay
          ? presented.whatsappDisplay
          : Ppres && typeof Ppres.formatPhoneBrDisplay === "function"
            ? Ppres.formatPhoneBrDisplay(waRaw)
            : waRaw,
      );
      const readOnly = !!(presented && presented.preferReadOnly) || confirmed;
      const roleLine = h.principal
        ? '<p class="guest-detail-role">Hóspede principal</p>'
        : '<p class="guest-detail-role">Acompanhante</p>';
      const nameLine = `<p class="guest-detail-nome">${nomeVal || "—"}</p>`;
      const badgeLine = confirmed
        ? `<p class="guest-detail-badge-ok" role="status">${escapeHtml(cadastroOk)}</p>`
        : statusLabelPending
          ? `<p class="guest-detail-status ${statusClass}">${escapeHtml(statusLabelPending)}</p>`
          : "";
      const readBlock = `
          <dl class="guest-detail-readout">
            <div><dt>E-mail</dt><dd>${emailVal || "—"}</dd></div>
            <div><dt>WhatsApp</dt><dd>${waDisplay || "—"}</dd></div>
          </dl>
          <button type="button" class="secondary-button guest-edit-toggle-btn" data-guest-index="${index}">Editar dados</button>`;
      const editBlock = `
          <div class="guest-detail-edit-fields${readOnly ? " hidden" : ""}" data-guest-edit="${index}">
            <div class="guest-detail-contact-row guest-detail-name-edit">
              <label>Nome</label>
              <input type="text" class="guest-nome-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${nomeVal}" placeholder="Nome do hóspede" />
            </div>
            <div class="guest-detail-contact-row">
              <label>E-mail</label>
              <input type="text" class="guest-email-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${emailVal}" placeholder="email@exemplo.com" />
            </div>
            <div class="guest-detail-contact-row">
              <label>WhatsApp</label>
              <input type="text" class="guest-whatsapp-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml(waRaw)}" placeholder="11999990000" />
            </div>
          </div>`;

      return {
        cardHtml: `
        <div class="guest-detail-card${confirmed ? " guest-detail-card--ok" : ""}" data-guest-index="${index}">
          ${roleLine}
          ${nameLine}
          ${badgeLine}
          ${operationalMsg ? `<p class="guest-detail-pendency">${escapeHtml(operationalMsg)}</p>` : ""}
          ${readOnly ? readBlock : ""}
          ${editBlock}
          ${metaDetalhesHtml}
          ${maisOpcoesHtml}
        </div>
      `,
        manageRowHtml: manageRowHtml,
      };
    });
  const guestsCardsHtml = guestsHtml.map((g) => g.cardHtml).join("");
  const manageBlockHtml = guestMgmt.showPerGuestManage
    ? `<details class="guest-detail-extra-collapsible" id="detail-manage-guests">` +
      `<summary class="guest-detail-meta-sum">${escapeHtml(guestMgmt.label)}</summary>` +
      `<div class="guest-manage-list">${guestsHtml.map((g) => g.manageRowHtml).join("")}</div>` +
      `</details>`
    : "";

  let enviarAlertsOnly = "";
  let enviarLinksBtnHtml = "";
  const prontosCount = prontos.length;
  const prontosSimplificada = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.CONFIRMACAO_SIMPLIFICADA).length;
  const prontosCompleto = prontos.filter((h) => h.modoColetaFnrh === MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO).length;
  const naoIdentCount = naoIdentificados.length;
  const faltamCount = faltamContato.length;
  const enviadosCount = hospedes.filter((h) => h.statusOperacional === GUEST_STATUS.ENVIADO).length;
  const confirmadosCount = getFnrhConfirmadas(reserva);
  const totalH = hospedes.length;

  function getEnviarButtonLabel() {
    if (prontosSimplificada > 0 && prontosCompleto === 0) return `Enviar confirmação${prontosSimplificada > 1 ? "ões" : ""} simplificada${prontosSimplificada > 1 ? "s" : ""} (${prontosCount})`;
    if (prontosCompleto > 0 && prontosSimplificada === 0) return `Enviar FNRH${prontosCompleto > 1 ? "s" : ""} completa${prontosCompleto > 1 ? "s" : ""} (${prontosCount})`;
    return `Enviar confirmações e FNRHs (${prontosCount})`;
  }

  function getEnviarLinkTopoLabel() {
    if (prontosCount <= 1) return "Enviar link FNRH";
    return "Enviar link FNRH (" + prontosCount + ")";
  }

  if (naoIdentCount > 0) {
    enviarAlertsOnly = `<div class="detail-enviar-links-alert is-warn">Completar dados de ${naoIdentCount} hóspede(s). Preencha o nome (evite "Hospede 2", "Acompanhante", etc.).</div>`;
  } else if (faltamCount > 0 && prontosCount === 0) {
    enviarAlertsOnly = `<div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s). Preencha e-mail ou WhatsApp para enviar o link.</div>`;
  } else if (faltamCount > 0 && prontosCount > 0) {
    enviarAlertsOnly = `<div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s).</div>`;
    enviarLinksBtnHtml = `<button type="button" class="primary-button detail-top-acao-btn detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}" title="${escapeHtml(getEnviarButtonLabel())}">${escapeHtml(getEnviarLinkTopoLabel())}</button>`;
  } else if (prontosCount > 0) {
    enviarLinksBtnHtml = `<button type="button" class="primary-button detail-top-acao-btn detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}" title="${escapeHtml(getEnviarButtonLabel())}">${escapeHtml(getEnviarLinkTopoLabel())}</button>`;
  } else if (confirmadosCount === totalH) {
    // Evita repetir o mesmo estado do card Situação / próxima ação.
    enviarAlertsOnly = "";
  } else if (enviadosCount > 0) {
    enviarAlertsOnly = `<div class="detail-enviar-links-alert is-ok">Link(s) enviado(s) para ${enviadosCount} hóspede(s). Aguardando confirmação.</div>`;
  }

  const temBotaoSenhaBackend = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
  const labelCredenciais = labelAcaoCredenciaisPainel(reserva);
  const senhaJaEnviada = !!(
    reserva.senhaEnviadaEm || obterUltimosEventosSenha(reserva).lastOkSenha
  );
  const falhaCredencial = detectarUltimaFalhaCredencial(reserva);
  const enviarSenhaBtnHtml = temBotaoSenhaBackend
    ? `<button type="button" class="primary-button detail-top-acao-btn detail-enviar-senha-btn" id="detail-enviar-senha-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-acao-credencial="${senhaJaEnviada ? "reenviar" : "gerar_enviar"}">${escapeHtml(labelCredenciais)}</button>` +
      (senhaJaEnviada
        ? `<button type="button" class="secondary-button detail-top-acao-btn detail-gerar-nova-senha-btn" id="detail-gerar-nova-senha-btn" data-reserva-id="${escapeHtml(reserva.id)}">Gerar nova senha</button>`
        : "") +
      (falhaCredencial && !senhaJaEnviada
        ? `<button type="button" class="primary-button detail-top-acao-btn detail-retry-credenciais-btn" id="detail-retry-credenciais-btn" data-reserva-id="${escapeHtml(reserva.id)}">Tentar novamente</button>`
        : "")
    : falhaCredencial && !senhaJaEnviada
      ? `<button type="button" class="primary-button detail-top-acao-btn detail-retry-credenciais-btn" id="detail-retry-credenciais-btn" data-reserva-id="${escapeHtml(reserva.id)}">Tentar novamente</button>`
      : "";

  let reenviarFnrhTopoBtnHtml = "";
  const podeReenviarFnrhTopo =
    hasFnrhPendente(reserva) &&
    prontosCount === 0 &&
    hospedes.some((h) => h.statusOperacional === GUEST_STATUS.ENVIADO && hasContatoSuficiente(h));
  if (podeReenviarFnrhTopo) {
    reenviarFnrhTopoBtnHtml = `<button type="button" class="primary-button detail-top-acao-btn detail-reenviar-fnrh-topo-btn" id="detail-reenviar-fnrh-topo-btn" data-reserva-id="${escapeHtml(reserva.id)}">Reenviar link FNRH</button>`;
  }

  // Ações manuais de tolerância removidas neste PR (sem auditoria append-only).
  const toleranciaAcoesHtml = "";

  const ctxRecomendacao = buildRecomendacaoOperacionalCtx(reserva);
  const situacaoAcaoTopoHtml = buildSituacaoAcaoTopoHtml(
    reserva,
    ctxRecomendacao,
    enviarLinksBtnHtml,
    reenviarFnrhTopoBtnHtml,
    enviarSenhaBtnHtml,
    temBotaoSenhaBackend,
    enviarAlertsOnly,
  );

  const ttlockSectionHtml =
    PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && auth?.invokeLifecycleAction
      ? `<div class="reservation-detail-section reservation-detail-ttlock-card" id="detail-ttlock-wrap">
    <div class="ttlock-card-head">
      <p class="ttlock-card-title">Acesso TTLock</p>
      <p class="ttlock-card-desc">Credencial na fechadura, sincronização e ações operacionais.</p>
    </div>
    <div class="ttlock-card-body" id="detail-ttlock-section">
      <p class="reservation-detail-ttlock-loading" id="detail-ttlock-loading">Carregando status…</p>
      <div class="reservation-detail-ttlock-content hidden" id="detail-ttlock-content"></div>
    </div>
  </div>`
      : "";

  const simuladosBtns = [];
  if (PAINEL_DATA_SOURCE !== PAINEL_DATA_SOURCE_BACKEND) {
    if (reserva.pagamento !== "pago") {
      simuladosBtns.push(
        `<button type="button" class="secondary-button detail-simular-pagamento-btn" data-reserva-id="${escapeHtml(reserva.id)}">Simular pagamento (demo local)</button>`,
      );
    }
    if (hasFnrhPendente(reserva)) {
      simuladosBtns.push(
        `<button type="button" class="secondary-button detail-simular-fnrh-btn" data-reserva-id="${escapeHtml(reserva.id)}">Simular confirmação FNRH (demo)</button>`,
      );
    }
  }
  const eventosSimuladosHtml =
    simuladosBtns.length > 0
      ? `<details class="detail-collapsible detail-collapsible--demo">
    <summary class="detail-collapsible-summary">Ferramentas de teste (demo local)</summary>
    <div class="reservation-detail-section reservation-detail-eventos-simulados">
    <p class="reservation-detail-section-title reservation-detail-section-title--inner">Eventos simulados</p>
    <p class="reservation-detail-eventos-desc">Atalhos para teste sem integração completa. Com backend, pagamento e dados mestres da reserva vêm do PMS.</p>
    <div class="reservation-detail-eventos-btns">${simuladosBtns.join(" ")}</div>
  </div></details>`
      : "";

  const resumoComunicacao = formatResumoComunicacao(reserva);
  const localModeDetailHtml = buildLocalModeDetailHtml(reserva);

  // groupHistoricoEvents ordena por timestamp real (mais recente primeiro); não confiar na ordem do array.
  const historicoRaw = (reserva.historicoOperacional || []).slice();
  let historicoHtml = `<p class="timeline-empty">Nenhum evento registrado ainda.</p>`;
  if (historicoRaw.length > 0) {
    if (Ppres && typeof Ppres.groupHistoricoEvents === "function" && typeof Ppres.renderHistoricoGroupsHtml === "function") {
      historicoHtml = Ppres.renderHistoricoGroupsHtml(Ppres.groupHistoricoEvents(historicoRaw));
    } else {
      historicoHtml = historicoRaw
        .slice()
        .sort(function (a, b) {
          const ta = a && a.criadoEmIso ? new Date(a.criadoEmIso).getTime() : 0;
          const tb = b && b.criadoEmIso ? new Date(b.criadoEmIso).getTime() : 0;
          return tb - ta;
        })
        .map(
          (ev) =>
            `<div class="timeline-item"><span class="timeline-time">${escapeHtml(ev.em)}</span> — <span class="timeline-title">${escapeHtml(ev.titulo)}</span>${ev.detalhe ? `<br><span class="timeline-detalhe">${escapeHtml(ev.detalhe)}</span>` : ""}</div>`,
        )
        .join("");
    }
  }
  const timelineSectionHtml = `<details class="detail-collapsible detail-collapsible--timeline">
    <summary class="detail-collapsible-summary">Histórico da reserva</summary>
    <div class="reservation-detail-section reservation-detail-timeline reservation-detail-aux">
    <p class="reservation-detail-section-title reservation-detail-section-title--inner">O que aconteceu nesta reserva</p>
    <div class="timeline-list hist-list">${historicoHtml}</div>
  </div></details>`;

  const resumoComHtml = resumoComunicacao
    ? `<p class="hospedes-block-comunicacao-line" title="Resumo de canais de envio por hóspede">${escapeHtml(resumoComunicacao)}</p>`
    : "";
  const guestHeaderAction = guestMgmt.showHeaderAdd
    ? `<button type="button" class="secondary-button detail-add-guest-btn" id="detail-add-guest-btn" data-reserva-id="${escapeHtml(reserva.id)}">${escapeHtml(guestMgmt.label)}</button>`
    : "";

  detailBodyElement.innerHTML = `
    ${situacaoAcaoTopoHtml}
    ${toleranciaAcoesHtml}
    ${buildPagarmeDetailSectionHtml(reserva)}
    ${localModeDetailHtml}
    ${ttlockSectionHtml}
    ${eventosSimuladosHtml}
    <div class="reservation-detail-section reservation-detail-hospedes-block reservation-detail-hospedes-apoio" id="detail-hospedes-section">
      <div class="reservation-detail-section-header-row reservation-detail-hospedes-header">
        <p class="reservation-detail-section-title reservation-detail-hospedes-title">Hóspedes e contatos</p>
        ${guestHeaderAction}
      </div>
      ${resumoComHtml}
      ${guestsCardsHtml}
      ${manageBlockHtml}
    </div>
    ${timelineSectionHtml}
  `;

  bindDetailListeners(reserva);
}

function bindDetailListeners(reserva) {
  if (!(detailBodyElement instanceof HTMLElement)) return;

  const copyAccessButton = detailBodyElement.querySelector("#detail-copy-access-btn");
  copyAccessButton?.addEventListener("click", async () => {
    const statusElement = detailBodyElement.querySelector(
      "#detail-copy-access-status",
    );
    try {
      await copyTextToClipboard(buildLocalAccessClipboardText(reserva));
      if (statusElement) {
        statusElement.textContent =
          "Dados demonstrativos copiados. Nenhuma credencial real foi incluída.";
        statusElement.classList.remove("hidden", "is-error");
      }
    } catch (error) {
      if (statusElement) {
        statusElement.textContent =
          error instanceof Error ? error.message : "Não foi possível copiar.";
        statusElement.classList.remove("hidden");
        statusElement.classList.add("is-error");
      }
    }
  });

  detailBodyElement.querySelectorAll(".detail-recomendacao-cta-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      var kind = btn.getAttribute("data-recomendacao-cta") || "";
      executeRecomendacaoCta(reserva.id, kind);
    });
  });

  detailBodyElement.querySelectorAll(".guest-edit-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      var idx = btn.getAttribute("data-guest-index");
      var card = btn.closest(".guest-detail-card");
      if (!card) return;
      var edit = card.querySelector('.guest-detail-edit-fields[data-guest-edit="' + idx + '"]');
      var readout = card.querySelector(".guest-detail-readout");
      if (edit) edit.classList.remove("hidden");
      if (readout) readout.classList.add("hidden");
      btn.classList.add("hidden");
      var first = edit && edit.querySelector("input");
      if (first) first.focus();
    });
  });

  detailBodyElement.querySelectorAll(".guest-nome-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target;
      atualizarHospedeCampo(t.dataset.reservaId, t.dataset.guestIndex, "nome", t.value);
    });
  });

  detailBodyElement.querySelectorAll(".guest-email-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target;
      atualizarHospedeCampo(t.dataset.reservaId, t.dataset.guestIndex, "email", t.value);
    });
  });

  detailBodyElement.querySelectorAll(".guest-whatsapp-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target;
      atualizarHospedeCampo(t.dataset.reservaId, t.dataset.guestIndex, "whatsapp", t.value);
    });
  });

  detailBodyElement.querySelectorAll(".guest-confirmar-fnrh-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      const r = getReservaById(rid);
      const h = getHospede(r, idx);
      if (!r || !h) return;
      const confirmadasAntes = getFnrhConfirmadas(r);
      h.statusOperacional = GUEST_STATUS.CONFIRMADO;
      addHistoricoEvento(r, "fnrh_confirmada", "FNRH confirmada por " + (h.nome || "hóspede"), null);
      maybeRegistrarFnrhCompleta(r, confirmadasAntes);
      refresh();
    });
  });

  detailBodyElement.querySelectorAll(".guest-set-principal-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      definirPrincipal(rid, idx);
    });
  });

  detailBodyElement.querySelectorAll(".guest-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      removerHospede(rid, idx);
    });
  });

  const addGuestBtn = detailBodyElement.querySelector("#detail-add-guest-btn");
  if (addGuestBtn) {
    addGuestBtn.addEventListener("click", () => {
      const rid = addGuestBtn.dataset.reservaId;
      adicionarHospede(rid);
    });
  }

  detailBodyElement.querySelectorAll(".detail-simular-pagamento-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      acaoMarcarPagamentoOk(btn.dataset.reservaId);
    });
  });

  detailBodyElement.querySelectorAll(".detail-simular-fnrh-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      acaoAvançarFnrh(btn.dataset.reservaId);
    });
  });

  const reenviarFnrhTopoBtn = detailBodyElement.querySelector("#detail-reenviar-fnrh-topo-btn");
  if (reenviarFnrhTopoBtn) {
    reenviarFnrhTopoBtn.addEventListener("click", () => {
      const rid = reenviarFnrhTopoBtn.dataset.reservaId;
      if (rid) openTopContatoPanel(rid, "fnrh_reenviar");
    });
  }

  const enviarBtn = detailBodyElement.querySelector("#detail-enviar-links-btn");
  if (enviarBtn) {
    enviarBtn.addEventListener("click", () => {
      const rid = enviarBtn.dataset.reservaId;
      if (rid) openTopContatoPanel(rid, "fnrh");
    });
  }

  const enviarSenhaBtn = detailBodyElement.querySelector("#detail-enviar-senha-btn");
  if (enviarSenhaBtn) {
    enviarSenhaBtn.addEventListener("click", () => {
      const rid = enviarSenhaBtn.dataset.reservaId;
      if (!rid) return;
      const reservaAtual = getReservaById(rid);
      if (!reservaAtual) return;
      const acao =
        enviarSenhaBtn.dataset.acaoCredencial === "reenviar"
          ? "reenviar"
          : "gerar_enviar";
      const decisao = avaliarPoliticaCredenciaisReserva(reservaAtual, {
        origem: "manual",
        acaoSolicitada: acao,
      });
      if (decisao && decisao.exigeConfirmacaoManual) {
        if (!confirmarLiberacaoManualComPendencias(reservaAtual, decisao)) {
          return;
        }
        registrarLiberacaoManualComPendencias(
          reservaAtual,
          decisao.pendenciasAtuais || [],
        );
      }
      openTopContatoPanel(rid, acao === "reenviar" ? "senha_reenviar" : "senha");
    });
  }

  const pagarmeOpenBtn = detailBodyElement.querySelector("#detail-pagarme-open-btn");
  if (pagarmeOpenBtn) {
    pagarmeOpenBtn.addEventListener("click", function () {
      const rid = pagarmeOpenBtn.getAttribute("data-reserva-id");
      if (rid) openPagarmeCobrancaModal(rid);
    });
  }

  const gerarNovaSenhaBtn = detailBodyElement.querySelector(
    "#detail-gerar-nova-senha-btn",
  );
  if (gerarNovaSenhaBtn) {
    gerarNovaSenhaBtn.addEventListener("click", () => {
      const rid = gerarNovaSenhaBtn.dataset.reservaId;
      if (!rid) return;
      const reservaAtual = getReservaById(rid);
      if (!reservaAtual) return;
      const decisao = avaliarPoliticaCredenciaisReserva(reservaAtual, {
        origem: "manual",
        acaoSolicitada: "gerar_nova",
      });
      if (decisao && decisao.exigeConfirmacaoGerarNova) {
        const ok = window.confirm(
          "Gerar uma nova senha invalida a anterior para este hóspede.\n\nDeseja continuar?",
        );
        if (!ok) return;
      }
      addHistoricoEvento(
        reservaAtual,
        "gerar_nova_senha_solicitada",
        "Geração de nova senha solicitada",
        "Confirmação do operador registrada antes do envio.",
      );
      openTopContatoPanel(rid, "senha_nova");
    });
  }

  const retryCredenciaisBtn = detailBodyElement.querySelector(
    "#detail-retry-credenciais-btn",
  );
  if (retryCredenciaisBtn) {
    retryCredenciaisBtn.addEventListener("click", async () => {
      const rid = retryCredenciaisBtn.dataset.reservaId;
      if (!rid) return;
      retryCredenciaisBtn.disabled = true;
      const prev = retryCredenciaisBtn.textContent;
      retryCredenciaisBtn.textContent = "Tentando…";
      try {
        const result = await aplicarRetryCredenciaisNoPainel(rid);
        if (!result.ok) {
          alert(result.error || "Não foi possível concluir a nova tentativa.");
        }
      } finally {
        retryCredenciaisBtn.disabled = false;
        retryCredenciaisBtn.textContent = prev || "Tentar novamente";
      }
    });
  }

  const contatoConfirm = detailBodyElement.querySelector("#detail-top-contato-confirm");
  if (contatoConfirm) {
    contatoConfirm.addEventListener("click", () => {
      submitDetailTopContatoPanel();
    });
  }
  const contatoCancel = detailBodyElement.querySelector("#detail-top-contato-cancel");
  if (contatoCancel) {
    contatoCancel.addEventListener("click", () => {
      closeTopContatoPanel();
    });
  }
}

/** Mensagens do modal de senha: linguagem operacional, sem jargão de banco/API. */
function humanizarMensagemModalEnviarSenha(raw) {
  if (raw == null) return "Não foi possível concluir o envio. Tente novamente em instantes.";
  const t = String(raw).trim();
  if (!t) return "Não foi possível concluir o envio. Tente novamente em instantes.";
  const lower = t.toLowerCase();

  if (lower.includes("atualize yes-supabase-auth") || lower.includes("getedgefunctionfetchheaders")) {
    return "Não foi possível autenticar o envio. Atualize a página ou entre de novo no painel.";
  }
  if (lower === "não autenticado." || lower === "nao autenticado." || lower.includes("não autenticado")) {
    return "Sessão expirada ou indisponível. Entre novamente no painel e tente de novo.";
  }
  if (lower.includes("resend_api_key") || lower.includes("resend não configurado")) {
    return "Envio por e-mail não está disponível neste ambiente. Tente WhatsApp ou contate o suporte.";
  }

  if (lower.includes("reserva_id") && lower.includes("obrigat")) {
    return "Referência da reserva não reconhecida. Atualize a página e tente de novo.";
  }

  const cheiraTecnico =
    /status_provisionamento|operacional_|credencial_id|remote_keyboard|insert into|select \*|duplicate key|violates|constraint|postgres|internal server|yes-hotel-lifecycle|lifecycle_provision|unexpected token|syntax error|json\.parse|erro ao consultar credencial de acesso:/i.test(
      t,
    );

  if (cheiraTecnico) {
    if (lower.includes("revog")) {
      return "Credencial encerrada ou revogada. Não é possível enviar senha para esta reserva neste estado.";
    }
    if (lower.includes("consultar credencial")) {
      return "Não foi possível verificar o acesso desta reserva. Tente novamente em instantes.";
    }
    return "Não há nova senha para gerar neste momento, ou o envio não pôde ser concluído. Verifique se a senha já foi enviada, se o acesso já está ativo ou aguarde a sincronização com a fechadura.";
  }

  if (lower.includes("falha na chamada yes-hotel-lifecycle") || /\bhttp 5\d\d\b/i.test(t)) {
    return "O serviço de acesso não respondeu. Tente novamente em instantes.";
  }
  if (lower.includes("lifecycle sem passcode") || lower.includes("sem passcode")) {
    return "Ainda não há senha disponível para envio. Conclua a liberação de acesso no fluxo da reserva e tente de novo.";
  }
  if (lower.includes("falha no provisionamento") || lower.includes("provisionamento da senha")) {
    return "Não foi possível preparar a senha na fechadura. Verifique o TTLock e tente novamente em instantes.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower === "load failed") {
    return "Sem conexão com o servidor. Verifique a internet e tente novamente.";
  }

  return t;
}

/* ---------- Cobrança Pagar.me (Checkpoint 3 — UI operacional) ---------- */
let pagarmeModalReservaId = null;
let pagarmeModalBusy = false;

async function backendCobrancaPagarmeAdmin(body) {
  if (!isPagarmeUiEnabledInPainel()) {
    return {
      ok: false,
      httpStatus: 0,
      error: "pagarme_ui_desabilitada",
      message: "Cobrança Pagar.me não está habilitada neste ambiente.",
    };
  }
  const supabase = getSupabase();
  if (!supabase || !auth || typeof auth.getEdgeFunctionFetchHeaders !== "function") {
    return {
      ok: false,
      httpStatus: 0,
      error: "auth_indisponivel",
      message: "Autenticação indisponível para cobrança.",
    };
  }
  let headers;
  try {
    headers = await auth.getEdgeFunctionFetchHeaders();
  } catch (_e) {
    return {
      ok: false,
      httpStatus: 401,
      error: "unauthorized",
      message: "Sessão inválida ou expirada.",
    };
  }
  const base = (
    typeof supabase.supabaseUrl === "string" ? supabase.supabaseUrl : ""
  ).replace(/\/$/, "");
  if (!base) {
    return {
      ok: false,
      httpStatus: 0,
      error: "config_indisponivel",
      message: "URL do Supabase indisponível.",
    };
  }
  let res;
  try {
    res = await fetch(base + "/functions/v1/cobranca-pagarme-admin", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {}),
    });
  } catch (_err) {
    return {
      ok: false,
      httpStatus: 0,
      error: "rede",
      message: "Falha de rede ao chamar cobrança.",
      ambiguous: true,
    };
  }
  const data = await res.json().catch(function () {
    return {};
  });
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      error: data.error || "erro",
      message: data.message || "",
      details: data.details,
      ambiguous: res.status >= 500 || res.status === 502,
    };
  }
  return { ok: true, httpStatus: res.status, data: data };
}

function setPagarmeModalMsg(text, kind) {
  const el = document.getElementById("modal-pagarme-msg");
  if (!(el instanceof HTMLElement)) return;
  const t = String(text || "").trim();
  if (!t) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("is-error", "is-success", "is-warn");
    return;
  }
  el.textContent = t;
  el.classList.remove("hidden", "is-error", "is-success", "is-warn");
  if (kind === "error") el.classList.add("is-error");
  else if (kind === "success") el.classList.add("is-success");
  else if (kind === "warn") el.classList.add("is-warn");
}

function closePagarmeCobrancaModal() {
  const overlay = document.getElementById("modal-pagarme-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
  pagarmeModalReservaId = null;
  pagarmeModalBusy = false;
  setPagarmeModalMsg("", null);
}

function openPagarmeCobrancaModal(reservaId) {
  if (!isPagarmeUiEnabledInPainel()) return;
  const reserva = getReservaById(reservaId);
  if (!reserva) return;
  pagarmeModalReservaId = reservaId;
  renderPagarmeCobrancaModal(reserva);
  const overlay = document.getElementById("modal-pagarme-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
}

function renderPagarmeCobrancaModal(reserva) {
  const api = getPagarmePaymentUiApi();
  const payUi = resolvePaymentUiForReserva(reserva) || {};
  const titleEl = document.getElementById("modal-pagarme-title");
  const bodyEl = document.getElementById("modal-pagarme-body");
  if (!(bodyEl instanceof HTMLElement)) return;

  if (titleEl) {
    titleEl.textContent =
      payUi.kind === "classificar"
        ? "Classificar cobrança"
        : payUi.kind === "aguardando"
          ? "Aguardando pagamento"
          : payUi.kind === "pago_pagarme_hits_pendente"
            ? "Pago no Pagar.me"
            : payUi.kind === "revisao"
              ? "Revisão necessária"
              : payUi.kind === "comissionada"
                ? "Reserva comissionada"
                : "Cobrança";
  }

  const classifLabel =
    reserva.classificacaoComissionamento === "nao_comissionada"
      ? "Não comissionada"
      : reserva.classificacaoComissionamento === "comissionada"
        ? "Comissionada"
        : "Desconhecida";
  const hitsLabel = isPagamentoOk(reserva) ? "Pago" : "Pendente";
  const cob = payUi.cobranca || null;
  const statusPagarme = cob ? String(cob.status || "—") : "—";
  const valorFmt =
    cob && cob.valor_centavos != null && api
      ? api.formatCentavosToBRL(cob.valor_centavos)
      : "—";

  let actionsHtml = "";
  if (payUi.showClassificar) {
    actionsHtml +=
      '<div class="modal-pagarme-classificar">' +
      '<p class="modal-pagarme-hint">Escolha somente a classificação. A cobrança só fica disponível depois.</p>' +
      '<button type="button" class="op-btn op-btn--primary" id="modal-pagarme-classificar-nao" data-classif="nao_comissionada">Reserva não comissionada — cobrar hóspede</button>' +
      '<button type="button" class="op-btn op-btn--secondary" id="modal-pagarme-classificar-sim" data-classif="comissionada">Reserva comissionada — não cobrar hóspede</button>' +
      "</div>";
  }

  if (payUi.kind === "comissionada") {
    actionsHtml +=
      '<div class="modal-pagarme-alert modal-pagarme-alert--amber" role="status">' +
      escapeHtml(payUi.detalheTexto || "") +
      "</div>";
  }

  if (payUi.kind === "pago_pagarme_hits_pendente") {
    actionsHtml +=
      '<div class="modal-pagarme-alert modal-pagarme-alert--ok" role="status">' +
      "<strong>Pago no Pagar.me</strong><br>Regularização no HITS pendente." +
      "</div>";
  }

  if (payUi.kind === "revisao") {
    actionsHtml +=
      '<div class="modal-pagarme-alert modal-pagarme-alert--danger" role="status">' +
      escapeHtml(payUi.detalheTexto || "Revisão necessária.") +
      "</div>";
  }

  if (payUi.hintAnterior) {
    actionsHtml +=
      '<p class="modal-pagarme-hint-soft">' + escapeHtml(payUi.hintAnterior) + "</p>";
  }

  if (payUi.showValorInput && payUi.showGerarCartao) {
    actionsHtml +=
      '<div class="modal-pagarme-form">' +
      '<label for="modal-pagarme-valor">Valor a cobrar</label>' +
      '<input type="text" id="modal-pagarme-valor" inputmode="decimal" placeholder="R$ 0,00" autocomplete="off" />' +
      '<p class="modal-pagarme-hint">Somente cartão neste momento. Pix não está disponível.</p>' +
      '<button type="button" class="op-btn op-btn--primary" id="modal-pagarme-gerar-cartao">Gerar link de cartão</button>' +
      "</div>";
  }

  if (payUi.canOpenLink || payUi.canCopyLink) {
    actionsHtml +=
      '<div class="modal-pagarme-link-actions">' +
      (payUi.canOpenLink
        ? '<button type="button" class="op-btn op-btn--primary" id="modal-pagarme-abrir-link">Abrir link</button>'
        : "") +
      (payUi.canCopyLink
        ? '<button type="button" class="op-btn op-btn--secondary" id="modal-pagarme-copiar-link">Copiar link</button>'
        : "") +
      "</div>";
  } else if (cob) {
    const rawLink = String(cob.payment_link_url || cob.pagarme_payment_link_url || "").trim();
    if (
      rawLink &&
      api &&
      typeof api.isSafeHttpsPaymentLinkUrl === "function" &&
      !api.isSafeHttpsPaymentLinkUrl(rawLink)
    ) {
      actionsHtml +=
        '<p class="modal-pagarme-hint-soft">Link de pagamento inválido. Atualize os dados da cobrança.</p>';
    }
  }

  bodyEl.innerHTML =
    '<dl class="modal-pagarme-meta">' +
    "<div><dt>Reserva</dt><dd>" +
    escapeHtml(String(reserva.id || "").slice(0, 8)) +
    "…</dd></div>" +
    "<div><dt>Apartamento</dt><dd>" +
    escapeHtml(reserva.apartamento || "—") +
    "</dd></div>" +
    "<div><dt>Hóspede</dt><dd>" +
    escapeHtml(reserva.hospedePrincipal || "—") +
    "</dd></div>" +
    "<div><dt>Classificação</dt><dd>" +
    escapeHtml(classifLabel) +
    "</dd></div>" +
    "<div><dt>Status HITS</dt><dd>" +
    escapeHtml(hitsLabel) +
    "</dd></div>" +
    "<div><dt>Status Pagar.me</dt><dd>" +
    escapeHtml(statusPagarme) +
    (cob && cob.valor_centavos != null ? " · " + escapeHtml(valorFmt) : "") +
    "</dd></div>" +
    "</dl>" +
    actionsHtml;

  bodyEl.querySelectorAll("[data-classif]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const classif = btn.getAttribute("data-classif");
      if (classif) void submitPagarmeClassificar(reserva.id, classif);
    });
  });
  const valorInput = bodyEl.querySelector("#modal-pagarme-valor");
  if (valorInput instanceof HTMLInputElement) {
    valorInput.addEventListener("blur", function () {
      if (!api || typeof api.formatBRLInputDisplay !== "function") return;
      valorInput.value = api.formatBRLInputDisplay(valorInput.value);
    });
    valorInput.addEventListener("focus", function () {
      if (!api || typeof api.toBRLInputEditValue !== "function") return;
      valorInput.value = api.toBRLInputEditValue(valorInput.value);
    });
  }
  const gerarBtn = bodyEl.querySelector("#modal-pagarme-gerar-cartao");
  if (gerarBtn) {
    gerarBtn.addEventListener("click", function () {
      void submitPagarmeCriarCartao(reserva.id);
    });
  }
  const abrirBtn = bodyEl.querySelector("#modal-pagarme-abrir-link");
  if (abrirBtn && payUi.paymentLinkUrl) {
    abrirBtn.addEventListener("click", function () {
      const candidate = String(payUi.paymentLinkUrl || "");
      if (
        !api ||
        typeof api.isSafeHttpsPaymentLinkUrl !== "function" ||
        !api.isSafeHttpsPaymentLinkUrl(candidate)
      ) {
        setPagarmeModalMsg("Link de pagamento inválido. Atualize os dados da cobrança.", "error");
        return;
      }
      window.open(candidate, "_blank", "noopener,noreferrer");
    });
  }
  const copiarBtn = bodyEl.querySelector("#modal-pagarme-copiar-link");
  if (copiarBtn && payUi.paymentLinkUrl) {
    copiarBtn.addEventListener("click", async function () {
      const candidate = String(payUi.paymentLinkUrl || "");
      if (
        !api ||
        typeof api.isSafeHttpsPaymentLinkUrl !== "function" ||
        !api.isSafeHttpsPaymentLinkUrl(candidate)
      ) {
        setPagarmeModalMsg("Link de pagamento inválido. Atualize os dados da cobrança.", "error");
        return;
      }
      try {
        await copyTextToClipboard(candidate);
        setPagarmeModalMsg("Link copiado.", "success");
      } catch (_e) {
        setPagarmeModalMsg("Não foi possível copiar o link.", "error");
      }
    });
  }
}

async function submitPagarmeClassificar(reservaId, classificacao) {
  if (pagarmeModalBusy) return;
  pagarmeModalBusy = true;
  setPagarmeModalMsg("Salvando classificação…", null);
  const result = await backendCobrancaPagarmeAdmin({
    action: "classificar_comissionamento",
    reserva_id: reservaId,
    classificacao: classificacao,
  });
  pagarmeModalBusy = false;
  const api = getPagarmePaymentUiApi();
  if (!result.ok) {
    const mapped = api
      ? api.mapPagarmeAdminError({
          code: result.error,
          message: result.message,
          httpStatus: result.httpStatus,
        })
      : { title: result.message || "Falha", detail: "", ambiguous: !!result.ambiguous };
    setPagarmeModalMsg(mapped.title + (mapped.detail ? " " + mapped.detail : ""), "error");
    if (result.ambiguous) await refreshFromSource();
    return;
  }
  setPagarmeModalMsg("Classificação salva.", "success");
  await refreshFromSource();
  const updated = getReservaById(reservaId);
  if (updated) renderPagarmeCobrancaModal(updated);
}

async function submitPagarmeCriarCartao(reservaId) {
  if (pagarmeModalBusy) return;
  const api = getPagarmePaymentUiApi();
  const input = document.getElementById("modal-pagarme-valor");
  const raw = input instanceof HTMLInputElement ? input.value : "";
  const parsed = api ? api.parseBRLToCentavos(raw) : { ok: false, reason: "api" };
  if (!parsed.ok) {
    setPagarmeModalMsg("Informe um valor válido maior que zero (ex.: R$ 1.800,00).", "error");
    return;
  }
  pagarmeModalBusy = true;
  const gerarBtn = document.getElementById("modal-pagarme-gerar-cartao");
  if (gerarBtn instanceof HTMLButtonElement) {
    gerarBtn.disabled = true;
    gerarBtn.textContent = "Gerando…";
  }
  setPagarmeModalMsg("Gerando link…", null);
  const result = await backendCobrancaPagarmeAdmin({
    action: "criar",
    reserva_id: reservaId,
    metodo: "cartao",
    valor_centavos: parsed.centavos,
  });
  pagarmeModalBusy = false;
  if (gerarBtn instanceof HTMLButtonElement) {
    gerarBtn.disabled = false;
    gerarBtn.textContent = "Gerar link de cartão";
  }
  if (!result.ok) {
    const mapped = api
      ? api.mapPagarmeAdminError({
          code: result.error,
          message: result.message,
          httpStatus: result.httpStatus,
        })
      : { title: result.message || "Falha", detail: "", ambiguous: !!result.ambiguous };
    setPagarmeModalMsg(mapped.title + (mapped.detail ? " " + mapped.detail : ""), "error");
    await refreshFromSource();
    const updatedErr = getReservaById(reservaId);
    if (updatedErr) renderPagarmeCobrancaModal(updatedErr);
    return;
  }
  setPagarmeModalMsg("Link de pagamento criado.", "success");
  await refreshFromSource();
  const updated = getReservaById(reservaId);
  if (updated) renderPagarmeCobrancaModal(updated);
}

function buildPagarmeDetailSectionHtml(reserva) {
  if (!isPagarmeUiEnabledInPainel()) return "";
  const payUi = resolvePaymentUiForReserva(reserva);
  if (!payUi || payUi.kind === "none" || payUi.kind === "hidden_perfil") return "";
  if (isPagamentoOk(reserva) && payUi.kind === "none") return "";

  const mod =
    payUi.variant === "amber"
      ? "warn"
      : payUi.variant === "success"
        ? "success"
        : payUi.variant === "danger"
          ? "danger"
          : payUi.variant === "info"
            ? "info"
            : "warn";

  return (
    '<div class="reservation-detail-section reservation-detail-pagarme reservation-detail-recomendacao--' +
    escapeHtml(mod) +
    '" id="detail-pagarme-section">' +
    '<p class="reservation-detail-section-title">Cobrança Pagar.me</p>' +
    '<p class="reservation-detail-recomendacao-texto">' +
    escapeHtml(payUi.detalheTexto || payUi.listaLabel || "") +
    "</p>" +
    (payUi.hintAnterior
      ? '<p class="modal-pagarme-hint-soft">' + escapeHtml(payUi.hintAnterior) + "</p>"
      : "") +
    '<div class="reservation-detail-recomendacao-cta">' +
    '<button type="button" class="primary-button" id="detail-pagarme-open-btn" data-reserva-id="' +
    escapeHtml(String(reserva.id)) +
    '">' +
    escapeHtml(payUi.ctaLabel || "Ver cobrança") +
    "</button></div></div>"
  );
}

async function backendEnviarSenha(reservaId, email, whatsapp, options) {
  const opts = options && typeof options === "object" ? options : {};
  const manual = opts.manual !== false;
  const origem = opts.origem || (manual ? "manual" : "requisitos");
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Não autenticado." };
  if (!auth?.getEdgeFunctionFetchHeaders) {
    return { ok: false, error: "Atualize yes-supabase-auth.js (getEdgeFunctionFetchHeaders)." };
  }
  let headers;
  try {
    headers = await auth.getEdgeFunctionFetchHeaders();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  var baseUrlFn =
    typeof supabase.supabaseUrl === "string"
      ? supabase.supabaseUrl
      : window.YES_HOTEL_SUPABASE_CONFIG && window.YES_HOTEL_SUPABASE_CONFIG.url
        ? window.YES_HOTEL_SUPABASE_CONFIG.url
        : "";
  const functionsUrl = baseUrlFn.replace(/\/$/, "") + "/functions/v1";
  const res = await fetch(functionsUrl + "/send-senha", {
    method: "POST",
    headers,
    body: JSON.stringify({
      reserva_id: reservaId,
      manual: !!manual,
      origem,
      email: (email || "").trim() || undefined,
      whatsapp: (whatsapp || "").trim() || undefined,
      usuario_id: session?.user?.id || undefined,
      gerar_nova: !!opts.gerarNova,
      confirmacao_gerar_nova: !!opts.confirmacaoGerarNova,
      acao: opts.gerarNova ? "gerar_nova" : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.mensagem || data.error || res.statusText,
      detalhe: data.error || null,
    };
  }
  return { ok: true, data, skipped: !!data.skipped };
}

let _modalEnviarSenhaReservaId = null;
function openModalEnviarSenha(reservaId) {
  const r = getReservaById(reservaId);
  if (!r) return;
  _modalEnviarSenhaReservaId = reservaId;
  const principal = Array.isArray(r.hospedes) ? r.hospedes.find((h) => h.principal) : null;
  const email = principal?.email?.trim() || "";
  const whatsapp = principal?.whatsapp?.trim() || "";
  const overlay = document.getElementById("modal-enviar-senha-overlay");
  const form = document.getElementById("modal-enviar-senha-form");
  const msgEl = document.getElementById("modal-enviar-senha-msg");
  if (form) {
    form.querySelector("#modal-enviar-senha-email").value = email;
    form.querySelector("#modal-enviar-senha-whatsapp").value = whatsapp;
  }
  if (msgEl) {
    msgEl.classList.add("hidden");
    msgEl.classList.remove("is-success", "is-error");
    msgEl.textContent = "";
  }
  if (overlay) overlay.classList.remove("hidden");
}

function closeModalEnviarSenha() {
  _modalEnviarSenhaReservaId = null;
  const overlay = document.getElementById("modal-enviar-senha-overlay");
  if (overlay) overlay.classList.add("hidden");
}

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) return;
  if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.add("hidden");
  accessStateElement.classList.remove("hidden");
  accessStateElement.innerHTML = `
    <h2>${title}</h2>
    <p>${message}</p>
    <a class="primary-link" href="./usuarios-login-mvp.html">${actionLabel}</a>
  `;
}

/* ---------- Bindings / init ---------- */
async function initCheckinOperacional() {
  let currentUser;
  if (!auth || !auth.isConfigured()) {
    showAccessState(
      "Autenticacao indisponivel",
      auth?.getConfigError?.() || "Configuracao de autenticacao indisponivel.",
      "Ir para login",
    );
    return;
  }

  currentUser = await auth.getCurrentUser();

  if (!currentUser) {
    showAccessState(
      "Login necessario",
      "Entre com um usuario interno para acessar o painel de check-in operacional.",
      "Fazer login",
    );
    return;
  }

  if (currentUser.role === "cafe") {
    window.location.href = "./cafe-da-manha-mvp.html";
    return;
  }

  if (currentUser.role !== "admin" && currentUser.role !== "recepcao") {
    showAccessState(
      "Acesso nao permitido",
      "Seu perfil nao tem acesso a esta tela.",
      "Voltar para login",
    );
    return;
  }

  painelOperadorRole = String(currentUser.role || "").trim().toLowerCase();

  if (accessStateElement instanceof HTMLElement) accessStateElement.classList.add("hidden");
  if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.remove("hidden");

  if (
    sessionUserElement instanceof HTMLElement &&
    sessionUserNameElement instanceof HTMLElement &&
    sessionUserRoleElement instanceof HTMLElement
  ) {
    sessionUserNameElement.textContent = currentUser.name;
    sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
  }

  // Reservas manuais descontinuadas: HITS é a única fonte. Mantém o nó por contrato, sempre oculto.
  if (opImportLink instanceof HTMLElement) {
    opImportLink.classList.add("hidden");
  }

  reservas = await loadReservasOperacionaisFromProvider();
  invalidateArrivalsCache();
  await ensureArrivalsDataset();

  document.querySelectorAll(".op-view-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setPainelView(btn.getAttribute("data-op-view") || "reservas");
    });
  });
  document.querySelectorAll("[data-arrivals-filter]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      arrivalsFilter = btn.getAttribute("data-arrivals-filter") || "hoje";
      arrivalsPage = 0;
      document.querySelectorAll("[data-arrivals-filter]").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      renderChegadasPanel();
    });
  });
  document.querySelector("#op-chegadas-prev")?.addEventListener("click", function () {
    arrivalsPage = Math.max(0, arrivalsPage - 1);
    renderChegadasPanel();
  });
  document.querySelector("#op-chegadas-next")?.addEventListener("click", function () {
    arrivalsPage += 1;
    renderChegadasPanel();
  });
  opKpiOccupiedBtn?.addEventListener("click", openOccupiedDrawer);
  document.querySelector("#op-occupied-close")?.addEventListener("click", closeOccupiedDrawer);
  document.querySelector("#op-occupied-backdrop")?.addEventListener("click", closeOccupiedDrawer);

  if (opSearchInput instanceof HTMLInputElement) {
    opSearchInput.addEventListener("input", () => {
      buscaLista = opSearchInput.value;
      renderStatusTabs();
      renderOperacionalLista();
    });
  }
  if (opPeriodSelect instanceof HTMLSelectElement) {
    opPeriodSelect.addEventListener("change", () => {
      periodoAtivo = opPeriodSelect.value || "all";
      renderStatusTabs();
      renderOperacionalLista();
    });
  }
  if (opToolbarStatusSelect instanceof HTMLSelectElement) {
    opToolbarStatusSelect.addEventListener("change", () => {
      filtroAtivo = opToolbarStatusSelect.value || FILTER_ALL;
      renderStatusTabs();
      renderOperacionalLista();
    });
  }
  opRefreshBtn?.addEventListener("click", () => {
    refreshFromSource().catch(() => refresh());
  });

  // Apresentação: menu lateral em overlay no tablet/celular (padrão v0).
  function setSidebarOpen(open) {
    document.body.classList.toggle("op-sidebar-open", !!open);
    const toggle = document.querySelector("#op-menu-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  document.querySelector("#op-menu-toggle")?.addEventListener("click", () => {
    setSidebarOpen(true);
  });
  document.querySelector("#op-sidebar-close")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  document.querySelector("#op-sidebar-backdrop")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1024) setSidebarOpen(false);
    if (!detailReservaId) {
      detailPanelElement?.classList.remove("op-detail--open");
      detailBackdropElement?.classList.add("hidden");
      return;
    }
    detailPanelElement?.classList.add("op-detail--open");
    detailBackdropElement?.classList.remove("hidden");
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.body.classList.contains("op-sidebar-open")) {
      setSidebarOpen(false);
      return;
    }
    if (ev.key !== "Escape" || !detailReservaId) return;
    closeDetail();
  });

  refresh();

  const requestedReservationId =
    new URLSearchParams(window.location.search).get("reserva") ||
    new URLSearchParams(window.location.hash.replace(/^#/, "")).get("reserva");
  if (requestedReservationId && getReservaById(requestedReservationId)) {
    openDetail(requestedReservationId);
  }

  detailCloseButtonElement?.addEventListener("click", closeDetail);
  detailBackdropElement?.addEventListener("click", closeDetail);

  const modalEnviarSenhaCancel = document.getElementById("modal-enviar-senha-cancel");
  const modalEnviarSenhaForm = document.getElementById("modal-enviar-senha-form");
  const modalEnviarSenhaOverlay = document.getElementById("modal-enviar-senha-overlay");
  if (modalEnviarSenhaCancel) modalEnviarSenhaCancel.addEventListener("click", closeModalEnviarSenha);
  if (modalEnviarSenhaOverlay) {
    modalEnviarSenhaOverlay.addEventListener("click", (e) => {
      if (e.target === modalEnviarSenhaOverlay) closeModalEnviarSenha();
    });
  }

  const modalPagarmeClose = document.getElementById("modal-pagarme-close");
  const modalPagarmeOverlay = document.getElementById("modal-pagarme-overlay");
  if (modalPagarmeClose) modalPagarmeClose.addEventListener("click", closePagarmeCobrancaModal);
  if (modalPagarmeOverlay) {
    modalPagarmeOverlay.addEventListener("click", function (e) {
      if (e.target === modalPagarmeOverlay) closePagarmeCobrancaModal();
    });
  }

  if (modalEnviarSenhaForm) {
    modalEnviarSenhaForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reservaId = _modalEnviarSenhaReservaId;
      if (!reservaId) return;
      const email = (document.getElementById("modal-enviar-senha-email")?.value || "").trim();
      const whatsapp = (document.getElementById("modal-enviar-senha-whatsapp")?.value || "").trim();
      if (!email && !whatsapp) {
        const msgEl = document.getElementById("modal-enviar-senha-msg");
        if (msgEl) {
          msgEl.textContent = "Informe pelo menos um contato (e-mail ou WhatsApp).";
          msgEl.classList.remove("hidden", "is-success");
          msgEl.classList.add("is-error");
        }
        return;
      }
      const msgEl = document.getElementById("modal-enviar-senha-msg");
      const submitBtn = document.getElementById("modal-enviar-senha-submit");
      const labelEnviar = submitBtn ? submitBtn.textContent : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando…";
      }
      if (msgEl) {
        msgEl.classList.remove("is-success", "is-error");
        msgEl.classList.add("hidden");
        msgEl.textContent = "";
      }
      const result = await backendEnviarSenha(reservaId, email, whatsapp, {
        manual: true,
        origem: "manual",
      });
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = labelEnviar || "Gerar e enviar";
      }
      if (result.ok) {
        const okText = (result.data && result.data.mensagem) || "Operação concluída.";
        if (msgEl) {
          msgEl.textContent = okText;
          msgEl.classList.remove("hidden", "is-error");
          msgEl.classList.add("is-success");
        }
        await refreshFromSource();
        setTimeout(function () {
          closeModalEnviarSenha();
        }, 1400);
      } else {
        if (msgEl) {
          msgEl.textContent = humanizarMensagemModalEnviarSenha(result.error || "Não foi possível enviar a senha.");
          msgEl.classList.remove("hidden", "is-success");
          msgEl.classList.add("is-error");
        }
      }
    });
  }
}

logoutButtonElement?.addEventListener("click", async () => {
  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

initCheckinOperacional().catch((error) => {
  showAccessState(
    "Falha ao abrir a tela",
    error instanceof Error ? error.message : "Erro inesperado de autenticacao.",
    "Voltar para login",
  );
});
