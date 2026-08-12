/**
 * Espelho browser do classificador financeiro HITS.
 * Fonte de verdade tipada: src/lib/domain/yes-hotel/reservation-financial-classification.ts
 */
(function (global) {
  "use strict";

  var B2B = { B2BRESERVAS: true };
  var OTA = [
    { id: "booking", re: /\bbooking(?:\.com)?\b/i },
    { id: "expedia", re: /\bexpedia\b/i },
    { id: "hotels_com", re: /\bhotels\.?\s*com\b/i },
    { id: "airbnb", re: /\bairbnb\b/i },
  ];

  function normText(v) {
    return String(v == null ? "" : v)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function upperCompact(v) {
    return normText(v).toUpperCase().replace(/\s+/g, "");
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
    for (var k in B2B) {
      if (Object.prototype.hasOwnProperty.call(B2B, k)) {
        if (compact === k || compact.indexOf(k) >= 0) return true;
      }
    }
    return false;
  }

  function matchOtaFromTexts(texts) {
    for (var i = 0; i < texts.length; i++) {
      var t = normText(texts[i]);
      if (!t) continue;
      if (/expedia\s*\/\s*hotels/i.test(t)) return "expedia";
      for (var j = 0; j < OTA.length; j++) {
        if (OTA[j].re.test(t)) return OTA[j].id;
      }
    }
    return null;
  }

  function isParticularMotorReservation(input) {
    var blobs = [
      input.channelManager,
      input.salesChannel,
      input.companyName,
      input.billingEntity,
      input.groupName,
    ].map(normText);
    var joined = blobs.join(" | ").toLowerCase();
    var hasMotor = /motor\s+de\s+reservas/.test(joined);
    var hasParticular = /\bparticular\b/.test(joined);
    if (hasParticular && hasMotor) return true;
    if (hasParticular && /sem\s+documento/.test(joined)) return true;
    if (hasMotor && !isB2bChannelManager(input.channelManager) && !matchOtaFromTexts(blobs)) {
      return true;
    }
    return false;
  }

  function classifyCommissionFromHits(input) {
    input = input || {};
    if (isB2bChannelManager(input.channelManager || input.integrator)) {
      return { classificacao: "comissionada", reason: "b2b_channel_manager", matchedOtaId: null };
    }
    var texts = [
      input.salesChannel,
      input.companyName,
      input.billingEntity,
      input.groupName,
      input.channelManager,
      input.integrator,
    ];
    var ota = matchOtaFromTexts(texts);
    if (ota) {
      return { classificacao: "comissionada", reason: "ota_channel", matchedOtaId: ota };
    }
    if (isParticularMotorReservation(input)) {
      return { classificacao: "nao_comissionada", reason: "particular_motor", matchedOtaId: null };
    }
    return { classificacao: "nao_comissionada", reason: "default_nao_comissionada", matchedOtaId: null };
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
  };
})(typeof window !== "undefined" ? window : globalThis);
