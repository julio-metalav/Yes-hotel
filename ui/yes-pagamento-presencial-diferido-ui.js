/**
 * Mirror browser da regra pagamento presencial diferido (sem I/O).
 * Fonte de verdade TS: src/lib/domain/yes-hotel/pagamento-presencial-diferido.ts
 * Fail-closed: só boolean true habilita.
 */
(function (global) {
  var OFFSET_MIN = -240; // America/Campo_Grande

  function extractYmd(value) {
    var m = String(value || "")
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function hotelLocalToUtcMs(ymd, hour, minute) {
    var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return NaN;
    var asIfUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute || 0, 0, 0);
    return asIfUtc - OFFSET_MIN * 60 * 1000;
  }

  function utcIsoToHotelLocalParts(iso) {
    var ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return null;
    var localMs = ms + OFFSET_MIN * 60 * 1000;
    var d = new Date(localMs);
    return {
      ymd:
        d.getUTCFullYear() +
        "-" +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getUTCDate()).padStart(2, "0"),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }

  function isPagamentoPresencialDiferidoUiEnabled(value) {
    return value === true;
  }

  function isAuthorizedProfile(perfil) {
    var p = String(perfil || "")
      .trim()
      .toLowerCase();
    return p === "admin" || p === "recepcao";
  }

  function isPaymentPendingStatus(status) {
    var s = String(status || "")
      .trim()
      .toLowerCase();
    return s === "pendente" || s === "parcial" || s === "emergencial";
  }

  function canShowPresencialDiferidoButton(input) {
    if (!isPagamentoPresencialDiferidoUiEnabled(input.featureEnabled)) {
      return { allowed: false, reason: "feature_off" };
    }
    if (!isAuthorizedProfile(input.perfilUsuario)) {
      return { allowed: false, reason: "perfil" };
    }
    if (String(input.statusReserva || "").toLowerCase() !== "ativa") {
      return { allowed: false, reason: "reserva_inativa" };
    }
    if (String(input.pagamentoStatus || "").toLowerCase() === "pago") {
      return { allowed: false, reason: "ja_pago" };
    }
    if (!isPaymentPendingStatus(input.pagamentoStatus)) {
      return { allowed: false, reason: "pagamento_nao_pendente" };
    }
    if (String(input.classificacaoComissionamento || "").toLowerCase() === "comissionada") {
      return { allowed: false, reason: "comissionada" };
    }
    if (input.jaAutorizado) {
      return { allowed: false, reason: "ja_autorizado" };
    }
    var checkIn = extractYmd(input.checkInYmd);
    var local = utcIsoToHotelLocalParts(input.nowIso);
    if (!local || local.ymd !== checkIn) {
      return { allowed: false, reason: "fora_do_dia_checkin" };
    }
    if (local.hour * 60 + local.minute < 8 * 60) {
      return { allowed: false, reason: "antes_das_08h" };
    }
    return { allowed: true, reason: "ok" };
  }

  function resolvePresencialDiferidoUiLabel(input) {
    if (String(input.pagamentoStatus || "").toLowerCase() === "pago") return null;
    if (!input.autorizado) return null;
    var suspended =
      input.graceStatus === "suspended" ||
      input.graceStatus === "suspension_pending" ||
      input.graceStatus === "partial_failure";
    if (input.efetivado && suspended) return "Pagamento vencido — acesso suspenso";
    if (input.efetivado) return "Pagamento presencial até 09:00";
    return "Presencial diferido autorizado";
  }

  global.YesPagamentoPresencialDiferidoUi = {
    isPagamentoPresencialDiferidoUiEnabled: isPagamentoPresencialDiferidoUiEnabled,
    canShowPresencialDiferidoButton: canShowPresencialDiferidoButton,
    resolvePresencialDiferidoUiLabel: resolvePresencialDiferidoUiLabel,
    hotelLocalToUtcMs: hotelLocalToUtcMs,
  };
})(typeof window !== "undefined" ? window : globalThis);
