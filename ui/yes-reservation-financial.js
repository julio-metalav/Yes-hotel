/**
 * Espelho browser do classificador financeiro HITS.
 * Fonte de verdade tipada: src/lib/domain/yes-hotel/reservation-financial-classification.ts
 *
 * PROIBIDO: matching frágil por substring booking (includes) ou regex
 * que confunda Booking Engine com Booking OTA.
 */
(function (global) {
  "use strict";

  var OTA_EXACT = {
    BOOKING: "booking",
    "BOOKING.COM": "booking",
    BOOKINGCOM: "booking",
    EXPEDIA: "expedia",
    "EXPEDIA/HOTELS.COM": "expedia",
    "EXPEDIA/HOTELSCOM": "expedia",
    "EXPEDIAHOTELS.COM": "expedia",
    EXPEDIAHOTELSCOM: "expedia",
    "HOTELS.COM": "hotels_com",
    HOTELSCOM: "hotels_com",
    AIRBNB: "airbnb",
  };

  function normText(v) {
    return String(v == null ? "" : v)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function upperCompact(v) {
    return normText(v).toUpperCase().replace(/\s+/g, "");
  }

  function trimOrEmpty(v) {
    return String(v == null ? "" : v).trim();
  }

  function parseHitsMoney(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    var s = String(v).trim().replace(/\s/g, "").replace(",", ".");
    if (!s) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function isB2bChannelManager(channelManager) {
    var compact = upperCompact(channelManager);
    if (!compact) return false;
    return compact === "B2BRESERVAS" || compact.indexOf("B2BRESERVAS") === 0;
  }

  function isBookingEngineChannel(value) {
    return upperCompact(value) === "BOOKINGENGINE";
  }

  function isMotorDeReservasChannel(value) {
    return upperCompact(value) === "MOTORADERESERVAS";
  }

  function matchOtaExactToken(value) {
    var compact = upperCompact(value);
    if (!compact || compact === "BOOKINGENGINE") return null;
    return Object.prototype.hasOwnProperty.call(OTA_EXACT, compact) ? OTA_EXACT[compact] : null;
  }

  function matchOtaFromTexts(texts) {
    for (var i = 0; i < texts.length; i++) {
      var id = matchOtaExactToken(texts[i]);
      if (id) return id;
    }
    return null;
  }

  function isDirectBookingEngineOrMotor(input) {
    var channels = [input.salesChannel, input.companyName, input.billingEntity, input.groupName];
    for (var i = 0; i < channels.length; i++) {
      if (isBookingEngineChannel(channels[i])) return true;
      if (isMotorDeReservasChannel(channels[i])) return true;
    }
    var joined = channels.map(normText).join(" | ").toLowerCase();
    return /\bparticular\b/.test(joined);
  }

  function isParticularMotorReservation(input) {
    return isDirectBookingEngineOrMotor(input);
  }

  function isManualHitsDirectReservation(input) {
    var manager = trimOrEmpty(input.channelManager) || trimOrEmpty(input.integrator);
    var channel =
      trimOrEmpty(input.salesChannel) ||
      trimOrEmpty(input.companyName) ||
      trimOrEmpty(input.billingEntity) ||
      trimOrEmpty(input.groupName);
    var channelId = trimOrEmpty(input.reservationChannelId);
    return !manager && !channel && !channelId;
  }

  function classifyCommissionFromHits(input) {
    input = input || {};
    if (isB2bChannelManager(input.channelManager || input.integrator)) {
      return {
        classificacao: "comissionada",
        reason: "b2b_channel_manager",
        matchedOtaId: null,
        originKind: "b2b",
      };
    }
    var channelCandidates = [
      input.salesChannel,
      input.companyName,
      input.billingEntity,
      input.groupName,
    ];
    var ota = matchOtaFromTexts(channelCandidates);
    if (ota) {
      return {
        classificacao: "comissionada",
        reason: "ota_channel",
        matchedOtaId: ota,
        originKind: "ota",
      };
    }
    if (channelCandidates.some(isBookingEngineChannel)) {
      return {
        classificacao: "nao_comissionada",
        reason: "booking_engine_direta",
        matchedOtaId: null,
        originKind: "booking_engine",
      };
    }
    if (isDirectBookingEngineOrMotor(input)) {
      return {
        classificacao: "nao_comissionada",
        reason: "particular_motor",
        matchedOtaId: null,
        originKind: "motor_particular",
      };
    }
    if (isManualHitsDirectReservation(input)) {
      return {
        classificacao: "nao_comissionada",
        reason: "manual_hits_direta",
        matchedOtaId: null,
        originKind: "manual_hits",
      };
    }
    return {
      classificacao: "nao_comissionada",
      reason: "default_nao_comissionada",
      matchedOtaId: null,
      originKind: "unknown",
    };
  }

  function resolveFinancialStatusVisible(input) {
    input = input || {};
    var pay = String(input.pagamentoStatus == null ? "" : input.pagamentoStatus)
      .trim()
      .toLowerCase();
    var balance = parseHitsMoney(input.balanceDue);
    var cls = String(input.classificacao == null ? "" : input.classificacao)
      .trim()
      .toLowerCase();
    var isPaid = pay === "pago" || (balance != null && balance <= 0);
    if (isPaid) return "pago";
    var hasDue =
      (balance != null && balance > 0) ||
      pay === "pendente" ||
      pay === "parcial" ||
      pay === "desconhecido" ||
      pay === "";
    if (hasDue && cls === "comissionada") return "pendente_comissionado";
    return "pendente";
  }

  function financialStatusLabel(status) {
    if (status === "pago") return "Pago";
    if (status === "pendente_comissionado") return "Pendente (comissionado)";
    return "Pendente";
  }

  function isFinanceiramenteLiberadoParaAcesso(input) {
    var status = resolveFinancialStatusVisible(input);
    if (status === "pago" || status === "pendente_comissionado") return true;
    var cls = String((input && input.classificacao) || "")
      .trim()
      .toLowerCase();
    return cls === "desconhecida";
  }

  function nextFinancialActionLabel(status) {
    if (status === "pendente") return "Gerar e enviar link de pagamento";
    if (status === "pendente_comissionado") return "Regularizar pagamento no HITS";
    return null;
  }

  function shouldCreatePagarmeCharge(input) {
    var status = resolveFinancialStatusVisible(input);
    if (status === "pago") return { allowed: false, reason: "reserva_ja_paga" };
    if (status === "pendente_comissionado") return { allowed: false, reason: "comissionada_bloqueada" };
    var cls = String((input && input.classificacao) || "")
      .trim()
      .toLowerCase();
    if (cls === "desconhecida" || !cls) return { allowed: false, reason: "classificacao_desconhecida" };
    if (cls !== "nao_comissionada") return { allowed: false, reason: "classificacao_invalida" };
    return { allowed: true, reason: "ok" };
  }

  global.YesReservationFinancial = {
    parseHitsMoney: parseHitsMoney,
    classifyCommissionFromHits: classifyCommissionFromHits,
    resolveFinancialStatusVisible: resolveFinancialStatusVisible,
    financialStatusLabel: financialStatusLabel,
    isFinanceiramenteLiberadoParaAcesso: isFinanceiramenteLiberadoParaAcesso,
    nextFinancialActionLabel: nextFinancialActionLabel,
    shouldCreatePagarmeCharge: shouldCreatePagarmeCharge,
    isB2bChannelManager: isB2bChannelManager,
    isParticularMotorReservation: isParticularMotorReservation,
    isBookingEngineChannel: isBookingEngineChannel,
    isManualHitsDirectReservation: isManualHitsDirectReservation,
    matchOtaExactToken: matchOtaExactToken,
  };
})(typeof window !== "undefined" ? window : globalThis);
