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

function ensureHospedeDefaults(payload) {
  const id = payload && payload.id != null ? sanitizeString(payload.id) : null;
  const nome = sanitizeString(payload && payload.nome);
  const principal = !!(payload && payload.principal);
  const email = sanitizeString(payload && payload.email);
  const whatsapp = sanitizeString(payload && payload.whatsapp);
  const statusOperacional =
    payload && payload.statusOperacional && Object.values(GUEST_STATUS).includes(payload.statusOperacional)
      ? payload.statusOperacional
      : GUEST_STATUS.NAO_IDENTIFICADO;
  const origemCadastro =
    payload && payload.origemCadastro && Object.values(ORIGEM_CADASTRO).includes(payload.origemCadastro)
      ? payload.origemCadastro
      : ORIGEM_CADASTRO.NOVO;
  const modoColetaFnrh =
    payload && payload.modoColetaFnrh && Object.values(MODO_COLETA_FNRH).includes(payload.modoColetaFnrh)
      ? payload.modoColetaFnrh
      : MODO_COLETA_FNRH.PREENCHIMENTO_COMPLETO;
  return {
    id,
    nome,
    principal,
    email,
    whatsapp,
    statusOperacional,
    origemCadastro,
    modoColetaFnrh,
    ultimoEnvioCanal: payload && payload.ultimoEnvioCanal != null ? payload.ultimoEnvioCanal : null,
    ultimoEnvioEm: payload && payload.ultimoEnvioEm != null ? payload.ultimoEnvioEm : null,
    tentativasEnvio: payload && payload.tentativasEnvio != null ? Number(payload.tentativasEnvio) : 0,
  };
}

function ensureReservaDefaults(payload) {
  const id = payload && payload.id != null ? sanitizeString(String(payload.id)) : "";
  const apartamento = sanitizeString(payload && (payload.apartamento ?? payload.room_number ?? payload.room)) || "";
  const hospedePrincipal = sanitizeString(payload && payload.hospedePrincipal) || "";
  const checkInPrevisto = sanitizeString(payload && (payload.checkInPrevisto ?? payload.check_in ?? payload.checkIn)) || "";
  const checkOutPrevisto = sanitizeString(payload && (payload.checkOutPrevisto ?? payload.check_out ?? payload.checkOut)) || "";
  const pagamento = payload && payload.pagamento === "pago" ? "pago" : "pendente";
  const acessoLiberado = !!(payload && payload.acessoLiberado);
  const entrouNoApto = !!(payload && payload.entrouNoApto);
  const veiculoPlaca = sanitizeString(payload && payload.veiculoPlaca) || "";
  const veiculoCor = sanitizeString(payload && payload.veiculoCor) || "";
  const historicoOperacional = Array.isArray(payload && payload.historicoOperacional) ? payload.historicoOperacional : [];
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
  const base = ensureHospedeDefaults(payload);
  if (!base.id) base.id = createHospedeId(reservaId, index);
  return base;
}

function normalizarReservaExterna(payload) {
  const reserva = ensureReservaDefaults(payload);
  const rawGuests = Array.isArray(payload && payload.hospedes) ? payload.hospedes : Array.isArray(payload && payload.guests) ? payload.guests : [];
  reserva.hospedes = rawGuests.map((g, i) => normalizarHospedeExterno(g, reserva.id, i + 1));
  if (!reserva.hospedePrincipal && reserva.hospedes.length > 0) {
    const principal = reserva.hospedes.find((h) => h.principal) || reserva.hospedes[0];
    reserva.hospedePrincipal = principal.nome || "";
  }
  return reserva;
}

function normalizarListaReservasExternas(payloads) {
  if (!Array.isArray(payloads)) return [];
  return payloads.map((p) => normalizarReservaExterna(p));
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

/* ---------- Provider de dados / origem do painel ---------- */
const PAINEL_DATA_SOURCE_MOCK_LOCAL = "mock-local";
const PAINEL_DATA_SOURCE_JSON_LOCAL = "json-local";
/** Origem atual: "mock-local" (embutido) ou "json-local" (arquivo reservas-operacionais.json). */
const PAINEL_DATA_SOURCE = PAINEL_DATA_SOURCE_MOCK_LOCAL;
const PAINEL_JSON_LOCAL_URL = "./reservas-operacionais.json";

function getMockReservasExternas() {
  return mockReservasExternasRaw;
}

function loadReservasOperacionais() {
  const payloads = getMockReservasExternas();
  return normalizarListaReservasExternas(payloads);
}

function loadReservasOperacionaisFromProvider() {
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
  if (PAINEL_DATA_SOURCE === PAINEL_DATA_SOURCE_JSON_LOCAL) {
    return { type: PAINEL_DATA_SOURCE_JSON_LOCAL, description: "JSON local (reservas-operacionais.json)" };
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
function atualizarHospedeCampo(reservaId, guestIndex, campo, valor) {
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
  refresh();
}

function acaoMarcarPagamentoOk(id) {
  const r = getReservaById(id);
  if (r) {
    r.pagamento = "pago";
    addHistoricoEvento(r, "pagamento_aprovado", "Pagamento aprovado", null);
  }
  refresh();
}

function acaoAvançarFnrh(id) {
  const r = getReservaById(id);
  if (!r) return;
  const antes = getFnrhConfirmadas(r);
  if (registrarProximaFnrh(r)) {
    addHistoricoEvento(r, "fnrh_confirmada", "FNRH confirmada (próxima pendente)", null);
    maybeRegistrarFnrhCompleta(r, antes);
  }
  refresh();
}

function acaoLiberarAcesso(id) {
  const r = getReservaById(id);
  if (r && r.pagamento === "pago" && !hasFnrhPendente(r)) {
    r.acessoLiberado = true;
    addHistoricoEvento(r, "acesso_liberado", "Acesso liberado", null);
  }
  refresh();
}

function acaoConfirmarCheckin(id) {
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

function renderAll() {
  refresh();
}

function escapeHtml(s) {
  if (s == null || s === "") return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function openDetail(reservaId) {
  const reserva = getReservaById(reservaId);
  if (!reserva) return;
  detailReservaId = reservaId;
  if (detailPanelElement) detailPanelElement.classList.remove("hidden");
  if (detailBackdropElement) detailBackdropElement.classList.remove("hidden");
  if (detailTitleElement) detailTitleElement.textContent = `Reserva Apto ${reserva.apartamento}`;
  renderDetail(reserva);
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

function reenviarHospede(reservaId, guestIndex) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
  if (h.statusOperacional !== GUEST_STATUS.ENVIADO || !hasContatoSuficiente(h)) return;
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

function adicionarHospede(reservaId) {
  const r = getReservaById(reservaId);
  if (!r || !Array.isArray(r.hospedes)) return;
  r.hospedes.push(createNovoHospede(r));
  addHistoricoEvento(r, "hospede_adicionado", "Hóspede adicionado à reserva", null);
  refresh();
}

function removerHospede(reservaId, guestIndex) {
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
  const nomeRemovido = h.nome || "Hóspede";
  r.hospedes.splice(guestIndex, 1);
  addHistoricoEvento(r, "hospede_removido", "Hóspede removido da reserva", nomeRemovido);
  refresh();
}

function definirPrincipal(reservaId, guestIndex) {
  const r = getReservaById(reservaId);
  const h = getHospede(r, guestIndex);
  if (!r || !h) return;
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
    enviarBtn.addEventListener("click", () => {
      const rid = enviarBtn.dataset.reservaId;
      const r = getReservaById(rid);
      if (!r || !Array.isArray(r.hospedes)) return;
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
