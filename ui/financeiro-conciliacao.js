(function () {
  var auth = window.YesHotelAuthApp;
  var config = window.YES_HOTEL_SUPABASE_CONFIG || {};

  var accessStateElement = document.querySelector("#access-state");
  var contentPanelElement = document.querySelector("#content-panel");
  var sessionUserNameElement = document.querySelector("#fin-session-user-name");
  var sessionUserRoleElement = document.querySelector("#fin-session-user-role");
  var logoutButtonElement = document.querySelector("#logout-button");
  var kpisElement = document.querySelector("#fin-kpis");
  var listBodyElement = document.querySelector("#fin-list-body");
  var listTitleElement = document.querySelector("#fin-list-title");
  var listMetaElement = document.querySelector("#fin-list-meta");
  var listNoteElement = document.querySelector("#fin-list-note");
  var pagerElement = document.querySelector("#fin-pager");
  var detailElement = document.querySelector("#fin-detail");
  var detailBodyElement = document.querySelector("#fin-detail-body");
  var filtersForm = document.querySelector("#fin-filters");

  var ANALYSIS_ERROR = "Não foi possível calcular a análise neste momento.";
  var state = {
    page: 1,
    periodStart: "",
    periodEnd: "",
    kpis: null,
    analysisKpis: false,
    analysisLoading: false,
    possibleLoading: false,
  };

  var VIEW_TITLES = {
    high: "Conciliados high",
    suggested: "Suggested — análise em memória",
    ambiguous: "Ambiguous — análise em memória",
    unmatched_omie: "Não conciliado — Omie sem banco",
    unmatched_bank: "Não conciliado — banco sem Omie",
    internal_transfer: "Transferências internas",
    possible_aggregation: "Possíveis agrupamentos",
  };

  function showAccessState(title, message, actionLabel) {
    if (!(accessStateElement instanceof HTMLElement)) return;
    if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.add("hidden");
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
    var toggle = document.querySelector("#fin-menu-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function bindSidebarControls() {
    document.querySelector("#fin-menu-toggle")?.addEventListener("click", function () {
      setSidebarOpen(true);
    });
    document.querySelector("#fin-sidebar-close")?.addEventListener("click", function () {
      setSidebarOpen(false);
    });
    document.querySelector("#fin-sidebar-backdrop")?.addEventListener("click", function () {
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoneyCents(cents) {
    if (cents == null) return "—";
    return (Number(cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatCount(value) {
    if (value == null) return "—";
    return String(value);
  }

  function reviewUrl() {
    return String(config.url || "").replace(/\/$/, "") + "/functions/v1/financial-recon-review";
  }

  async function invokeReview(action, payload) {
    if (!auth || typeof auth.getEdgeFunctionFetchHeaders !== "function") {
      throw new Error("Auth indisponível.");
    }
    var headers = await auth.getEdgeFunctionFetchHeaders();
    var response = await fetch(reviewUrl(), {
      method: "POST",
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var data = await response.json().catch(function () {
      return null;
    });
    if (!response.ok) {
      if (action === "analysis" || action === "possible_aggregations") {
        throw new Error(ANALYSIS_ERROR);
      }
      throw new Error((data && (data.error || data.message)) || "Falha na revisão financeira.");
    }
    return data;
  }

  function currentFilters() {
    return {
      period_start: document.querySelector("#fin-period-start")?.value || state.periodStart,
      period_end: document.querySelector("#fin-period-end")?.value || state.periodEnd,
      origin: document.querySelector("#fin-origin")?.value || "all",
      view: document.querySelector("#fin-view")?.value || "high",
      direction: document.querySelector("#fin-direction")?.value || "all",
      account_code: document.querySelector("#fin-account")?.value || "all",
      page: state.page,
    };
  }

  function kpiCard(label, count, cents, extra, kind) {
    return (
      "<article" +
      (kind ? ' data-kind="' + escapeHtml(kind) + '"' : "") +
      "><span>" +
      escapeHtml(label) +
      "</span><strong>" +
      escapeHtml(formatCount(count)) +
      "</strong><small>" +
      escapeHtml(formatMoneyCents(cents)) +
      (extra ? " · " + extra : "") +
      "</small></article>"
    );
  }

  function renderKpis(kpis) {
    if (!(kpisElement instanceof HTMLElement) || !kpis) return;
    kpisElement.innerHTML = [
      kpiCard("Omie AR", kpis.omie_ar_count, kpis.omie_ar_cents),
      kpiCard("Omie AP", kpis.omie_ap_count, kpis.omie_ap_cents),
      kpiCard("Sicredi créditos", kpis.sicredi_credit_count, kpis.sicredi_credit_cents),
      kpiCard("Sicredi débitos", kpis.sicredi_debit_count, kpis.sicredi_debit_cents),
      kpiCard("Conciliados high", kpis.high_count, kpis.high_cents),
      kpiCard("Suggested", kpis.suggested_count, kpis.suggested_cents, "análise"),
      kpiCard("Ambiguous", kpis.ambiguous_count, kpis.ambiguous_cents, "análise"),
      kpiCard("Omie sem banco", kpis.unmatched_omie_count, kpis.unmatched_omie_cents, "não conciliado"),
      kpiCard("Banco sem Omie", kpis.unmatched_bank_count, kpis.unmatched_bank_cents, "não conciliado"),
      kpiCard("Transferências internas", kpis.transfer_count, kpis.transfer_cents, "fora de receita/despesa", "transfer"),
    ].join("");
  }

  function kindLabel(kind) {
    if (kind === "AR") return "AR";
    if (kind === "AP") return "AP";
    if (kind === "internal_transfer") return "Transferência interna";
    return "Não conciliado";
  }

  function renderRows(page) {
    if (!(listBodyElement instanceof HTMLElement)) return;
    var rows = (page && page.rows) || [];
    if (!rows.length) {
      listBodyElement.innerHTML = '<tr><td colspan="8">Nenhum item neste filtro.</td></tr>';
      return;
    }
    listBodyElement.innerHTML = rows
      .map(function (row) {
        return (
          "<tr data-id=\"" +
          escapeHtml(row.id) +
          "\" data-persisted=\"" +
          (row.persisted ? "1" : "0") +
          "\">" +
          "<td>" +
          escapeHtml(row.date || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(kindLabel(row.kind)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatMoneyCents(row.amount_cents)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.omie_label || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(row.bank_label || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(row.status || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(row.score == null ? "—" : String(row.score)) +
          "</td>" +
          "<td>" +
          escapeHtml((row.evidence_summary || []).join(" · ")) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderPager(page) {
    if (!(pagerElement instanceof HTMLElement) || !page) return;
    var totalPages = Math.max(1, Math.ceil(page.total / page.page_size));
    pagerElement.innerHTML =
      '<button type="button" class="op-btn op-btn--ghost" data-page="prev" ' +
      (page.page <= 1 ? "disabled" : "") +
      ">Anterior</button>" +
      "<span>Página " +
      page.page +
      " de " +
      totalPages +
      " · " +
      page.total +
      " itens</span>" +
      '<button type="button" class="op-btn op-btn--ghost" data-page="next" ' +
      (page.page >= totalPages ? "disabled" : "") +
      ">Próxima</button>";
  }

  function renderDetail(detail) {
    if (!(detailElement instanceof HTMLElement) || !(detailBodyElement instanceof HTMLElement)) return;
    if (!detail) {
      detailElement.classList.add("hidden");
      return;
    }
    detailElement.classList.remove("hidden");
    var transferNote = detail.kind === "internal_transfer"
      ? '<p class="fin-transfer-note">Transferência interna — não é receita nem despesa.</p>'
      : "";
    var omie = detail.omie
      ? "<div><h3>Omie</h3><dl>" +
        "<dt>Tipo</dt><dd>" +
        escapeHtml(detail.omie.type) +
        "</dd>" +
        "<dt>Settlement</dt><dd>" +
        escapeHtml(detail.omie.settlement_date) +
        "</dd>" +
        "<dt>Pessoa</dt><dd>" +
        escapeHtml(detail.omie.person_name_masked || "—") +
        "</dd>" +
        "<dt>Gross</dt><dd>" +
        escapeHtml(formatMoneyCents(detail.omie.gross_amount_cents)) +
        "</dd>" +
        "<dt>Settled</dt><dd>" +
        escapeHtml(formatMoneyCents(detail.omie.settled_amount_cents)) +
        "</dd>" +
        "<dt>Open</dt><dd>" +
        escapeHtml(formatMoneyCents(detail.omie.open_amount_cents)) +
        "</dd></dl></div>"
      : "";
    function bankBlock(title, side) {
      if (!side) return "";
      return (
        "<div><h3>" +
        escapeHtml(title) +
        "</h3><dl>" +
        "<dt>Data</dt><dd>" +
        escapeHtml(side.settlement_date) +
        "</dd>" +
        "<dt>Conta</dt><dd>" +
        escapeHtml((side.account_code || "—") + (side.account_mask ? " · **" + side.account_mask : "")) +
        "</dd>" +
        "<dt>Direção</dt><dd>" +
        escapeHtml(side.direction) +
        "</dd>" +
        "<dt>Valor</dt><dd>" +
        escapeHtml(formatMoneyCents(side.amount_cents)) +
        "</dd>" +
        "<dt>Descrição</dt><dd>" +
        escapeHtml(side.description_redacted || "—") +
        "</dd>" +
        "<dt>FITID</dt><dd>" +
        escapeHtml(side.fitid_masked || "—") +
        "</dd></dl></div>"
      );
    }
    var evidenceItems = (detail.evidence_summary || [])
      .map(function (item) {
        return "<li>" + escapeHtml(item) + "</li>";
      })
      .join("");
    var evidenceFields = Object.keys(detail.score_evidence || [])
      .filter(function (key) {
        return detail.score_evidence[key] != null && detail.score_evidence[key] !== "";
      })
      .map(function (key) {
        return "<dt>" + escapeHtml(key) + "</dt><dd>" + escapeHtml(String(detail.score_evidence[key])) + "</dd>";
      })
      .join("");
    detailBodyElement.innerHTML =
      transferNote +
      '<div class="fin-detail-grid">' +
      omie +
      bankBlock("Sicredi", detail.bank) +
      bankBlock("Débito", detail.transfer_debit) +
      bankBlock("Crédito", detail.transfer_credit) +
      "</div>" +
      '<div class="fin-evidence"><h3>Evidência</h3><ul>' +
      evidenceItems +
      "</ul><dl>" +
      evidenceFields +
      "</dl>" +
      "<p>rule_version " +
      escapeHtml(detail.rule_version) +
      " · status " +
      escapeHtml(detail.status) +
      " · created_at " +
      escapeHtml(detail.created_at || "—") +
      "</p></div>";
  }

  function setListNote(view) {
    if (!(listNoteElement instanceof HTMLElement)) return;
    var notes = {
      suggested: "Análise V1.2 em memória. Não persistido. Sem confirmação nesta rodada.",
      ambiguous: "Análise V1.2 em memória. Não persistido. Sem confirmação nesta rodada.",
      unmatched_omie: "Não conciliado. Não é erro nem fraude.",
      unmatched_bank: "Não conciliado. Não é erro nem fraude.",
      possible_aggregation: "Diagnóstico — não conciliado. Sem confirmação.",
      internal_transfer: "Transferência interna — não misturar com receita/despesa.",
      high: "",
    };
    var text = notes[view] || "";
    listNoteElement.hidden = !text;
    listNoteElement.textContent = text;
  }

  function analysisActionFor(view) {
    if (view === "possible_aggregation") return "possible_aggregations";
    return "analysis";
  }

  function mergePossibleKpis(base, extra) {
    if (!base || !extra) return extra || base;
    return Object.assign({}, base, {
      possible_aggregation_count: extra.possible_aggregation_count,
      possible_aggregation_cents: extra.possible_aggregation_cents,
    });
  }

  async function loadList() {
    var filters = currentFilters();
    if (listTitleElement) listTitleElement.textContent = VIEW_TITLES[filters.view] || "Lista";
    setListNote(filters.view);
    if (listMetaElement) listMetaElement.textContent = "Carregando…";
    var persistedView = filters.view === "high" || filters.view === "internal_transfer";
    var action = persistedView ? "high_list" : analysisActionFor(filters.view);
    if (action === "analysis") state.analysisLoading = true;
    if (action === "possible_aggregations") state.possibleLoading = true;
    try {
      var data = await invokeReview(action, filters);
      if (data.kpis) {
        state.kpis = action === "possible_aggregations" ? mergePossibleKpis(state.kpis, data.kpis) : data.kpis;
        state.analysisKpis = !persistedView;
        renderKpis(state.kpis);
      }
      renderRows(data.page);
      renderPager(data.page);
      if (listMetaElement) {
        listMetaElement.textContent =
          (data.page && data.page.total != null ? data.page.total + " itens" : "") +
          (persistedView ? " · persistido" : " · análise read-only");
      }
    } catch (error) {
      if (!persistedView) {
        if (listBodyElement) {
          listBodyElement.innerHTML =
            '<tr><td colspan="8">' + escapeHtml(ANALYSIS_ERROR) + "</td></tr>";
        }
        if (listMetaElement) listMetaElement.textContent = ANALYSIS_ERROR;
        if (listNoteElement instanceof HTMLElement) {
          listNoteElement.hidden = false;
          listNoteElement.textContent = ANALYSIS_ERROR;
        }
        return;
      }
      throw error;
    } finally {
      if (action === "analysis") state.analysisLoading = false;
      if (action === "possible_aggregations") state.possibleLoading = false;
    }
  }

  async function loadOverview() {
    var data = await invokeReview("overview", currentFilters());
    state.periodStart = data.period_start;
    state.periodEnd = data.period_end;
    var startInput = document.querySelector("#fin-period-start");
    var endInput = document.querySelector("#fin-period-end");
    if (startInput && !startInput.value) startInput.value = data.period_start;
    if (endInput && !endInput.value) endInput.value = data.period_end;
    var accountSelect = document.querySelector("#fin-account");
    if (accountSelect && data.accounts) {
      data.accounts.forEach(function (code) {
        if (accountSelect.querySelector('option[value="' + code + '"]')) return;
        var option = document.createElement("option");
        option.value = code;
        option.textContent = code;
        accountSelect.append(option);
      });
    }
    state.kpis = data.kpis;
    renderKpis(data.kpis);
    await loadList();
    if (document.querySelector("#fin-view")?.value === "high") {
      state.analysisLoading = true;
      invokeReview("analysis", Object.assign(currentFilters(), { view: "suggested", page: 1 }))
        .then(function (analysis) {
          if (analysis.kpis) {
            state.kpis = analysis.kpis;
            state.analysisKpis = true;
            renderKpis(analysis.kpis);
          }
        })
        .catch(function () {
          if (listNoteElement instanceof HTMLElement) {
            listNoteElement.hidden = false;
            listNoteElement.textContent = ANALYSIS_ERROR;
          }
        })
        .finally(function () {
          state.analysisLoading = false;
        });
    }
  }

  function bindEvents() {
    filtersForm?.addEventListener("submit", function (event) {
      event.preventDefault();
      state.page = 1;
      loadList().catch(function (error) {
        if (listBodyElement) {
          listBodyElement.innerHTML =
            '<tr><td colspan="8">' + escapeHtml(error instanceof Error ? error.message : "Falha") + "</td></tr>";
        }
      });
    });
    pagerElement?.addEventListener("click", function (event) {
      var button = event.target.closest("[data-page]");
      if (!(button instanceof HTMLElement) || button.hasAttribute("disabled")) return;
      if (button.getAttribute("data-page") === "prev") state.page = Math.max(1, state.page - 1);
      if (button.getAttribute("data-page") === "next") state.page += 1;
      loadList().catch(function () {});
    });
    listBodyElement?.addEventListener("click", function (event) {
      var row = event.target.closest("tr[data-id]");
      if (!(row instanceof HTMLElement)) return;
      if (row.getAttribute("data-persisted") !== "1") return;
      listBodyElement.querySelectorAll("tr[aria-selected]").forEach(function (node) {
        node.removeAttribute("aria-selected");
      });
      row.setAttribute("aria-selected", "true");
      invokeReview("group_detail", { group_id: row.getAttribute("data-id") })
        .then(function (data) {
          renderDetail(data.detail);
        })
        .catch(function (error) {
          if (detailBodyElement) {
            detailElement?.classList.remove("hidden");
            detailBodyElement.textContent = error instanceof Error ? error.message : "Falha ao abrir detalhe.";
          }
        });
    });
    logoutButtonElement?.addEventListener("click", async function () {
      if (auth && auth.logout) await auth.logout();
      window.location.href = "./usuarios-login-mvp.html";
    });
  }

  async function boot() {
    bindSidebarControls();
    bindEvents();
    if (!auth || typeof auth.getCurrentUser !== "function") {
      showAccessState("Login necessário", "Entre com um usuário interno admin.", "Fazer login");
      return;
    }
    var currentUser = await auth.getCurrentUser();
    if (!currentUser) {
      showAccessState("Login necessário", "Entre com um usuário interno admin.", "Fazer login");
      return;
    }
    if (currentUser.role === "cafe") {
      window.location.href = "./cafe-da-manha-mvp.html";
      return;
    }
    var canRecon =
      typeof auth.canAccessFinancialRecon === "function"
        ? auth.canAccessFinancialRecon(currentUser)
        : currentUser.role === "admin";
    if (!canRecon) {
      showAccessState(
        "Acesso não permitido",
        "Conciliação financeira é restrita a admin.",
        "Voltar para login",
      );
      return;
    }
    if (accessStateElement instanceof HTMLElement) accessStateElement.classList.add("hidden");
    if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.remove("hidden");
    if (sessionUserNameElement) sessionUserNameElement.textContent = currentUser.name;
    if (sessionUserRoleElement) sessionUserRoleElement.textContent = auth.getRoleLabel(currentUser.role);
    document.querySelectorAll('[data-nav="cafe"]').forEach(function (node) {
      node.classList.toggle("hidden", !auth.canAccessBreakfast(currentUser));
    });
    document.querySelectorAll('[data-nav="gestao"]').forEach(function (node) {
      node.classList.toggle("hidden", !auth.canAccessManagement(currentUser));
    });
    document.querySelectorAll('[data-nav="financeiro"]').forEach(function (node) {
      node.classList.toggle("hidden", !canRecon);
    });
    try {
      await loadOverview();
    } catch (error) {
      if (listBodyElement) {
        listBodyElement.innerHTML =
          '<tr><td colspan="8">' +
          escapeHtml(error instanceof Error ? error.message : "Falha ao carregar conciliação.") +
          "</td></tr>";
      }
    }
  }

  boot();
})();
