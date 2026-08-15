(function () {
  var auth = window.YesHotelAuthApp;
  var historico = window.YesHotelGestaoHistorico;

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

  function formatPct(ratio, digits) {
    var n = Number(ratio) * 100;
    var d = digits == null ? 0 : digits;
    return n.toFixed(d).replace(".", ",") + "%";
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

  function trend(current, previous) {
    if (previous == null || previous === 0) {
      return { deltaLabel: "sem base anterior", direction: "flat" };
    }
    var pct = (current - previous) / Math.abs(previous);
    var direction = pct > 0.004 ? "up" : pct < -0.004 ? "down" : "flat";
    var sign = pct > 0 ? "+" : "";
    return {
      direction: direction,
      deltaLabel: sign + (pct * 100).toFixed(1).replace(".", ",") + "% vs período anterior",
    };
  }

  function periodKeys(dataset) {
    return Object.keys(dataset.periods).filter(function (k) {
      return k !== "2026-ytd";
    }).concat(["2026-ytd"]);
  }

  function previousKey(key) {
    var months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
    var idx = months.indexOf(key);
    if (idx <= 0) return null;
    return months[idx - 1];
  }

  function buildKpis(period, previous) {
    return [
      {
        label: "Receita de hospedagem",
        format: "money",
        valueCents: period.lodgingRevenueCents,
        trend: previous ? trend(period.lodgingRevenueCents, previous.lodgingRevenueCents) : { deltaLabel: period.label, direction: "flat" },
      },
      {
        label: "Ocupação",
        format: "pct",
        valueRatio: period.occupancy,
        trend: previous ? trend(period.occupancy, previous.occupancy) : { deltaLabel: "base 40 aptos", direction: "flat" },
      },
      {
        label: "ADR",
        format: "money",
        valueCents: period.adrCents,
        trend: previous ? trend(period.adrCents, previous.adrCents) : { deltaLabel: "Diária-A&B / RN", direction: "flat" },
      },
      {
        label: "RevPAR",
        format: "money",
        valueCents: period.revparCents,
        trend: previous ? trend(period.revparCents, previous.revparCents) : { deltaLabel: "Diária-A&B / disponíveis", direction: "flat" },
      },
      {
        label: "Room nights",
        format: "count",
        valueCount: period.roomNights,
        trend: previous ? trend(period.roomNights, previous.roomNights) : { deltaLabel: "Regular + L", direction: "flat" },
      },
      {
        label: "A&B",
        format: "money",
        valueCents: period.abCents,
        trend: { deltaLabel: "não entra no ADR", direction: "flat" },
      },
    ];
  }

  function renderPeriodTabs(dataset, selectedKey) {
    var root = document.querySelector("#gestao-period");
    if (!root) return;
    root.innerHTML = periodKeys(dataset)
      .map(function (key) {
        var label = dataset.periods[key].label.replace("/2026", "").replace("Acumulado Jan–Jul/2026", "Jan–Jul");
        return (
          '<button type="button" role="tab" data-period="' +
          escapeHtml(key) +
          '" aria-selected="' +
          (key === selectedKey ? "true" : "false") +
          '">' +
          escapeHtml(label) +
          "</button>"
        );
      })
      .join("");
  }

  function renderDashboard(dataset, selectedKey) {
    var period = dataset.periods[selectedKey];
    var previous = selectedKey === "2026-ytd" ? dataset.periods["2026-06"] : dataset.periods[previousKey(selectedKey) || ""];
    if (bannerElement instanceof HTMLElement) {
      bannerElement.textContent = dataset.banner;
    }
    var footnote = document.querySelector("#gestao-footnote");
    if (footnote) footnote.textContent = dataset.footnote;

    renderPeriodTabs(dataset, selectedKey);

    var kpisRoot = document.querySelector("#gestao-kpis");
    if (kpisRoot) {
      kpisRoot.innerHTML = buildKpis(period, previous)
        .map(function (kpi) {
          var dir = kpi.trend?.direction || "flat";
          var value = kpi.format === "pct" ? formatPct(kpi.valueRatio, 1) : formatKpiValue(kpi);
          return (
            "<article>" +
            "<span>" +
            escapeHtml(kpi.label) +
            "</span>" +
            "<strong>" +
            escapeHtml(value) +
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
      otbRoot.textContent = "Forecast / próximos 30 dias — aguardando integração online HITS";
    }

    var channelsRoot = document.querySelector("#gestao-channels");
    if (channelsRoot) {
      channelsRoot.innerHTML = (period.channels || [])
        .map(function (row) {
          var sharePct = Math.round((row.shareOfRevenue || 0) * 100);
          var barClass =
            row.group === "ota" ? "gestao-bar--ota" : row.group === "b2b" ? "gestao-bar--b2b" : row.group === "other" ? "gestao-bar--ota" : "gestao-bar--direct";
          var kindLabel =
            row.kind === "booking_engine"
              ? "engine"
              : row.kind === "ota"
                ? "ota"
                : row.kind === "b2b"
                  ? "b2b"
                  : row.kind === "unknown"
                    ? "n/d"
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
            escapeHtml(formatCount(row.stayCount)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatCount(row.roomNights)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatMoneyCents(row.lodgingRevenueCents)) +
            "</td>" +
            "<td>" +
            escapeHtml(row.adrCents == null ? "—" : formatMoneyCents(row.adrCents)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatPct(row.shareOfRevenue, 1)) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }

    var coverage = document.querySelector("#gestao-coverage");
    if (coverage && period.coverage) {
      var identified = period.coverage.revenueIdentified || 0;
      var unknownShare = 1 - identified;
      var unknownRow = (period.channels || []).find(function (c) {
        return c.code === "unknown";
      });
      if (unknownRow && unknownRow.shareOfRevenue != null) {
        unknownShare = unknownRow.shareOfRevenue;
      }
      coverage.innerHTML =
        "Cobertura de identificação de canal: <strong>" +
        escapeHtml(formatPct(identified, 1)) +
        "</strong> da receita realizada<br />Não identificado — <strong>" +
        escapeHtml(formatPct(unknownShare, 1)) +
        "</strong> da receita";
    }

    var alertsRoot = document.querySelector("#gestao-alerts");
    if (alertsRoot) {
      var alerts = period.alerts || [];
      alertsRoot.innerHTML = alerts.length
        ? alerts
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
            .join("")
        : "<li data-severity=\"info\">Nenhum alerta determinístico neste período.</li>";
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
    var canFinancial =
      typeof auth.canAccessFinancialRecon === "function"
        ? auth.canAccessFinancialRecon(currentUser)
        : currentUser.role === "admin";
    document.querySelectorAll('[data-nav="financeiro"]').forEach(function (node) {
      node.classList.toggle("hidden", !canFinancial);
    });

    if (!historico || !historico.periods) {
      showAccessState(
        "Dados históricos indisponíveis",
        "Não foi possível carregar o dataset gerencial Jan–Jul/2026.",
        "Voltar para login",
      );
      return;
    }

    var selected = historico.defaultPeriod || "2026-07";
    renderDashboard(historico, selected);
    document.querySelector("#gestao-period")?.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-period]");
      if (!btn) return;
      renderDashboard(historico, btn.getAttribute("data-period"));
    });
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
