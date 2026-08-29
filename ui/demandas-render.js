(function attachYesHotelDemandasRender(globalScope) {
  function resolveDom(dom) {
    const target = dom || globalScope.document;
    if (!target || typeof target.createElement !== "function") {
      throw new Error("DOM indisponivel para renderizar Demandas.");
    }
    return target;
  }

  function el(dom, tag, props) {
    const node = dom.createElement(tag);
    if (!props) {
      return node;
    }
    if (props.className) {
      node.className = props.className;
    }
    if (props.text != null) {
      node.textContent = String(props.text);
    }
    if (props.type) {
      node.type = props.type;
    }
    return node;
  }

  function appendMetaText(dom, host, text) {
    host.append(el(dom, "span", { text: text }));
  }

  function appendBadge(dom, host, text, extraClass) {
    host.append(
      el(dom, "span", {
        className: extraClass ? `demandas-badge ${extraClass}` : "demandas-badge",
        text: text,
      }),
    );
  }

  function fillAssigneeSelect(select, users, dom) {
    const doc = resolveDom(dom);
    if (!select || typeof select.replaceChildren !== "function") {
      return;
    }
    select.replaceChildren();
    (users || []).forEach(function (user) {
      const opt = doc.createElement("option");
      opt.value = String(user && user.id ? user.id : "");
      opt.textContent = String(user && user.nome ? user.nome : "");
      select.append(opt);
    });
  }

  function formatDateBr(value) {
    const raw = String(value == null ? "" : value);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) {
      return raw;
    }
    return match[3] + "/" + match[2] + "/" + match[1];
  }

  function prioridadeLabel(value) {
    if (value === "alta") {
      return "Alta";
    }
    if (value === "baixa") {
      return "Baixa";
    }
    if (value === "media") {
      return "Média";
    }
    return String(value || "");
  }

  function tipoLabel(value) {
    if (value === "corretiva") {
      return "Corretiva";
    }
    if (value === "programada") {
      return "Programada";
    }
    return String(value || "");
  }

  function descriptionSnippet(value, maxLen) {
    const limit = typeof maxLen === "number" && maxLen > 0 ? maxLen : 110;
    const raw = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!raw) {
      return "";
    }
    if (raw.length <= limit) {
      return raw;
    }
    return raw.slice(0, limit).trim() + "…";
  }

  function appendLabeled(dom, host, label, value) {
    const row = el(dom, "div", { className: "demandas-card-row" });
    row.append(el(dom, "span", { className: "demandas-card-label", text: label }));
    row.append(el(dom, "span", { className: "demandas-card-value", text: value }));
    host.append(row);
  }

  function appendStatusRow(dom, host, row, options) {
    const status = String((row && row.status) || "");
    const statusRow = el(dom, "div", { className: "demandas-card-row demandas-card-row--wide" });
    statusRow.append(el(dom, "span", { className: "demandas-card-label", text: "Status" }));
    appendBadge(
      dom,
      statusRow,
      (options && options.statusLabel) || status,
      status ? "is-status-" + status : "",
    );
    if (options && options.overdue) {
      appendBadge(dom, statusRow, "Vencida", "is-vencida");
    }
    host.append(statusRow);
  }

  function appendDetailBlock(dom, wrap, title, fill) {
    const section = el(dom, "section", { className: "demandas-detail-block" });
    section.append(el(dom, "h3", { className: "demandas-detail-block-title", text: title }));
    const meta = el(dom, "div", { className: "demandas-detail-meta" });
    fill(meta);
    section.append(meta);
    wrap.append(section);
  }

  function buildCard(row, options, dom) {
    const doc = resolveDom(dom);
    const overdue = Boolean(options && options.overdue);
    const status = String((row && row.status) || "");
    const prioridade = String((row && row.prioridade) || "");
    const classes = ["demandas-card"];
    if (overdue) {
      classes.push("is-vencida");
    }
    if (prioridade === "alta") {
      classes.push("is-alta");
    }
    if (status === "aguardando_validacao") {
      classes.push("is-validacao");
    }
    const card = el(doc, "article", { className: classes.join(" ") });
    if (typeof card.setAttribute === "function") {
      card.setAttribute("tabindex", "0");
    }
    card.append(
      el(doc, "strong", {
        className: "demandas-card-title",
        text: row && row.titulo ? row.titulo : "",
      }),
    );
    const head = el(doc, "div", { className: "demandas-card-head" });
    if (prioridade) {
      appendBadge(doc, head, prioridadeLabel(prioridade), "is-prioridade-" + prioridade);
    }
    appendBadge(
      doc,
      head,
      (options && options.statusLabel) || status,
      status ? "is-status-" + status : "",
    );
    if (overdue) {
      appendBadge(doc, head, "Vencida", "is-vencida");
    }
    if (row && row.exigir_foto) {
      appendBadge(doc, head, "Foto obrigatória", "is-foto");
    }
    card.append(head);
    const body = el(doc, "div", { className: "demandas-card-body" });
    if (!options || options.showExecutor !== false) {
      appendLabeled(doc, body, "Responsável", String((row && row.executor_nome) || ""));
    }
    appendLabeled(doc, body, "Prazo", formatDateBr(row && row.data_prevista_conclusao));
    const snippet = descriptionSnippet(row && row.descricao);
    if (snippet) {
      body.append(el(doc, "p", { className: "demandas-card-snippet", text: snippet }));
    }
    if (row && row.sem_local_especifico) {
      body.append(
        el(doc, "p", { className: "demandas-card-local-note", text: "Sem local específico" }),
      );
    }
    card.append(body);
    return card;
  }

  function appendDetailBadges(dom, host, row, options) {
    const status = String((row && row.status) || "");
    const prioridade = String((row && row.prioridade) || "");
    if (status) {
      appendBadge(
        dom,
        host,
        (options && options.statusLabel) || status,
        "is-status-" + status,
      );
    }
    if (prioridade) {
      appendBadge(dom, host, prioridadeLabel(prioridade), "is-prioridade-" + prioridade);
    }
    if (options && options.overdue) {
      appendBadge(dom, host, "Vencida", "is-vencida");
    }
  }

  function buildDetailLead(row, options, dom) {
    const doc = resolveDom(dom);
    const lead = el(doc, "div", { className: "demandas-detail-lead" });
    const badges = el(doc, "div", { className: "demandas-detail-badges" });
    appendDetailBadges(doc, badges, row, options);
    lead.append(badges);
    const facts = el(doc, "div", { className: "demandas-detail-facts" });
    appendLabeled(doc, facts, "Prazo", formatDateBr(row && row.data_prevista_conclusao));
    appendLabeled(doc, facts, "Executor", String((row && row.executor_nome) || ""));
    appendLabeled(doc, facts, "Supervisor", String((row && row.supervisor_nome) || ""));
    lead.append(facts);
    const full = String((row && row.descricao) || "").replace(/\s+/g, " ").trim();
    const snippet = descriptionSnippet(full, 160);
    if (snippet) {
      lead.append(el(doc, "p", { className: "demandas-detail-desc", text: snippet }));
    }
    return lead;
  }

  function buildDetailSummary(row, options, dom) {
    const doc = resolveDom(dom);
    const summary = el(doc, "div", { className: "demandas-detail-summary" });
    appendDetailBlock(doc, summary, "Pessoas", function (meta) {
      appendLabeled(doc, meta, "Criador", String((row && row.criador_nome) || ""));
      appendLabeled(doc, meta, "Executor", String((row && row.executor_nome) || ""));
      appendLabeled(doc, meta, "Supervisor", String((row && row.supervisor_nome) || ""));
    });
    appendDetailBlock(doc, summary, "Datas", function (meta) {
      appendLabeled(doc, meta, "Início programado", formatDateBr(row && row.data_programada_inicio));
      appendLabeled(doc, meta, "Conclusão prevista", formatDateBr(row && row.data_prevista_conclusao));
    });
    appendDetailBlock(doc, summary, "Regras", function (meta) {
      appendLabeled(doc, meta, "Tipo", tipoLabel(row && row.tipo));
      appendLabeled(doc, meta, "Foto", row && row.exigir_foto ? "Obrigatória" : "Facultativa");
      appendLabeled(
        doc,
        meta,
        "Local",
        row && row.sem_local_especifico ? "Sem local específico" : "Exige geolocalização",
      );
    });
    const full = String((row && row.descricao) || "");
    const normalized = full.replace(/\s+/g, " ").trim();
    const snippet = descriptionSnippet(normalized, 160);
    if (normalized && snippet !== normalized) {
      const desc = el(doc, "section", { className: "demandas-detail-block demandas-detail-desc-block" });
      desc.append(el(doc, "h3", { className: "demandas-detail-block-title", text: "Descrição" }));
      desc.append(el(doc, "p", { className: "demandas-detail-desc-full", text: full }));
      summary.append(desc);
    }
    return summary;
  }

  function buildDetail(row, options, dom) {
    const doc = resolveDom(dom);
    const wrap = el(doc, "div", { className: "demandas-detail" });
    wrap.append(buildDetailLead(row, options, doc));
    wrap.append(buildDetailSummary(row, options, doc));
    return wrap;
  }

  function buildHistoricoItem(item, dom) {
    const doc = resolveDom(dom);
    const li = el(doc, "li", { className: "demandas-historico-item" });
    const when = item && item.whenLabel ? item.whenLabel : "";
    const acao = item && item.acao ? item.acao : "";
    li.append(el(doc, "span", { className: "demandas-historico-when", text: when }));
    li.append(el(doc, "span", { className: "demandas-historico-acao", text: acao }));
    if (item && item.justificativa) {
      li.append(el(doc, "span", { className: "demandas-historico-just", text: item.justificativa }));
    }
    return li;
  }

  function collectExecutableSignals(node, acc) {
    if (!node) {
      return acc;
    }
    const tag = String(node.tagName || "").toUpperCase();
    if (tag === "IMG" || tag === "SVG" || tag === "SCRIPT" || tag === "IFRAME") {
      acc.tags.push(tag);
    }
    const attrs = node.attrs || node.attributes;
    if (attrs) {
      const entries =
        typeof attrs[Symbol.iterator] === "function"
          ? Array.from(attrs).map(function (attr) {
              return [attr.name, attr.value];
            })
          : Object.entries(attrs);
      entries.forEach(function (entry) {
        const name = String(entry[0] || "").toLowerCase();
        const value = String(entry[1] || "");
        if (name.startsWith("on") || /javascript:/i.test(value)) {
          acc.attrs.push(`${name}=${value}`);
        }
      });
    }
    const children = node.children || [];
    Array.from(children).forEach(function (child) {
      collectExecutableSignals(child, acc);
    });
    return acc;
  }

  globalScope.YesHotelDemandasRender = {
    fillAssigneeSelect: fillAssigneeSelect,
    descriptionSnippet: descriptionSnippet,
    buildCard: buildCard,
    buildDetailLead: buildDetailLead,
    buildDetailSummary: buildDetailSummary,
    buildDetail: buildDetail,
    buildHistoricoItem: buildHistoricoItem,
    collectExecutableSignals: collectExecutableSignals,
  };
})(typeof window !== "undefined" ? window : globalThis);
