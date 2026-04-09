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

/* ---------- Refs DOM ---------- */
const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const sessionUserElement = document.querySelector("#session-user");
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

/* ---------- Utils (data/hora, formatação) ---------- */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function formatHistoricoTimestamp(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
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

function compareApartamentoCrescente(a, b) {
  const sa = String(a.apartamento != null ? a.apartamento : "").trim();
  const sb = String(b.apartamento != null ? b.apartamento : "").trim();
  return sa.localeCompare(sb, "pt-BR", { numeric: true, sensitivity: "base" });
}

function sortReservasPorPrioridade(lista) {
  return [...lista].sort((a, b) => {
    const ra = getFilaOperacionalRank(a);
    const rb = getFilaOperacionalRank(b);
    if (ra !== rb) return ra - rb;
    const apt = compareApartamentoCrescente(a, b);
    if (apt !== 0) return apt;
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
  return {
    id,
    apartamento,
    hospedePrincipal,
    checkInPrevisto,
    checkOutPrevisto,
    pagamento,
    acessoLiberado,
    entrouNoApto,
    veiculoPlaca,
    veiculoCor,
    hospedes: [],
    historicoOperacional,
    fnrhStatusAgregado,
    fnrhCompletoEm,
    senhaEnviadaEm,
    comunicacaoEnviosOperacional,
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
    apartamento: reserva.apartamento,
    hospedePrincipal: reserva.hospedePrincipal,
    checkInPrevisto: reserva.checkInPrevisto,
    checkOutPrevisto: reserva.checkOutPrevisto,
    pagamento: reserva.pagamento,
    acessoLiberado: !!reserva.acessoLiberado,
    entrouNoApto: !!reserva.entrouNoApto,
    veiculoPlaca: reserva.veiculoPlaca || "",
    veiculoCor: reserva.veiculoCor || "",
    hospedes: (reserva.hospedes || []).map(serializarHospedeOperacional),
    historicoOperacional: Array.isArray(reserva.historicoOperacional) ? reserva.historicoOperacional : [],
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
    pagamento: r.pagamento === "pago" || r.paymentStatus === "paid" ? "pago" : "pendente",
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
/** Origem atual: "backend" (Supabase) | "mock-local" | "json-local" | "hits-adapter". */
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
  return {
    id: r.id,
    apartamento: (r.apartamento || "").trim(),
    hospedePrincipal: (r.hospede_principal || "").trim(),
    checkInPrevisto: checkIn ? (typeof checkIn === "string" ? checkIn.slice(0, 10) : checkIn) : "",
    checkOutPrevisto: checkOut ? (typeof checkOut === "string" ? checkOut.slice(0, 10) : checkOut) : "",
    pagamento: r.pagamento_status === "pago" ? "pago" : "pendente",
    acessoLiberado: !!r.acesso_liberado,
    entrouNoApto: !!r.entrou_no_apto,
    veiculoPlaca: (r.veiculo_placa || "").trim(),
    veiculoCor: (r.veiculo_cor || "").trim(),
    fnrhStatusAgregado: r.fnrh_status_agregado || "fnrh_pendente",
    fnrhCompletoEm: r.fnrh_completo_em || null,
    senhaEnviadaEm: r.senha_enviada_em || null,
    hospedes,
    historicoOperacional: historico,
    comunicacaoEnviosOperacional: mapDbComunicacaoEnviosToInternal(enviosRows || []),
  };
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
    const internal = mapDbReservaToInternal(r, hospedesRows || [], eventosRows || [], fnrhRows || [], enviosRows || []);
    const ridKey = String(r.id);
    internal.ttlockBloqueiaLiberado = ttlockCritico.has(ridKey);
    internal.ttlockPrincipalTodosProvisionados = principalTtlockOk.has(ridKey);
    out.push(internal);
  }
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

function loadReservasOperacionaisFromProvider() {
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
  if (reserva.pagamento === "pendente") {
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
    return lista.filter((r) => r.pagamento === "pendente");
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
    "pendente-fnrh": "op-badge op-badge--pend-fnrh",
    "pronto-liberar": "op-badge op-badge--pronto",
    "aguardando-chegada": "op-badge op-badge--aguardando",
    entrou: "op-badge op-badge--concluido",
    neutral: "op-badge op-badge--neutral",
  };
  return map[type] || "op-badge op-badge--neutral";
}

function isMobileDetailLayout() {
  return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 767px)").matches;
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
    if (ok) await refreshFromSource();
    return;
  }
  const r = getReservaById(id);
  if (r) {
    r.pagamento = "pago";
    addHistoricoEvento(r, "pagamento_aprovado", "Pagamento aprovado", null);
  }
  refresh();
}

async function acaoAvançarFnrh(id) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendConfirmarFnrh(id, null);
    if (ok) await refreshFromSource();
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

/** Texto curto + destaque (CTA no detalhe) para coluna Próxima ação — alinhado a derivarRecomendacaoOperacional. */
function listaProximaAcaoOperacional(reserva) {
  const ctx = buildRecomendacaoOperacionalCtx(reserva);
  const rec = derivarRecomendacaoOperacional(reserva, ctx);
  const raw = rec && rec.listaLabel != null ? String(rec.listaLabel).trim() : "";
  const texto = raw || "—";
  return { texto, destaque: !!(rec && rec.cta) };
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
        <td class="op-td op-td--next"><span class="${proxCls}">${escapeHtml(prox)}</span></td>
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
      return `<button type="button" class="op-mcard" data-id="${rid}">
        <div class="op-mcard__r1">
          <span class="op-mcard__apt">${escapeHtml(String(reserva.apartamento || "—"))}</span>
          <span class="${badgeCls}">${escapeHtml(status.label)}</span>
        </div>
        <div class="op-mcard__name" title="${mGuestTitle}">${escapeHtml(mGuest)}</div>
        <div class="op-mcard__meta">${ci} → ${co}</div>
        <div class="op-mcard__flux">${linhaFluxoResumo(reserva)}</div>
        <div class="op-mcard__row5">
          <span class="op-next-action${proxInfoM.destaque ? "" : " op-next-action--muted"}">${escapeHtml(prox)}</span>
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

  opMobileList?.querySelectorAll(".op-mcard").forEach((card) => {
    card.addEventListener("click", (e) => {
      const id = card.getAttribute("data-id");
      if (!id) return;
      if ((e.target).closest && (e.target).closest("[data-stop]")) {
        e.stopPropagation();
        openDetail(id);
        return;
      }
      openDetail(id);
    });
  });

  updateRowSelectionUi();
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
  const st = derivarStatusOperacional(reserva);
  const badgeHtml = `<span class="${badgeClassFromStatusType(st.type)}">${escapeHtml(st.label)}</span>`;
  if (opDetailApto instanceof HTMLElement) {
    opDetailApto.textContent = String(reserva.apartamento || "—");
  }
  if (opDetailBadgeWrap instanceof HTMLElement) {
    opDetailBadgeWrap.innerHTML = badgeHtml;
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

function refresh() {
  renderExcecoesOperacionais();
  renderStatusTabs();
  renderOperacionalLista();
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
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
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
    const syncStatus = data.syncStatus ?? null;
    const statusClass = syncStatus === "ok" ? "sync-ok" : syncStatus === "pending" ? "sync-pending" : syncStatus === "partial" ? "sync-partial" : "sync-failed";
    const statusLabel = syncStatus === "ok" ? "Sync OK" : syncStatus === "pending" ? "Sync pendente" : syncStatus === "partial" ? "Sync parcial" : syncStatus === "failed" ? "Sync falhou" : "—";
    let html = `<div class="ttlock-panel-stack">`;
    html += `<div class="ttlock-card-status-block ttlock-card-status-block--${statusClass}">`;
    html += `<p class="ttlock-card-status-label">Status TTLock</p>`;
    html += `<div class="ttlock-status-row"><span class="ttlock-sync-badge ${statusClass}" role="status">${escapeHtml(statusLabel)}</span></div>`;
    html += `<p class="reservation-detail-ttlock-resumo">${escapeHtml(data.resumo || "")}</p>`;
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
  if (isMobileDetailLayout()) {
    detailPanelElement?.classList.add("op-detail--open");
    detailBackdropElement?.classList.remove("hidden");
  }
  updateRowSelectionUi();
}

function closeDetail() {
  detailReservaId = null;
  syncDetailPanelChrome(null);
  if (isMobileDetailLayout()) {
    detailPanelElement?.classList.remove("op-detail--open");
    detailBackdropElement?.classList.add("hidden");
  }
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
  const parts = [];
  if (r.porWhatsapp > 0) parts.push(`${r.porWhatsapp} com envio por WhatsApp`);
  if (r.porEmail > 0) parts.push(`${r.porEmail} com envio por e-mail`);
  if (r.porAmbos > 0) parts.push(`${r.porAmbos} com envio por ambos`);
  if (r.naoEnviado > 0) parts.push(`${r.naoEnviado} ainda não enviado`);
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
function derivarExcecaoOperacionalReserva(reserva) {
  if (!reserva || isCheckinConcluido(reserva)) return null;

  var isBack = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
  var ob = obterUltimosEventosSenha(reserva);
  var lastOk = ob.lastOkSenha;
  var lastFail = ob.lastFailSenha;
  var failRecente = falhaSenhaMaisRecenteQueSucesso(lastOk, lastFail);

  var naoIdent = getNaoIdentificados(reserva).length;
  var faltam = getFaltamContato(reserva).length;
  var prontos = getProntosParaEnvio(reserva).length;

  if (lastFail && lastFail.p && lastFail.p.tipo_bloqueio === "credencial_revogada" && failRecente) {
    return {
      severidade: "critica",
      prioridade: 1,
      motivo: "Credencial revogada — envio de senha bloqueado",
      ctaHint: "Revisar TTLock",
      codigo: "credencial_revogada",
    };
  }

  if (
    isPagamentoOk(reserva) &&
    naoIdent === 0 &&
    prontos === 0 &&
    faltam > 0 &&
    !isFnrhCompleta(reserva)
  ) {
    return {
      severidade: "critica",
      prioridade: 2,
      motivo: "Sem e-mail/WhatsApp para hóspedes que ainda precisam de FNRH",
      ctaHint: "Corrigir contato",
      codigo: "sem_contato_fnrh",
    };
  }

  if (isPagamentoOk(reserva) && isChegadaHoje(reserva) && !isFnrhCompleta(reserva)) {
    return {
      severidade: "critica",
      prioridade: 3,
      motivo: "FNRH pendente com check-in hoje",
      ctaHint: "Reenviar FNRH",
      codigo: "checkin_hoje_fnrh",
    };
  }

  if (lastFail && lastFail.p && lastFail.p.tipo_bloqueio === "provisionamento" && failRecente) {
    return {
      severidade: "critica",
      prioridade: 4,
      motivo: "Falha recente ao provisionar senha (TTLock)",
      ctaHint: "Ver TTLock",
      codigo: "provisionamento_senha",
    };
  }

  if (
    isBack &&
    (reserva.fnrhStatusAgregado || "") === "fnrh_completo" &&
    acessoLiberadoEfetivo(reserva) &&
    !reserva.senhaEnviadaEm &&
    !lastOk
  ) {
    return {
      severidade: "critica",
      prioridade: 5,
      motivo: "FNRH válida no sistema, acesso liberado, senha não registrada como enviada",
      ctaHint: "Gerar e enviar senha",
      codigo: "senha_pendente",
    };
  }

  if (isProntaParaLiberarAcesso(reserva)) {
    return {
      severidade: "moderada",
      prioridade: 101,
      motivo: "Pronta para liberar acesso (FNRH e pagamento ok)",
      ctaHint: "Liberar acesso",
      codigo: "liberar_pendente",
    };
  }

  var fnrhA = agregarEnviosFnrhDoHistorico(reserva.historicoOperacional || []);
  if (isPagamentoOk(reserva) && fnrhA.reminderCount > 0 && !isFnrhCompleta(reserva)) {
    return {
      severidade: "moderada",
      prioridade: 102,
      motivo: "Houve lembrete(s) de FNRH e ainda há pendência",
      ctaHint: "Ver hóspedes",
      codigo: "fnrh_lembrete",
    };
  }

  if (isBack && (reserva.fnrhStatusAgregado || "") === "fnrh_completo" && !isFnrhCompleta(reserva)) {
    return {
      severidade: "moderada",
      prioridade: 103,
      motivo: "FNRH completa no cadastro digital e painel ainda não reflete tudo",
      ctaHint: "Conferir hóspedes",
      codigo: "inconsistencia_fnrh",
    };
  }

  if (ultimoEnvioFnrhTeveFalhaRegistrada(reserva) && !isFnrhCompleta(reserva)) {
    return {
      severidade: "moderada",
      prioridade: 104,
      motivo: "Último disparo de links FNRH registrado sem sucesso",
      ctaHint: "Reenviar FNRH",
      codigo: "fnrh_envio_falhou",
    };
  }

  if (
    failRecente &&
    lastFail &&
    lastFail.p &&
    (lastFail.p.tipo_bloqueio === "sem_contato" || lastFail.p.tipo_bloqueio === "falha_canais")
  ) {
    var mSenha = lastFail.p.motivo_bloqueio || "Falha no envio da senha";
    return {
      severidade: "moderada",
      prioridade: 105,
      motivo: mSenha.length > 90 ? mSenha.slice(0, 87) + "…" : mSenha,
      ctaHint: "Corrigir contatos",
      codigo: "senha_falha_envio",
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
        '<span class="operacional-excecao-apt">Apto <strong>' +
        escapeHtml(apt) +
        "</strong></span>" +
        '<span class="operacional-excecao-sep" aria-hidden="true"> — </span>' +
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
  excecoesStripElement.classList.remove("hidden");
  excecoesStripElement.innerHTML =
    '<div class="operacional-excecoes-inner">' +
    '<div class="operacional-excecoes-head">' +
    '<span class="operacional-excecoes-title">Exceções operacionais</span>' +
    '<span class="operacional-excecoes-counts">' +
    escapeHtml(String(crit)) +
    (crit === 1 ? " crítica" : " críticas") +
    " · " +
    escapeHtml(String(mod)) +
    (mod === 1 ? " moderada" : " moderadas") +
    "</span></div>" +
    '<ul class="operacional-excecoes-list">' +
    rows +
    "</ul>" +
    maisTxt +
    "</div>";

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
      cta: { kind: "ir_hospedes", label: "Ver hóspedes" },
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

  var precisaSenhaBackend =
    PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND &&
    temBotaoSenhaBackend &&
    (reserva.fnrhStatusAgregado || "") === "fnrh_completo" &&
    acessoLiberadoEfetivo(reserva) &&
    !reserva.senhaEnviadaEm &&
    !lastOk;

  if (precisaSenhaBackend) {
    return {
      variant: "info",
      texto: "FNRH validada no sistema e acesso liberado. A senha ainda não foi registrada como enviada.",
      listaLabel: "Gerar e enviar senha",
      cta: { kind: "gerar_senha", label: "Gerar e enviar senha" },
    };
  }

  if (failRecente && lastFail && lastFail.p) {
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
    var senhaOk = !!(reserva.senhaEnviadaEm || lastOk);
    if (senhaOk) {
      return {
        variant: "success",
        texto: "Senha já enviada com sucesso (registrada). Aguarde a chegada do hóspede.",
        listaLabel: "Aguardar chegada",
        cta: null,
      };
    }
    return {
      variant: "neutral",
      texto:
        "Acesso liberado. A senha pode sair automaticamente na janela definida; use o envio manual abaixo se fizer sentido.",
      listaLabel: temBotaoSenhaBackend ? "Gerar e enviar senha" : "Aguardar envio da senha",
      cta: temBotaoSenhaBackend ? { kind: "gerar_senha", label: "Gerar e enviar senha" } : null,
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
  } else if (temBotaoSenhaBackend && enviarSenhaBtnHtml) {
    primaryRow = enviarSenhaBtnHtml;
    usedSenhaAsPrimary = true;
  }

  var secondaryRow = "";
  if (temBotaoSenhaBackend && enviarSenhaBtnHtml && !usedSenhaAsPrimary) {
    secondaryRow =
      '<div class="detail-top-actions-secondary detail-top-actions-senha-apoio">' +
      '<button type="button" class="secondary-button detail-enviar-senha-btn detail-enviar-senha-btn--topo-apoio" id="detail-enviar-senha-btn" data-reserva-id="' +
      rid +
      '">Gerar e enviar senha</button></div>';
  }

  var situacaoLinha = escapeHtml(st.label);
  var acaoHint = rec.listaLabel && String(rec.listaLabel).trim() && rec.listaLabel !== "—" ? escapeHtml(rec.listaLabel) : "";

  var acaoBlock = "";
  if (primaryRow || secondaryRow) {
    acaoBlock =
      '<p class="detail-acao-kicker">Ação</p>' +
      '<div class="detail-top-actions">' +
      (primaryRow || "") +
      secondaryRow +
      "</div>";
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

function renderDetail(reserva) {
  if (!(detailBodyElement instanceof HTMLElement) || !reserva) return;
  const hospedes = Array.isArray(reserva.hospedes) ? reserva.hospedes : [];
  const naoIdentificados = getNaoIdentificados(reserva);
  const faltamContato = getFaltamContato(reserva);
  const prontos = getProntosParaEnvio(reserva);

  const guestsHtml = hospedes
    .map((h, index) => {
      syncGuestOriginAndCollectionMode(h);
      const statusClass = guestStatusClass(h.statusOperacional);
      const statusLabel = guestStatusLabel(h.statusOperacional);
      const origemLabel = getOrigemCadastroLabel(h.origemCadastro);
      const modoLabel = getModoColetaLabel(h.modoColetaFnrh);
      const operationalMsg = getGuestOperationalMessage(h);
      const principalBadge = h.principal ? '<span class="guest-detail-badge-principal">Principal</span>' : "";
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
      const comunicacaoHtml = `<p class="guest-detail-comunicacao guest-detail-comunicacao--muted">Último envio: ${escapeHtml(canalLabel)}${enviadoEm ? ` · ${escapeHtml(enviadoEm)}` : ""} · Tent.: ${tentativas}</p>`;
      const fnrhLinkApoioHtml = h.fnrhLink
        ? `<p class="guest-detail-fnrh-apoio"><a href="${escapeHtml(h.fnrhLink)}" target="_blank" rel="noopener" class="guest-fnrh-apoio-link">Abrir link FNRH</a></p>`
        : "";
      const metaDetalhesHtml =
        `<details class="guest-detail-meta-collapsible">` +
        `<summary class="guest-detail-meta-sum">Cadastro e origem</summary>` +
        `<p class="guest-detail-origin-mode">${escapeHtml(origemLabel)} · ${escapeHtml(modoLabel)}</p>` +
        `${vehicleHtml}` +
        `${comunicacaoHtml}` +
        `${fnrhLinkApoioHtml}` +
        `</details>`;
      const maisOpcoesHtml =
        `<details class="guest-detail-extra-collapsible">` +
        `<summary class="guest-detail-meta-sum">Composição da reserva</summary>` +
        `${compositionActions}` +
        `${confirmarBtn ? `<div class="guest-detail-actions">${confirmarBtn}</div>` : ""}` +
        `</details>`;

      return `
        <div class="guest-detail-card" data-guest-index="${index}">
          <div class="guest-detail-name-row">
            ${principalBadge}
            <span class="guest-detail-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          ${metaDetalhesHtml}
          <div class="guest-detail-contact-row guest-detail-name-edit">
            <label>Nome</label>
            <input type="text" class="guest-nome-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.nome || "").trim())}" placeholder="Nome do hóspede" />
          </div>
          <p class="guest-detail-pendency">${escapeHtml(operationalMsg)}</p>
          <div class="guest-detail-contact-row">
            <label>E-mail</label>
            <input type="text" class="guest-email-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.email || "").trim())}" placeholder="email@exemplo.com" />
          </div>
          <div class="guest-detail-contact-row">
            <label>WhatsApp</label>
            <input type="text" class="guest-whatsapp-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.whatsapp || "").trim())}" placeholder="11999990000" />
          </div>
          ${maisOpcoesHtml}
        </div>
      `;
    })
    .join("");

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
    enviarLinksBtnHtml = `<button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}" title="${escapeHtml(getEnviarButtonLabel())}">${escapeHtml(getEnviarLinkTopoLabel())}</button>`;
  } else if (prontosCount > 0) {
    enviarLinksBtnHtml = `<button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}" title="${escapeHtml(getEnviarButtonLabel())}">${escapeHtml(getEnviarLinkTopoLabel())}</button>`;
  } else if (confirmadosCount === totalH) {
    enviarAlertsOnly = acessoLiberadoEfetivo(reserva)
      ? '<div class="detail-enviar-links-alert is-ok">Todas as FNRHs confirmadas. Acesso liberado; aguardando chegada do hóspede.</div>'
      : '<div class="detail-enviar-links-alert is-ok">Todas as FNRHs estão confirmadas. Reserva pronta para liberar acesso.</div>';
  } else if (enviadosCount > 0) {
    enviarAlertsOnly = `<div class="detail-enviar-links-alert is-ok">Link(s) enviado(s) para ${enviadosCount} hóspede(s). Aguardando confirmação.</div>`;
  }

  const temBotaoSenhaBackend = PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND;
  const enviarSenhaBtnHtml = temBotaoSenhaBackend
    ? `<button type="button" class="primary-button detail-enviar-senha-btn" id="detail-enviar-senha-btn" data-reserva-id="${escapeHtml(reserva.id)}">Gerar e enviar senha</button>`
    : "";

  let reenviarFnrhTopoBtnHtml = "";
  const podeReenviarFnrhTopo =
    hasFnrhPendente(reserva) &&
    prontosCount === 0 &&
    hospedes.some((h) => h.statusOperacional === GUEST_STATUS.ENVIADO && hasContatoSuficiente(h));
  if (podeReenviarFnrhTopo) {
    reenviarFnrhTopoBtnHtml = `<button type="button" class="primary-button detail-reenviar-fnrh-topo-btn" id="detail-reenviar-fnrh-topo-btn" data-reserva-id="${escapeHtml(reserva.id)}">Reenviar link FNRH</button>`;
  }

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

  const historico = (reserva.historicoOperacional || []).slice().reverse();
  const historicoHtml =
    historico.length === 0
      ? `<p class="timeline-empty">Nenhum evento registrado ainda.</p>`
      : historico
          .map(
            (ev) =>
              `<div class="timeline-item"><span class="timeline-time">${escapeHtml(ev.em)}</span> — <span class="timeline-title">${escapeHtml(ev.titulo)}</span>${ev.detalhe ? `<br><span class="timeline-detalhe">${escapeHtml(ev.detalhe)}</span>` : ""}</div>`,
          )
          .join("");
  const timelineSectionHtml = `<details class="detail-collapsible detail-collapsible--timeline">
    <summary class="detail-collapsible-summary">Linha do tempo</summary>
    <div class="reservation-detail-section reservation-detail-timeline reservation-detail-aux">
    <p class="reservation-detail-section-title reservation-detail-section-title--inner">Eventos</p>
    <div class="timeline-list">${historicoHtml}</div>
  </div></details>`;

  detailBodyElement.innerHTML = `
    ${situacaoAcaoTopoHtml}
    ${ttlockSectionHtml}
    ${eventosSimuladosHtml}
    <div class="reservation-detail-section reservation-detail-hospedes-block reservation-detail-hospedes-apoio" id="detail-hospedes-section">
      <div class="reservation-detail-section-header-row reservation-detail-hospedes-header">
        <p class="reservation-detail-section-title reservation-detail-hospedes-title">Hóspedes e contatos</p>
        <button type="button" class="guest-link-btn guest-link-btn--subtle detail-add-guest-btn" id="detail-add-guest-btn" data-reserva-id="${escapeHtml(reserva.id)}">Adicionar</button>
      </div>
      <p class="hospedes-block-comunicacao-line" title="Resumo de canais de envio por hóspede">${escapeHtml(resumoComunicacao)}</p>
      ${guestsHtml}
    </div>
    ${timelineSectionHtml}
  `;

  bindDetailListeners(reserva);
}

function bindDetailListeners(reserva) {
  if (!(detailBodyElement instanceof HTMLElement)) return;

  detailBodyElement.querySelectorAll(".detail-recomendacao-cta-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      var kind = btn.getAttribute("data-recomendacao-cta") || "";
      var rid = reserva.id;
      if (kind === "enviar_fnrh") {
        var el = detailBodyElement.querySelector("#detail-enviar-links-btn");
        if (el) el.click();
        else {
          backendEnviarLinks(rid).then(function (ok) {
            if (ok) refreshFromSource();
          });
        }
      } else if (kind === "gerar_senha") {
        openModalEnviarSenha(rid);
      } else if (kind === "liberar_acesso") {
        acaoLiberarAcesso(rid);
      } else if (kind === "marcar_entrada") {
        acaoConfirmarCheckin(rid);
      } else if (kind === "simular_pagamento") {
        acaoMarcarPagamentoOk(rid);
      } else if (kind === "ir_hospedes") {
        var sec = document.getElementById("detail-hospedes-section");
        if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (kind === "ir_ttlock") {
        var tw = document.getElementById("detail-ttlock-wrap");
        if (tw) tw.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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
    reenviarFnrhTopoBtn.addEventListener("click", async () => {
      await reenviarLinksFnrhTopo(reenviarFnrhTopoBtn.dataset.reservaId);
    });
  }

  const enviarBtn = detailBodyElement.querySelector("#detail-enviar-links-btn");
  if (enviarBtn) {
    enviarBtn.addEventListener("click", async () => {
      const rid = enviarBtn.dataset.reservaId;
      const r = getReservaById(rid);
      if (!r || !Array.isArray(r.hospedes)) return;
      if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
        const ok = await backendEnviarLinks(rid);
        if (ok) await refreshFromSource();
        return;
      }
      let porEmail = 0, porWhatsapp = 0, porAmbos = 0;
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
    });
  }

  const enviarSenhaBtn = detailBodyElement.querySelector("#detail-enviar-senha-btn");
  if (enviarSenhaBtn) {
    enviarSenhaBtn.addEventListener("click", () => {
      const rid = enviarSenhaBtn.dataset.reservaId;
      if (rid) openModalEnviarSenha(rid);
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

async function backendEnviarSenha(reservaId, email, whatsapp) {
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
      manual: true,
      email: (email || "").trim() || undefined,
      whatsapp: (whatsapp || "").trim() || undefined,
      usuario_id: session?.user?.id || undefined,
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
  return { ok: true, data };
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
  if (!auth || !auth.isConfigured()) {
    showAccessState(
      "Autenticacao indisponivel",
      auth?.getConfigError?.() || "Configuracao de autenticacao indisponivel.",
      "Ir para login",
    );
    return;
  }

  const currentUser = await auth.getCurrentUser();

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

  if (accessStateElement instanceof HTMLElement) accessStateElement.classList.add("hidden");
  if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.remove("hidden");

  if (sessionUserElement instanceof HTMLElement) {
    sessionUserElement.textContent =
      `${currentUser.name} | ${auth.getRoleLabel(currentUser.role)} | sessao de ${auth.getSessionDurationHours()} horas`;
  }

  if (opImportLink instanceof HTMLElement) {
    opImportLink.classList.toggle("hidden", currentUser.role !== "admin");
  }

  reservas = await loadReservasOperacionaisFromProvider();

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

  window.addEventListener("resize", () => {
    if (!detailReservaId) {
      if (!isMobileDetailLayout()) {
        detailPanelElement?.classList.remove("op-detail--open");
        detailBackdropElement?.classList.add("hidden");
      }
      return;
    }
    if (isMobileDetailLayout()) {
      detailPanelElement?.classList.add("op-detail--open");
      detailBackdropElement?.classList.remove("hidden");
    } else {
      detailPanelElement?.classList.remove("op-detail--open");
      detailBackdropElement?.classList.add("hidden");
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !detailReservaId) return;
    if (isMobileDetailLayout()) closeDetail();
  });

  refresh();

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
      const result = await backendEnviarSenha(reservaId, email, whatsapp);
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
