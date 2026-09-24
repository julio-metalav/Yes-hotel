/**
 * Painel somente leitura: reservas HITS a partir do SNAPSHOT local.
 *
 * Isolado de checkin-operacional-mvp.js de propósito — não altera estado
 * operacional, não persiste nada e não toca no fluxo de chegadas.
 *
 * A tela NÃO consulta mais o HITS ao vivo: quem lê o HITS é o scheduler (Edge
 * hits-reservations-preview a cada 10 min), que grava a projeção
 * public.hits_reservas_snapshot. Aqui só há dois SELECTs locais (snapshot +
 * estado do último sync), sob RLS por perfil. Abrir a tela N vezes não gera
 * nenhuma requisição ao gateway HITS.
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

  /** Tabelas/colunas lidas. Só o que a tela exibe; nada de contato/financeiro. */
  var SNAPSHOT_TABLE = "hits_reservas_snapshot";
  var SNAPSHOT_COLUMNS =
    "external_reservation_id, apartamento, hospede_principal, check_in, check_out, status_reserva, ciclo_hits, total_hospedes";
  var SYNC_STATE_TABLE = "hits_snapshot_sync_state";
  var SYNC_STATE_COLUMNS =
    "last_started_at, last_finished_at, last_status, last_error, last_rows_count, last_failed_count, last_success_at";
  /** Teto defensivo de linhas lidas (o scheduler grava no máximo ~100 por ciclo). */
  var SNAPSHOT_MAX_ROWS = 500;
  /** O scheduler roda a cada 10 min; acima disto o snapshot é tratado como desatualizado. */
  var SNAPSHOT_STALE_MINUTES = 30;

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

  function parseIso(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Saúde do snapshot, derivada só do estado do último sync.
   *   sem_snapshot   → nunca houve sync bem-sucedido (nada válido para mostrar)
   *   falhou         → último ciclo falhou, mas existe fotografia anterior válida
   *   desatualizado  → última fotografia válida é mais antiga que o esperado
   *   parcial        → último ciclo ok, com reserva(s) sem detalhe
   *   ok             → recente e completo
   */
  function describeSync(state, now) {
    var s = state || {};
    var ref = now || new Date();
    var lastSuccess = parseIso(s.last_success_at);
    var base = {
      lastStatus: s.last_status || null,
      lastError: s.last_error || null,
      lastSuccessAt: lastSuccess,
      failedCount: Math.max(0, Number(s.last_failed_count) || 0),
      ageMinutes: null,
    };
    if (!lastSuccess) {
      return assign(base, {
        status: "sem_snapshot",
        level: "error",
        message: "dados ainda não sincronizados",
      });
    }
    var age = Math.max(0, Math.round((ref.getTime() - lastSuccess.getTime()) / 60000));
    base.ageMinutes = age;
    var quando = hhmm(lastSuccess);
    if (s.last_status === "error") {
      return assign(base, {
        status: "falhou",
        level: "warn",
        message: "última sincronização com HITS falhou — exibindo dados de " + quando,
      });
    }
    if (age > SNAPSHOT_STALE_MINUTES) {
      return assign(base, {
        status: "desatualizado",
        level: "warn",
        message: "dados desatualizados — última sincronização " + quando,
      });
    }
    if (s.last_status === "partial") {
      return assign(base, {
        status: "parcial",
        level: "ok",
        message:
          "sincronizado " + quando + " · " + base.failedCount +
          (base.failedCount === 1 ? " reserva sem detalhe" : " reservas sem detalhe"),
      });
    }
    return assign(base, { status: "ok", level: "ok", message: "sincronizado " + quando });
  }

  function assign(target, extra) {
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) target[k] = extra[k];
    return target;
  }

  /** Resumo da barra compacta: saúde do snapshot, quantidade e hora do sync. */
  function renderResumo(result) {
    var ok = !!(result && result.ok);
    var sync = ok && result.sync ? result.sync : null;
    var semSnapshot = ok && sync && sync.status === "sem_snapshot";
    var level = !ok || semSnapshot ? "error" : sync ? sync.level : "ok";
    if (badgeEl) {
      badgeEl.classList.toggle("hidden", level === "error");
    }
    if (count) {
      var n = ok ? (result.raw || []).length : 0;
      count.textContent = !ok
        ? "leitura indisponível"
        : semSnapshot
          ? "HITS — dados ainda não sincronizados"
          : n + (n === 1 ? " reserva" : " reservas");
      count.classList.toggle("op-hits-bar__count--error", level === "error");
      count.classList.toggle("op-hits-bar__count--warn", level === "warn");
    }
    if (updatedEl) {
      updatedEl.textContent = ok && sync && !semSnapshot ? sync.message : "";
      updatedEl.classList.toggle("op-hits-bar__updated--warn", level === "warn");
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

  function getSupabaseClient() {
    var auth = global.YesHotelAuthApp;
    if (!auth || typeof auth.getSupabaseClient !== "function") return null;
    try {
      return auth.getSupabaseClient() || null;
    } catch (_e) {
      return null;
    }
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
   * Ciclo de leitura compartilhado: painel técnico e grade operacional
   * consomem a MESMA leitura do snapshot (dois SELECTs locais, nada mais).
   */
  var inflight = null;
  var cycleResult = null;
  var cycleListeners = [];

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

  /** Linha do banco → shape "raw" (o mesmo que a Edge devolvia) p/ o painel. */
  function toRawRow(row) {
    var r = row || {};
    return {
      external_reservation_id: String(r.external_reservation_id || "").trim(),
      apartamento: String(r.apartamento || "").trim(),
      hospede_principal: String(r.hospede_principal || "").trim(),
      check_in: String(r.check_in || "").slice(0, 10),
      check_out: String(r.check_out || "").slice(0, 10),
      status_reserva: r.status_reserva === "cancelada" ? "cancelada" : "ativa",
      ciclo_hits: r.ciclo_hits === "hospedada" ? "hospedada" : "confirmada",
      total_hospedes: Math.max(1, Number(r.total_hospedes) || 1),
    };
  }

  function failure(error) {
    return { ok: false, raw: [], rows: [], failed: [], sync: null, error: error };
  }

  async function requestCycle() {
    var client = getSupabaseClient();
    if (!client) return failure("supabase_nao_configurado");
    try {
      var results = await Promise.all([
        client
          .from(SNAPSHOT_TABLE)
          .select(SNAPSHOT_COLUMNS)
          .order("check_in", { ascending: true })
          .order("apartamento", { ascending: true })
          .limit(SNAPSHOT_MAX_ROWS),
        client.from(SYNC_STATE_TABLE).select(SYNC_STATE_COLUMNS).eq("id", true).maybeSingle(),
      ]);
      var rowsRes = results[0] || {};
      var stateRes = results[1] || {};
      if (rowsRes.error) {
        return failure(
          String((rowsRes.error && (rowsRes.error.code || rowsRes.error.message)) || "snapshot_indisponivel"),
        );
      }
      // Estado ausente (linha ainda não criada / sem permissão) conta como "sem snapshot":
      // a UI nunca converte isso em "0 reservas" silenciosamente.
      var state = stateRes && !stateRes.error ? stateRes.data : null;
      var raw = (Array.isArray(rowsRes.data) ? rowsRes.data : []).map(toRawRow).filter(function (r) {
        return r.external_reservation_id;
      });
      // Duas representações da MESMA leitura:
      //   raw  → shape da Edge (external_reservation_id, check_in, ...) p/ o painel
      //   rows → shape da listagem operacional (externalReservationId, ...) p/ a grade
      return {
        ok: true,
        raw: raw,
        rows: raw.map(toReservaOperacional),
        failed: [],
        sync: describeSync(state),
      };
    } catch (err) {
      return failure("falha_de_rede");
    }
  }

  /**
   * Uma leitura por ciclo. Chamadas concorrentes compartilham a mesma promise;
   * `force` relê o snapshot (botão do painel / troca de período). Ler o
   * snapshot é barato (SELECT local) e nunca toca o HITS.
   */
  function loadCycle(options) {
    var opts = options || {};
    var force = opts.force === true;

    // Reaproveita a última leitura (boot/ciclo em andamento) e nunca abre SELECT novo.
    if (opts.reuseOnly === true) {
      if (inflight) return inflight;
      return Promise.resolve(cycleResult || failure("sem_leitura"));
    }
    if (inflight) return inflight;
    if (!force && cycleResult) return Promise.resolve(cycleResult);

    setStatus("Lendo snapshot HITS…", false);

    inflight = requestCycle().then(function (result) {
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
      setStatus("Não foi possível ler o snapshot HITS (" + result.error + ").", true);
      return;
    }
    // Painel técnico lê o shape bruto, não o transformado.
    renderRows(result.raw || []);
    var sync = result.sync || {};
    if (sync.status === "sem_snapshot") {
      setStatus("HITS — dados ainda não sincronizados. O scheduler grava o snapshot a cada 10 min.", true);
      return;
    }
    var note =
      "Snapshot local das reservas HITS, gravado pelo scheduler. " +
      "Nenhuma consulta ao vivo e nada gravado no HITS.";
    if (sync.status === "falhou") {
      note = "Última sincronização com HITS falhou" +
        (sync.lastError ? " (" + sync.lastError + ")" : "") +
        " — exibindo dados de " + hhmm(sync.lastSuccessAt) + ".";
    } else if (sync.status === "desatualizado") {
      note = "Dados desatualizados — última sincronização " + hhmm(sync.lastSuccessAt) + ".";
    } else if (sync.status === "parcial") {
      note += " " + sync.failedCount + " reserva(s) sem detalhe no último ciclo.";
    }
    setStatus(note, sync.level === "warn");
  }

  /** Botão do painel: relê o snapshot local (nunca o HITS). */
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
   * Linha do snapshot → objeto no formato que a listagem operacional consome.
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
   * Reservas do snapshot no formato da listagem, pelo ciclo compartilhado.
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
    describeSync: describeSync,
    isReadOnlyId: isReadOnlyId,
    READ_ONLY_ID_PREFIX: READ_ONLY_ID_PREFIX,
    SNAPSHOT_STALE_MINUTES: SNAPSHOT_STALE_MINUTES,
  };
})(typeof window !== "undefined" ? window : globalThis);
