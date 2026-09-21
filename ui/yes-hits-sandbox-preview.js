/**
 * Painel somente leitura: reservas reais do HITS Sandbox.
 *
 * Isolado de checkin-operacional-mvp.js de propósito — não altera estado
 * operacional, não persiste nada e não toca no fluxo de chegadas.
 * Chama apenas GET /functions/v1/hits-reservations-preview; o token do
 * gateway fica no backend.
 */
(function (global) {
  "use strict";

  var doc = global.document;
  if (!doc) return;

  var panel = doc.querySelector("#op-hits-sandbox-panel");
  if (!panel) return;

  var body = doc.querySelector("#op-hits-sandbox-body");
  var count = doc.querySelector("#op-hits-sandbox-count");
  var statusEl = doc.querySelector("#op-hits-sandbox-status");
  var emptyEl = doc.querySelector("#op-hits-sandbox-empty");
  var badgeEl = doc.querySelector("#op-hits-sandbox-badge");
  var updatedEl = doc.querySelector("#op-hits-sandbox-updated");
  var toggleEl = doc.querySelector("#op-hits-sandbox-toggle");
  var detailsEl = doc.querySelector("#op-hits-sandbox-details");

  /** Diagnóstico nasce recolhido: a barra compacta é o estado normal. */
  function setDetailsOpen(open) {
    if (!detailsEl || !toggleEl) return;
    detailsEl.classList.toggle("hidden", !open);
    toggleEl.setAttribute("aria-expanded", open ? "true" : "false");
    toggleEl.textContent = open ? "Ocultar diagnóstico" : "Ver diagnóstico";
  }

  function isDetailsOpen() {
    return !!detailsEl && !detailsEl.classList.contains("hidden");
  }

  function hhmm(date) {
    var d = date || new Date();
    return (
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
    );
  }

  /** Resumo da barra compacta: conectado, quantidade e hora da leitura. */
  function renderResumo(result) {
    var conectado = !!(result && result.ok);
    if (badgeEl) {
      badgeEl.classList.toggle("hidden", !conectado);
    }
    if (count) {
      // Conta o que o HITS devolveu, não o que sobrou após a transformação.
      var n = conectado ? (result.raw || []).length : 0;
      count.textContent = conectado
        ? n + (n === 1 ? " reserva lida" : " reservas lidas")
        : "leitura indisponível";
      count.classList.toggle("op-hits-bar__count--error", !conectado);
    }
    if (updatedEl) {
      updatedEl.textContent = conectado ? "atualizado " + hhmm() : "";
    }
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("op-hits-sandbox__status--error", isError === true);
    statusEl.classList.toggle("hidden", !text);
  }

  function text(value) {
    var s = value == null ? "" : String(value).trim();
    return s || "—";
  }

  /**
   * A janela vem pronta de quem calcula o dia operacional do hotel
   * (checkin-operacional-mvp.js). Aqui só é repassada — nada de timezone.
   * Sem janela, a Edge aplica o default dela.
   */
  function functionsUrl(win) {
    var cfg = global.YES_HOTEL_SUPABASE_CONFIG;
    if (!cfg || !cfg.url) return "";
    var url = String(cfg.url).replace(/\/+$/, "") + "/functions/v1/hits-reservations-preview";
    if (win && win.from && win.to) {
      url += "?date_from=" + encodeURIComponent(win.from) + "&date_to=" + encodeURIComponent(win.to);
    }
    return url;
  }

  /** Assinatura da janela — entra na memoização do ciclo. */
  function windowKey(win) {
    return win && win.from && win.to ? win.from + ".." + win.to : "default";
  }

  function renderRows(rows) {
    if (!body) return;
    body.innerHTML = "";
    rows.forEach(function (r) {
      var tr = doc.createElement("tr");
      [
        text(r.external_reservation_id),
        text(r.apartamento),
        text(r.hospede_principal),
        text(r.check_in),
        text(r.check_out),
        r.status_reserva === "cancelada" ? "Cancelada" : "Ativa",
        String(Math.max(1, Number(r.total_hospedes) || 1)),
      ].forEach(function (value) {
        var td = doc.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    // A contagem vive na barra compacta (renderResumo), não aqui.
    if (emptyEl) emptyEl.classList.toggle("hidden", rows.length > 0);
  }

  /**
   * Ciclo de leitura compartilhado.
   *
   * Painel técnico e grade operacional consomem a MESMA resposta: duas leituras
   * concorrentes somavam ~66 requisições ao gateway (1 listagem + 1 detalhe por
   * reserva, duas vezes) e estouravam o limite de 60/min, derrubando uma delas.
   */
  var inflight = null;
  var cycleResult = null;
  var cycleListeners = [];
  /** Janela do último ciclo: o botão do painel reusa a mesma da grade. */
  var lastWindow = null;
  var cycleKey = null;

  function notifyCycle(payload) {
    cycleListeners.forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        /* um assinante com defeito não pode derrubar os outros */
      }
    });
  }

  /** Assina o fim de cada ciclo. Se já houve um, recebe o resultado na hora. */
  function onCycle(fn) {
    if (typeof fn !== "function") return;
    cycleListeners.push(fn);
    if (cycleResult) fn(cycleResult);
  }

  async function requestCycle(win) {
    var auth = global.YesHotelAuthApp;
    var url = functionsUrl(win);
    if (!auth || !auth.getEdgeFunctionFetchHeaders || !url) {
      return { ok: false, raw: [], rows: [], error: "supabase_nao_configurado" };
    }
    try {
      var headers = await auth.getEdgeFunctionFetchHeaders();
      var res = await global.fetch(url, { method: "GET", headers: headers });
      var data = await res.json().catch(function () {
        return null;
      });
      if (!res.ok || !data || data.ok !== true) {
        return {
          ok: false,
          raw: [],
          rows: [],
          error: (data && (data.error || data.message)) || "HTTP " + res.status,
        };
      }
      // Duas representações da MESMA leitura:
      //   raw  → shape da Edge (external_reservation_id, check_in, ...) p/ o painel
      //   rows → shape da listagem operacional (externalReservationId, ...) p/ a grade
      var raw = data.rows || [];
      return {
        ok: true,
        raw: raw,
        rows: raw.map(toReservaOperacional).filter(function (r) {
          return r.externalReservationId;
        }),
        failed: data.failed || [],
      };
    } catch (err) {
      return { ok: false, raw: [], rows: [], error: "falha_de_rede" };
    }
  }

  /**
   * Uma leitura por ciclo. Chamadas concorrentes compartilham a mesma promise;
   * `force` inicia um ciclo novo (botão Atualizar / Consultar).
   */
  function loadCycle(options) {
    var opts = options || {};
    var force = opts.force === true;
    // Janela da chamada; sem janela explícita, herda a última usada pela grade.
    var win =
      opts.dateFrom && opts.dateTo
        ? { from: opts.dateFrom, to: opts.dateTo }
        : lastWindow;
    var key = windowKey(win);

    // Reaproveita a última leitura (boot/ciclo em andamento) e nunca abre GET novo:
    // o botão Atualizar da listagem não é uma atualização manual do HITS.
    if (opts.reuseOnly === true) {
      if (inflight) return inflight;
      return Promise.resolve(cycleResult || { ok: false, raw: [], rows: [], error: "sem_leitura" });
    }
    if (inflight && key === cycleKey) return inflight;
    // Virada do dia operacional muda a janela: o ciclo anterior não serve mais.
    if (!force && cycleResult && key === cycleKey) return Promise.resolve(cycleResult);

    setStatus("Consultando HITS Sandbox…", false);

    lastWindow = win;
    cycleKey = key;
    inflight = requestCycle(win).then(function (result) {
      cycleResult = result;
      inflight = null;
      renderCycle(result);
      notifyCycle(result);
      return result;
    });
    return inflight;
  }

  function renderCycle(result) {
    renderResumo(result);
    if (!result.ok) {
      renderRows([]);
      setStatus("Não foi possível ler o HITS Sandbox (" + result.error + ").", true);
      return;
    }
    // Painel técnico lê o shape bruto da Edge, não o transformado.
    renderRows(result.raw || []);
    var note = "Leitura direta do HITS Sandbox pelo gateway. Nada foi gravado.";
    if (result.failed && result.failed.length) {
      note += " " + result.failed.length + " reserva(s) sem detalhe.";
    }
    setStatus(note, false);
  }

  /** O painel exibe o que já veio da grade; não dispara leitura própria. */
  function load() {
    return loadCycle({ force: true });
  }

  if (toggleEl) {
    toggleEl.addEventListener("click", function () {
      setDetailsOpen(!isDetailsOpen());
    });
  }
  setDetailsOpen(false);

  /** Prefixo do id sintético — nunca existe no banco, por construção. */
  var READ_ONLY_ID_PREFIX = "hits-preview:";

  function isReadOnlyId(id) {
    return String(id || "").indexOf(READ_ONLY_ID_PREFIX) === 0;
  }

  /**
   * Linha da Edge → objeto no formato que a listagem operacional consome.
   * Somente leitura: sem id de banco, sem hóspedes, sem eventos, sem FNRH.
   * O id sintético carrega o idReservation para a busca continuar achando.
   */
  function toReservaOperacional(row) {
    var ext = String((row && row.external_reservation_id) || "").trim();
    return {
      id: READ_ONLY_ID_PREFIX + ext,
      somenteLeituraHits: true,
      apartamento: String((row && row.apartamento) || "").trim(),
      hospedePrincipal: String((row && row.hospede_principal) || "").trim(),
      externalReservationId: ext || null,
      origemExterna: "hits_preview",
      checkInPrevisto: String((row && row.check_in) || "").slice(0, 10),
      checkOutPrevisto: String((row && row.check_out) || "").slice(0, 10),
      totalHospedesHits: Math.max(1, Number(row && row.total_hospedes) || 1),
      statusReserva: row && row.status_reserva === "cancelada" ? "cancelada" : "ativa",
      // Campos operacionais neutros: nada aqui dispara ação.
      pagamento: "desconhecido",
      acessoLiberado: false,
      // Status=3 no HITS = hóspede já entrou. Sem isto a reserva sumia da grade
      // no instante do check-in.
      entrouNoApto: !!(row && row.ciclo_hits === "hospedada"),
      hospedes: [],
      historico: [],
      cobrancasPagarme: [],
      pagamentosPagarme: [],
      fnrhStatusAgregado: null,
      pagamentoPresencialDiferidoAutorizado: false,
    };
  }

  /**
   * Reservas do Sandbox no formato da listagem, pelo ciclo compartilhado.
   * Nunca lança: a tela operacional não pode quebrar por causa do HITS.
   */
  function fetchReservasOperacionais(options) {
    return loadCycle(options).then(function (result) {
      return result.rows;
    });
  }

  global.YesHotelHitsSandboxPreview = {
    load: load,
    loadCycle: loadCycle,
    onCycle: onCycle,
    fetchReservasOperacionais: fetchReservasOperacionais,
    toReservaOperacional: toReservaOperacional,
    isReadOnlyId: isReadOnlyId,
    READ_ONLY_ID_PREFIX: READ_ONLY_ID_PREFIX,
  };
})(typeof window !== "undefined" ? window : globalThis);
