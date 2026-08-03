/**
 * @typedef {Object} BreakfastApartmentCard
 * @property {string} apartmentCode
 * @property {string} guestMainName
 * @property {boolean} breakfastPaid
 * @property {number} expectedGuests
 * @property {number} arrivedGuests
 */

const auth = window.YesHotelAuthApp;

/** @type {BreakfastApartmentCard[]} */
const breakfastCards = [
  {
    apartmentCode: "12",
    guestMainName: "Julio Cesar",
    breakfastPaid: true,
    expectedGuests: 4,
    arrivedGuests: 2,
  },
  {
    apartmentCode: "18",
    guestMainName: "Sandra Maria",
    breakfastPaid: false,
    expectedGuests: 2,
    arrivedGuests: 0,
  },
  {
    apartmentCode: "24",
    guestMainName: "Joao Pedro",
    breakfastPaid: true,
    expectedGuests: 3,
    arrivedGuests: 3,
  },
];

const cardsListElement = document.querySelector("#cards-list");
const accessStateElement = document.querySelector("#access-state");
const sessionBannerElement = document.querySelector("#session-banner");
const sessionBannerUserElement = document.querySelector("#session-banner-user");
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

  cardsListElement.innerHTML = "";
  contentPanelElement?.classList.add("hidden");
  sessionBannerElement?.classList.add("hidden");
  accessStateElement.classList.remove("hidden");
  accessStateElement.innerHTML = `
    <h2 class="access-state-title">${title}</h2>
    <p class="access-state-text">${message}</p>
    <a class="secondary-link" href="./usuarios-login-mvp.html">${actionLabel}</a>
  `;
}

function hideAccessState() {
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }

  accessStateElement.classList.add("hidden");
  accessStateElement.innerHTML = "";
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

function getVisibleCards() {
  return breakfastCards
    .map((card, cardIndex) => ({ card, cardIndex }))
    .filter(({ card }) => matchesActiveFilter(card) && matchesSearch(card));
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

  article.innerHTML = `
    <div class="guest-cell">
      <span class="apartment-code">Apto ${card.apartmentCode}</span>
      <span class="guest-name">${card.guestMainName}</span>
    </div>
    <div class="attendance-cell">
      <div class="attendance-metrics">
        <span><small>Previstos</small><strong>${card.expectedGuests}</strong></span>
        <span><small>Atendidos</small><strong>${card.arrivedGuests}</strong></span>
        <span class="${missingGuests > 0 ? "missing-count" : ""}">
          <small>Faltantes</small><strong>${missingGuests}</strong>
        </span>
      </div>
      <div class="progress-track" aria-label="${card.arrivedGuests} de ${card.expectedGuests} hóspedes atendidos">
        <span style="width: ${card.expectedGuests > 0 ? (card.arrivedGuests / card.expectedGuests) * 100 : 0}%"></span>
      </div>
    </div>
    <div class="payment-cell">
      <span class="payment-badge ${card.breakfastPaid ? "is-paid" : "is-unpaid"}">
        ${getPaymentLabel(card)}
      </span>
    </div>
    <div class="status-cell">
      <span class="status-badge ${isComplete ? "is-complete" : "is-pending"}">
        ${isComplete ? "Completo" : "Pendente"}
      </span>
    </div>
    <div class="control-cell">
      <span class="control-label">Atendidos</span>
      <div class="counter-controls">
        <button
          class="icon-button"
          type="button"
          aria-label="Diminuir quantidade que veio do apto ${card.apartmentCode}"
          ${card.arrivedGuests === 0 ? "disabled" : ""}
          data-action="decrease"
          data-card-index="${cardIndex}"
        >
          −
        </button>
        <span class="arrived-pill" aria-live="polite">${card.arrivedGuests}</span>
        <button
          class="icon-button"
          type="button"
          aria-label="Aumentar quantidade que veio do apto ${card.apartmentCode}"
          ${card.arrivedGuests === card.expectedGuests ? "disabled" : ""}
          data-action="increase"
          data-card-index="${cardIndex}"
        >
          +
        </button>
      </div>
    </div>
  `;

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
  if (
    !(sessionBannerElement instanceof HTMLElement) ||
    !(sessionBannerUserElement instanceof HTMLElement)
  ) {
    return;
  }

  if (!currentUser) {
    sessionBannerElement.classList.add("hidden");
    return;
  }

  sessionBannerUserElement.textContent =
    `${currentUser.name} · ${auth.getRoleLabel(currentUser.role)} · sessão de ${auth.getSessionDurationHours()} horas`;
  sessionBannerElement.classList.remove("hidden");

  if (usersLinkElement instanceof HTMLElement) {
    usersLinkElement.classList.toggle(
      "hidden",
      !auth.canAccessUserManagement(currentUser),
    );
  }
}

function renderCards() {
  cardsListElement.innerHTML = "";

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
