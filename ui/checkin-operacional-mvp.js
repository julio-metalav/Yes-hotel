const auth = window.YesHotelAuthApp;

const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const sessionUserElement = document.querySelector("#session-user");
const logoutButtonElement = document.querySelector("#logout-button");
const summaryCardsElement = document.querySelector("#summary-cards");
const filterBarElement = document.querySelector("#filter-bar");
const listaElement = document.querySelector("#lista-operacional");

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const FILTER_ALL = "all";
const FILTER_CHEGANDO_HOJE = "chegando_hoje";
const FILTER_PENDENTE_PAGAMENTO = "pendente_pagamento";
const FILTER_PENDENTE_FNRH = "pendente_fnrh";
const FILTER_ACESSO_LIBERADO = "acesso_liberado";
const FILTER_NAO_ENTROU = "nao_entrou";
const FILTER_ENTROU = "entrou";

let reservas = [
  {
    id: "1",
    apartamento: "12",
    hospedePrincipal: "Julio Cesar",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    fnrh: "pendente",
    acessoLiberado: false,
    entrouNoApto: false,
  },
  {
    id: "2",
    apartamento: "18",
    hospedePrincipal: "Sandra Maria",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pendente",
    fnrh: "pendente",
    acessoLiberado: false,
    entrouNoApto: false,
  },
  {
    id: "3",
    apartamento: "24",
    hospedePrincipal: "Joao Pedro",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    fnrh: "preenchido",
    acessoLiberado: true,
    entrouNoApto: true,
  },
  {
    id: "4",
    apartamento: "07",
    hospedePrincipal: "Ana Souza",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    fnrh: "pendente",
    acessoLiberado: false,
    entrouNoApto: false,
  },
  {
    id: "5",
    apartamento: "31",
    hospedePrincipal: "Carlos Mendes",
    checkInPrevisto: todayStr(),
    checkOutPrevisto: todayStr(),
    pagamento: "pago",
    fnrh: "preenchido",
    acessoLiberado: true,
    entrouNoApto: false,
  },
];

function derivarStatusOperacional(reserva) {
  if (reserva.pagamento === "pendente") {
    return { label: "Pendente pagamento", type: "pendente-pagamento" };
  }
  if (reserva.fnrh === "pendente") {
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
    return lista.filter((r) => r.fnrh === "pendente");
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
  return lista;
}

function calcularResumo(lista) {
  const hoje = todayStr();
  return {
    chegadasHoje: lista.filter((r) => r.checkInPrevisto === hoje).length,
    pendentesPagamento: lista.filter((r) => r.pagamento === "pendente").length,
    pendentesFnrh: lista.filter((r) => r.fnrh === "pendente").length,
    acessosLiberados: lista.filter((r) => r.acessoLiberado === true).length,
    aindaNaoEntraram: lista.filter((r) => r.acessoLiberado === true && r.entrouNoApto === false).length,
    jaEntraram: lista.filter((r) => r.entrouNoApto === true).length,
  };
}

function renderSummary(summary) {
  if (!(summaryCardsElement instanceof HTMLElement)) return;
  summaryCardsElement.innerHTML = `
    <div class="summary-card is-neutral"><span class="summary-card-value">${summary.chegadasHoje}</span><span class="summary-card-label">Chegadas hoje</span></div>
    <div class="summary-card is-danger"><span class="summary-card-value">${summary.pendentesPagamento}</span><span class="summary-card-label">Pend. pagamento</span></div>
    <div class="summary-card is-warn"><span class="summary-card-value">${summary.pendentesFnrh}</span><span class="summary-card-label">Pend. FNRH</span></div>
    <div class="summary-card is-info"><span class="summary-card-value">${summary.acessosLiberados}</span><span class="summary-card-label">Acessos liberados</span></div>
    <div class="summary-card is-info"><span class="summary-card-value">${summary.aindaNaoEntraram}</span><span class="summary-card-label">Ainda nao entraram</span></div>
    <div class="summary-card is-ok"><span class="summary-card-value">${summary.jaEntraram}</span><span class="summary-card-label">Ja entraram</span></div>
  `;
}

let filtroAtivo = FILTER_ALL;

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
      renderList();
    });
  });
}

function acaoMarcarPagamentoOk(id) {
  const r = reservas.find((x) => x.id === id);
  if (r) r.pagamento = "pago";
  renderAll();
}

function acaoMarcarFnrhOk(id) {
  const r = reservas.find((x) => x.id === id);
  if (r) r.fnrh = "preenchido";
  renderAll();
}

function acaoLiberarAcesso(id) {
  const r = reservas.find((x) => x.id === id);
  if (r && r.pagamento === "pago" && r.fnrh === "preenchido") r.acessoLiberado = true;
  renderAll();
}

function acaoConfirmarCheckin(id) {
  const r = reservas.find((x) => x.id === id);
  if (r) r.entrouNoApto = true;
  renderAll();
}

function primaryActionFor(reserva) {
  const status = derivarStatusOperacional(reserva);
  if (reserva.pagamento === "pendente") {
    return { label: "Marcar pagamento ok", action: "marcar_pagamento", id: reserva.id };
  }
  if (reserva.fnrh === "pendente") {
    return { label: "Marcar FNRH ok", action: "marcar_fnrh", id: reserva.id };
  }
  if (!reserva.acessoLiberado) {
    return { label: "Liberar acesso", action: "liberar_acesso", id: reserva.id };
  }
  if (reserva.acessoLiberado && !reserva.entrouNoApto) {
    return { label: "Confirmar check-in", action: "confirmar_checkin", id: reserva.id };
  }
  return null;
}

function renderList() {
  if (!(listaElement instanceof HTMLElement)) return;
  const filtradas = filtrarReservas(reservas, filtroAtivo);

  listaElement.innerHTML = filtradas
    .map((reserva) => {
      const status = derivarStatusOperacional(reserva);
      const primary = primaryActionFor(reserva);
      const period = `${reserva.checkInPrevisto} a ${reserva.checkOutPrevisto}`;

      const badgeClasses = [
        reserva.pagamento === "pago" ? "badge badge-pago" : "badge badge-pendente",
        reserva.fnrh === "preenchido" ? "badge badge-preenchido" : "badge badge-pendente",
        reserva.acessoLiberado ? "badge badge-liberado" : "badge badge-nao-liberado",
        reserva.entrouNoApto ? "badge badge-entrou" : "badge badge-nao-entrou",
      ];
      const badgeLabels = [
        reserva.pagamento === "pago" ? "Pago" : "Pendente",
        reserva.fnrh === "preenchido" ? "FNRH ok" : "FNRH pend.",
        reserva.acessoLiberado ? "Liberado" : "Nao liberado",
        reserva.entrouNoApto ? "Entrou" : "Nao entrou",
      ];

      let actionsHtml = "";
      if (primary) {
        const disabled = primary.action === "liberar_acesso" && (reserva.pagamento !== "pago" || reserva.fnrh !== "preenchido") ? " disabled" : "";
        actionsHtml = `<button type="button" class="primary-button" data-action="${primary.action}" data-id="${primary.id}"${disabled}>${primary.label}</button>`;
      } else {
        actionsHtml = '<span class="muted" style="font-size:13px;color:var(--muted)">Check-in concluido</span>';
      }

      const badgesHtml = badgeClasses
        .map((cls, i) => `<span class="${cls}">${badgeLabels[i]}</span>`)
        .join("");

      return `
        <article class="operational-card" data-id="${reserva.id}">
          <div class="operational-card-header">
            <span class="operational-card-apt">Apto ${reserva.apartamento}</span>
            <span class="operational-card-status status-${status.type}">${status.label}</span>
          </div>
          <div class="operational-card-guest">${reserva.hospedePrincipal}</div>
          <div class="operational-card-period">${period}</div>
          <div class="operational-card-badges">${badgesHtml}</div>
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
    if (action === "marcar_fnrh") btn.addEventListener("click", () => acaoMarcarFnrhOk(id));
    if (action === "liberar_acesso") btn.addEventListener("click", () => acaoLiberarAcesso(id));
    if (action === "confirmar_checkin") btn.addEventListener("click", () => acaoConfirmarCheckin(id));
  });
}

function renderAll() {
  const summary = calcularResumo(reservas);
  renderSummary(summary);
  renderList();
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

  renderFilters();
  renderAll();
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
