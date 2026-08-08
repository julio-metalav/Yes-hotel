/**
 * @typedef {Object} BreakfastApartmentCard
 * @property {string} apartmentCode
 * @property {string} guestMainName
 * @property {boolean} breakfastPaid
 * @property {number} expectedGuests
 * @property {number} arrivedGuests
 */

const auth = window.YesHotelAuthApp;

/**
 * Fonte atual: mocks estáticos locais (não HITS / não produção).
 * Ponto de entrada dos mocks: constante `breakfastCards` abaixo.
 * @type {BreakfastApartmentCard[]}
 */
const breakfastCards = [
  {
    apartmentCode: "24",
    guestMainName: "Joao Pedro",
    breakfastPaid: true,
    expectedGuests: 3,
    arrivedGuests: 3,
  },
  {
    apartmentCode: "07",
    guestMainName: "Maria Souza",
    breakfastPaid: true,
    expectedGuests: 2,
    arrivedGuests: 1,
  },
  {
    apartmentCode: "18",
    guestMainName: "Sandra Maria",
    breakfastPaid: false,
    expectedGuests: 2,
    arrivedGuests: 0,
  },
  {
    apartmentCode: "12",
    guestMainName: "Julio Cesar",
    breakfastPaid: true,
    expectedGuests: 4,
    arrivedGuests: 2,
  },
  {
    apartmentCode: "10",
    guestMainName: "Carlos Lima",
    breakfastPaid: false,
    expectedGuests: 1,
    arrivedGuests: 0,
  },
];

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
const searchElement = document.querySelector("#breakfast-search");
const filtersElement = document.querySelector("#breakfast-filters");
const markAllButtonElement = document.querySelector("#mark-all-button");
const emptyStateElement = document.querySelector("#empty-state");
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

let activeFilter = "all";
let searchTerm = "";

if (!(cardsListElement instanceof HTMLElement)) {
  throw new Error("Elemento principal da tela de cafe da manha nao encontrado.");
}

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }

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
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }

  accessStateElement.classList.add("hidden");
  accessStateElement.replaceChildren();
  contentPanelElement?.classList.remove("hidden");
}

function clampArrivedGuests(nextValue, expectedGuests) {
  return Math.max(0, Math.min(nextValue, expectedGuests));
}

function getMissingGuests(card) {
  return Math.max(0, card.expectedGuests - card.arrivedGuests);
}

function getPaymentLabel(card) {
  return card.breakfastPaid ? "Pago" : "Não pago";
}

function updateArrivedGuests(cardIndex, delta) {
  const currentCard = breakfastCards[cardIndex];

  if (!currentCard) {
    return;
  }

  currentCard.arrivedGuests = clampArrivedGuests(
    currentCard.arrivedGuests + delta,
    currentCard.expectedGuests,
  );

  renderCards();
}

function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesActiveFilter(card) {
  const isComplete = getMissingGuests(card) === 0;

  if (activeFilter === "pending") {
    return !isComplete;
  }

  if (activeFilter === "complete") {
    return isComplete;
  }

  if (activeFilter === "paid") {
    return card.breakfastPaid;
  }

  if (activeFilter === "unpaid") {
    return !card.breakfastPaid;
  }

  return true;
}

function matchesSearch(card) {
  if (!searchTerm) {
    return true;
  }

  return normalizeSearchValue(
    `${card.apartmentCode} ${card.guestMainName}`,
  ).includes(searchTerm);
}

/** Extrai o número real do apartamento para ordenação 7 < 10 < 12 (não lexicográfica). */
function apartmentNumberValue(code) {
  const match = String(code ?? "").trim().match(/(\d+)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function compareApartmentCodes(a, b) {
  const na = apartmentNumberValue(a);
  const nb = apartmentNumberValue(b);
  if (na !== nb) return na - nb;
  return String(a ?? "")
    .trim()
    .localeCompare(String(b ?? "").trim(), "pt-BR", {
      numeric: true,
      sensitivity: "base",
    });
}

function getVisibleCards() {
  return breakfastCards
    .map((card, cardIndex) => ({ card, cardIndex }))
    .filter(({ card }) => matchesActiveFilter(card) && matchesSearch(card))
    .sort((left, right) =>
      compareApartmentCodes(left.card.apartmentCode, right.card.apartmentCode),
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

function createCard(card, cardIndex) {
  const missingGuests = getMissingGuests(card);
  const isComplete = missingGuests === 0;
  const article = document.createElement("article");
  article.className = [
    "breakfast-card",
    isComplete ? "is-complete" : "is-pending",
    card.breakfastPaid ? "is-paid" : "is-unpaid",
  ].join(" ");

  const guestCell = document.createElement("div");
  guestCell.className = "guest-cell";
  const apt = document.createElement("span");
  apt.className = "apartment-code";
  apt.textContent = `Apto ${card.apartmentCode}`;
  const guest = document.createElement("span");
  guest.className = "guest-name";
  guest.textContent = card.guestMainName;
  guestCell.append(apt, guest);

  const attendanceCell = document.createElement("div");
  attendanceCell.className = "attendance-cell";
  const metrics = document.createElement("div");
  metrics.className = "attendance-metrics";
  metrics.append(
    createMetric("Previstos", card.expectedGuests),
    createMetric("Atendidos", card.arrivedGuests),
    createMetric("Faltantes", missingGuests, missingGuests > 0 ? "missing-count" : ""),
  );
  const progress = document.createElement("div");
  progress.className = "progress-track";
  progress.setAttribute(
    "aria-label",
    `${card.arrivedGuests} de ${card.expectedGuests} hóspedes atendidos`,
  );
  const bar = document.createElement("span");
  bar.style.width = `${
    card.expectedGuests > 0 ? (card.arrivedGuests / card.expectedGuests) * 100 : 0
  }%`;
  progress.appendChild(bar);
  attendanceCell.append(metrics, progress);

  const badgesCell = document.createElement("div");
  badgesCell.className = "badges-cell";

  const paymentCell = document.createElement("div");
  paymentCell.className = "payment-cell";
  const paymentBadge = document.createElement("span");
  paymentBadge.className = `payment-badge ${card.breakfastPaid ? "is-paid" : "is-unpaid"}`;
  paymentBadge.textContent = getPaymentLabel(card);
  paymentCell.appendChild(paymentBadge);

  const statusCell = document.createElement("div");
  statusCell.className = "status-cell";
  const statusBadge = document.createElement("span");
  statusBadge.className = `status-badge ${isComplete ? "is-complete" : "is-pending"}`;
  statusBadge.textContent = isComplete ? "Completo" : "Pendente";
  statusCell.appendChild(statusBadge);
  badgesCell.append(paymentCell, statusCell);

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
  decrease.setAttribute(
    "aria-label",
    `Diminuir quantidade que veio do apto ${card.apartmentCode}`,
  );
  decrease.disabled = card.arrivedGuests === 0;
  decrease.dataset.action = "decrease";
  decrease.dataset.cardIndex = String(cardIndex);
  decrease.textContent = "−";

  const arrived = document.createElement("span");
  arrived.className = "arrived-pill";
  arrived.setAttribute("aria-live", "polite");
  arrived.textContent = String(card.arrivedGuests);

  const increase = document.createElement("button");
  increase.className = "icon-button";
  increase.type = "button";
  increase.setAttribute(
    "aria-label",
    `Aumentar quantidade que veio do apto ${card.apartmentCode}`,
  );
  increase.disabled = card.arrivedGuests === card.expectedGuests;
  increase.dataset.action = "increase";
  increase.dataset.cardIndex = String(cardIndex);
  increase.textContent = "+";

  controls.append(decrease, arrived, increase);
  controlCell.append(controlLabel, controls);

  article.append(guestCell, attendanceCell, badgesCell, controlCell);
  return article;
}

function renderIndicators() {
  const expectedGuests = breakfastCards.reduce(
    (total, card) => total + card.expectedGuests,
    0,
  );
  const arrivedGuests = breakfastCards.reduce(
    (total, card) => total + card.arrivedGuests,
    0,
  );
  const missingGuests = Math.max(0, expectedGuests - arrivedGuests);
  const completeApartments = breakfastCards.filter(
    (card) => getMissingGuests(card) === 0,
  ).length;
  const progress = expectedGuests
    ? Math.round((arrivedGuests / expectedGuests) * 100)
    : 0;

  if (expectedKpiElement instanceof HTMLElement) {
    expectedKpiElement.textContent = String(expectedGuests);
  }
  if (arrivedKpiElement instanceof HTMLElement) {
    arrivedKpiElement.textContent = String(arrivedGuests);
  }
  if (missingKpiElement instanceof HTMLElement) {
    missingKpiElement.textContent = String(missingGuests);
  }
  if (progressKpiElement instanceof HTMLElement) {
    progressKpiElement.textContent = `${progress}% do atendimento`;
  }
  if (completeApartmentsKpiElement instanceof HTMLElement) {
    completeApartmentsKpiElement.textContent = String(completeApartments);
  }
  if (apartmentsTotalKpiElement instanceof HTMLElement) {
    apartmentsTotalKpiElement.textContent =
      `de ${breakfastCards.length} apartamentos`;
  }
  if (markAllButtonElement instanceof HTMLButtonElement) {
    markAllButtonElement.disabled = missingGuests === 0;
  }
}

async function renderSessionBannerAsync(currentUser) {
  if (!currentUser) {
    sessionBannerElement?.classList.add("hidden");
    return;
  }

  // Cabeçalho oficial: nome + perfil (sem texto de duração de sessão).
  if (
    sessionUserNameElement instanceof HTMLElement &&
    sessionUserRoleElement instanceof HTMLElement
  ) {
    sessionUserNameElement.textContent = currentUser.name;
    sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
  } else if (sessionBannerUserElement instanceof HTMLElement) {
    sessionBannerUserElement.textContent =
      `${currentUser.name} · ${auth.getRoleLabel(currentUser.role)}`;
  }

  if (usersLinkElement instanceof HTMLElement) {
    usersLinkElement.classList.toggle(
      "hidden",
      !auth.canAccessUserManagement(currentUser),
    );
  }

  // Perfil Café: somente Café na sidebar (sem atalho de Operação).
  document.querySelectorAll('[data-nav="operacao"]').forEach((node) => {
    node.classList.toggle("hidden", currentUser.role === "cafe");
  });
}

function renderCards() {
  cardsListElement.replaceChildren();

  const visibleCards = getVisibleCards();

  visibleCards.forEach(({ card, cardIndex }) => {
    cardsListElement.appendChild(createCard(card, cardIndex));
  });

  emptyStateElement?.classList.toggle("hidden", visibleCards.length > 0);
  renderIndicators();

  cardsListElement.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const cardIndex = Number(button.dataset.cardIndex);
      const delta = button.dataset.action === "increase" ? 1 : -1;
      updateArrivedGuests(cardIndex, delta);
    });
  });
}

function renderCurrentDate() {
  if (!(currentDateElement instanceof HTMLElement)) {
    return;
  }

  currentDateElement.textContent = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function setSidebarOpen(open) {
  document.body.classList.toggle("op-sidebar-open", !!open);
  const toggle = document.querySelector("#cafe-menu-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindSidebarControls() {
  document.querySelector("#cafe-menu-toggle")?.addEventListener("click", () => {
    setSidebarOpen(true);
  });
  document.querySelector("#cafe-sidebar-close")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  document.querySelector("#cafe-sidebar-backdrop")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1101) setSidebarOpen(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.body.classList.contains("op-sidebar-open")) {
      setSidebarOpen(false);
    }
  });
}

searchElement?.addEventListener("input", () => {
  if (!(searchElement instanceof HTMLInputElement)) {
    return;
  }

  searchTerm = normalizeSearchValue(searchElement.value);
  renderCards();
});

filtersElement?.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement) || !target.dataset.filter) {
    return;
  }

  activeFilter = target.dataset.filter;
  filtersElement.querySelectorAll("[data-filter]").forEach((button) => {
    const isActive = button === target;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  renderCards();
});

markAllButtonElement?.addEventListener("click", () => {
  breakfastCards.forEach((card) => {
    card.arrivedGuests = card.expectedGuests;
  });
  renderCards();
});

logoutButtonElement?.addEventListener("click", async () => {
  if (!auth) {
    return;
  }

  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

async function initBreakfastPage() {
  bindSidebarControls();
  renderCurrentDate();

  if (!auth || !auth.isConfigured()) {
    showAccessState(
      "Autenticacao indisponivel",
      auth?.getConfigError?.() ||
        "A biblioteca minima de autenticacao nao foi carregada nesta tela.",
      "Ir para login",
    );
    return;
  }

  const currentUser = await auth.getCurrentUser();

  if (!currentUser) {
    showAccessState(
      "Login necessario",
      "Entre com um usuario interno para acessar a operacao do cafe da manha.",
      "Fazer login",
    );
    return;
  }

  if (!auth.canAccessBreakfast(currentUser)) {
    showAccessState(
      "Acesso nao permitido",
      "Seu perfil nao tem acesso a esta tela.",
      "Voltar para login",
    );
    return;
  }

  hideAccessState();
  await renderSessionBannerAsync(currentUser);
  renderCards();
}

initBreakfastPage().catch((error) => {
  showAccessState(
    "Falha ao abrir a tela",
    error instanceof Error ? error.message : "Erro inesperado de autenticacao.",
    "Voltar para login",
  );
});
