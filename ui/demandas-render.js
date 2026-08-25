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

  function buildCard(row, options, dom) {
    const doc = resolveDom(dom);
    const overdue = Boolean(options && options.overdue);
    const card = el(doc, "button", {
      className: overdue ? "demandas-card is-vencida" : "demandas-card",
    });
    card.type = "button";
    card.append(el(doc, "strong", { text: row && row.titulo ? row.titulo : "" }));
    const meta = el(doc, "div", { className: "demandas-card-meta" });
    appendBadge(doc, meta, (options && options.statusLabel) || String((row && row.status) || ""));
    if (overdue) {
      appendBadge(doc, meta, "Vencida", "is-vencida");
    }
    appendMetaText(doc, meta, String((row && row.tipo) || ""));
    appendMetaText(doc, meta, String((row && row.prioridade) || ""));
    appendMetaText(doc, meta, `Início ${String((row && row.data_programada_inicio) || "")}`);
    appendMetaText(doc, meta, `Conclusão ${String((row && row.data_prevista_conclusao) || "")}`);
    appendMetaText(doc, meta, `Executor: ${String((row && row.executor_nome) || "")}`);
    card.append(meta);
    return card;
  }

  function buildDetail(row, options, dom) {
    const doc = resolveDom(dom);
    const wrap = el(doc, "div");
    wrap.append(el(doc, "p", { text: row && row.descricao ? row.descricao : "" }));
    const meta = el(doc, "p", { className: "demandas-card-meta" });
    appendBadge(doc, meta, (options && options.statusLabel) || String((row && row.status) || ""));
    if (options && options.overdue) {
      appendBadge(doc, meta, "Vencida", "is-vencida");
    }
    appendMetaText(doc, meta, `${String((row && row.tipo) || "")} · ${String((row && row.prioridade) || "")}`);
    appendMetaText(doc, meta, `Criador: ${String((row && row.criador_nome) || "")}`);
    appendMetaText(doc, meta, `Supervisor: ${String((row && row.supervisor_nome) || "")}`);
    appendMetaText(doc, meta, `Executor: ${String((row && row.executor_nome) || "")}`);
    appendMetaText(doc, meta, `Início programado: ${String((row && row.data_programada_inicio) || "")}`);
    appendMetaText(doc, meta, `Conclusão prevista: ${String((row && row.data_prevista_conclusao) || "")}`);
    appendMetaText(doc, meta, row && row.exigir_foto ? "Foto obrigatória" : "Foto facultativa");
    appendMetaText(
      doc,
      meta,
      row && row.sem_local_especifico ? "Sem local específico" : "Exige geolocalização",
    );
    wrap.append(meta);
    return wrap;
  }

  function buildHistoricoItem(item, dom) {
    const doc = resolveDom(dom);
    const li = el(doc, "li");
    const when = item && item.whenLabel ? item.whenLabel : "";
    const acao = item && item.acao ? item.acao : "";
    const justificativa = item && item.justificativa ? ` — ${item.justificativa}` : "";
    li.textContent = `${when} · ${acao}${justificativa}`;
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
