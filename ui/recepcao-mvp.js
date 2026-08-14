const auth = window.YesHotelAuthApp;

const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const sessionUserElement = document.querySelector("#session-user");
const sessionUserNameElement = document.querySelector("#recepcao-session-user-name");
const sessionUserRoleElement = document.querySelector("#recepcao-session-user-role");
const logoutButtonElement = document.querySelector("#logout-button");

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }

  if (contentPanelElement instanceof HTMLElement) {
    contentPanelElement.classList.add("hidden");
  }

  accessStateElement.classList.remove("hidden");
  accessStateElement.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  const action = document.createElement("a");
  action.className = "primary-link";
  action.href = "./usuarios-login-mvp.html";
  action.textContent = actionLabel;

  accessStateElement.append(heading, paragraph, action);
}

function setSidebarOpen(open) {
  document.body.classList.toggle("op-sidebar-open", !!open);
  const toggle = document.querySelector("#recepcao-menu-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindSidebarControls() {
  document.querySelector("#recepcao-menu-toggle")?.addEventListener("click", () => {
    setSidebarOpen(true);
  });
  document.querySelector("#recepcao-sidebar-close")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  document.querySelector("#recepcao-sidebar-backdrop")?.addEventListener("click", () => {
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

async function initRecepcaoPage() {
  bindSidebarControls();

  if (!auth || !auth.isConfigured()) {
    showAccessState(
      "Autenticação indisponível",
      auth?.getConfigError?.() || "Configuração de autenticação indisponível.",
      "Ir para login",
    );
    return;
  }

  const currentUser = await auth.getCurrentUser();

  if (!currentUser) {
    showAccessState(
      "Login necessário",
      "Entre com um usuário interno para acessar a recepção.",
      "Fazer login",
    );
    return;
  }

  if (currentUser.role === "cafe") {
    window.location.href = "./cafe-da-manha-mvp.html";
    return;
  }

  if (accessStateElement instanceof HTMLElement) {
    accessStateElement.classList.add("hidden");
  }

  if (contentPanelElement instanceof HTMLElement) {
    contentPanelElement.classList.remove("hidden");
  }

  const canBreakfast = auth.canAccessBreakfast(currentUser);
  document.querySelectorAll('[data-nav="cafe"]').forEach((node) => {
    node.classList.toggle("hidden", !canBreakfast);
  });

  const canManage =
    typeof auth.canAccessManagement === "function"
      ? auth.canAccessManagement(currentUser)
      : currentUser.role === "admin" || currentUser.role === "recepcao";
  document.querySelectorAll('[data-nav="gestao"]').forEach((node) => {
    node.classList.toggle("hidden", !canManage);
  });

  if (
    sessionUserElement instanceof HTMLElement &&
    sessionUserNameElement instanceof HTMLElement &&
    sessionUserRoleElement instanceof HTMLElement
  ) {
    sessionUserNameElement.textContent = currentUser.name;
    sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
  }
}

logoutButtonElement?.addEventListener("click", async () => {
  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

initRecepcaoPage().catch((error) => {
  showAccessState(
    "Falha ao abrir a tela",
    error instanceof Error ? error.message : "Erro inesperado de autenticação.",
    "Voltar para login",
  );
});
