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
  var ANALYSIS_LOADING = "Calculando pendências...";
  var ENTRY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var state = {
    page: 1,
    periodStart: "",
    periodEnd: "",
    kpis: null,
    analysisKpis: false,
    analysisLoading: false,
    possibleLoading: false,
    lastAudit: null,
  };

  var VIEW_TITLES = {
    high: "Conciliados automaticamente",
    suggested: "Pendências — Suggested",
    ambiguous: "Pendências — Ambiguous",
    unmatched_omie: "Pendências — Omie sem banco",
    unmatched_bank: "Pendências — banco sem Omie",
    internal_transfer: "Transferências internas",
    possible_aggregation: "Pendências — possíveis agrupamentos",
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

  function formatDateBr(value) {
    var match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? match[3] + "/" + match[2] + "/" + match[1] : String(value || "");
  }

  function dlRow(label, value) {
    if (value == null || value === "") return "";
    return "<dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(String(value)) + "</dd>";
  }

  function formatCount(value) {
    if (value == null) return "—";
    return String(value);
  }

  function reviewUrl() {
    return String(config.url || "").replace(/\/$/, "") + "/functions/v1/financial-recon-review";
  }

  function decideUrl() {
    return String(config.url || "").replace(/\/$/, "") + "/functions/v1/financial-recon-decide";
  }

  async function invokeEdge(url, action, payload) {
    if (!auth || typeof auth.getEdgeFunctionFetchHeaders !== "function") {
      throw new Error("Auth indisponível.");
    }
    var headers = await auth.getEdgeFunctionFetchHeaders();
    var response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var data = await response.json().catch(function () {
      return null;
    });
    if (!response.ok) {
      var raw = (data && (data.error || data.message)) || "Falha na revisão financeira.";
      throw new Error(/invalid input syntax for type uuid/i.test(raw) ? "Identificador financeiro inválido." : raw);
    }
    return data;
  }

  async function invokeReview(action, payload) {
    try {
      return await invokeEdge(reviewUrl(), action, payload);
    } catch (error) {
      if (action === "analysis" || action === "possible_aggregations") {
        throw new Error(ANALYSIS_ERROR);
      }
      throw error;
    }
  }

  function currentFilters() {
    return {
      period_start: document.querySelector("#fin-period-start")?.value || state.periodStart,
      period_end: document.querySelector("#fin-period-end")?.value || state.periodEnd,
      origin: document.querySelector("#fin-origin")?.value || "all",
      view: document.querySelector("#fin-view")?.value || "suggested",
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
      kpiCard("Conciliados high", kpis.high_count, kpis.high_cents, "persistido"),
      kpiCard(
        "High recomputado",
        kpis.high_recomputed_count,
        kpis.high_recomputed_cents,
        kpis.high_unpersisted_count
          ? kpis.high_unpersisted_count + " ainda não persistidos"
          : "análise",
      ),
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
      listBodyElement.innerHTML = '<tr><td colspan="9">Nenhum item neste filtro.</td></tr>';
      return;
    }
    listBodyElement.innerHTML = rows
      .map(function (row) {
        var cta = row.persisted
          ? '<button type="button" class="op-btn op-btn--ghost" data-open="1">Ver</button>'
          : '<button type="button" class="op-btn" data-review="1">Revisar</button>';
        return (
          "<tr data-id=\"" +
          escapeHtml(row.id) +
          "\" data-persisted=\"" +
          (row.persisted ? "1" : "0") +
          "\" data-omie=\"" +
          escapeHtml(row.omie_entry_id || "") +
          "\" data-bank=\"" +
          escapeHtml(row.bank_entry_id || "") +
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
          escapeHtml(row.evidence_label || (row.evidence_summary || []).join(" · ") || "—") +
          "</td>" +
          "<td>" +
          cta +
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
      "</p></div>" +
      (detail.decision_html || "");
  }

  function setListNote(view) {
    if (!(listNoteElement instanceof HTMLElement)) return;
    var notes = {
      suggested: "Maior valor primeiro. Confirmar cria grupo humano; rejeitar impede a sugestão de reaparecer.",
      ambiguous: "Escolha um candidato ou marque nenhum destes. Não é fraude.",
      unmatched_omie: "Não conciliado. Não é erro nem fraude. Dá para associar manualmente ou manter.",
      unmatched_bank: "Não conciliado. Não é erro nem fraude.",
      possible_aggregation: "Diagnóstico — não conciliado. Sem auto-match.",
      internal_transfer: "Transferência interna — não misturar com receita/despesa. Somente visualização.",
      high: "Conciliados automaticamente: 601 high. Somente visualização nesta rodada.",
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
    var persistedView = filters.view === "high" || filters.view === "internal_transfer";
    if (listMetaElement) listMetaElement.textContent = persistedView ? "Carregando…" : ANALYSIS_LOADING;
    if (!persistedView && listBodyElement) {
      listBodyElement.innerHTML = '<tr><td colspan="9">' + ANALYSIS_LOADING + "</td></tr>";
    }
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
            '<tr><td colspan="9">' + escapeHtml(ANALYSIS_ERROR) + "</td></tr>";
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

  function candidateRadioName(reviewType) {
    return reviewType === "unmatched_bank" ? "selected_omie_entry_id" : "selected_bank_entry_id";
  }

  function candidateTable(candidates, reviewType) {
    if (!candidates || !candidates.length) return "";
    var radioName = candidateRadioName(reviewType);
    var rows = candidates
      .map(function (row) {
        return (
          "<tr>" +
          "<td><input type=\"radio\" name=\"" +
          radioName +
          "\" value=\"" +
          escapeHtml(row.entry_id) +
          "\" " +
          (row.diagnostic_only || row.blocked ? "disabled" : "") +
          " /></td>" +
          "<td>" +
          escapeHtml(formatDateBr(row.settlement_date)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatMoneyCents(row.amount_cents)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.description || row.person_name || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(row.account_label || row.direction_label || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(row.date_distance_days == null ? "—" : String(row.date_distance_days)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.amount_delta_cents == null ? "—" : formatMoneyCents(row.amount_delta_cents)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.status_label || "—") +
          (row.blocked ? " · já usado" : "") +
          "</td></tr>"
        );
      })
      .join("");
    return (
      '<div class="fin-table-wrap"><table class="gestao-channel-table fin-table fin-candidate-table">' +
      "<thead><tr><th></th><th>Data</th><th>Valor</th><th>Nome / histórico</th><th>Conta</th><th>Dias</th><th>Diferença</th><th>Status</th></tr></thead>" +
      "<tbody>" +
      rows +
      "</tbody></table></div>"
    );
  }

  function originBlock(title, side) {
    if (!side) return "";
    var body =
      dlRow("Tipo da fonte", side.source_type) +
      dlRow("Arquivo", side.filename) +
      dlRow("Parser", side.parser_name) +
      dlRow("Versão do parser", side.parser_version) +
      dlRow("Importado em", side.imported_at ? formatDateBr(side.imported_at) : "") +
      dlRow("Linha da fonte", side.source_row) +
      dlRow("FITID / registro", side.source_record_id) +
      dlRow("Conta", side.account_label);
    if (!body) return "";
    return "<div><h4>" + escapeHtml(title) + "</h4><dl>" + body + "</dl></div>";
  }

  function omieAmountCents(omie) {
    if (!omie) return null;
    if (omie.settled_amount_cents != null) return omie.settled_amount_cents;
    return omie.gross_amount_cents;
  }

  function candidateAsBank(row) {
    if (!row) return null;
    return {
      id: row.entry_id,
      settlement_date: row.settlement_date,
      direction_label: row.direction_label,
      amount_cents: row.amount_cents,
      account_label: row.account_label,
      description: row.description,
      person_name: row.person_name,
      source_record_id: row.source_record_id,
      amount_delta_cents: row.amount_delta_cents,
      date_distance_days: row.date_distance_days,
    };
  }

  function displayedBank(data) {
    if (!data) return null;
    if (data.review_type === "unmatched_bank") return data.bank || null;
    var form = document.querySelector("#fin-decision-form");
    var selected = form && form.querySelector('input[name="selected_bank_entry_id"]:checked');
    if (selected) {
      var row = (data.candidates || []).find(function (item) {
        return item.entry_id === selected.value;
      });
      if (row) return candidateAsBank(row);
    }
    return data.bank || null;
  }

  function previewBank(data) {
    var selected = displayedBank(data);
    if (selected) return selected;
    if (!data || data.review_type === "unmatched_bank") return null;
    var first = (data.candidates || []).find(function (row) {
      return !row.blocked;
    });
    return first ? candidateAsBank(first) : null;
  }

  function displayedOmie(data) {
    if (!data) return null;
    if (data.review_type !== "unmatched_bank") return data.omie || null;
    var form = document.querySelector("#fin-decision-form");
    var selected = form && form.querySelector('input[name="selected_omie_entry_id"]:checked');
    if (selected) {
      var row = (data.candidates || []).find(function (item) {
        return item.entry_id === selected.value;
      });
      if (row) {
        return {
          id: row.entry_id,
          person_name: row.person_name,
          settled_amount_cents: row.amount_cents,
          gross_amount_cents: row.amount_cents,
        };
      }
    }
    return data.omie || null;
  }

  function omieSideHtml(omie) {
    if (!omie) {
      return (
        '<div class="fin-omie-empty"><h3>Omie</h3>' +
        "<p>Nenhum lançamento Omie associado a este movimento.</p></div>"
      );
    }
    return (
      "<div><h3>Omie</h3><dl>" +
      dlRow("Pessoa", omie.person_name) +
      dlRow("Data de pagamento/recebimento", formatDateBr(omie.settlement_date)) +
      dlRow("Tipo", omie.type_label) +
      dlRow("Valor original", formatMoneyCents(omie.gross_amount_cents)) +
      dlRow("Valor pago/recebido", formatMoneyCents(omie.settled_amount_cents)) +
      dlRow("Saldo em aberto", formatMoneyCents(omie.open_amount_cents)) +
      dlRow("Impostos", omie.tax_cents == null ? "" : formatMoneyCents(omie.tax_cents)) +
      dlRow("Descrição", omie.description) +
      dlRow("Categoria da fonte", omie.category_source) +
      dlRow("Documento", omie.document_number) +
      dlRow("Parcela", omie.installment) +
      dlRow("Emissão", omie.issue_date ? formatDateBr(omie.issue_date) : "") +
      dlRow("Vencimento", omie.due_date ? formatDateBr(omie.due_date) : "") +
      dlRow("Competência", omie.competence_date ? formatDateBr(omie.competence_date) : "") +
      dlRow("Forma de pagamento", omie.payment_method) +
      dlRow("Referência externa", omie.external_reference) +
      "</dl></div>"
    );
  }

  function sicrediSideHtml(bank, corr) {
    if (!bank) {
      return (
        '<div class="fin-sicredi-empty" id="fin-sicredi-panel">' +
        "<h3>Possível movimento no Sicredi</h3>" +
        "<p>Nenhum movimento bancário candidato foi encontrado.</p></div>"
      );
    }
    var amountDelta = bank.amount_delta_cents != null ? bank.amount_delta_cents : corr && corr.amount_delta_cents;
    var dateDelta = bank.date_distance_days != null ? bank.date_distance_days : corr && corr.date_distance_days;
    return (
      '<div id="fin-sicredi-panel"><h3>Possível movimento no Sicredi</h3><dl>' +
      dlRow("Data", formatDateBr(bank.settlement_date)) +
      dlRow("Conta Yes", bank.account_label) +
      dlRow("Crédito/débito", bank.direction_label) +
      dlRow("Valor", formatMoneyCents(bank.amount_cents)) +
      dlRow("Histórico bancário", bank.description) +
      dlRow("Pessoa no extrato", bank.person_name) +
      dlRow("FITID", bank.source_record_id) +
      dlRow("Referência bancária", bank.external_reference) +
      (amountDelta == null ? "" : dlRow("Diferença de valor", formatMoneyCents(amountDelta))) +
      (dateDelta == null ? "" : dlRow("Diferença de dias", String(dateDelta))) +
      (bank.looks_like_transfer ? dlRow("Sinal de transferência", "Histórico compatível com transferência interna") : "") +
      "</dl></div>"
    );
  }

  function evidenceHtml(corr) {
    var lines = (corr && corr.evidence_lines) || [];
    if (!lines.length && corr) {
      lines = [corr.amount_delta_label, corr.date_delta_label, corr.party_match_label, corr.why_label].filter(Boolean);
    }
    return (
      '<section class="fin-correspondence"><h3>Evidência</h3><ul>' +
      lines
        .map(function (line) {
          return "<li>" + escapeHtml(line) + "</li>";
        })
        .join("") +
      "</ul></section>"
    );
  }

  function hasSelectableCandidate(candidates) {
    return (candidates || []).some(function (row) {
      return !row.diagnostic_only && !row.blocked;
    });
  }

  function canConfirmPair(data) {
    var omie = displayedOmie(data);
    var bank = displayedBank(data);
    return !!(financialEntryId(omie && omie.id) && financialEntryId(bank && bank.id));
  }

  function refreshAuditDecision() {
    var data = state.lastAudit;
    if (!data) return;
    var form = document.querySelector("#fin-decision-form");
    var panel = document.querySelector("#fin-sicredi-panel");
    var preview = document.querySelector("#fin-associate-preview");
    var confirmBtn = form && form.querySelector('button[value="confirm_match"]');
    var bank = displayedBank(data);
    var omie = displayedOmie(data);
    if (panel && data.review_type !== "unmatched_bank") {
      panel.outerHTML = sicrediSideHtml(previewBank(data), data.correspondence || {});
    }
    var ready = canConfirmPair(data);
    if (confirmBtn) confirmBtn.disabled = !ready;
    if (preview) {
      if (ready) {
        preview.hidden = false;
        preview.textContent =
          "Você está prestes a associar: Omie " +
          formatMoneyCents(omieAmountCents(omie)) +
          " com Sicredi " +
          formatMoneyCents(bank && bank.amount_cents);
      } else {
        preview.hidden = true;
        preview.textContent = "";
      }
    }
  }

  function renderAdminAudit(data, decisionHtml) {
    if (!(detailElement instanceof HTMLElement) || !(detailBodyElement instanceof HTMLElement)) return;
    state.lastAudit = data;
    detailElement.classList.remove("hidden");
    var omie = data.omie || null;
    var bank = previewBank(data);
    var corr = data.correspondence || {};
    var tech =
      '<details class="fin-technical"><summary>Informações técnicas</summary>' +
      (data.origin ? '<div class="fin-detail-grid">' + originBlock("Omie", data.origin.omie) + originBlock("Sicredi", data.origin.sicredi) + "</div>" : "") +
      (data.technical
        ? "<dl>" +
          dlRow("Regra", data.technical.rule_version) +
          dlRow("Tipo da fila", data.technical.review_type) +
          dlRow("Omie entry", data.technical.omie_entry_id) +
          dlRow("Sicredi entry", data.technical.bank_entry_id) +
          dlRow("Score", data.technical.score) +
          dlRow("party_match", data.technical.party_match) +
          dlRow("candidate_count", data.technical.candidate_count) +
          "</dl>"
        : "") +
      "</details>";
    detailBodyElement.innerHTML =
      '<div class="fin-detail-grid">' +
      omieSideHtml(omie) +
      sicrediSideHtml(bank, corr) +
      "</div>" +
      evidenceHtml(corr) +
      (decisionHtml || "") +
      tech;
    refreshAuditDecision();
  }

  function financialEntryId(value) {
    var text = String(value || "").trim();
    return ENTRY_UUID_RE.test(text) ? text : "";
  }

  function reviewCasePayload(row, filters) {
    var omieId = financialEntryId(row.getAttribute("data-omie"));
    var bankId = financialEntryId(row.getAttribute("data-bank"));
    var payload = {
      period_start: filters.period_start,
      period_end: filters.period_end,
      review_type: filters.view,
    };
    if (omieId) payload.omie_entry_id = omieId;
    if (bankId) payload.bank_entry_id = bankId;
    return payload;
  }

  async function openReviewCase(row) {
    var filters = currentFilters();
    var data = await invokeEdge(decideUrl(), "review_case", reviewCasePayload(row, filters));
    var actions = data.allowed_actions || [];
    var showConfirm =
      actions.indexOf("confirm_match") >= 0 &&
      !!(data.bank || data.omie) &&
      !!(data.bank || hasSelectableCandidate(data.candidates));
    var decision =
      '<form id="fin-decision-form" class="fin-decision" data-review-type="' +
      escapeHtml(filters.view) +
      '" data-omie="' +
      escapeHtml((data.omie && data.omie.id) || "") +
      '" data-bank="' +
      escapeHtml((data.bank && data.bank.id) || "") +
      '" data-entry="' +
      escapeHtml(data.focus_id || "") +
      '"><h3>Decisão</h3>' +
      (data.candidates && data.candidates.length
        ? '<section class="fin-candidates"><h3>Candidatos</h3>' +
          candidateTable(data.candidates, filters.view) +
          "</section>"
        : "") +
      '<p id="fin-associate-preview" class="fin-associate-preview" hidden></p>' +
      '<label class="fin-note-label">Observação da revisão<textarea name="reason" maxlength="500" rows="4" placeholder="Opcional"></textarea></label>' +
      '<p id="fin-decision-error" class="fin-decision-error"></p><div class="fin-decision-actions">';
    if (showConfirm) {
      decision +=
        '<button type="submit" class="op-btn" name="decide" value="confirm_match" disabled>Confirmar conciliação</button>';
    }
    if (actions.indexOf("reject_suggestion") >= 0 && filters.view === "suggested") {
      decision += '<button type="submit" class="op-btn op-btn--ghost" name="decide" value="reject_suggestion">Rejeitar sugestão</button>';
    }
    if (actions.indexOf("reject_ambiguous") >= 0 && filters.view === "ambiguous") {
      decision += '<button type="submit" class="op-btn op-btn--ghost" name="decide" value="reject_ambiguous">Nenhum destes</button>';
    }
    if (actions.indexOf("mark_unmatched") >= 0) {
      decision += '<button type="submit" class="op-btn op-btn--ghost" name="decide" value="mark_unmatched">Manter não conciliado</button>';
    }
    if (actions.indexOf("mark_awaiting_settlement") >= 0) {
      decision += '<button type="submit" class="op-btn op-btn--ghost" name="decide" value="mark_awaiting_settlement">Aguardando liquidação</button>';
    }
    if (actions.indexOf("mark_possible_aggregation") >= 0) {
      decision += '<button type="submit" class="op-btn op-btn--ghost" name="decide" value="mark_possible_aggregation">Possível agrupamento</button>';
    }
    decision += "</div></form>";
    renderAdminAudit(data, decision);
  }

  async function submitDecision(form, submitter) {
    var action = (submitter && submitter.getAttribute("name") === "decide" && submitter.value) || "";
    var selectedBank = form.querySelector('input[name="selected_bank_entry_id"]:checked');
    var selectedOmie = form.querySelector('input[name="selected_omie_entry_id"]:checked');
    var omieId =
      financialEntryId((selectedOmie && selectedOmie.value) || form.getAttribute("data-omie")) || "";
    var bankId =
      financialEntryId((selectedBank && selectedBank.value) || form.getAttribute("data-bank")) || "";
    if (action === "confirm_match" && (!omieId || !bankId)) {
      var box = document.querySelector("#fin-decision-error");
      if (box) box.textContent = "Selecione o movimento Sicredi para confirmar a conciliação.";
      return;
    }
    var payload = {
      review_type: form.getAttribute("data-review-type"),
      omie_entry_id: omieId || undefined,
      bank_entry_id: bankId || undefined,
      selected_bank_entry_id: selectedBank && financialEntryId(selectedBank.value) || undefined,
      selected_omie_entry_id: selectedOmie && financialEntryId(selectedOmie.value) || undefined,
      reason: form.reason && form.reason.value,
      period_start: currentFilters().period_start,
      period_end: currentFilters().period_end,
    };
    var buttons = form.querySelectorAll("button");
    buttons.forEach(function (button) {
      button.disabled = true;
    });
    try {
      await invokeEdge(decideUrl(), action, payload);
      if (detailElement) detailElement.classList.add("hidden");
      await loadList();
    } finally {
      buttons.forEach(function (button) {
        button.disabled = false;
      });
      refreshAuditDecision();
    }
  }

  function bindEvents() {
    filtersForm?.addEventListener("submit", function (event) {
      event.preventDefault();
      state.page = 1;
      loadList().catch(function (error) {
        if (listBodyElement) {
          listBodyElement.innerHTML =
            '<tr><td colspan="9">' + escapeHtml(error instanceof Error ? error.message : "Falha") + "</td></tr>";
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
      listBodyElement.querySelectorAll("tr[aria-selected]").forEach(function (node) {
        node.removeAttribute("aria-selected");
      });
      row.setAttribute("aria-selected", "true");
      if (row.getAttribute("data-persisted") === "1") {
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
        return;
      }
      openReviewCase(row).catch(function (error) {
        if (detailBodyElement) {
          detailElement?.classList.remove("hidden");
          detailBodyElement.textContent = error instanceof Error ? error.message : "Falha ao abrir caso.";
        }
      });
    });
    detailBodyElement?.addEventListener("change", function (event) {
      var input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "radio") return;
      if (input.name !== "selected_bank_entry_id" && input.name !== "selected_omie_entry_id") return;
      refreshAuditDecision();
    });
    detailBodyElement?.addEventListener("submit", function (event) {
      var form = event.target;
      if (!(form instanceof HTMLFormElement) || form.id !== "fin-decision-form") return;
      event.preventDefault();
      submitDecision(form, event.submitter).catch(function (error) {
        var box = document.querySelector("#fin-decision-error");
        if (box) box.textContent = error instanceof Error ? error.message : "Falha ao gravar decisão.";
      });
    });
    document.querySelector("#fin-detail-close")?.addEventListener("click", function () {
      if (detailElement) detailElement.classList.add("hidden");
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
          '<tr><td colspan="9">' +
          escapeHtml(error instanceof Error ? error.message : "Falha ao carregar conciliação.") +
          "</td></tr>";
      }
    }
  }

  boot();
})();
