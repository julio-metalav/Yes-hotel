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
const sessionUserNameElement = document.querySelector("#session-user-name");
const sessionUserRoleElement = document.querySelector("#session-user-role");
const dashboardWelcomeTitleElement = document.querySelector("#dashboard-welcome-title");
const logoutButtonElement = document.querySelector("#logout-button");
const cancelEditButtonElement = document.querySelector("#cancel-edit-button");
const loginEmailElement = document.querySelector("#login-email");
const loginPasswordElement = document.querySelector("#login-password");
const rememberEmailElement = document.querySelector("#remember-email");
const passwordToggleElement = document.querySelector(".password-toggle");
const loginSubmitButtonElement = loginFormElement?.querySelector('[type="submit"]');
const REMEMBERED_EMAIL_STORAGE_KEY = "yesHotel.rememberedEmail";
let usersCache = [];

function isCafeDemoReturnRequested() {
  return new URLSearchParams(window.location.search).get("next") === "cafe-demo";
}

function redirectUserByRole(user) {
  if (!user) {
    return false;
  }

  if (isCafeDemoReturnRequested() && auth.canAccessBreakfast(user)) {
    window.location.href = "./cafe-da-manha-mvp.html?demo=1";
    return true;
  }

  return false;
}

function applyDashboardCards(user) {
  const isAdmin = user?.role === "admin";
  const isCafe = user?.role === "cafe";
  const canManage =
    typeof auth.canAccessManagement === "function"
      ? auth.canAccessManagement(user)
      : user?.role === "admin" || user?.role === "recepcao";
  const canFinancial =
    typeof auth.canAccessFinancialRecon === "function"
      ? auth.canAccessFinancialRecon(user)
      : user?.role === "admin";

  document.querySelectorAll('[data-nav="checkin"]').forEach((node) => {
    node.classList.toggle("hidden", isCafe);
  });
  document.querySelectorAll('[data-nav="gestao"]').forEach((node) => {
    node.classList.toggle("hidden", !canManage);
  });
  document.querySelectorAll('[data-nav="financeiro"]').forEach((node) => {
    node.classList.toggle("hidden", !canFinancial);
  });
  document.querySelectorAll('[data-nav="wifi"]').forEach((node) => {
    node.classList.toggle("hidden", !canManage);
  });
  document.querySelectorAll('[data-nav="usuarios"]').forEach((node) => {
    node.classList.toggle("hidden", !isAdmin);
  });
  document.querySelectorAll(".dashboard-admin-only").forEach((node) => {
    node.classList.toggle("hidden", !isAdmin);
  });
}

function showNotice(message, variant = "success") {
  if (!(noticeElement instanceof HTMLElement)) {
    return;
  }

  noticeElement.textContent = message;
  noticeElement.className = `notice is-${variant}`;
  noticeElement.setAttribute("role", variant === "error" ? "alert" : "status");
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
  const isAppView = panelElement === appPanelElement;
  document.body.classList.toggle("auth-view", !isAppView);
  document.body.classList.toggle("app-view", isAppView);

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
  document.body.classList.add("auth-view");
  document.body.classList.remove("app-view");

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
  if (userFormElement.elements.telefoneWhatsapp) {
    userFormElement.elements.telefoneWhatsapp.value = "";
  }

  if (userFormTitleElement instanceof HTMLElement) {
    userFormTitleElement.textContent = "Novo usuário";
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
  if (userFormElement.elements.telefoneWhatsapp) {
    userFormElement.elements.telefoneWhatsapp.value =
      user.telefoneWhatsapp || user.telefone_whatsapp || "";
  }

  if (userFormTitleElement instanceof HTMLElement) {
    userFormTitleElement.textContent = "Editar usuário";
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
  usersListElement.replaceChildren();

  usersCache.forEach((user) => {
    const card = document.createElement("article");
    card.className = "user-card";

    const main = document.createElement("div");
    main.className = "user-card-main";
    const title = document.createElement("p");
    title.className = "user-card-title";
    title.textContent = user.name;
    const meta = document.createElement("div");
    meta.className = "user-card-meta";
    const email = document.createElement("span");
    email.className = "user-card-email";
    email.textContent = user.email;
    const role = document.createElement("span");
    role.className = "user-card-role";
    role.textContent = auth.getRoleLabel(user.role);
    const phone = document.createElement("span");
    phone.className = "user-card-phone";
    phone.textContent =
      user.telefoneWhatsapp || user.telefone_whatsapp || "Sem WhatsApp";
    meta.append(email, role, phone);
    main.append(title, meta);

    const side = document.createElement("div");
    side.className = "user-card-side";
    const badge = document.createElement("span");
    badge.className = `badge ${user.active ? "is-active" : "is-inactive"}`;
    badge.textContent = user.active ? "Ativo" : "Inativo";
    const editButton = document.createElement("button");
    editButton.className = "secondary-button";
    editButton.type = "button";
    editButton.dataset.editUserId = user.id;
    editButton.textContent = "Editar";
    side.append(badge, editButton);

    card.append(main, side);
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

async function renderDashboard() {
  const currentUser = await auth.getCurrentUser();

  if (!currentUser) {
    await renderPageState();
    return;
  }

  showOnlyPanel(appPanelElement);
  applyDashboardCards(currentUser);
  resetUserForm();
  if (auth.canAccessUserManagement(currentUser)) {
    await renderUsersList();
  }
  hideErrorNoticeOnly();

  if (
    sessionUserElement instanceof HTMLElement &&
    sessionUserNameElement instanceof HTMLElement &&
    sessionUserRoleElement instanceof HTMLElement
  ) {
    sessionUserNameElement.textContent = currentUser.name;
    sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
  }

  if (dashboardWelcomeTitleElement instanceof HTMLElement) {
    dashboardWelcomeTitleElement.textContent = `Olá, ${currentUser.name}`;
  }
}

async function renderPageState() {
  if (!auth || !auth.isConfigured()) {
    showConfigErrorState();
    return;
  }

  const currentUser = await auth.getCurrentUser();

  if (currentUser) {
    if (isCafeDemoReturnRequested() && redirectUserByRole(currentUser)) {
      return;
    }

    await renderDashboard();
    return;
  }

  const hasUsers = await auth.hasUsers();

  if (!hasUsers) {
    showOnlyPanel(bootstrapPanelElement);
    hideNotice();
    return;
  }

  showOnlyPanel(loginPanelElement);
  hideNotice();
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
    await renderDashboard();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha ao criar admin.", "error");
  }
});

function updateRememberedEmailStorage() {
  if (
    !(loginEmailElement instanceof HTMLInputElement) ||
    !(rememberEmailElement instanceof HTMLInputElement)
  ) {
    return;
  }

  try {
    const email = loginEmailElement.value.trim();

    if (rememberEmailElement.checked && email) {
      localStorage.setItem(REMEMBERED_EMAIL_STORAGE_KEY, email);
      return;
    }

    localStorage.removeItem(REMEMBERED_EMAIL_STORAGE_KEY);
  } catch (error) {
    console.warn("Não foi possível atualizar o e-mail lembrado.", error);
  }
}

if (
  loginEmailElement instanceof HTMLInputElement &&
  rememberEmailElement instanceof HTMLInputElement
) {
  try {
    const rememberedEmail = localStorage.getItem(REMEMBERED_EMAIL_STORAGE_KEY);

    if (rememberedEmail) {
      loginEmailElement.value = rememberedEmail;
      rememberEmailElement.checked = true;
    }
  } catch (error) {
    console.warn("Não foi possível carregar o e-mail lembrado.", error);
  }

  rememberEmailElement.addEventListener("change", updateRememberedEmailStorage);
  loginEmailElement.addEventListener("change", updateRememberedEmailStorage);
}

passwordToggleElement?.addEventListener("click", () => {
  if (
    !(passwordToggleElement instanceof HTMLButtonElement) ||
    !(loginPasswordElement instanceof HTMLInputElement)
  ) {
    return;
  }

  const shouldShowPassword = loginPasswordElement.type === "password";
  loginPasswordElement.type = shouldShowPassword ? "text" : "password";
  passwordToggleElement.textContent = shouldShowPassword ? "Ocultar" : "Mostrar";
  passwordToggleElement.setAttribute("aria-pressed", String(shouldShowPassword));
  loginPasswordElement.focus();
});

loginFormElement?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideNotice();

  if (!(loginFormElement instanceof HTMLFormElement)) {
    return;
  }

  if (
    loginSubmitButtonElement instanceof HTMLButtonElement &&
    loginSubmitButtonElement.disabled
  ) {
    return;
  }

  if (loginSubmitButtonElement instanceof HTMLButtonElement) {
    loginSubmitButtonElement.disabled = true;
    loginSubmitButtonElement.setAttribute("aria-busy", "true");
  }

  updateRememberedEmailStorage();
  const formData = new FormData(loginFormElement);

  try {
    const { user } = await auth.login(formData.get("email"), formData.get("password"));

    if (isCafeDemoReturnRequested() && redirectUserByRole(user)) {
      return;
    }

    await renderDashboard();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha no login.", "error");
  } finally {
    if (loginSubmitButtonElement instanceof HTMLButtonElement) {
      loginSubmitButtonElement.disabled = false;
      loginSubmitButtonElement.removeAttribute("aria-busy");
    }
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
        telefoneWhatsapp: formData.get("telefoneWhatsapp"),
      });
      showNotice("Usuario atualizado com sucesso.");
    } else {
      await auth.createUser({
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        role: formData.get("role"),
        active: formData.get("active") === "on",
        telefoneWhatsapp: formData.get("telefoneWhatsapp"),
      });
      showNotice("Usuario criado com sucesso.");
    }

    await renderDashboard();
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
