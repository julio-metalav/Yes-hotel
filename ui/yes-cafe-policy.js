/**
 * Policy browser do Café — espelha:
 * - src/lib/domain/yes-hotel/cafe-operational-date.ts
 * - src/lib/domain/yes-hotel/cafe-stay-selection.ts
 * - src/lib/domain/yes-hotel/cafe-breakfast-entitlement.ts
 * - src/lib/domain/yes-hotel/cafe-attendance-policy.ts
 */
(function (global) {
  "use strict";

  var TZ = "America/Campo_Grande";
  var ROLLOVER_HOUR = 12;
  var MAPPING_GAP =
    "HITS não homologou campo seguro para café incluído / café avulso pago. " +
    "Candidato bruto: rooms[].mealPlanDesc (string). Avulso/quantidade paga: ausente.";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function hotelLocalParts(now) {
    now = now || new Date();
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    function get(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return parts[i].value;
      }
      return "";
    }
    return {
      ymd: get("year") + "-" + get("month") + "-" + get("day"),
      hour: Number(get("hour")),
      minute: Number(get("minute")),
    };
  }

  function addDaysYmd(ymd, days) {
    var m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error("YMD invalido: " + ymd);
    var dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
    return (
      dt.getUTCFullYear() +
      "-" +
      pad2(dt.getUTCMonth() + 1) +
      "-" +
      pad2(dt.getUTCDate())
    );
  }

  function hotelTodayYmd(now) {
    return hotelLocalParts(now).ymd;
  }

  function resolveCafeOperationalDateYmd(now) {
    var parts = hotelLocalParts(now);
    if (parts.hour >= ROLLOVER_HOUR) return addDaysYmd(parts.ymd, 1);
    return parts.ymd;
  }

  function formatCafeDateBr(ymd) {
    var m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    return m[3] + "/" + m[2] + "/" + m[1];
  }

  function resolveCafeDateHeader(selectedYmd, now) {
    var today = hotelTodayYmd(now);
    var tomorrow = addDaysYmd(today, 1);
    var br = formatCafeDateBr(selectedYmd);
    if (selectedYmd === today) return { kind: "hoje", label: "Café de hoje — " + br };
    if (selectedYmd === tomorrow) return { kind: "amanha", label: "Café de amanhã — " + br };
    return { kind: "consulta", label: "Consulta — " + br };
  }

  function canRegisterCafeAttendanceForDate(cafeDateYmd, now) {
    return String(cafeDateYmd).slice(0, 10) <= hotelTodayYmd(now);
  }

  function resolveSelectedCafeDateYmd(mode, manualYmd, now) {
    if (mode === "manual" && manualYmd) return String(manualYmd).slice(0, 10);
    return resolveCafeOperationalDateYmd(now);
  }

  function isValidCafeStayStatus(status) {
    var s = String(status || "").trim().toLowerCase();
    if (!s) return false;
    if (s === "cancelada" || s === "canceled" || s === "cancelled" || s === "2") return false;
    if (s === "no-show" || s === "noshow" || s === "no_show") return false;
    // Status 4 / Blocked: significado HITS não confirmado — fora da seleção.
    if (s === "4" || s === "blocked" || s === "bloqueado" || s === "bloqueada") return false;
    return s === "ativa" || s === "1" || s === "confirmed" || s === "3" || s === "processed";
  }

  function isCafeStayOnDate(reservation, cafeDateYmd) {
    if (!isValidCafeStayStatus(reservation.statusReserva)) return false;
    var cin = String(reservation.checkInYmd || "").slice(0, 10);
    var cout = String(reservation.checkOutYmd || "").slice(0, 10);
    var d = String(cafeDateYmd || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cin) || !/^\d{4}-\d{2}-\d{2}$/.test(cout)) return false;
    return cin < d && cout >= d;
  }

  function apartmentNumberValue(code) {
    var match = String(code || "").trim().match(/(\d+)/);
    if (!match) return Number.POSITIVE_INFINITY;
    var value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function compareCafeApartmentCodes(a, b) {
    var na = apartmentNumberValue(a);
    var nb = apartmentNumberValue(b);
    if (na !== nb) return na - nb;
    return String(a || "")
      .trim()
      .localeCompare(String(b || "").trim(), "pt-BR", { numeric: true, sensitivity: "base" });
  }

  function selectCafeStaysForDate(reservations, cafeDateYmd) {
    return reservations
      .filter(function (r) {
        return isCafeStayOnDate(r, cafeDateYmd);
      })
      .slice()
      .sort(function (left, right) {
        var apt = compareCafeApartmentCodes(left.apartmentCode, right.apartmentCode);
        if (apt !== 0) return apt;
        return String(left.id).localeCompare(String(right.id), "pt-BR");
      });
  }

  function resolveCafeBreakfastEntitlementFromHits(input) {
    var guestCount = Math.max(0, Number(input.guestCount) || 0);
    var mealPlanDesc =
      input.mealPlanDesc == null ? null : String(input.mealPlanDesc).trim() || null;
    return {
      kind: "nao_mapeado",
      entitledQty: 0,
      guestCount: guestCount,
      paidExtraQty: 0,
      mealPlanDesc: mealPlanDesc,
      mappingGapReason: MAPPING_GAP,
    };
  }

  function buildCafeBreakfastEntitlement(input) {
    var guestCount = Math.max(0, Number(input.guestCount) || 0);
    var paidExtraQty = Math.max(0, Number(input.paidExtraQty) || 0);
    if (input.kind === "incluido") {
      return {
        kind: "incluido",
        entitledQty: guestCount,
        guestCount: guestCount,
        paidExtraQty: 0,
        mealPlanDesc: input.mealPlanDesc || null,
        mappingGapReason: null,
      };
    }
    if (input.kind === "avulso_pago") {
      return {
        kind: "avulso_pago",
        entitledQty: paidExtraQty,
        guestCount: guestCount,
        paidExtraQty: paidExtraQty,
        mealPlanDesc: input.mealPlanDesc || null,
        mappingGapReason: null,
      };
    }
    return {
      kind: "sem_cafe",
      entitledQty: 0,
      guestCount: guestCount,
      paidExtraQty: 0,
      mealPlanDesc: input.mealPlanDesc || null,
      mappingGapReason: null,
    };
  }

  function clampCafeAttendedQty(nextValue, entitledQty) {
    var max = Math.max(0, entitledQty);
    if (!Number.isFinite(nextValue)) return 0;
    return Math.max(0, Math.min(Math.trunc(nextValue), max));
  }

  function cafeMissingQty(card) {
    return Math.max(0, card.entitlement.entitledQty - card.attendedQty);
  }

  function canRoleWriteCafeAttendance(role) {
    return String(role || "").trim().toLowerCase() === "cafe";
  }

  function assertCanWriteCafeAttendance(input) {
    if (!canRoleWriteCafeAttendance(input.role)) {
      return { ok: false, error: "cafe_write_forbidden_role" };
    }
    if (!canRegisterCafeAttendanceForDate(input.cafeDateYmd, input.now)) {
      return { ok: false, error: "cafe_write_forbidden_future_date" };
    }
    if (input.entitlement.kind === "nao_mapeado") {
      return { ok: false, error: "cafe_write_forbidden_unmapped_entitlement" };
    }
    if (input.entitlement.kind === "sem_cafe" || input.entitlement.entitledQty <= 0) {
      return { ok: false, error: "cafe_write_forbidden_no_entitlement" };
    }
    return { ok: true };
  }

  function summarizeCafeKpis(cards) {
    var expectedGuests = 0;
    var attendedGuests = 0;
    var completeApartments = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var entitled = Math.max(0, card.entitlement.entitledQty);
      if (entitled <= 0) continue;
      expectedGuests += entitled;
      var attended = clampCafeAttendedQty(card.attendedQty, entitled);
      attendedGuests += attended;
      if (attended >= entitled) completeApartments += 1;
    }
    return {
      apartments: cards.length,
      expectedGuests: expectedGuests,
      attendedGuests: attendedGuests,
      missingGuests: Math.max(0, expectedGuests - attendedGuests),
      completeApartments: completeApartments,
    };
  }

  function planMarkAllCafeAttended(cards) {
    // Só IDs — direito/limite são decididos na RPC, não no navegador.
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var entitled = Math.max(0, card.entitlement.entitledQty);
      if (entitled <= 0) continue;
      if (card.entitlement.kind === "sem_cafe" || card.entitlement.kind === "nao_mapeado") continue;
      var previousQty = clampCafeAttendedQty(card.attendedQty, entitled);
      if (previousQty === entitled) continue;
      out.push({ reservationId: card.reservationId });
    }
    return out;
  }

  function cafeStatusLabel(entitlement) {
    if (entitlement.kind === "avulso_pago") {
      var n = entitlement.paidExtraQty;
      return n === 1 ? "1 café avulso pago" : n + " cafés avulsos pagos";
    }
    return "";
  }

  function cafeGuestLine(entitlement) {
    var n = entitlement.guestCount;
    var base = n === 1 ? "1 hóspede" : n + " hóspedes";
    if (entitlement.kind === "avulso_pago") return base + " · " + cafeStatusLabel(entitlement);
    return base;
  }

  function cafeAlertLabel(entitlement) {
    return entitlement.kind === "sem_cafe" ? "SEM CAFÉ" : null;
  }

  function cafeOperationalStatusLabel(entitlement, attendedQty) {
    if (entitlement.kind === "sem_cafe" || entitlement.kind === "nao_mapeado") {
      return "";
    }
    var attended = clampCafeAttendedQty(attendedQty, entitlement.entitledQty);
    return attended >= entitlement.entitledQty
      ? "Atendimento completo"
      : "Aguardando atendimento";
  }

  /** Espelho de cafe-ppd-alert.ts — alerta operacional PPD (não altera pagamento). */
  function parsePositiveMoney(value) {
    if (value == null || value === "") return null;
    var n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
  }

  function formatBrl(amount) {
    return amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function resolvePpdChargeAmount(input) {
    input = input || {};
    var operacional = parsePositiveMoney(input.operacionalValorTotal);
    if (operacional != null) {
      return {
        source: "operacional_explicit",
        amount: operacional,
        displayLabel: formatBrl(operacional),
      };
    }
    var hits = parsePositiveMoney(input.hitsReservationTotalAmount);
    if (hits != null) {
      return {
        source: "hits_reservation_total",
        amount: hits,
        displayLabel: formatBrl(hits),
      };
    }
    return { source: "none", amount: null, displayLabel: "valor a confirmar" };
  }

  function isOfficialPaymentPaid(pagamentoStatus) {
    return String(pagamentoStatus || "").trim().toLowerCase() === "pago";
  }

  function resolveCafePpdOperationalState(input) {
    if (!input || !input.ppdEfetivado) return "none";
    if (input.ppdRegularizadoEm || isOfficialPaymentPaid(input.pagamentoStatus)) {
      return "regularized";
    }
    if (input.pagarmeObrigacaoLiquidada === true) return "none";
    var status = String(input.statusReserva || "").trim().toLowerCase();
    if (status === "cancelada" || status === "checkout" || status === "finalizada") {
      return "none";
    }
    if (input.ppdBloqueadoEm) return "suspended";
    var deadlineMs = input.ppdDeadlineEm ? Date.parse(input.ppdDeadlineEm) : NaN;
    var nowMs = input.nowIso ? Date.parse(input.nowIso) : Date.now();
    if (isFinite(deadlineMs) && isFinite(nowMs) && nowMs >= deadlineMs) {
      return "overdue";
    }
    return "pending";
  }

  function shouldShowCafePpdAlert(input) {
    var state = resolveCafePpdOperationalState(input);
    return state === "pending" || state === "overdue" || state === "suspended";
  }

  function buildCafePpdAlertView(input) {
    var charge = (input && input.charge) || resolvePpdChargeAmount({});
    var state = (input && input.state) || "pending";
    var badgeLabel =
      charge.source === "none"
        ? "DIÁRIA PENDENTE"
        : "DIÁRIA PENDENTE: " + charge.displayLabel;
    return {
      state: state,
      tone: "danger",
      badgeLabel: badgeLabel,
    };
  }

  var api = {
    TZ: TZ,
    hotelTodayYmd: hotelTodayYmd,
    resolveCafeOperationalDateYmd: resolveCafeOperationalDateYmd,
    formatCafeDateBr: formatCafeDateBr,
    resolveCafeDateHeader: resolveCafeDateHeader,
    canRegisterCafeAttendanceForDate: canRegisterCafeAttendanceForDate,
    resolveSelectedCafeDateYmd: resolveSelectedCafeDateYmd,
    isCafeStayOnDate: isCafeStayOnDate,
    selectCafeStaysForDate: selectCafeStaysForDate,
    compareCafeApartmentCodes: compareCafeApartmentCodes,
    resolveCafeBreakfastEntitlementFromHits: resolveCafeBreakfastEntitlementFromHits,
    buildCafeBreakfastEntitlement: buildCafeBreakfastEntitlement,
    clampCafeAttendedQty: clampCafeAttendedQty,
    cafeMissingQty: cafeMissingQty,
    canRoleWriteCafeAttendance: canRoleWriteCafeAttendance,
    assertCanWriteCafeAttendance: assertCanWriteCafeAttendance,
    summarizeCafeKpis: summarizeCafeKpis,
    planMarkAllCafeAttended: planMarkAllCafeAttended,
    cafeStatusLabel: cafeStatusLabel,
    cafeGuestLine: cafeGuestLine,
    cafeAlertLabel: cafeAlertLabel,
    cafeOperationalStatusLabel: cafeOperationalStatusLabel,
    resolvePpdChargeAmount: resolvePpdChargeAmount,
    resolveCafePpdOperationalState: resolveCafePpdOperationalState,
    shouldShowCafePpdAlert: shouldShowCafePpdAlert,
    buildCafePpdAlertView: buildCafePpdAlertView,
    isOfficialPaymentPaid: isOfficialPaymentPaid,
    MAPPING_GAP: MAPPING_GAP,
  };

  global.YesHotelCafePolicy = api;
})(typeof window !== "undefined" ? window : globalThis);
