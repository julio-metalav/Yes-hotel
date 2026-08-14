(function () {
  var auth = window.YesHotelAuthApp;
  var demoApi = window.YesHotelGestaoSaudeDemo;

  var accessStateElement = document.querySelector("#access-state");
  var contentPanelElement = document.querySelector("#content-panel");
  var sessionUserNameElement = document.querySelector("#gestao-session-user-name");
  var sessionUserRoleElement = document.querySelector("#gestao-session-user-role");
  var logoutButtonElement = document.querySelector("#logout-button");
  var bannerElement = document.querySelector("#gestao-demo-banner");

  function showAccessState(title, message, actionLabel) {
    if (!(accessStateElement instanceof HTMLElement)) return;
    if (contentPanelElement instanceof HTMLElement) {
      contentPanelElement.classList.add("hidden");
    }
    accessStateElement.classList.remove("hidden");
    accessStateElement.replaceChildren();
    var heading = document.createElement("h2");
    heading.textContent = title;
    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    var action = document.createElement("a");
    action.className = "primary-link";
    action.href = "./usuarios-login-mvp.html";
    action.textContent = actionLabel;
    accessStateElement.append(heading, paragraph, action);
  }

  function setSidebarOpen(open) {
    document.body.classList.toggle("op-sidebar-open", !!open);
    var toggle = document.querySelector("#gestao-menu-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function bindSidebarControls() {
    document.querySelector("#gestao-menu-toggle")?.addEventListener("click", function () {
      setSidebarOpen(true);
    });
    document.querySelector("#gestao-sidebar-close")?.addEventListener("click", function () {
      setSidebarOpen(false);
    });
    document.querySelector("#gestao-sidebar-backdrop")?.addEventListener("click", function () {
      setSidebarOpen(false);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth >= 1101) setSidebarOpen(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && document.body.classList.contains("op-sidebar-open")) {
        setSidebarOpen(false);
      }
    });
  }

  function formatMoneyCents(cents) {
    var value = Number(cents || 0) / 100;
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatPct(ratio) {
    return (Number(ratio) * 100).toFixed(0).replace(".", ",") + "%";
  }

  function formatCount(n) {
    return String(n);
  }

  function formatKpiValue(kpi) {
    if (kpi.format === "money") return formatMoneyCents(kpi.valueCents);
    if (kpi.format === "pct") return formatPct(kpi.valueRatio);
    return formatCount(kpi.valueCount);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderDashboard(data) {
    if (bannerElement instanceof HTMLElement) {
      bannerElement.textContent = data.banner;
    }

    var kpisRoot = document.querySelector("#gestao-kpis");
    if (kpisRoot) {
      kpisRoot.innerHTML = data.kpis
        .map(function (kpi) {
          var dir = kpi.trend?.direction || "flat";
          return (
            "<article>" +
            "<span>" +
            escapeHtml(kpi.label) +
            "</span>" +
            "<strong>" +
            escapeHtml(formatKpiValue(kpi)) +
            "</strong>" +
            '<small class="gestao-trend--' +
            dir +
            '">' +
            escapeHtml(kpi.trend?.deltaLabel || "") +
            "</small>" +
            "</article>"
          );
        })
        .join("");
    }

    var otbRoot = document.querySelector("#gestao-otb");
    if (otbRoot) {
      otbRoot.innerHTML =
        "<div><span>Ocupação já reservada</span><strong>" +
        escapeHtml(formatPct(data.otb.occupancyBooked)) +
        "</strong></div>" +
        "<div><span>Receita futura contratada</span><strong>" +
        escapeHtml(formatMoneyCents(data.otb.contractedRevenueCents)) +
        "</strong></div>" +
        "<div><span>ADR futuro</span><strong>" +
        escapeHtml(formatMoneyCents(data.otb.futureAdrCents)) +
        "</strong></div>" +
        "<div><span>Reservas futuras</span><strong>" +
        escapeHtml(formatCount(data.otb.futureReservations)) +
        "</strong></div>";
    }

    var channelsRoot = document.querySelector("#gestao-channels");
    if (channelsRoot) {
      channelsRoot.innerHTML = data.channels
        .map(function (row) {
          var sharePct = Math.round(row.shareOfReservations * 100);
          var barClass =
            row.group === "ota" ? "gestao-bar--ota" : row.group === "b2b" ? "gestao-bar--b2b" : "gestao-bar--direct";
          var kindLabel =
            row.kind === "booking_engine"
              ? "engine"
              : row.kind === "ota"
                ? "ota"
                : row.kind === "b2b"
                  ? "b2b"
                  : "direto";
          return (
            "<tr data-channel-code=\"" +
            escapeHtml(row.code) +
            '" data-channel-kind="' +
            escapeHtml(row.kind) +
            '" data-channel-group="' +
            escapeHtml(row.group) +
            '">' +
            "<td>" +
            escapeHtml(row.label) +
            '<span class="gestao-kind">' +
            escapeHtml(kindLabel) +
            "</span>" +
            '<span class="gestao-bar ' +
            barClass +
            '" aria-hidden="true"><i style="width:' +
            sharePct +
            '%"></i></span>' +
            "</td>" +
            "<td>" +
            escapeHtml(formatCount(row.reservations)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatMoneyCents(row.lodgingRevenueCents)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatMoneyCents(row.adrCents)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatPct(row.shareOfReservations)) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }

    var alertsRoot = document.querySelector("#gestao-alerts");
    if (alertsRoot) {
      alertsRoot.innerHTML = data.alerts
        .slice(0, 5)
        .map(function (alert) {
          return (
            '<li data-severity="' +
            escapeHtml(alert.severity) +
            '">' +
            escapeHtml(alert.message) +
            "</li>"
          );
        })
        .join("");
    }
  }

  async function initGestaoPage() {
    bindSidebarControls();

    if (!auth || !auth.isConfigured()) {
      showAccessState(
        "Autenticação indisponível",
        auth?.getConfigError?.() || "Configuração de autenticação indisponível.",
        "Ir para login",
      );
      return;
    }

    var currentUser = await auth.getCurrentUser();

    if (!currentUser) {
      showAccessState(
        "Login necessário",
        "Entre com um usuário interno para acessar Gestão.",
        "Fazer login",
      );
      return;
    }

    if (currentUser.role === "cafe") {
      window.location.href = "./cafe-da-manha-mvp.html";
      return;
    }

    var canManage =
      typeof auth.canAccessManagement === "function"
        ? auth.canAccessManagement(currentUser)
        : currentUser.role === "admin" || currentUser.role === "recepcao";

    if (!canManage) {
      showAccessState(
        "Acesso não permitido",
        "Gestão é restrita a admin e recepção.",
        "Voltar para login",
      );
      return;
    }

    if (accessStateElement instanceof HTMLElement) accessStateElement.classList.add("hidden");
    if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.remove("hidden");

    if (sessionUserNameElement instanceof HTMLElement) {
      sessionUserNameElement.textContent = currentUser.name;
    }
    if (sessionUserRoleElement instanceof HTMLElement) {
      sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
    }

    var canBreakfast = auth.canAccessBreakfast(currentUser);
    document.querySelectorAll('[data-nav="cafe"]').forEach(function (node) {
      node.classList.toggle("hidden", !canBreakfast);
    });

    if (!demoApi || typeof demoApi.buildDashboard !== "function") {
      showAccessState(
        "Dados demonstrativos indisponíveis",
        "Não foi possível carregar o fixture gerencial.",
        "Voltar para login",
      );
      return;
    }

    renderDashboard(demoApi.buildDashboard());
  }

  logoutButtonElement?.addEventListener("click", async function () {
    await auth.logout();
    window.location.href = "./usuarios-login-mvp.html";
  });

  initGestaoPage().catch(function (error) {
    showAccessState(
      "Falha ao abrir a tela",
      error instanceof Error ? error.message : "Erro inesperado de autenticação.",
      "Voltar para login",
    );
  });
})();
