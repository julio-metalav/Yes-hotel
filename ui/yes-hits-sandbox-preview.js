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

  var btn = doc.querySelector("#op-hits-sandbox-refresh");
  var body = doc.querySelector("#op-hits-sandbox-body");
  var count = doc.querySelector("#op-hits-sandbox-count");
  var statusEl = doc.querySelector("#op-hits-sandbox-status");
  var emptyEl = doc.querySelector("#op-hits-sandbox-empty");

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

  function functionsUrl() {
    var cfg = global.YES_HOTEL_SUPABASE_CONFIG;
    if (!cfg || !cfg.url) return "";
    return String(cfg.url).replace(/\/+$/, "") + "/functions/v1/hits-reservations-preview";
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
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    if (emptyEl) emptyEl.classList.toggle("hidden", rows.length > 0);
  }

  async function load() {
    var auth = global.YesHotelAuthApp;
    var url = functionsUrl();
    if (!auth || !auth.getEdgeFunctionFetchHeaders || !url) {
      setStatus("Supabase não configurado nesta build.", true);
      return;
    }

    if (btn) btn.disabled = true;
    setStatus("Consultando HITS Sandbox…", false);
    try {
      var headers = await auth.getEdgeFunctionFetchHeaders();
      var res = await global.fetch(url, { method: "GET", headers: headers });
      var data = await res.json().catch(function () {
        return null;
      });

      if (!res.ok || !data || data.ok !== true) {
        var code = (data && (data.error || data.message)) || "HTTP " + res.status;
        renderRows([]);
        setStatus("Não foi possível ler o HITS Sandbox (" + code + ").", true);
        return;
      }

      renderRows(data.rows || []);
      var note = "Leitura direta do HITS Sandbox pelo gateway. Nada foi gravado.";
      if (data.failed && data.failed.length) {
        note += " " + data.failed.length + " reserva(s) sem detalhe.";
      }
      setStatus(note, false);
    } catch (err) {
      renderRows([]);
      setStatus("Falha de rede ao consultar o gateway.", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (btn) btn.addEventListener("click", load);

  global.YesHotelHitsSandboxPreview = { load: load };
})(typeof window !== "undefined" ? window : globalThis);
