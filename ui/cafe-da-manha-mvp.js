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

if (!(cardsListElement instanceof HTMLElement)) {
  throw new Error("Elemento principal da tela de cafe da manha nao encontrado.");
}

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }

  cardsListElement.innerHTML = "";
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
}

function clampArrivedGuests(nextValue, expectedGuests) {
  return Math.max(0, Math.min(nextValue, expectedGuests));
}

function getMissingGuests(card) {
  return Math.max(0, card.expectedGuests - card.arrivedGuests);
}

function getPaymentLabel(card) {
  return card.breakfastPaid ? "Pago" : "Nao pago";
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

function createCard(card, cardIndex) {
  const missingGuests = getMissingGuests(card);
  const isComplete = missingGuests === 0;
  const article = document.createElement("article");
  article.className = `breakfast-card${isComplete ? " is-complete" : ""}`;

  article.innerHTML = `
    <div class="card-top">
      <div class="card-title">
        <span class="apartment-code">Apto ${card.apartmentCode}</span>
        <span class="guest-name">${card.guestMainName}</span>
      </div>
      <span class="payment-badge ${card.breakfastPaid ? "is-paid" : "is-unpaid"}">
        ${getPaymentLabel(card)}
      </span>
    </div>
    <div class="card-bottom">
      <div class="counts-line">
        Previsto: <strong>${card.expectedGuests}</strong> |
        Vieram: <strong>${card.arrivedGuests}</strong> |
        Faltam: <strong>${missingGuests}</strong>
        ${isComplete ? '| <span class="is-complete-text">Completo</span>' : ""}
      </div>
      <div class="counter-controls">
        <button
          class="icon-button"
          type="button"
          aria-label="Diminuir quantidade que veio do apto ${card.apartmentCode}"
          ${card.arrivedGuests === 0 ? "disabled" : ""}
          data-action="decrease"
          data-card-index="${cardIndex}"
        >
          -
        </button>
        <span class="arrived-pill">${card.arrivedGuests}</span>
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
    `${currentUser.name} | ${auth.getRoleLabel(currentUser.role)} | sessao de ${auth.getSessionDurationHours()} horas`;
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

  breakfastCards.forEach((card, cardIndex) => {
    cardsListElement.appendChild(createCard(card, cardIndex));
  });

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

logoutButtonElement?.addEventListener("click", async () => {
  if (!auth) {
    return;
  }

  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

async function initBreakfastPage() {
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
