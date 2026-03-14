const auth = window.YesHotelAuthApp;

const noticeElement = document.querySelector("#notice");
const bootstrapPanelElement = document.querySelector("#bootstrap-panel");
const loginPanelElement = document.querySelector("#login-panel");
const appPanelElement = document.querySelector("#app-panel");
const bootstrapFormElement = document.querySelector("#bootstrap-form");
const loginFormElement = document.querySelector("#login-form");
const userFormElement = document.querySelector("#user-form");
const userFormTitleElement = document.querySelector("#user-form-title");
const usersListElement = document.querySelector("#users-list");
const sessionUserElement = document.querySelector("#session-user");
const logoutButtonElement = document.querySelector("#logout-button");
const cancelEditButtonElement = document.querySelector("#cancel-edit-button");
let usersCache = [];

function showNotice(message, variant = "success") {
  if (!(noticeElement instanceof HTMLElement)) {
    return;
  }

  noticeElement.textContent = message;
  noticeElement.className = `notice is-${variant}`;
  noticeElement.classList.remove("hidden");
}

function hideNotice() {
  if (!(noticeElement instanceof HTMLElement)) {
    return;
  }

  noticeElement.textContent = "";
  noticeElement.className = "notice hidden";
}

function hideErrorNoticeOnly() {
  if (!(noticeElement instanceof HTMLElement)) {
    return;
  }

  if (noticeElement.classList.contains("is-error")) {
    hideNotice();
  }
}

function showOnlyPanel(panelElement) {
  [bootstrapPanelElement, loginPanelElement, appPanelElement].forEach((element) => {
    if (element instanceof HTMLElement) {
      element.classList.add("hidden");
    }
  });

  if (panelElement instanceof HTMLElement) {
    panelElement.classList.remove("hidden");
  }
}

function hideAllPanels() {
  [bootstrapPanelElement, loginPanelElement, appPanelElement].forEach((element) => {
    if (element instanceof HTMLElement) {
      element.classList.add("hidden");
    }
  });
}

function resetUserForm() {
  if (!(userFormElement instanceof HTMLFormElement)) {
    return;
  }

  userFormElement.reset();
  userFormElement.elements.userId.value = "";
  userFormElement.elements.role.value = "recepcao";
  userFormElement.elements.active.checked = true;

  if (userFormTitleElement instanceof HTMLElement) {
    userFormTitleElement.textContent = "Novo usuario";
  }
}

function populateUserForm(user) {
  if (!(userFormElement instanceof HTMLFormElement)) {
    return;
  }

  userFormElement.elements.userId.value = user.id;
  userFormElement.elements.name.value = user.name;
  userFormElement.elements.email.value = user.email;
  userFormElement.elements.password.value = "";
  userFormElement.elements.role.value = user.role;
  userFormElement.elements.active.checked = Boolean(user.active);

  if (userFormTitleElement instanceof HTMLElement) {
    userFormTitleElement.textContent = "Editar usuario";
  }
}

function showConfigErrorState() {
  hideAllPanels();
  showNotice(auth.getConfigError(), "error");
}

async function renderUsersList() {
  if (!(usersListElement instanceof HTMLElement)) {
    return;
  }

  usersCache = await auth.listUsers();
  usersListElement.innerHTML = "";

  usersCache.forEach((user) => {
    const card = document.createElement("article");
    card.className = "user-card";
    card.innerHTML = `
      <div class="user-card-main">
        <p class="user-card-title">${user.name}</p>
        <p class="user-card-meta">${user.email} | ${auth.getRoleLabel(user.role)}</p>
      </div>
      <div class="user-card-side">
        <span class="badge ${user.active ? "is-active" : "is-inactive"}">
          ${user.active ? "Ativo" : "Inativo"}
        </span>
        <button class="secondary-button" type="button" data-edit-user-id="${user.id}">
          Editar
        </button>
      </div>
    `;
    usersListElement.appendChild(card);
  });

  usersListElement.querySelectorAll("[data-edit-user-id]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const user = usersCache.find((item) => item.id === button.dataset.editUserId);

      if (user) {
        hideNotice();
        populateUserForm(user);
      }
    });
  });
}

async function renderAdminPanel() {
  const currentUser = await auth.getCurrentUser();

  if (!currentUser) {
    await renderPageState();
    return;
  }

  if (!auth.canAccessUserManagement(currentUser)) {
    window.location.href = "./cafe-da-manha-mvp.html";
    return;
  }

  showOnlyPanel(appPanelElement);
  resetUserForm();
  await renderUsersList();
  hideErrorNoticeOnly();

  if (sessionUserElement instanceof HTMLElement) {
    sessionUserElement.textContent =
      `${currentUser.name} | ${auth.getRoleLabel(currentUser.role)} | sessao de ${auth.getSessionDurationHours()} horas`;
  }
}

async function renderPageState() {
  if (!auth || !auth.isConfigured()) {
    showConfigErrorState();
    return;
  }

  const currentUser = await auth.getCurrentUser();

  if (currentUser) {
    if (!auth.canAccessUserManagement(currentUser)) {
      window.location.href = "./cafe-da-manha-mvp.html";
      return;
    }

    await renderAdminPanel();
    return;
  }

  const hasUsers = await auth.hasUsers();

  if (!hasUsers) {
    showOnlyPanel(bootstrapPanelElement);
    hideNotice();
    return;
  }

  if (!currentUser) {
    showOnlyPanel(loginPanelElement);
    hideNotice();
    return;
  }
}

bootstrapFormElement?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideNotice();

  if (!(bootstrapFormElement instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(bootstrapFormElement);

  try {
    await auth.bootstrapFirstAdmin({
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
    });
    await auth.login(formData.get("email"), formData.get("password"));
    showNotice("Primeiro admin criado com sucesso.");
    await renderAdminPanel();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha ao criar admin.", "error");
  }
});

loginFormElement?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideNotice();

  if (!(loginFormElement instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(loginFormElement);

  try {
    const { user } = await auth.login(formData.get("email"), formData.get("password"));

    if (auth.canAccessUserManagement(user)) {
      await renderAdminPanel();
      return;
    }

    window.location.href = "./cafe-da-manha-mvp.html";
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha no login.", "error");
  }
});

userFormElement?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideNotice();

  if (!(userFormElement instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(userFormElement);
  const userId = String(formData.get("userId") || "");

  try {
    if (userId) {
      await auth.updateUser(userId, {
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        role: formData.get("role"),
        active: formData.get("active") === "on",
      });
      showNotice("Usuario atualizado com sucesso.");
    } else {
      await auth.createUser({
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        role: formData.get("role"),
        active: formData.get("active") === "on",
      });
      showNotice("Usuario criado com sucesso.");
    }

    await renderAdminPanel();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha ao salvar usuario.", "error");
  }
});

logoutButtonElement?.addEventListener("click", async () => {
  await auth.logout();
  await renderPageState();
});

cancelEditButtonElement?.addEventListener("click", () => {
  hideNotice();
  resetUserForm();
});

renderPageState().catch((error) => {
  showNotice(error instanceof Error ? error.message : "Falha ao iniciar tela.", "error");
});
