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
const logoutButtonElement = document.querySelector("#logout-button");
const summaryCardsElement = document.querySelector("#summary-cards");
const filterBarElement = document.querySelector("#filter-bar");
const listaElement = document.querySelector("#lista-operacional");
const detailPanelElement = document.querySelector("#reservation-detail-panel");
const detailBackdropElement = document.querySelector("#reservation-detail-backdrop");
const detailTitleElement = document.querySelector("#reservation-detail-title");
const detailBodyElement = document.querySelector("#reservation-detail-body");
const detailCloseButtonElement = document.querySelector("#reservation-detail-close");

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
  reserva.historicoOperacional.push({
    tipo,
    titulo,
    detalhe: detalhe || null,
    em: formatHistoricoTimestamp(new Date()),
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

function getPrioridadeReserva(reserva) {
  if (isCheckinConcluido(reserva)) return PRIORIDADE_BAIXA;
  if (isProntaParaLiberarAcesso(reserva)) return PRIORIDADE_ALTA;
  if (reserva.acessoLiberado && !reserva.entrouNoApto) return PRIORIDADE_ALTA;
  if (isChegadaHoje(reserva)) return PRIORIDADE_ALTA;
  return PRIORIDADE_MEDIA;
}

function getPrioridadeLabel(prioridade) {
  const labels = { [PRIORIDADE_ALTA]: "Alta", [PRIORIDADE_MEDIA]: "Média", [PRIORIDADE_BAIXA]: "Baixa" };
  return labels[prioridade] || "";
}

function sortReservasPorPrioridade(lista) {
  const ordem = { [PRIORIDADE_ALTA]: 0, [PRIORIDADE_MEDIA]: 1, [PRIORIDADE_BAIXA]: 2 };
  const hoje = todayStr();
  return [...lista].sort((a, b) => {
    const pa = ordem[getPrioridadeReserva(a)] ?? 1;
    const pb = ordem[getPrioridadeReserva(b)] ?? 1;
    if (pa !== pb) return pa - pb;
    const aHoje = a.checkInPrevisto === hoje ? 1 : 0;
    const bHoje = b.checkInPrevisto === hoje ? 1 : 0;
    if (bHoje !== aHoje) return bHoje - aHoje;
    return (a.apartamento || "").localeCompare(b.apartamento || "");
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
  const d = row.criado_em ? new Date(row.criado_em) : null;
  return {
    tipo: row.tipo || "",
    titulo: row.titulo || "",
    detalhe: row.detalhe || null,
    em: d && !isNaN(d.getTime()) ? formatHistoricoTimestamp(d) : "",
  };
}

function mapDbHospedeToInternal(row) {
  if (!row) return null;
  return {
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
}

function mapDbReservaToInternal(r, hospedesRows, eventosRows) {
  const checkIn = r.check_in_previsto;
  const checkOut = r.check_out_previsto;
  const hospedes = (hospedesRows || []).map(mapDbHospedeToInternal).filter(Boolean);
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
    hospedes,
    historicoOperacional: historico,
  };
}

async function loadReservasFromBackend() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: reservasRows, error: errReservas } = await supabase
    .from("operacional_reservas")
    .select("*")
    .order("created_at", { ascending: true });
  if (errReservas || !Array.isArray(reservasRows)) return [];
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
    out.push(mapDbReservaToInternal(r, hospedesRows || [], eventosRows || []));
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
  if (!supabase) return false;
  const r = getReservaById(reservaId);
  if (r && Array.isArray(r.hospedes)) {
    const now = new Date().toISOString();
    for (const h of r.hospedes) {
      if (h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO && hasContatoSuficiente(h)) {
        await supabase
          .from("operacional_hospedes")
          .update({ status_operacional: GUEST_STATUS.ENVIADO, ultimo_envio_canal: "mock", ultimo_envio_em: now, tentativas_envio: (h.tentativasEnvio || 0) + 1 })
          .eq("id", h.id);
      }
    }
  }
  await backendAddEvento(reservaId, "envio_link", "Envio/reenvio de link", "Envio simulado (canal mock). Persistido para histórico.");
  return true;
}

async function backendLiberarAcesso(reservaId) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("operacional_reservas").update({ acesso_liberado: true }).eq("id", reservaId);
  if (error) return false;
  await backendAddEvento(reservaId, "acesso_liberado", "Acesso liberado", "Acesso ao apartamento liberado.");
  return true;
}

async function backendMarcarEntrada(reservaId) {
  const supabase = getSupabase();
  if (!supabase) return false;
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
  return isPagamentoOk(reserva) && isFnrhCompleta(reserva) && !reserva.acessoLiberado;
}

function isCheckinConcluido(reserva) {
  return reserva.acessoLiberado === true && reserva.entrouNoApto === true;
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
  if (reserva.acessoLiberado === true && reserva.entrouNoApto !== true) return ETAPA_FUNIL.ACESSO_LIBERADO;
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
  if (isProntaParaLiberarAcesso(reserva)) return "Pronta para liberar acesso";
  if (reserva.acessoLiberado && !reserva.entrouNoApto) return "Acesso liberado, aguardando entrada";
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
  if (reserva.acessoLiberado && !reserva.entrouNoApto) return "Aguardar entrada no apartamento";
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
  if (!reserva.acessoLiberado) {
    return { label: "Pronto para liberar acesso", type: "pronto-liberar" };
  }
  if (reserva.acessoLiberado && !reserva.entrouNoApto) {
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
    return lista.filter((r) => r.acessoLiberado === true);
  }
  if (filtroAtivo === FILTER_NAO_ENTROU) {
    return lista.filter((r) => r.acessoLiberado === true && r.entrouNoApto === false);
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
let detailReservaId = null;

/* ---------- Render ---------- */
function renderSummary(summary) {
  if (!(summaryCardsElement instanceof HTMLElement)) return;
  const cards = [
    { key: ETAPA_FUNIL.DADOS_PENDENTES, label: "Dados pendentes", value: summary.dadosPendentes, css: "is-danger" },
    { key: ETAPA_FUNIL.FNRH_EM_ANDAMENTO, label: "FNRH em andamento", value: summary.fnrhEmAndamento, css: "is-warn" },
    { key: ETAPA_FUNIL.PRONTA_LIBERAR, label: "Prontas para liberar acesso", value: summary.prontaLiberar, css: "is-info" },
    { key: ETAPA_FUNIL.ACESSO_LIBERADO, label: "Acesso liberado", value: summary.acessoLiberado, css: "is-info" },
    { key: ETAPA_FUNIL.CHECKIN_CONCLUIDO, label: "Check-in concluído", value: summary.checkinConcluido, css: "is-ok" },
  ];
  const funnelHtml = cards
    .map(
      (c) => {
        const filtro = MAPA_FILTRO_ETAPA[c.key];
        const active = filtroAtivo === filtro ? " summary-card-is-active" : "";
        return `<button type="button" class="summary-card summary-card-funnel ${c.css}${active}" data-etapa="${c.key}" aria-label="Filtrar: ${escapeHtml(c.label)}">
          <span class="summary-card-value">${c.value}</span>
          <span class="summary-card-label">${escapeHtml(c.label)}</span>
        </button>`;
      },
    )
    .join("");
  const chegadasHtml = `<div class="summary-card is-neutral summary-card-aux" title="Chegadas previstas hoje"><span class="summary-card-value">${summary.chegadasHoje}</span><span class="summary-card-label">Chegadas hoje</span></div>`;
  summaryCardsElement.innerHTML = `<div class="summary-cards-funnel">${funnelHtml}</div>${chegadasHtml}`;

  summaryCardsElement.querySelectorAll(".summary-card-funnel").forEach((btn) => {
    btn.addEventListener("click", () => {
      const etapa = btn.dataset.etapa;
      const filtro = MAPA_FILTRO_ETAPA[etapa];
      filtroAtivo = filtroAtivo === filtro ? FILTER_ALL : filtro;
      renderFilters();
      refresh();
    });
  });
}

function renderFilters() {
  if (!(filterBarElement instanceof HTMLElement)) return;
  const filters = [
    [FILTER_ALL, "Todos"],
    [FILTER_CHEGANDO_HOJE, "Chegando hoje"],
    [FILTER_PENDENTE_PAGAMENTO, "Pendente pagamento"],
    [FILTER_PENDENTE_FNRH, "Pendente FNRH"],
    [FILTER_ACESSO_LIBERADO, "Acesso liberado"],
    [FILTER_NAO_ENTROU, "Nao entrou"],
    [FILTER_ENTROU, "Entrou"],
    [FILTER_PRIORIDADE_ALTA, "Alta"],
    [FILTER_PRIORIDADE_MEDIA, "Média"],
    [FILTER_PRIORIDADE_BAIXA, "Baixa"],
  ];
  filterBarElement.innerHTML = filters
    .map(
      ([key, label]) =>
        `<button type="button" class="filter-btn ${filtroAtivo === key ? "is-active" : ""}" data-filter="${key}">${label}</button>`,
    )
    .join("");

  filterBarElement.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      filtroAtivo = btn.dataset.filter;
      renderFilters();
      refresh();
    });
  });
}

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
    const ok = await backendLiberarAcesso(id);
    if (ok) await refreshFromSource();
    return;
  }
  const r = getReservaById(id);
  if (r && r.pagamento === "pago" && !hasFnrhPendente(r)) {
    r.acessoLiberado = true;
    addHistoricoEvento(r, "acesso_liberado", "Acesso liberado", null);
  }
  refresh();
}

async function acaoConfirmarCheckin(id) {
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND) {
    const ok = await backendMarcarEntrada(id);
    if (ok) await refreshFromSource();
    return;
  }
  const r = getReservaById(id);
  if (r) {
    r.entrouNoApto = true;
    addHistoricoEvento(r, "entrada_apartamento", "Entrada no apartamento registrada", null);
  }
  refresh();
}

function primaryActionFor(reserva) {
  if (!reserva.acessoLiberado && isProntaParaLiberarAcesso(reserva)) {
    return { label: "Liberar acesso", action: "liberar_acesso", id: reserva.id };
  }
  if (reserva.acessoLiberado && !reserva.entrouNoApto) {
    return { label: "Marcar entrada no apartamento", action: "confirmar_checkin", id: reserva.id };
  }
  return null;
}

function renderList() {
  if (!(listaElement instanceof HTMLElement)) return;
  const filtradas = filtrarReservas(reservas, filtroAtivo);
  const ordenadas = sortReservasPorPrioridade(filtradas);

  listaElement.innerHTML = ordenadas
    .map((reserva) => {
      const status = derivarStatusOperacional(reserva);
      const primary = primaryActionFor(reserva);
      const prioridade = getPrioridadeReserva(reserva);
      const prioridadeLabel = getPrioridadeLabel(prioridade);
      const period = `${reserva.checkInPrevisto} a ${reserva.checkOutPrevisto}`;
      const fnrhStatus = getFnrhStatus(reserva);
      const hospedesTotal = getHospedesTotal(reserva);
      const veiculoLine =
        reserva.veiculoPlaca && reserva.veiculoPlaca.trim()
          ? `${(reserva.veiculoPlaca || "").trim()}${reserva.veiculoCor ? " • " + (reserva.veiculoCor || "").trim() : ""}`
          : "";

      const badgeClasses = [
        reserva.pagamento === "pago" ? "badge badge-pago" : "badge badge-pendente",
        "badge fnrh-badge " + fnrhStatus.class,
        reserva.acessoLiberado ? "badge badge-liberado" : "badge badge-nao-liberado",
        reserva.entrouNoApto ? "badge badge-entrou" : "badge badge-nao-entrou",
      ];
      const badgeLabels = [
        reserva.pagamento === "pago" ? "Pago" : "Pendente",
        fnrhStatus.label,
        reserva.acessoLiberado ? "Liberado" : "Nao liberado",
        reserva.entrouNoApto ? "Entrou" : "Nao entrou",
      ];

      let actionsHtml = "";
      if (primary) {
        actionsHtml = `<button type="button" class="primary-button" data-action="${primary.action}" data-id="${primary.id}">${primary.label}</button>`;
      } else {
        actionsHtml = '<span class="muted" style="font-size:13px;color:var(--muted)">Check-in concluído</span>';
      }

      const badgesHtml = badgeClasses
        .map((cls, i) => `<span class="${cls}">${badgeLabels[i]}</span>`)
        .join("");

      const metaParts = [`Hóspedes: ${hospedesTotal}`, fnrhStatus.label];
      if (veiculoLine) metaParts.push(`Veículo: ${veiculoLine}`);
      const metaHtml = `<div class="operational-card-meta">${metaParts.map((t) => `<span class="operational-card-meta-item">${t}</span>`).join("")}</div>`;

      const priorityBadgeHtml = `<span class="priority-badge priority-${prioridade}">${prioridadeLabel}</span>`;

      return `
        <article class="operational-card" data-id="${reserva.id}">
          <div class="operational-card-header">
            <span class="operational-card-apt">Apto ${reserva.apartamento}</span>
            <span class="operational-card-status status-${status.type}">${status.label}</span>
            ${priorityBadgeHtml}
          </div>
          <div class="operational-card-guest">${reserva.hospedePrincipal}</div>
          <div class="operational-card-period">${period}</div>
          <div class="operational-card-badges">${badgesHtml}</div>
          ${metaHtml}
          <div class="operational-card-actions">${actionsHtml}</div>
        </article>
      `;
    })
    .join("");

  listaElement.querySelectorAll("[data-action]").forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "marcar_pagamento") btn.addEventListener("click", () => acaoMarcarPagamentoOk(id));
    if (action === "avancar_fnrh") btn.addEventListener("click", () => acaoAvançarFnrh(id));
    if (action === "liberar_acesso") btn.addEventListener("click", () => acaoLiberarAcesso(id));
    if (action === "confirmar_checkin") btn.addEventListener("click", () => acaoConfirmarCheckin(id));
  });

  listaElement.querySelectorAll(".operational-card").forEach((card) => {
    const reservaId = card.dataset.id;
    if (!reservaId) return;
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetail(reservaId);
    });
  });
}

function refresh() {
  const summary = calcularResumo(reservas);
  renderSummary(summary);
  renderList();
  if (detailReservaId) {
    const r = getReservaById(detailReservaId);
    if (r) renderDetail(r);
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
  if (!loadingEl || !contentEl || !auth?.invokeLifecycleAction) return;
  try {
    const data = await auth.invokeLifecycleAction("sync_summary", { reservaId });
    const syncStatus = data.syncStatus ?? null;
    const statusClass = syncStatus === "ok" ? "sync-ok" : syncStatus === "pending" ? "sync-pending" : syncStatus === "partial" ? "sync-partial" : "sync-failed";
    const statusLabel = syncStatus === "ok" ? "Sync OK" : syncStatus === "pending" ? "Sync pendente" : syncStatus === "partial" ? "Sync parcial" : syncStatus === "failed" ? "Sync falhou" : "—";
    let html = `<p class="reservation-detail-ttlock-resumo"><span class="ttlock-sync-badge ${statusClass}">${escapeHtml(statusLabel)}</span> ${escapeHtml(data.resumo || "")}</p>`;
    if (data.lastSyncAttemptAt) {
      html += `<p class="reservation-detail-ttlock-meta">Última tentativa: ${escapeHtml(data.lastSyncAttemptAt)}</p>`;
    }
    if (data.lastSyncError) {
      html += `<p class="reservation-detail-ttlock-error">${escapeHtml(data.lastSyncError)}</p>`;
    }
    if (data.temCredencial && data.status !== "revogada") {
      html += `<div class="reservation-detail-ttlock-actions">
        <button type="button" class="secondary-button detail-ttlock-cancel-btn" data-reserva-id="${escapeHtml(reservaId)}">Cancelar reserva (revogar acesso TTLock)</button>
        <button type="button" class="secondary-button detail-ttlock-checkout-btn" data-reserva-id="${escapeHtml(reservaId)}">Checkout (revogar acesso TTLock)</button>
      </div>`;
    }
    if (data.temCredencial && data.status === "revogada" && data.syncStatus && data.syncStatus !== "ok") {
      html += `<div class="reservation-detail-ttlock-actions">
        <button type="button" class="secondary-button detail-ttlock-retry-btn" data-reserva-id="${escapeHtml(reservaId)}">Reprocessar sincronização</button>
      </div>`;
    }
    if (data.temCredencial === false) {
      html += `<p class="muted">Sem credencial operacional para esta reserva.</p>`;
    }
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
    contentEl.innerHTML = `<p class="reservation-detail-ttlock-error">Erro ao carregar status: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
    loadingEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
  }
}

async function acaoLifecycleCancel(reservaId) {
  if (!reservaId || !auth?.invokeLifecycleAction) return;
  if (!confirm("Revogar acesso TTLock desta reserva (cancelamento)? A ação é irreversível para a credencial.")) return;
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
  if (detailPanelElement) detailPanelElement.classList.remove("hidden");
  if (detailBackdropElement) detailBackdropElement.classList.remove("hidden");
  if (detailTitleElement) detailTitleElement.textContent = `Reserva Apto ${reserva.apartamento}`;
  renderDetail(reserva);
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && document.getElementById("detail-ttlock-section")) {
    loadAndRenderTtlockSection(reservaId);
  }
}

function closeDetail() {
  detailReservaId = null;
  if (detailPanelElement) detailPanelElement.classList.add("hidden");
  if (detailBackdropElement) detailBackdropElement.classList.add("hidden");
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
  const period = `${reserva.checkInPrevisto} a ${reserva.checkOutPrevisto}`;
  const hospedes = Array.isArray(reserva.hospedes) ? reserva.hospedes : [];
  const naoIdentificados = getNaoIdentificados(reserva);
  const faltamContato = getFaltamContato(reserva);
  const prontos = getProntosParaEnvio(reserva);
  const proximaAcao = getProximaAcaoReserva(reserva);

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
      const confirmarBtn = onlyConfirmarEnviado
        ? `<button type="button" class="secondary-button guest-confirmar-fnrh-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Simular confirmação</button>`
        : "";
      const setPrincipalBtn = !h.principal
        ? `<button type="button" class="guest-link-btn guest-set-principal-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Definir como principal</button>`
        : "";
      const removeBtn = `<button type="button" class="guest-link-btn guest-remove-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Remover</button>`;
      const compositionActions = `<div class="guest-detail-composition">${setPrincipalBtn}${setPrincipalBtn ? " " : ""}${removeBtn}</div>`;

      const canalLabel = getCanalEnvioLabel(h.ultimoEnvioCanal || null);
      const enviadoEm = h.ultimoEnvioEm || null;
      const tentativas = h.tentativasEnvio != null ? h.tentativasEnvio : 0;
      const comunicacaoHtml = `<p class="guest-detail-comunicacao">Último envio: ${escapeHtml(canalLabel)}${enviadoEm ? ` · Enviado em: ${escapeHtml(enviadoEm)}` : ""} · Tentativas: ${tentativas}</p>`;
      const reenviarBtn =
        h.statusOperacional === GUEST_STATUS.ENVIADO && hasContatoSuficiente(h)
          ? `<button type="button" class="guest-link-btn guest-reenviar-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Reenviar</button>`
          : "";

      return `
        <div class="guest-detail-card" data-guest-index="${index}">
          <div class="guest-detail-name-row">
            ${principalBadge}
            <span class="guest-detail-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          <p class="guest-detail-origin-mode">${escapeHtml(origemLabel)} · ${escapeHtml(modoLabel)}</p>
          <div class="guest-detail-contact-row guest-detail-name-edit">
            <label>Nome</label>
            <input type="text" class="guest-nome-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.nome || "").trim())}" placeholder="Nome do hóspede" />
          </div>
          <p class="guest-detail-pendency">${escapeHtml(operationalMsg)}</p>
          ${comunicacaoHtml}
          ${reenviarBtn ? `<div class="guest-detail-composition">${reenviarBtn}</div>` : ""}
          ${vehicleHtml}
          <div class="guest-detail-contact-row">
            <label>E-mail</label>
            <input type="text" class="guest-email-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.email || "").trim())}" placeholder="email@exemplo.com" />
          </div>
          <div class="guest-detail-contact-row">
            <label>WhatsApp</label>
            <input type="text" class="guest-whatsapp-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.whatsapp || "").trim())}" placeholder="11999990000" />
          </div>
          ${compositionActions}
          ${confirmarBtn ? `<div class="guest-detail-actions">${confirmarBtn}</div>` : ""}
        </div>
      `;
    })
    .join("");

  let enviarSection = "";
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

  if (naoIdentCount > 0) {
    enviarSection = `<div class="detail-enviar-links-alert is-warn">Completar dados de ${naoIdentCount} hóspede(s). Preencha o nome (evite "Hospede 2", "Acompanhante", etc.).</div>`;
  } else if (faltamCount > 0 && prontosCount === 0) {
    enviarSection = `<div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s). Preencha e-mail ou WhatsApp para enviar o link.</div>`;
  } else if (faltamCount > 0 && prontosCount > 0) {
    enviarSection = `
      <div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s).</div>
      <button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}">${escapeHtml(getEnviarButtonLabel())}</button>
    `;
  } else if (prontosCount > 0) {
    enviarSection = `<button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}">${escapeHtml(getEnviarButtonLabel())}</button>`;
  } else if (confirmadosCount === totalH) {
    enviarSection = '<div class="detail-enviar-links-alert is-ok">Todas as FNRHs estão confirmadas. Reserva pronta para liberar acesso.</div>';
  } else if (enviadosCount > 0) {
    enviarSection = `<div class="detail-enviar-links-alert is-ok">Link(s) enviado(s) para ${enviadosCount} hóspede(s). Aguardando confirmação.</div>`;
  }

  const statusOperacionalTexto = getStatusOperacionalReservaTexto(reserva);
  const bloqueios = getBloqueiosReserva(reserva);
  const statusReservaClass = bloqueios.length > 0 ? "is-blocked" : isCheckinConcluido(reserva) ? "is-ok" : "is-neutral";
  const statusReservaHtml = `<div class="reservation-detail-section reservation-detail-status-reserva reservation-detail-status-${statusReservaClass}">
    <p class="reservation-detail-section-title">Status da reserva</p>
    <p class="reservation-detail-status-reserva-text">${escapeHtml(statusOperacionalTexto)}</p>
  </div>`;

  const ttlockSectionHtml =
    PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_BACKEND && auth?.invokeLifecycleAction
      ? `<div class="reservation-detail-section reservation-detail-ttlock" id="detail-ttlock-section">
    <p class="reservation-detail-section-title">Acesso TTLock</p>
    <p class="reservation-detail-ttlock-loading" id="detail-ttlock-loading">Carregando...</p>
    <div class="reservation-detail-ttlock-content hidden" id="detail-ttlock-content"></div>
  </div>`
      : "";

  const proximaAcaoHtml =
    proximaAcao &&
    `<div class="reservation-detail-section reservation-detail-proxima-acao">
      <p class="reservation-detail-section-title">Próxima ação</p>
      <p class="reservation-detail-proxima-acao-label">${escapeHtml(proximaAcao)}</p>
    </div>`;

  const simuladosBtns = [];
  if (reserva.pagamento !== "pago") {
    simuladosBtns.push(`<button type="button" class="secondary-button detail-simular-pagamento-btn" data-reserva-id="${escapeHtml(reserva.id)}">Simular pagamento aprovado</button>`);
  }
  if (hasFnrhPendente(reserva)) {
    simuladosBtns.push(`<button type="button" class="secondary-button detail-simular-fnrh-btn" data-reserva-id="${escapeHtml(reserva.id)}">Simular confirmação de FNRH</button>`);
  }
  const eventosSimuladosHtml =
    simuladosBtns.length > 0
      ? `<div class="reservation-detail-section reservation-detail-eventos-simulados">
    <p class="reservation-detail-section-title">Eventos simulados</p>
    <p class="reservation-detail-eventos-desc">Simular retorno do sistema para testar o fluxo.</p>
    <div class="reservation-detail-eventos-btns">${simuladosBtns.join(" ")}</div>
  </div>`
      : "";

  const resumoComunicacao = formatResumoComunicacao(reserva);
  const comunicacaoReservaHtml = `<div class="reservation-detail-section reservation-detail-comunicacao">
    <p class="reservation-detail-section-title">Comunicação da reserva</p>
    <p class="reservation-detail-comunicacao-text">${escapeHtml(resumoComunicacao)}</p>
  </div>`;

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
  const timelineSectionHtml = `<div class="reservation-detail-section reservation-detail-timeline">
    <p class="reservation-detail-section-title">Linha do tempo da reserva</p>
    <div class="timeline-list">${historicoHtml}</div>
  </div>`;

  detailBodyElement.innerHTML = `
    ${statusReservaHtml}
    ${ttlockSectionHtml}
    ${proximaAcaoHtml || ""}
    ${eventosSimuladosHtml}
    <div class="reservation-detail-section">
      <p class="reservation-detail-section-title">Período</p>
      <p style="margin:0;font-size:14px;color:var(--text)">${escapeHtml(period)}</p>
    </div>
    <div class="reservation-detail-section">
      <div class="reservation-detail-section-header-row">
        <p class="reservation-detail-section-title">Hóspedes</p>
        <button type="button" class="guest-link-btn detail-add-guest-btn" id="detail-add-guest-btn" data-reserva-id="${escapeHtml(reserva.id)}">Adicionar hóspede</button>
      </div>
      ${guestsHtml}
    </div>
    ${comunicacaoReservaHtml}
    ${timelineSectionHtml}
    <div class="reservation-detail-section">
      ${enviarSection}
    </div>
  `;

  bindDetailListeners(reserva);
}

function bindDetailListeners(reserva) {
  if (!(detailBodyElement instanceof HTMLElement)) return;

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

  detailBodyElement.querySelectorAll(".guest-reenviar-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      reenviarHospede(rid, idx);
    });
  });
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

  const sessionActions = contentPanelElement?.querySelector(".session-actions");
  if (sessionActions && currentUser.role === "admin") {
    const importLink = document.createElement("a");
    importLink.className = "secondary-link";
    importLink.href = "./importar-reservas-mvp.html";
    importLink.textContent = "Importar reservas";
    sessionActions.insertBefore(importLink, sessionActions.firstChild);
  }

  reservas = await loadReservasOperacionaisFromProvider();
  renderFilters();
  refresh();

  detailCloseButtonElement?.addEventListener("click", closeDetail);
  detailBackdropElement?.addEventListener("click", closeDetail);
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
