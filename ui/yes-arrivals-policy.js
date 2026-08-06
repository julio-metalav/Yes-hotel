/**
 * Policy browser: Chegadas + card hospedados.
 * Espelha src/lib/domain/yes-hotel/arrivals-ui.ts — manter sincronizado.
 * Testado via node:vm em scripts/test-hits-reservation-sync-chegadas.ts
 */
(function (global) {
  "use strict";

  var TZ = "America/Campo_Grande";

  function localDateYmd(now) {
    now = now || new Date();
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }

  function addDaysYmd(ymd, days) {
    var parts = ymd.split("-").map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return dt.toISOString().slice(0, 10);
  }

  function deriveArrivalsAlerts(r) {
    var out = [];
    var pay = String(r.pagamento_status || "").toLowerCase();
    if (pay === "pendente") out.push({ code: "pagamento_pendente", label: "Pagamento pendente" });
    else if (pay === "parcial") out.push({ code: "pagamento_parcial", label: "Pagamento parcial" });
    else if (pay === "desconhecido")
      out.push({ code: "pagamento_nao_confirmado", label: "Pagamento não confirmado" });
    if (r.fnrh_pendente) out.push({ code: "fnrh_pendente", label: "FNRH pendente" });
    if (r.status_reserva === "cancelada")
      out.push({ code: "reserva_cancelada", label: "Reserva cancelada" });
    (r.recent_change_labels || []).forEach(function (label) {
      if (out.length < 3) out.push({ code: "alteracao_recente", label: label });
    });
    if (r.credencial_ausente) out.push({ code: "credencial_ausente", label: "Credencial não criada" });
    if (r.comunicacao_falha) out.push({ code: "comunicacao_falha", label: "Falha de comunicação" });
    if (r.tolerancia_ativa) out.push({ code: "tolerancia", label: "Tolerância" });
    if (r.senha_suspensa) out.push({ code: "senha_suspensa", label: "Senha suspensa" });
    return out.slice(0, 3);
  }

  function toRow(r) {
    var ext = (r.external_reservation_id || "").trim();
    return {
      id: r.id,
      check_in: r.check_in_previsto,
      external_reservation_id: ext || "—",
      apartamento: r.apartamento || "—",
      hospede_principal: r.hospede_principal || "—",
      total_hospedes: Math.max(1, Number(r.total_hospedes) || 1),
      alerts: deriveArrivalsAlerts(r),
    };
  }

  function filterArrivals(items, filter, now) {
    var today = localDateYmd(now);
    var tomorrow = addDaysYmd(today, 1);
    var end7 = addDaysYmd(today, 6);
    return (items || [])
      .filter(function (r) {
        var cin = String(r.check_in_previsto || "").slice(0, 10);
        if (filter === "so_problemas") {
          if (r.status_reserva === "cancelada") {
            return r.recent_cancel_event === true;
          }
          return deriveArrivalsAlerts(r).length > 0;
        }
        if (r.status_reserva === "cancelada") return false;
        if (filter === "hoje") return cin === today;
        if (filter === "amanha") return cin === tomorrow;
        if (filter === "proximos_7_dias") return cin >= today && cin <= end7;
        if (filter === "todas_futuras") return cin >= today;
        return false;
      })
      .map(toRow)
      .sort(function (a, b) {
        if (a.check_in !== b.check_in) return a.check_in < b.check_in ? -1 : 1;
        if (a.apartamento !== b.apartamento)
          return a.apartamento < b.apartamento ? -1 : 1;
        return a.hospede_principal < b.hospede_principal ? -1 : 1;
      });
  }

  function summarizeOccupiedGuests(items, now) {
    var today = localDateYmd(now);
    var stays = (items || []).filter(function (r) {
      if (r.status_reserva !== "ativa") return false;
      if (!r.entrou_no_apto) return false;
      var cin = String(r.check_in_previsto || "").slice(0, 10);
      var cout = String(r.check_out_previsto || "").slice(0, 10);
      return cin <= today && cout > today;
    });
    var apartments = {};
    var total = 0;
    stays.forEach(function (s) {
      var apt = (s.apartamento || "").trim();
      if (apt) apartments[apt] = true;
      total += Math.max(1, Number(s.total_hospedes) || 1);
    });
    return {
      total_guests: total,
      occupied_apartments: Object.keys(apartments).length,
      stays: stays.map(function (s) {
        return {
          id: s.id,
          apartamento: s.apartamento || "—",
          hospede_principal: s.hospede_principal || "—",
          total_hospedes: Math.max(1, Number(s.total_hospedes) || 1),
          check_out: s.check_out_previsto,
          alerts: deriveArrivalsAlerts({
            id: s.id,
            external_reservation_id: null,
            apartamento: s.apartamento,
            hospede_principal: s.hospede_principal,
            check_in_previsto: s.check_in_previsto,
            check_out_previsto: s.check_out_previsto,
            status_reserva: s.status_reserva,
            pagamento_status: s.pagamento_status || "pago",
            entrou_no_apto: true,
            total_hospedes: s.total_hospedes,
            fnrh_pendente: s.fnrh_pendente,
          }),
        };
      }),
    };
  }

  function paginateRows(rows, page, pageSize) {
    var p = Math.max(0, page || 0);
    var size = Math.max(1, pageSize || 20);
    var start = p * size;
    var items = (rows || []).slice(start, start + size);
    return {
      items: items,
      page: p,
      pageSize: size,
      total: (rows || []).length,
      hasMore: start + size < (rows || []).length,
    };
  }

  global.YesHotelArrivalsPolicy = {
    localDateYmd: localDateYmd,
    filterArrivals: filterArrivals,
    summarizeOccupiedGuests: summarizeOccupiedGuests,
    paginateRows: paginateRows,
    deriveArrivalsAlerts: deriveArrivalsAlerts,
  };
})(typeof window !== "undefined" ? window : globalThis);
