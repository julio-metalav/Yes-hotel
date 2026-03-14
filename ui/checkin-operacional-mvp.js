const auth = window.YesHotelAuthApp;

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

const GUEST_STATUS = {
  NAO_IDENTIFICADO: "nao_identificado",
  AGUARDANDO_CONTATO: "aguardando_contato",
  PRONTO_PARA_ENVIO: "pronto_para_envio",
  ENVIADO: "enviado",
  CONFIRMADO: "confirmado",
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

let reservas = [
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
      { nome: "Julio Cesar", principal: true, email: "julio@email.com", whatsapp: "11999990001", statusOperacional: GUEST_STATUS.CONFIRMADO },
      { nome: "Sandra Maria", principal: false, email: "sandra@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.CONFIRMADO },
      { nome: "Hospede 3", principal: false, email: "", whatsapp: "11999990003", statusOperacional: GUEST_STATUS.ENVIADO },
      { nome: "Hospede 4", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.AGUARDANDO_CONTATO },
      { nome: "Hospede 5", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO },
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
      { nome: "Sandra Maria", principal: true, email: "sandra@email.com", whatsapp: "11988880000", statusOperacional: GUEST_STATUS.AGUARDANDO_CONTATO },
      { nome: "Hospede 2", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO },
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
      { nome: "Joao Pedro", principal: true, email: "joao@email.com", whatsapp: "11977770000", statusOperacional: GUEST_STATUS.CONFIRMADO },
      { nome: "Maria Silva", principal: false, email: "maria@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.CONFIRMADO },
      { nome: "Hospede 3", principal: false, email: "", whatsapp: "11977770002", statusOperacional: GUEST_STATUS.CONFIRMADO },
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
      { nome: "Ana Souza", principal: true, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO },
      { nome: "Hospede 2", principal: false, email: "", whatsapp: "", statusOperacional: GUEST_STATUS.NAO_IDENTIFICADO },
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
      { nome: "Carlos Mendes", principal: true, email: "carlos@email.com", whatsapp: "11966660000", statusOperacional: GUEST_STATUS.CONFIRMADO },
      { nome: "Hospede 2", principal: false, email: "h2@email.com", whatsapp: "", statusOperacional: GUEST_STATUS.PRONTO_PARA_ENVIO },
    ],
  },
];

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

function getProntosParaEnvio(reserva) {
  if (!Array.isArray(reserva.hospedes)) return [];
  return reserva.hospedes.filter(
    (h) => h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO && hasContatoSuficiente(h),
  );
}

function getFaltamContato(reserva) {
  if (!Array.isArray(reserva.hospedes)) return [];
  return reserva.hospedes.filter(
    (h) => h.statusOperacional !== GUEST_STATUS.CONFIRMADO && h.statusOperacional !== GUEST_STATUS.ENVIADO && !hasContatoSuficiente(h),
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
  return lista;
}

function calcularResumo(lista) {
  const hoje = todayStr();
  return {
    chegadasHoje: lista.filter((r) => r.checkInPrevisto === hoje).length,
    pendentesPagamento: lista.filter((r) => r.pagamento === "pendente").length,
    pendentesFnrh: lista.filter((r) => getFnrhPreenchidas(r) < getHospedesTotal(r)).length,
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

function acaoAvançarFnrh(id) {
  const r = reservas.find((x) => x.id === id);
  if (r && registrarProximaFnrh(r)) renderAll();
}

function acaoLiberarAcesso(id) {
  const r = reservas.find((x) => x.id === id);
  if (r && r.pagamento === "pago" && !hasFnrhPendente(r)) r.acessoLiberado = true;
  renderAll();
}

function acaoConfirmarCheckin(id) {
  const r = reservas.find((x) => x.id === id);
  if (r) r.entrouNoApto = true;
  renderAll();
}

function primaryActionFor(reserva) {
  if (reserva.pagamento === "pendente") {
    return { label: "Marcar pagamento ok", action: "marcar_pagamento", id: reserva.id };
  }
  if (hasFnrhPendente(reserva)) {
    return { label: "Avançar FNRH", action: "avancar_fnrh", id: reserva.id };
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
        const disabled = primary.action === "liberar_acesso" && (reserva.pagamento !== "pago" || hasFnrhPendente(reserva)) ? " disabled" : "";
        actionsHtml = `<button type="button" class="primary-button" data-action="${primary.action}" data-id="${primary.id}"${disabled}>${primary.label}</button>`;
      } else {
        actionsHtml = '<span class="muted" style="font-size:13px;color:var(--muted)">Check-in concluido</span>';
      }

      const badgesHtml = badgeClasses
        .map((cls, i) => `<span class="${cls}">${badgeLabels[i]}</span>`)
        .join("");

      const metaParts = [`Hóspedes: ${hospedesTotal}`, fnrhStatus.label];
      if (veiculoLine) metaParts.push(`Veículo: ${veiculoLine}`);
      const metaHtml = `<div class="operational-card-meta">${metaParts.map((t) => `<span class="operational-card-meta-item">${t}</span>`).join("")}</div>`;

      return `
        <article class="operational-card" data-id="${reserva.id}">
          <div class="operational-card-header">
            <span class="operational-card-apt">Apto ${reserva.apartamento}</span>
            <span class="operational-card-status status-${status.type}">${status.label}</span>
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

function renderAll() {
  const summary = calcularResumo(reservas);
  renderSummary(summary);
  renderList();
}

function escapeHtml(s) {
  if (s == null || s === "") return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

let detailReservaId = null;

function openDetail(reservaId) {
  const reserva = reservas.find((r) => r.id === reservaId);
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

function renderDetail(reserva) {
  if (!(detailBodyElement instanceof HTMLElement) || !reserva) return;
  const period = `${reserva.checkInPrevisto} a ${reserva.checkOutPrevisto}`;
  const hospedes = Array.isArray(reserva.hospedes) ? reserva.hospedes : [];
  const faltamContato = getFaltamContato(reserva);
  const prontos = getProntosParaEnvio(reserva);

  const guestsHtml = hospedes
    .map((h, index) => {
      const statusClass = guestStatusClass(h.statusOperacional);
      const statusLabel = guestStatusLabel(h.statusOperacional);
      const contatoOk = hasContatoSuficiente(h);
      const principalBadge = h.principal ? '<span class="guest-detail-badge-principal">Principal</span>' : "";
      const vehicleHtml =
        h.principal && reserva.veiculoPlaca && reserva.veiculoPlaca.trim()
          ? `<div class="guest-detail-vehicle">Veículo: ${escapeHtml(reserva.veiculoPlaca.trim())}${reserva.veiculoCor ? " • " + escapeHtml(reserva.veiculoCor.trim()) : ""}</div>`
          : "";
      const canConfirmar = h.statusOperacional !== GUEST_STATUS.CONFIRMADO;
      const canProntoEnvio =
        hasContatoSuficiente(h) &&
        (h.statusOperacional === GUEST_STATUS.NAO_IDENTIFICADO || h.statusOperacional === GUEST_STATUS.AGUARDANDO_CONTATO);
      const confirmarBtn = canConfirmar
        ? `<button type="button" class="secondary-button guest-confirmar-fnrh-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Confirmar FNRH</button>`
        : "";
      const prontoBtn = canProntoEnvio
        ? ` <button type="button" class="secondary-button guest-pronto-envio-btn" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}">Pronto para envio</button>`
        : "";

      return `
        <div class="guest-detail-card" data-guest-index="${index}">
          <div class="guest-detail-name-row">
            <span class="guest-detail-name">${escapeHtml(h.nome)}</span>
            ${principalBadge}
            <span class="guest-detail-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          ${vehicleHtml}
          <div class="guest-detail-contact-row">
            <label>E-mail</label>
            <input type="text" class="guest-email-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.email || "").trim())}" placeholder="email@exemplo.com" />
          </div>
          <div class="guest-detail-contact-row">
            <label>WhatsApp</label>
            <input type="text" class="guest-whatsapp-input" data-reserva-id="${escapeHtml(reserva.id)}" data-guest-index="${index}" value="${escapeHtml((h.whatsapp || "").trim())}" placeholder="11999990000" />
          </div>
          <div class="guest-detail-contact-row">
            ${contatoOk ? '<span class="guest-detail-contact-ok">Contato suficiente</span>' : '<span class="guest-detail-contact-falta">Falta contato</span>'}
          </div>
          ${confirmarBtn || prontoBtn ? `<div class="guest-detail-actions">${confirmarBtn}${prontoBtn}</div>` : ""}
        </div>
      `;
    })
    .join("");

  let enviarSection = "";
  const prontosCount = prontos.length;
  const faltamCount = faltamContato.length;
  if (faltamCount > 0 && prontosCount === 0) {
    enviarSection = `<div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s). Preencha e-mail ou WhatsApp para enviar o link.</div>`;
  } else if (faltamCount > 0 && prontosCount > 0) {
    enviarSection = `
      <div class="detail-enviar-links-alert is-warn">Falta contato para ${faltamCount} hóspede(s).</div>
      <button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}">Enviar link(s) FNRH (${prontosCount} pronto(s))</button>
    `;
  } else if (prontosCount > 0) {
    enviarSection = `<button type="button" class="primary-button detail-enviar-links-btn" id="detail-enviar-links-btn" data-reserva-id="${escapeHtml(reserva.id)}">Enviar link(s) FNRH (${prontosCount})</button>`;
  } else {
    const enviados = hospedes.filter((x) => x.statusOperacional === GUEST_STATUS.ENVIADO).length;
    const confirmados = getFnrhConfirmadas(reserva);
    if (confirmados === hospedes.length) {
      enviarSection = '<div class="detail-enviar-links-alert is-ok">Todas as FNRHs estão confirmadas.</div>';
    } else if (enviados > 0) {
      enviarSection = `<div class="detail-enviar-links-alert is-ok">Link(s) enviado(s) para ${enviados} hóspede(s). Aguardando confirmação.</div>`;
    }
  }

  detailBodyElement.innerHTML = `
    <div class="reservation-detail-section">
      <p class="reservation-detail-section-title">Período</p>
      <p style="margin:0;font-size:14px;color:var(--text)">${escapeHtml(period)}</p>
    </div>
    <div class="reservation-detail-section">
      <p class="reservation-detail-section-title">Hóspedes</p>
      ${guestsHtml}
    </div>
    <div class="reservation-detail-section">
      ${enviarSection}
    </div>
  `;

  bindDetailListeners(reserva);
}

function bindDetailListeners(reserva) {
  if (!(detailBodyElement instanceof HTMLElement)) return;

  detailBodyElement.querySelectorAll(".guest-email-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const target = e.target;
      const rid = target.dataset.reservaId;
      const idx = parseInt(target.dataset.guestIndex, 10);
      const r = reservas.find((x) => x.id === rid);
      if (r && r.hospedes && r.hospedes[idx] != null) {
        r.hospedes[idx].email = target.value.trim();
        if (detailReservaId === rid) renderDetail(r);
      }
    });
  });

  detailBodyElement.querySelectorAll(".guest-whatsapp-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const target = e.target;
      const rid = target.dataset.reservaId;
      const idx = parseInt(target.dataset.guestIndex, 10);
      const r = reservas.find((x) => x.id === rid);
      if (r && r.hospedes && r.hospedes[idx] != null) {
        r.hospedes[idx].whatsapp = target.value.trim();
        if (detailReservaId === rid) renderDetail(r);
      }
    });
  });

  detailBodyElement.querySelectorAll(".guest-confirmar-fnrh-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      const r = reservas.find((x) => x.id === rid);
      if (r && r.hospedes && r.hospedes[idx] != null) {
        r.hospedes[idx].statusOperacional = GUEST_STATUS.CONFIRMADO;
        renderAll();
        if (detailReservaId === rid) renderDetail(r);
      }
    });
  });

  detailBodyElement.querySelectorAll(".guest-pronto-envio-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rid = btn.dataset.reservaId;
      const idx = parseInt(btn.dataset.guestIndex, 10);
      const r = reservas.find((x) => x.id === rid);
      if (r && r.hospedes && r.hospedes[idx] != null) {
        r.hospedes[idx].statusOperacional = GUEST_STATUS.PRONTO_PARA_ENVIO;
        renderAll();
        if (detailReservaId === rid) renderDetail(r);
      }
    });
  });

  const enviarBtn = detailBodyElement.querySelector("#detail-enviar-links-btn");
  if (enviarBtn) {
    enviarBtn.addEventListener("click", () => {
      const rid = enviarBtn.dataset.reservaId;
      const r = reservas.find((x) => x.id === rid);
      if (!r || !Array.isArray(r.hospedes)) return;
      r.hospedes.forEach((h) => {
        if (h.statusOperacional === GUEST_STATUS.PRONTO_PARA_ENVIO && hasContatoSuficiente(h)) {
          h.statusOperacional = GUEST_STATUS.ENVIADO;
        }
      });
      renderAll();
      if (detailReservaId === rid) renderDetail(r);
    });
  }
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
