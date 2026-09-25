/**
 * Café da manhã — dados reais de operacional_reservas (sync HITS).
 * Sem mocks em runtime de produção.
 *
 * Seam de teste (somente harness externo): window.__YES_CAFE_TEST_DATASET__
 * Nunca é populado por este arquivo.
 *
 * Demo explícito: ?demo=1, após autenticação/autorização, somente em memória.
 */

const policy = window.YesHotelCafePolicy;

if (!policy || typeof policy.resolveCafeOperationalDateYmd !== "function") {
  throw new Error("Café: yes-cafe-policy.js não carregou antes de cafe-da-manha-mvp.js.");
}

function getAuth() {
  return window.YesHotelAuthApp;
}

async function ensureDemoModuleLoaded() {
  if (!demoMode || window.YesHotelCafeDemo?.createDataset) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./cafe-demo-data.js?v=2";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Não foi possível carregar o modo demonstração."));
    document.head.appendChild(script);
  });
}

const cardsListElement = document.querySelector("#cards-list");
const accessStateElement = document.querySelector("#access-state");
const sessionBannerElement = document.querySelector("#session-banner");
const sessionBannerUserElement = document.querySelector("#session-banner-user");
const sessionUserNameElement = document.querySelector("#cafe-session-user-name");
const sessionUserRoleElement = document.querySelector("#cafe-session-user-role");
const usersLinkElement = document.querySelector("#users-link");
const logoutButtonElement = document.querySelector("#logout-button");
const contentPanelElement = document.querySelector("#content-panel");
const currentDateElement = document.querySelector("#current-date");
const cafeDateInputElement = document.querySelector("#cafe-date-input");
const cafeDateResetButton = document.querySelector("#cafe-date-reset");
const cafeReadonlyBadge = document.querySelector("#cafe-readonly-badge");
const cafeDemoBanner = document.querySelector("#cafe-demo-banner");
const cafeLoadStateElement = document.querySelector("#cafe-load-state");
const cafeRetryButton = document.querySelector("#cafe-retry-button");
const searchElement = document.querySelector("#breakfast-search");
const filtersElement = document.querySelector("#breakfast-filters");
const markAllButtonElement = document.querySelector("#mark-all-button");
const emptyStateElement = document.querySelector("#empty-state");
const emptyStateTitleElement = document.querySelector("#empty-state-title");
const emptyStateTextElement = document.querySelector("#empty-state-text");
const dayClosureElement = document.querySelector("#cafe-day-closure");
const dayClosureTitleElement = document.querySelector("#cafe-day-closure-title");
const dayClosureStatusElement = document.querySelector("#cafe-day-closure-status");
const dayClosureCountsElement = document.querySelector("#cafe-day-closure-counts");
const dayClosureSignatureElement = document.querySelector("#cafe-day-closure-signature");
const dayCloseButtonElement = document.querySelector("#cafe-day-close-button");
const dayReopenButtonElement = document.querySelector("#cafe-day-reopen-button");
const expectedKpiElement = document.querySelector("#kpi-expected");
const arrivedKpiElement = document.querySelector("#kpi-arrived");
const missingKpiElement = document.querySelector("#kpi-missing");
const progressKpiElement = document.querySelector("#kpi-progress");
const completeApartmentsKpiElement = document.querySelector(
  "#kpi-complete-apartments",
);
const apartmentsTotalKpiElement = document.querySelector(
  "#kpi-apartments-total",
);

/** @type {import('../src/lib/domain/yes-hotel/cafe-attendance-policy').CafeCardModel[]} */
let cafeCards = [];
let activeFilter = "all";
let searchTerm = "";
/** @type {'auto'|'manual'} */
let dateMode = "auto";
let manualYmd = null;
let selectedYmd = policy.resolveCafeOperationalDateYmd();
let currentUser = null;
let loadError = null;
let isLoading = false;
let realtimeChannel = null;
let autoDateTimer = null;
let writeInFlight = false;
/** Estado do serviço da data selecionada. Vem do banco; nunca é inferido. */
let dayClosure = policy.buildOpenCafeDay(selectedYmd);
let closureInFlight = false;
const demoMode = new URLSearchParams(window.location.search).get("demo") === "1";
let demoDataset = null;
let demoDatasetYmd = null;

if (!(cardsListElement instanceof HTMLElement) || !policy) {
  throw new Error("Café: dependências da tela não encontradas.");
}

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) return;
  cardsListElement.replaceChildren();
  contentPanelElement?.classList.add("hidden");
  sessionBannerElement?.classList.add("hidden");
  accessStateElement.classList.remove("hidden");
  accessStateElement.replaceChildren();

  const heading = document.createElement("h2");
  heading.className = "access-state-title";
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.className = "access-state-text";
  paragraph.textContent = message;
  const action = document.createElement("a");
  action.className = "secondary-link";
  action.href = demoMode
    ? "./usuarios-login-mvp.html?next=cafe-demo"
    : "./usuarios-login-mvp.html";
  action.textContent = actionLabel;
  accessStateElement.append(heading, paragraph, action);
}

function hideAccessState() {
  if (!(accessStateElement instanceof HTMLElement)) return;
  accessStateElement.classList.add("hidden");
  accessStateElement.replaceChildren();
  contentPanelElement?.classList.remove("hidden");
}

function canWrite() {
  if (!currentUser) return false;
  if (demoMode) return true;
  if (!policy.canRoleWriteCafeAttendance(currentUser.role)) return false;
  if (!policy.canRegisterCafeAttendanceForDate(selectedYmd)) return false;
  // Serviço encerrado: a tela continua visível, mas em consulta.
  if (policy.isCafeDayClosed(dayClosure)) return false;
  return true;
}

function canWriteCard(card) {
  if (!canWrite()) return false;
  if (demoMode) return true;
  return policy.assertCanWriteCafeAttendance({
    role: currentUser?.role,
    cafeDateYmd: selectedYmd,
    entitlement: card.entitlement,
    dayStatus: dayClosure?.status,
  }).ok;
}

function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesActiveFilter(card) {
  const missing = policy.cafeMissingQty(card);
  const entitled = card.entitlement.entitledQty;
  const isComplete = entitled > 0 && missing === 0;
  const hasEntitlement = entitled > 0;

  if (activeFilter === "pending") return hasEntitlement && !isComplete;
  if (activeFilter === "complete") return isComplete;
  if (activeFilter === "paid") {
    return (
      card.entitlement.kind === "incluido" ||
      card.entitlement.kind === "avulso_pago"
    );
  }
  if (activeFilter === "no_breakfast") return card.entitlement.kind === "sem_cafe";
  if (activeFilter === "unknown") return card.entitlement.kind === "nao_mapeado";
  return true;
}

function matchesSearch(card) {
  if (!searchTerm) return true;
  return normalizeSearchValue(
    `${card.apartmentCode} ${card.mainGuestName}`,
  ).includes(searchTerm);
}

function getVisibleCards() {
  return cafeCards
    .filter((card) => matchesActiveFilter(card) && matchesSearch(card))
    .slice()
    .sort((a, b) =>
      policy.compareCafeApartmentCodes(a.apartmentCode, b.apartmentCode),
    );
}

function createMetric(label, value, extraClass) {
  const wrap = document.createElement("span");
  if (extraClass) wrap.className = extraClass;
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = String(value);
  wrap.append(small, strong);
  return wrap;
}

function createSimpleAlert(className, text) {
  const alert = document.createElement("div");
  alert.className = `cafe-simple-alert ${className} is-danger`;
  alert.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.className = "cafe-simple-alert__title";
  title.textContent = text;
  alert.append(title);
  return alert;
}

function createCard(card) {
  const missingGuests = policy.cafeMissingQty(card);
  const isComplete =
    card.entitlement.entitledQty > 0 && missingGuests === 0;
  const writable = canWriteCard(card);

  const article = document.createElement("article");
  article.className = [
    "breakfast-card",
    isComplete ? "is-complete" : "is-pending",
    card.entitlement.kind === "incluido" || card.entitlement.kind === "avulso_pago"
      ? "is-paid"
      : "is-unpaid",
    `is-kind-${card.entitlement.kind}`,
    card.ppdAlert ? "has-ppd-alert" : "",
    card.ppdAlert ? `has-ppd-${card.ppdAlert.state}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  article.dataset.reservationId = card.reservationId;

  const guestCell = document.createElement("div");
  guestCell.className = "guest-cell";
  const apt = document.createElement("span");
  apt.className = "apartment-code";
  apt.textContent = `Apto ${card.apartmentCode}`;
  const guest = document.createElement("span");
  guest.className = "guest-name";
  guest.textContent = card.mainGuestName || "—";
  const guestLine = document.createElement("span");
  guestLine.className = "guest-line";
  guestLine.textContent = policy.cafeGuestLine(card.entitlement);
  guestCell.append(apt, guest, guestLine);

  const cafeAlert = policy.cafeAlertLabel(card.entitlement);
  if (cafeAlert) {
    guestCell.appendChild(createSimpleAlert("cafe-no-breakfast-alert", cafeAlert));
  }

  if (card.ppdAlert) {
    guestCell.appendChild(
      createSimpleAlert("ppd-cafe-alert", card.ppdAlert.badgeLabel),
    );
  }

  const attendanceCell = document.createElement("div");
  attendanceCell.className = "attendance-cell";
  const metrics = document.createElement("div");
  metrics.className = "attendance-metrics";
  metrics.append(
    createMetric("Previstos", card.entitlement.entitledQty),
    createMetric("Atendidos", card.attendedQty),
    createMetric(
      "Faltantes",
      missingGuests,
      missingGuests > 0 ? "missing-count" : "",
    ),
  );
  const progress = document.createElement("div");
  progress.className = "progress-track";
  const bar = document.createElement("span");
  const pct =
    card.entitlement.entitledQty > 0
      ? (card.attendedQty / card.entitlement.entitledQty) * 100
      : 0;
  bar.style.width = `${pct}%`;
  progress.appendChild(bar);
  attendanceCell.append(metrics, progress);

  const badgesCell = document.createElement("div");
  badgesCell.className = "badges-cell";
  const paymentCell = document.createElement("div");
  paymentCell.className = "payment-cell";
  const paymentBadge = document.createElement("span");
  paymentBadge.className = `payment-badge ${
    card.entitlement.kind === "incluido" || card.entitlement.kind === "avulso_pago"
      ? "is-paid"
      : "is-neutral"
  }`;
  const paymentLabel = policy.cafeStatusLabel(card.entitlement);
  if (paymentLabel) {
    paymentBadge.textContent = paymentLabel;
    paymentCell.appendChild(paymentBadge);
  }

  const statusCell = document.createElement("div");
  statusCell.className = "status-cell";
  const statusBadge = document.createElement("span");
  statusBadge.className = `status-badge ${
    card.entitlement.entitledQty <= 0
      ? "is-neutral"
      : isComplete
        ? "is-complete"
        : "is-pending"
  }`;
  const statusLabel = policy.cafeOperationalStatusLabel(
    card.entitlement,
    card.attendedQty,
  );
  if (statusLabel) {
    statusBadge.textContent = statusLabel;
    statusCell.appendChild(statusBadge);
  }
  if (paymentCell.childElementCount > 0) badgesCell.appendChild(paymentCell);
  if (statusCell.childElementCount > 0) badgesCell.appendChild(statusCell);

  const controlCell = document.createElement("div");
  controlCell.className = "control-cell";
  const controlLabel = document.createElement("span");
  controlLabel.className = "control-label";
  controlLabel.textContent = "Atendidos";
  const controls = document.createElement("div");
  controls.className = "counter-controls";

  const decrease = document.createElement("button");
  decrease.className = "icon-button";
  decrease.type = "button";
  decrease.textContent = "−";
  decrease.disabled = !writable || card.attendedQty <= 0;
  decrease.dataset.action = "decrease";
  decrease.dataset.reservationId = card.reservationId;

  const arrived = document.createElement("span");
  arrived.className = "arrived-pill";
  arrived.setAttribute("aria-live", "polite");
  arrived.textContent = String(card.attendedQty);

  const increase = document.createElement("button");
  increase.className = "icon-button";
  increase.type = "button";
  increase.textContent = "+";
  // Sem teto pelo direito: o operador conta o que serviu. "Marcar todos" é que
  // continua preso ao total oficial.
  increase.disabled = !writable;
  increase.dataset.action = "increase";
  increase.dataset.reservationId = card.reservationId;

  controls.append(decrease, arrived, increase);
  controlCell.append(controlLabel, controls);

  article.append(guestCell, attendanceCell, badgesCell, controlCell);
  return article;
}

function setLoadState(kind, message) {
  if (!(cafeLoadStateElement instanceof HTMLElement)) return;
  cafeLoadStateElement.classList.remove("hidden", "is-error", "is-loading");
  if (!kind) {
    cafeLoadStateElement.classList.add("hidden");
    cafeLoadStateElement.replaceChildren();
    cafeRetryButton?.classList.add("hidden");
    return;
  }
  cafeLoadStateElement.classList.add(kind === "error" ? "is-error" : "is-loading");
  cafeLoadStateElement.textContent = message || "";
  cafeRetryButton?.classList.toggle("hidden", kind !== "error");
}

function renderDateHeader() {
  const header = policy.resolveCafeDateHeader(selectedYmd);
  if (currentDateElement instanceof HTMLElement) {
    currentDateElement.textContent = header.label;
  }
  if (cafeDateInputElement instanceof HTMLInputElement) {
    cafeDateInputElement.value = selectedYmd;
  }
  cafeDateResetButton?.classList.toggle("hidden", dateMode !== "manual");
}

function renderSession(user) {
  if (
    sessionUserNameElement instanceof HTMLElement &&
    sessionUserRoleElement instanceof HTMLElement
  ) {
    sessionUserNameElement.textContent = user.name;
    sessionUserRoleElement.textContent = getAuth().getRoleLabel(user.role);
  } else if (sessionBannerUserElement instanceof HTMLElement) {
    sessionBannerUserElement.textContent = `${user.name} · ${getAuth().getRoleLabel(user.role)}`;
  }

  usersLinkElement?.classList.toggle(
    "hidden",
    !getAuth().canAccessUserManagement(user),
  );
  document.querySelectorAll('[data-nav="operacao"]').forEach((node) => {
    node.classList.toggle("hidden", user.role === "cafe");
  });

  const write = canWrite();
  if (cafeReadonlyBadge instanceof HTMLElement) {
    // A tela deixou de ser só consulta: o badge agora diz em que modo se está.
    cafeReadonlyBadge.textContent = write ? "Controle operacional" : "Somente consulta";
    cafeReadonlyBadge.classList.remove("hidden");
  }
  if (markAllButtonElement instanceof HTMLButtonElement) {
    markAllButtonElement.classList.toggle(
      "hidden",
      !demoMode && !policy.canRoleWriteCafeAttendance(user.role),
    );
  }
}

function renderIndicators() {
  const kpis = policy.summarizeCafeKpis(cafeCards);
  if (expectedKpiElement) expectedKpiElement.textContent = String(kpis.expectedGuests);
  if (arrivedKpiElement) arrivedKpiElement.textContent = String(kpis.attendedGuests);
  if (missingKpiElement) missingKpiElement.textContent = String(kpis.missingGuests);
  if (progressKpiElement) {
    const pct = kpis.expectedGuests
      ? Math.round((kpis.attendedGuests / kpis.expectedGuests) * 100)
      : 0;
    progressKpiElement.textContent = `${pct}% do atendimento`;
  }
  if (completeApartmentsKpiElement) {
    completeApartmentsKpiElement.textContent = String(kpis.apartments);
  }
  if (apartmentsTotalKpiElement) {
    apartmentsTotalKpiElement.textContent =
      `${kpis.withBreakfast} com café · ${kpis.withoutBreakfast} sem café · ${kpis.unknownPlan} não identificados`;
  }
  // Contagem por situação nos próprios filtros (sem poluir o layout).
  if (filtersElement) {
    const contagem = {
      paid: kpis.withBreakfast,
      no_breakfast: kpis.withoutBreakfast,
      unknown: kpis.unknownPlan,
    };
    filtersElement.querySelectorAll("[data-filter]").forEach((botao) => {
      const chave = botao.getAttribute("data-filter");
      const base = botao.getAttribute("data-label") || botao.textContent || "";
      if (!botao.getAttribute("data-label")) botao.setAttribute("data-label", base.trim());
      if (Object.prototype.hasOwnProperty.call(contagem, chave)) {
        botao.textContent = `${botao.getAttribute("data-label")} (${contagem[chave]})`;
      }
    });
  }
  if (markAllButtonElement instanceof HTMLButtonElement) {
    const plans = policy.planMarkAllCafeAttended(cafeCards);
    markAllButtonElement.disabled = !canWrite() || plans.length === 0 || writeInFlight;
  }
  renderDayClosure(kpis);
}

/**
 * Card do serviço do dia. O status sai do banco; os números, dos KPIs já
 * calculados. Atendidos = previstos NÃO conclui nada — quem conclui é o botão.
 */
function renderDayClosure(kpis) {
  if (!(dayClosureElement instanceof HTMLElement)) return;
  const fechado = policy.isCafeDayClosed(dayClosure);
  const header = policy.resolveCafeDateHeader(selectedYmd);

  dayClosureElement.classList.toggle("is-closed", fechado);

  if (dayClosureTitleElement instanceof HTMLElement) {
    dayClosureTitleElement.textContent = fechado
      ? "Café da manhã concluído"
      : `Café da manhã — ${header.label}`;
  }
  if (dayClosureStatusElement instanceof HTMLElement) {
    dayClosureStatusElement.textContent =
      `Status: ${policy.cafeDayStatusLabel(dayClosure)}`;
  }
  if (dayClosureCountsElement instanceof HTMLElement) {
    dayClosureCountsElement.textContent =
      `${kpis.expectedGuests} cafés previstos · ${kpis.attendedGuests} atendidos · ${kpis.missingGuests} faltantes`;
  }
  if (dayClosureSignatureElement instanceof HTMLElement) {
    const assinatura = policy.cafeClosureSummaryLine(dayClosure);
    dayClosureSignatureElement.textContent = assinatura;
    dayClosureSignatureElement.classList.toggle("hidden", !assinatura);
  }

  const podeFechar =
    !demoMode &&
    policy.canCloseCafeDay({
      role: currentUser?.role,
      cafeDateYmd: selectedYmd,
      closure: dayClosure,
    });
  if (dayCloseButtonElement instanceof HTMLButtonElement) {
    dayCloseButtonElement.classList.toggle("hidden", !podeFechar);
    dayCloseButtonElement.disabled = closureInFlight || writeInFlight;
  }

  // Reabrir é exceção de admin. Café e recepção não veem o botão.
  const podeReabrir =
    !demoMode &&
    policy.canReopenCafeDay({ role: currentUser?.role, closure: dayClosure });
  if (dayReopenButtonElement instanceof HTMLButtonElement) {
    dayReopenButtonElement.classList.toggle("hidden", !podeReabrir);
    dayReopenButtonElement.disabled = closureInFlight || writeInFlight;
  }
}

function renderCards() {
  cardsListElement.replaceChildren();
  const visible = getVisibleCards();
  visible.forEach((card) => {
    cardsListElement.appendChild(createCard(card));
  });

  const empty = visible.length === 0 && !isLoading && !loadError;
  emptyStateElement?.classList.toggle("hidden", !empty);
  if (emptyStateTitleElement) {
    emptyStateTitleElement.textContent = searchTerm || activeFilter !== "all"
      ? "Nenhum apartamento encontrado"
      : "Nenhum café previsto para esta data.";
  }
  if (emptyStateTextElement) {
    emptyStateTextElement.textContent =
      searchTerm || activeFilter !== "all"
        ? "Ajuste a busca ou selecione outro filtro para continuar."
        : "Não há reservas sincronizadas elegíveis para o café nesta data.";
  }

  renderIndicators();
  renderDateHeader();
  if (currentUser) renderSession(currentUser);

  cardsListElement.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!(button instanceof HTMLButtonElement) || writeInFlight) return;
      const reservationId = button.dataset.reservationId;
      const action = button.dataset.action;
      const card = cafeCards.find((c) => c.reservationId === reservationId);
      if (!card) return;
      const delta = action === "increase" ? 1 : -1;
      // Envia só a ação; o servidor calcula o novo valor e o teto oficial.
      void persistAttendance(card, null, delta > 0 ? "increment" : "decrement");
    });
  });
}

function resolveEntitlementForStay(stay, overrideKind, paidExtraQty) {
  if (overrideKind === "incluido" || overrideKind === "sem_cafe" || overrideKind === "avulso_pago") {
    return policy.buildCafeBreakfastEntitlement({
      kind: overrideKind,
      guestCount: stay.totalGuests,
      paidExtraQty: paidExtraQty || 0,
      mealPlanDesc: stay.mealPlanDesc,
    });
  }
  return policy.resolveCafeBreakfastEntitlementFromHits({
    guestCount: stay.totalGuests,
    mealPlanDesc: stay.mealPlanDesc,
  });
}

function mapRowsToCards(reservas, atendimentosByReserva) {
  const stays = policy.selectCafeStaysForDate(
    reservas.map((r) => ({
      id: r.id,
      externalReservationId: r.external_reservation_id,
      apartmentCode: r.apartamento || "",
      mainGuestName: r.hospede_principal || "",
      checkInYmd: String(r.check_in_previsto || "").slice(0, 10),
      checkOutYmd: String(r.check_out_previsto || "").slice(0, 10),
      statusReserva: r.status_reserva || "ativa",
      totalGuests:
        Number(r.total_hospedes_hits) > 0
          ? Number(r.total_hospedes_hits)
          : Number(r.__guest_count_fallback) || 1,
      mealPlanDesc: r.meal_plan_desc || null,
      __testKind: r.__testKind,
      __paidExtraQty: r.__paidExtraQty,
      __ppdEfetivado: !!r.pagamento_presencial_diferido_efetivado || !!r.__ppdEfetivado,
      __ppdAutorizado: !!r.pagamento_presencial_diferido_autorizado || !!r.__ppdAutorizado,
      __pagamentoStatus: r.pagamento_status || r.__pagamentoStatus || null,
      __ppdRegularizadoEm:
        r.pagamento_presencial_diferido_regularizado_em || r.__ppdRegularizadoEm || null,
      __ppdBloqueadoEm:
        r.pagamento_presencial_diferido_bloqueado_em || r.__ppdBloqueadoEm || null,
      __ppdDeadlineEm:
        r.pagamento_presencial_diferido_deadline_em || r.__ppdDeadlineEm || null,
      __demoNowIso: r.__demoNowIso || null,
      __pagarmePaid: !!r.__pagarmePaid,
      __operacionalValorTotal: r.__operacionalValorTotal ?? null,
      __hitsReservationTotalAmount: r.__hitsReservationTotalAmount ?? null,
    })),
    selectedYmd,
  );

  return stays.map((stay) => {
    const att = atendimentosByReserva.get(stay.id);
    const entitlement = resolveEntitlementForStay(
      stay,
      stay.__testKind,
      stay.__paidExtraQty,
    );
    const charge = policy.resolvePpdChargeAmount({
      operacionalValorTotal: stay.__operacionalValorTotal,
      hitsReservationTotalAmount: stay.__hitsReservationTotalAmount,
    });
    const ppdInput = {
      ppdEfetivado: !!stay.__ppdEfetivado,
      ppdAutorizado: !!stay.__ppdAutorizado,
      pagamentoStatus: stay.__pagamentoStatus,
      statusReserva: stay.statusReserva,
      ppdRegularizadoEm: stay.__ppdRegularizadoEm,
      ppdBloqueadoEm: stay.__ppdBloqueadoEm,
      ppdDeadlineEm: stay.__ppdDeadlineEm,
      nowIso: stay.__demoNowIso,
      pagarmeObrigacaoLiquidada: !!stay.__pagarmePaid,
    };
    const ppdState = policy.resolveCafePpdOperationalState(ppdInput);
    const ppdAlert = policy.shouldShowCafePpdAlert(ppdInput)
      ? policy.buildCafePpdAlertView({
          charge,
          state: ppdState,
        })
      : null;
    return {
      reservationId: stay.id,
      apartmentCode: stay.apartmentCode,
      mainGuestName: stay.mainGuestName,
      entitlement,
      attendedQty: policy.clampCafeAttendedQty(
        att?.quantidade_atendida ?? 0,
        entitlement.entitledQty,
      ),
      ppdAlert,
      /** Somente leitura — UI do café NÃO altera pagamento_status. */
      pagamentoStatus: stay.__pagamentoStatus || null,
    };
  });
}

async function loadCafeDataset() {
  // Estado do dia nunca sobrevive a uma troca de data: cada data tem o seu.
  if (dayClosure?.dateYmd !== selectedYmd) {
    dayClosure = policy.buildOpenCafeDay(selectedYmd);
  }
  const testDataset = window.__YES_CAFE_TEST_DATASET__;
  if (demoMode) {
    if (!window.YesHotelCafeDemo?.createDataset) {
      throw new Error("Fixtures do modo demonstração não foram carregadas.");
    }
    if (!Array.isArray(demoDataset) || demoDatasetYmd !== selectedYmd) {
      demoDataset = window.YesHotelCafeDemo.createDataset(selectedYmd);
      demoDatasetYmd = selectedYmd;
    }
  }
  const localDataset = demoMode ? demoDataset : testDataset;
  if (Array.isArray(localDataset)) {
    cafeCards = mapRowsToCards(
      localDataset.map((row) => ({
        id: row.id,
        external_reservation_id: row.externalReservationId || null,
        apartamento: row.apartmentCode,
        hospede_principal: row.mainGuestName,
        check_in_previsto: row.checkInYmd,
        check_out_previsto: row.checkOutYmd,
        status_reserva: row.statusReserva || "ativa",
        total_hospedes_hits: row.totalGuests,
        meal_plan_desc: row.mealPlanDesc || null,
        pagamento_status: row.pagamentoStatus || null,
        pagamento_presencial_diferido_efetivado: !!row.ppdEfetivado,
        pagamento_presencial_diferido_autorizado: !!row.ppdAutorizado,
        pagamento_presencial_diferido_regularizado_em: row.ppdRegularizadoEm || null,
        pagamento_presencial_diferido_bloqueado_em: row.ppdBloqueadoEm || null,
        pagamento_presencial_diferido_deadline_em: row.ppdDeadlineEm || null,
        __testKind: row.kind,
        __paidExtraQty: row.paidExtraQty || 0,
        __pagarmePaid: !!row.pagarmePaid,
        __operacionalValorTotal: row.operacionalValorTotal ?? null,
        __hitsReservationTotalAmount: row.hitsReservationTotalAmount ?? null,
        __demoNowIso: row.demoNowIso || null,
      })),
      new Map(
        localDataset.map((row) => [
          row.id,
          { quantidade_atendida: row.attendedQty || 0 },
        ]),
      ),
    );
    loadError = null;
    return;
  }

  if (!getAuth()?.isConfigured?.() || !getAuth().getSupabaseClient) {
    throw new Error("Supabase não configurado para carregar o café.");
  }
  const supabase = getAuth().getSupabaseClient();
  if (!supabase) throw new Error("Sessão inválida. Faça login novamente.");

  // Fonte única para a listagem: RPC dedicada, somente leitura. O café não
  // tem mais SELECT direto em operacional_reservas nem em
  // operacional_hospedes (achado de auditoria corrigido) — a RPC já devolve
  // a contagem de hóspedes agregada (total_guests) e a mesma janela de data
  // que antes era calculada aqui (estadias que cruzam selectedYmd).
  const { data: rpcRows, error: errRpc } = await supabase.rpc(
    "operacional_cafe_listar_hospedagens",
    { p_data_cafe: selectedYmd },
  );
  if (errRpc) throw new Error(errRpc.message || "Falha ao carregar reservas.");

  // Universo HITS: a RPC devolve a população do snapshot; reservation_id vem
  // NULL para reserva ainda não materializada (a materialização automática a
  // cria no próximo ciclo). Id sintético só para a lista — nunca vai ao banco.
  const enriched = (rpcRows || []).map((r) => ({
    id: r.reservation_id || "hits:" + String(r.external_reservation_id || ""),
    __somenteHits: !r.reservation_id,
    apartamento: r.apartment_code,
    hospede_principal: r.main_guest_name,
    check_in_previsto: r.check_in_previsto,
    check_out_previsto: r.check_out_previsto,
    status_reserva: r.status_reserva,
    external_reservation_id: r.external_reservation_id,
    // Já agregado pela RPC (total_hospedes_hits oficial, senão contagem de
    // hóspedes não removidos, com piso 1) — mapRowsToCards usa este valor
    // direto, sem precisar de um fallback local.
    total_hospedes_hits: r.total_guests,
    meal_plan_desc: r.meal_plan_desc,
    pagamento_status: r.pagamento_status,
    pagamento_presencial_diferido_autorizado: r.pagamento_presencial_diferido_autorizado,
    pagamento_presencial_diferido_efetivado: r.pagamento_presencial_diferido_efetivado,
    pagamento_presencial_diferido_regularizado_em: r.pagamento_presencial_diferido_regularizado_em,
    pagamento_presencial_diferido_bloqueado_em: r.pagamento_presencial_diferido_bloqueado_em,
    pagamento_presencial_diferido_deadline_em: r.pagamento_presencial_diferido_deadline_em,
  }));

  // Atendimentos só existem para reservas materializadas (id operacional real).
  const ids = enriched.filter((r) => !r.__somenteHits).map((r) => r.id);
  const atendimentosByReserva = new Map();
  if (ids.length) {
    const { data: atts, error: errAtt } = await supabase
      .from("operacional_cafe_atendimentos")
      .select("operacional_reserva_id, quantidade_atendida, quantidade_direito, cafe_kind")
      .eq("data_cafe", selectedYmd)
      .in("operacional_reserva_id", ids);
    if (errAtt) {
      // Tabela pode ainda não existir no ambiente; não cair em mock.
      if (!/does not exist|schema cache|42P01/i.test(String(errAtt.message || ""))) {
        throw new Error(errAtt.message || "Falha ao carregar atendimentos.");
      }
    } else {
      for (const row of atts || []) {
        atendimentosByReserva.set(row.operacional_reserva_id, row);
      }
    }
  }

  cafeCards = mapRowsToCards(enriched, atendimentosByReserva);
  await loadDayClosure(supabase);
  loadError = null;
}

/**
 * Estado do serviço da data. Falha de leitura não pode inventar conclusão:
 * qualquer erro deixa o dia aberto, que é o estado que preserva a operação.
 */
async function loadDayClosure(supabase) {
  if (demoMode || !supabase) {
    dayClosure = policy.buildOpenCafeDay(selectedYmd);
    return;
  }
  const { data, error } = await supabase.rpc("operacional_cafe_status_dia", {
    p_data_cafe: selectedYmd,
  });
  if (error) {
    // Ambiente ainda sem a migration do fechamento: segue aberto.
    dayClosure = policy.buildOpenCafeDay(selectedYmd);
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  dayClosure = policy.parseCafeDayClosure(selectedYmd, row);
}

async function refreshCafe(options = {}) {
  const silent = !!options.silent;
  if (!silent) {
    isLoading = true;
    setLoadState("loading", "Carregando café…");
  }
  try {
    await loadCafeDataset();
    setLoadState(null);
  } catch (error) {
    loadError = error;
    cafeCards = [];
    setLoadState(
      "error",
      error?.message || "Não foi possível carregar os dados do café.",
    );
  } finally {
    isLoading = false;
    renderCards();
  }
}

async function persistAttendance(card, nextQty, action) {
  if (demoMode) {
    if (
      !currentUser ||
      card.entitlement.kind === "sem_cafe" ||
      card.entitlement.kind === "nao_mapeado" ||
      card.entitlement.entitledQty <= 0
    ) {
      return;
    }
    let localNext;
    if (action === "increment") {
      localNext = card.attendedQty + 1;
    } else if (action === "decrement") {
      localNext = card.attendedQty - 1;
    } else if (action === "marcar_todos") {
      localNext = card.entitlement.entitledQty;
    } else {
      localNext = nextQty;
    }
    localNext = policy.clampCafeAttendedQty(
      localNext,
      card.entitlement.entitledQty,
    );
    card.attendedQty = localNext;
    const row = demoDataset?.find((item) => item.id === card.reservationId);
    if (row) row.attendedQty = localNext;
    renderCards();
    return;
  }

  const gate = policy.assertCanWriteCafeAttendance({
    role: currentUser?.role,
    cafeDateYmd: selectedYmd,
    entitlement: card.entitlement,
  });
  if (!gate.ok) return;

  // Harness de teste: atualiza só memória (espelha teto local de exibição).
  if (Array.isArray(window.__YES_CAFE_TEST_DATASET__)) {
    let localNext;
    if (action === "increment") {
      localNext = policy.clampCafeAttendedQty(
        card.attendedQty + 1,
        card.entitlement.entitledQty,
      );
    } else if (action === "decrement") {
      localNext = policy.clampCafeAttendedQty(
        card.attendedQty - 1,
        card.entitlement.entitledQty,
      );
    } else if (action === "marcar_todos") {
      localNext = Math.max(0, card.entitlement.entitledQty);
    } else {
      localNext = policy.clampCafeAttendedQty(
        nextQty,
        card.entitlement.entitledQty,
      );
    }
    card.attendedQty = localNext;
    const row = window.__YES_CAFE_TEST_DATASET__.find((r) => r.id === card.reservationId);
    if (row) row.attendedQty = localNext;
    renderCards();
    return;
  }

  const supabase = getAuth().getSupabaseClient();
  if (!supabase) return;
  // Reserva ainda só no HITS (sem id operacional): não há onde gravar
  // atendimento até a materialização automática criar a reserva local.
  if (String(card.reservationId || "").indexOf("hits:") === 0) {
    setLoadState(
      "error",
      "Reserva ainda em sincronização com o HITS — o atendimento poderá ser registrado após a materialização.",
    );
    return;
  }

  writeInFlight = true;
  renderIndicators();
  try {
    // Contrato seguro: id estável + data + ação/quantidade solicitada.
    // Nunca enviar cafe_kind, quantidade_direito nem avulso — o servidor calcula.
    const payload = {
      p_data_cafe: selectedYmd,
      p_operacional_reserva_id: card.reservationId,
      p_acao: action,
    };
    if (action === "set" && nextQty != null) {
      payload.p_quantidade_atendida = nextQty;
    }
    const { data, error } = await supabase.rpc(
      "operacional_cafe_set_atendimento",
      payload,
    );
    if (error) throw error;
    if (data && typeof data.quantidade_atendida === "number") {
      card.attendedQty = data.quantidade_atendida;
    } else if (action === "marcar_todos") {
      card.attendedQty = Math.max(0, card.entitlement.entitledQty);
    } else if (action === "increment") {
      card.attendedQty = policy.clampCafeAttendedQty(
        card.attendedQty + 1,
        card.entitlement.entitledQty,
      );
    } else if (action === "decrement") {
      card.attendedQty = policy.clampCafeAttendedQty(
        card.attendedQty - 1,
        card.entitlement.entitledQty,
      );
    } else if (nextQty != null) {
      card.attendedQty = nextQty;
    }
  } catch (error) {
    setLoadState(
      "error",
      error?.message || "Não foi possível gravar o atendimento.",
    );
  } finally {
    writeInFlight = false;
    renderCards();
  }
}

async function markAllAttended() {
  if (!canWrite()) return;
  // Só IDs estáveis + ação; o servidor define o teto oficial.
  const plans = policy.planMarkAllCafeAttended(cafeCards);
  for (const plan of plans) {
    const card = cafeCards.find((c) => c.reservationId === plan.reservationId);
    if (!card) continue;
    await persistAttendance(card, null, "marcar_todos");
  }
}

/**
 * Fecha ou reabre o serviço da data. Ambas as decisões são do servidor: aqui
 * só se chama a RPC e se recarrega o estado real. Nada é assumido no cliente.
 */
async function persistDayClosure(action) {
  if (demoMode || closureInFlight) return;
  const supabase = getAuth()?.getSupabaseClient?.();
  if (!supabase) return;

  const rpc =
    action === "reabrir"
      ? "operacional_cafe_reabrir_dia"
      : "operacional_cafe_fechar_dia";

  closureInFlight = true;
  renderIndicators();
  try {
    const { error } = await supabase.rpc(rpc, { p_data_cafe: selectedYmd });
    if (error) throw error;
    await refreshCafe({ silent: true });
  } catch (error) {
    setLoadState(
      "error",
      error?.message ||
        (action === "reabrir"
          ? "Não foi possível reabrir o atendimento."
          : "Não foi possível concluir o café do dia."),
    );
  } finally {
    closureInFlight = false;
    renderCards();
  }
}

dayCloseButtonElement?.addEventListener("click", () => {
  void persistDayClosure("concluir");
});

dayReopenButtonElement?.addEventListener("click", () => {
  void persistDayClosure("reabrir");
});

function syncSelectedDateFromMode() {
  selectedYmd = policy.resolveSelectedCafeDateYmd(dateMode, manualYmd);
}

function startAutoDateWatch() {
  if (autoDateTimer) clearInterval(autoDateTimer);
  autoDateTimer = setInterval(() => {
    if (dateMode !== "auto") return;
    const next = policy.resolveCafeOperationalDateYmd();
    if (next !== selectedYmd) {
      selectedYmd = next;
      void refreshCafe();
    } else {
      // Reavaliar bloqueio de data futura → liberação à meia-noite.
      renderCards();
    }
  }, 30000);
}

function setupRealtime(supabase) {
  if (demoMode || !supabase?.channel || realtimeChannel) return;
  realtimeChannel = supabase
    .channel(`cafe-atendimentos-${selectedYmd}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "operacional_cafe_atendimentos",
        filter: `data_cafe=eq.${selectedYmd}`,
      },
      () => {
        void refreshCafe({ silent: true });
      },
    )
    // Fechamento/reabertura do dia: sem isto, outra tela aberta continuaria
    // aceitando cliques num serviço já encerrado até o próximo reload.
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "operacional_cafe_fechamentos",
        filter: `data_cafe=eq.${selectedYmd}`,
      },
      () => {
        void refreshCafe({ silent: true });
      },
    )
    .subscribe();
}

function teardownRealtime() {
  const supabase = getAuth()?.getSupabaseClient?.();
  if (realtimeChannel && supabase) {
    supabase.removeChannel(realtimeChannel);
  }
  realtimeChannel = null;
}

searchElement?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  searchTerm = normalizeSearchValue(target.value);
  renderCards();
});

filtersElement?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.filter) return;
  activeFilter = target.dataset.filter;
  filtersElement.querySelectorAll("[data-filter]").forEach((button) => {
    const active = button === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderCards();
});

markAllButtonElement?.addEventListener("click", () => {
  void markAllAttended();
});

cafeDateInputElement?.addEventListener("change", () => {
  if (!(cafeDateInputElement instanceof HTMLInputElement)) return;
  const value = cafeDateInputElement.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  dateMode = "manual";
  manualYmd = value;
  syncSelectedDateFromMode();
  teardownRealtime();
  void refreshCafe().then(() => {
    const supabase = getAuth().getSupabaseClient?.();
    if (supabase) setupRealtime(supabase);
  });
});

cafeDateResetButton?.addEventListener("click", () => {
  dateMode = "auto";
  manualYmd = null;
  syncSelectedDateFromMode();
  teardownRealtime();
  void refreshCafe().then(() => {
    const supabase = getAuth().getSupabaseClient?.();
    if (supabase) setupRealtime(supabase);
  });
});

cafeRetryButton?.addEventListener("click", () => {
  void refreshCafe();
});

logoutButtonElement?.addEventListener("click", async () => {
  teardownRealtime();
  if (autoDateTimer) clearInterval(autoDateTimer);
  await getAuth().logout();
  window.location.href = "./usuarios-login-mvp.html";
});

function setupSidebar() {
  const sidebar = document.querySelector("#cafe-sidebar");
  const toggle = document.querySelector("#cafe-menu-toggle");
  const closeBtn = document.querySelector("#cafe-sidebar-close");
  const backdrop = document.querySelector("#cafe-sidebar-backdrop");
  const setOpen = (open) => {
    sidebar?.classList.toggle("is-open", open);
    backdrop?.classList.toggle("is-open", open);
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  };
  toggle?.addEventListener("click", () => setOpen(true));
  closeBtn?.addEventListener("click", () => setOpen(false));
  backdrop?.addEventListener("click", () => setOpen(false));
}

async function initBreakfastPage() {
  setupSidebar();
  syncSelectedDateFromMode();
  startAutoDateWatch();

  if (!getAuth() || typeof getAuth().isConfigured !== "function" || !getAuth().isConfigured()) {
    showAccessState(
      "Configuração necessária",
      "Configure o Supabase para acessar o café da manhã com dados reais.",
      "Ir para login",
    );
    return;
  }

  currentUser = await getAuth().getCurrentUser();
  if (!currentUser) {
    showAccessState(
      "Login necessário",
      "Faça login para acessar o café da manhã.",
      "Fazer login",
    );
    return;
  }

  if (!getAuth().canAccessBreakfast(currentUser)) {
    showAccessState(
      "Acesso negado",
      "Seu perfil não tem permissão para a tela de café da manhã.",
      "Voltar",
    );
    return;
  }

  const navPolicy = window.YesHotelNavPolicy;
  if (navPolicy) {
    const sidebarNavElement = document.querySelector(
      '.yes-sidebar nav[aria-label="Navegação principal"]',
    );
    navPolicy.renderSidebarNav(sidebarNavElement, currentUser.role, "cafe");
  }

  await ensureDemoModuleLoaded();
  document.body.classList.toggle("is-demo", demoMode);
  cafeDemoBanner?.classList.toggle("hidden", !demoMode);
  hideAccessState();
  renderSession(currentUser);
  await refreshCafe();
  const supabase = getAuth().getSupabaseClient();
  if (supabase && !demoMode && !Array.isArray(window.__YES_CAFE_TEST_DATASET__)) {
    setupRealtime(supabase);
  }
}

void initBreakfastPage();

// Seam exclusivo de harness de validação visual (não usado em produção).
window.__YES_CAFE_FORCE_REINIT__ = initBreakfastPage;
window.__YES_CAFE_SET_DATE__ = async function setCafeDateForHarness(ymd) {
  dateMode = "manual";
  manualYmd = String(ymd).slice(0, 10);
  syncSelectedDateFromMode();
  teardownRealtime();
  await refreshCafe();
};
