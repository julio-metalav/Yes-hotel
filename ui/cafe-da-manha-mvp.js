/**
 * Café da manhã — dados reais de operacional_reservas (sync HITS).
 * Sem mocks em runtime de produção.
 *
 * Seam de teste (somente harness externo): window.__YES_CAFE_TEST_DATASET__
 * Nunca é populado por este arquivo.
 */

const policy = window.YesHotelCafePolicy;

if (!policy || typeof policy.resolveCafeOperationalDateYmd !== "function") {
  throw new Error("Café: yes-cafe-policy.js não carregou antes de cafe-da-manha-mvp.js.");
}

function getAuth() {
  return window.YesHotelAuthApp;
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
const cafeLoadStateElement = document.querySelector("#cafe-load-state");
const cafeRetryButton = document.querySelector("#cafe-retry-button");
const searchElement = document.querySelector("#breakfast-search");
const filtersElement = document.querySelector("#breakfast-filters");
const markAllButtonElement = document.querySelector("#mark-all-button");
const emptyStateElement = document.querySelector("#empty-state");
const emptyStateTitleElement = document.querySelector("#empty-state-title");
const emptyStateTextElement = document.querySelector("#empty-state-text");
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
  action.href = "./usuarios-login-mvp.html";
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
  if (!policy.canRoleWriteCafeAttendance(currentUser.role)) return false;
  if (!policy.canRegisterCafeAttendanceForDate(selectedYmd)) return false;
  return true;
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
  if (activeFilter === "unpaid") {
    return (
      card.entitlement.kind === "sem_cafe" ||
      card.entitlement.kind === "nao_mapeado"
    );
  }
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
    .sort((a, b) => {
      const aPpd = a.ppdAlert ? 0 : 1;
      const bPpd = b.ppdAlert ? 0 : 1;
      if (aPpd !== bPpd) return aPpd - bPpd;
      return policy.compareCafeApartmentCodes(a.apartmentCode, b.apartmentCode);
    });
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

function createCard(card) {
  const missingGuests = policy.cafeMissingQty(card);
  const isComplete =
    card.entitlement.entitledQty > 0 && missingGuests === 0;
  const writable =
    canWrite() &&
    policy.assertCanWriteCafeAttendance({
      role: currentUser?.role,
      cafeDateYmd: selectedYmd,
      entitlement: card.entitlement,
    }).ok;

  const article = document.createElement("article");
  article.className = [
    "breakfast-card",
    isComplete ? "is-complete" : "is-pending",
    card.entitlement.kind === "incluido" || card.entitlement.kind === "avulso_pago"
      ? "is-paid"
      : "is-unpaid",
    `is-kind-${card.entitlement.kind}`,
    card.ppdAlert ? "has-ppd-alert" : "",
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

  if (card.ppdAlert) {
    const ppdBox = document.createElement("div");
    ppdBox.className = "ppd-cafe-alert";
    ppdBox.setAttribute("role", "status");
    const ppdBadge = document.createElement("span");
    ppdBadge.className = "ppd-cafe-badge";
    ppdBadge.textContent = card.ppdAlert.badgeLabel;
    const ppdTitle = document.createElement("strong");
    ppdTitle.className = "ppd-cafe-title";
    ppdTitle.textContent = card.ppdAlert.title;
    const ppdCharge = document.createElement("span");
    ppdCharge.className = "ppd-cafe-charge";
    ppdCharge.textContent = card.ppdAlert.chargeLine;
    const ppdHits = document.createElement("span");
    ppdHits.className = "ppd-cafe-hits";
    ppdHits.textContent = card.ppdAlert.hitsHint;
    ppdBox.append(ppdBadge, ppdTitle, ppdCharge, ppdHits);
    guestCell.appendChild(ppdBox);
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
      : "is-unpaid"
  }`;
  paymentBadge.textContent = policy.cafeStatusLabel(card.entitlement);
  paymentCell.appendChild(paymentBadge);

  const statusCell = document.createElement("div");
  statusCell.className = "status-cell";
  const statusBadge = document.createElement("span");
  statusBadge.className = `status-badge ${isComplete ? "is-complete" : "is-pending"}`;
  if (card.entitlement.entitledQty <= 0) {
    statusBadge.textContent =
      card.entitlement.kind === "sem_cafe"
        ? "Sem direito"
        : card.entitlement.kind === "nao_mapeado"
          ? "Não mapeado"
          : "Sem direito";
  } else {
    statusBadge.textContent = isComplete ? "Completo" : "Pendente";
  }
  statusCell.appendChild(statusBadge);
  badgesCell.append(paymentCell, statusCell);
  if (card.ppdAlert) {
    const ppdBadgeCell = document.createElement("div");
    ppdBadgeCell.className = "ppd-badge-cell";
    const ppdMini = document.createElement("span");
    ppdMini.className = "ppd-cafe-badge ppd-cafe-badge--mini";
    ppdMini.textContent = card.ppdAlert.badgeLabel;
    ppdBadgeCell.appendChild(ppdMini);
    badgesCell.appendChild(ppdBadgeCell);
  }

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
  increase.disabled =
    !writable || card.attendedQty >= card.entitlement.entitledQty;
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
  cafeReadonlyBadge?.classList.toggle("hidden", write);
  if (markAllButtonElement instanceof HTMLButtonElement) {
    markAllButtonElement.classList.toggle("hidden", !policy.canRoleWriteCafeAttendance(user.role));
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
    apartmentsTotalKpiElement.textContent = `${kpis.completeApartments} com atendimento completo`;
  }
  if (markAllButtonElement instanceof HTMLButtonElement) {
    const plans = policy.planMarkAllCafeAttended(cafeCards);
    markAllButtonElement.disabled = !canWrite() || plans.length === 0 || writeInFlight;
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
    const showPpd = policy.shouldShowCafePpdAlert({
      ppdEfetivado: !!stay.__ppdEfetivado,
      ppdAutorizado: !!stay.__ppdAutorizado,
      pagamentoStatus: stay.__pagamentoStatus,
      statusReserva: stay.statusReserva,
      ppdRegularizadoEm: stay.__ppdRegularizadoEm,
      ppdBloqueadoEm: stay.__ppdBloqueadoEm,
      pagarmeObrigacaoLiquidada: !!stay.__pagarmePaid,
    });
    const ppdAlert = showPpd
      ? policy.buildCafePpdAlertView({
          apartmentCode: stay.apartmentCode,
          guestName: stay.mainGuestName,
          charge,
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

async function countGuestsFallback(supabase, reservaIds) {
  const map = new Map();
  if (!reservaIds.length) return map;
  const { data, error } = await supabase
    .from("operacional_hospedes")
    .select("reserva_id, removed_from_reservation")
    .in("reserva_id", reservaIds);
  if (error || !data) return map;
  for (const row of data) {
    if (row.removed_from_reservation) continue;
    map.set(row.reserva_id, (map.get(row.reserva_id) || 0) + 1);
  }
  return map;
}

async function loadCafeDataset() {
  const testDataset = window.__YES_CAFE_TEST_DATASET__;
  if (Array.isArray(testDataset)) {
    cafeCards = mapRowsToCards(
      testDataset.map((row) => ({
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
        __testKind: row.kind,
        __paidExtraQty: row.paidExtraQty || 0,
        __pagarmePaid: !!row.pagarmePaid,
        __operacionalValorTotal: row.operacionalValorTotal ?? null,
        __hitsReservationTotalAmount: row.hitsReservationTotalAmount ?? null,
      })),
      new Map(
        testDataset.map((row) => [
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

  // Janela ampla o bastante para estadias que cruzam a data do café.
  const from = selectedYmd;
  const { data: reservas, error: errRes } = await supabase
    .from("operacional_reservas")
    .select(
      "id, apartamento, hospede_principal, check_in_previsto, check_out_previsto, status_reserva, external_reservation_id, total_hospedes_hits, meal_plan_desc, pagamento_status, pagamento_presencial_diferido_autorizado, pagamento_presencial_diferido_efetivado, pagamento_presencial_diferido_regularizado_em, pagamento_presencial_diferido_bloqueado_em, pagamento_presencial_diferido_deadline_em",
    )
    .neq("status_reserva", "cancelada")
    .lt("check_in_previsto", from)
    .gte("check_out_previsto", from);

  if (errRes) throw new Error(errRes.message || "Falha ao carregar reservas.");

  const ids = (reservas || []).map((r) => r.id);
  const guestFallback = await countGuestsFallback(supabase, ids);
  const enriched = (reservas || []).map((r) => ({
    ...r,
    __guest_count_fallback: guestFallback.get(r.id) || 1,
  }));

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
  loadError = null;
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
  if (!supabase?.channel || realtimeChannel) return;
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

  hideAccessState();
  renderSession(currentUser);
  await refreshCafe();
  const supabase = getAuth().getSupabaseClient();
  if (supabase && !Array.isArray(window.__YES_CAFE_TEST_DATASET__)) {
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
