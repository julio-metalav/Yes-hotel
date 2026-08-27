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
    const card = el(doc, "button", {
      className: overdue ? "demandas-card is-vencida" : "demandas-card",
    });
    card.type = "button";
    card.append(el(doc, "strong", { className: "demandas-card-title", text: row && row.titulo ? row.titulo : "" }));
    const head = el(doc, "div", { className: "demandas-card-head" });
    appendStatusRow(doc, head, row, options);
    card.append(head);
    const body = el(doc, "div", { className: "demandas-card-body" });
    appendLabeled(doc, body, "Executor", String((row && row.executor_nome) || ""));
    appendLabeled(doc, body, "Prioridade", prioridadeLabel(row && row.prioridade));
    appendLabeled(doc, body, "Prazo", formatDateBr(row && row.data_prevista_conclusao));
    const tipo = String((row && row.tipo) || "");
    if (tipo) {
      appendLabeled(doc, body, "Tipo", tipoLabel(tipo));
    }
    card.append(body);
    return card;
  }

  function buildDetail(row, options, dom) {
    const doc = resolveDom(dom);
    const wrap = el(doc, "div", { className: "demandas-detail" });
    wrap.append(el(doc, "p", { className: "demandas-detail-desc", text: row && row.descricao ? row.descricao : "" }));
    appendDetailBlock(doc, wrap, "Dados principais", function (meta) {
      appendStatusRow(doc, meta, row, options);
      appendLabeled(doc, meta, "Tipo", tipoLabel(row && row.tipo));
      appendLabeled(doc, meta, "Prioridade", prioridadeLabel(row && row.prioridade));
    });
    appendDetailBlock(doc, wrap, "Pessoas", function (meta) {
      appendLabeled(doc, meta, "Criador", String((row && row.criador_nome) || ""));
      appendLabeled(doc, meta, "Supervisor", String((row && row.supervisor_nome) || ""));
      appendLabeled(doc, meta, "Executor", String((row && row.executor_nome) || ""));
    });
    appendDetailBlock(doc, wrap, "Datas", function (meta) {
      appendLabeled(doc, meta, "Início programado", formatDateBr(row && row.data_programada_inicio));
      appendLabeled(doc, meta, "Conclusão prevista", formatDateBr(row && row.data_prevista_conclusao));
    });
    appendDetailBlock(doc, wrap, "Regras", function (meta) {
      appendLabeled(doc, meta, "Foto", row && row.exigir_foto ? "Obrigatória" : "Facultativa");
      appendLabeled(
        doc,
        meta,
        "Local",
        row && row.sem_local_especifico ? "Sem local específico" : "Exige geolocalização",
      );
    });
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
    buildCard: buildCard,
    buildDetail: buildDetail,
    buildHistoricoItem: buildHistoricoItem,
    collectExecutableSignals: collectExecutableSignals,
  };
})(typeof window !== "undefined" ? window : globalThis);
