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

  /**
   * Espelho de src/lib/domain/yes-hotel/cafe-meal-plan.ts.
   * Lista FECHADA observada no HITS: "Café da Manhã" e "Nenhum". Nada de
   * heurística por substring; desconhecido/nulo/vazio é NÃO IDENTIFICADO.
   */
  function normalizeMealPlanDesc(raw) {
    return String(raw == null ? "" : raw)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  var CAFE_MEAL_PLAN_HOMOLOGADO = {
    "cafe da manha": "incluido",
    nenhum: "sem_cafe",
  };

  function classifyMealPlanDesc(raw) {
    var chave = normalizeMealPlanDesc(raw);
    if (!chave) return "nao_mapeado";
    return CAFE_MEAL_PLAN_HOMOLOGADO[chave] || "nao_mapeado";
  }

  function resolveCafeBreakfastEntitlementFromHits(input) {
    var guestCount = Math.max(0, Number(input.guestCount) || 0);
    var mealPlanDesc =
      input.mealPlanDesc == null ? null : String(input.mealPlanDesc).trim() || null;
    var paidExtraQty = Math.max(0, Number(input.paidExtraQtyFromHits) || 0);
    var plano = classifyMealPlanDesc(mealPlanDesc);

    if (plano === "incluido") {
      return {
        kind: "incluido",
        entitledQty: guestCount,
        guestCount: guestCount,
        paidExtraQty: 0,
        mealPlanDesc: mealPlanDesc,
        mappingGapReason: null,
      };
    }
    if (paidExtraQty > 0) {
      return {
        kind: "avulso_pago",
        entitledQty: paidExtraQty,
        guestCount: guestCount,
        paidExtraQty: paidExtraQty,
        mealPlanDesc: mealPlanDesc,
        mappingGapReason: null,
      };
    }
    if (plano === "sem_cafe") {
      return {
        kind: "sem_cafe",
        entitledQty: 0,
        guestCount: guestCount,
        paidExtraQty: 0,
        mealPlanDesc: mealPlanDesc,
        mappingGapReason: null,
      };
    }
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

  // O direito deixou de ser TETO do atendimento (migration
  // 20260928090000_cafe_controle_operacional): enquanto meal_plan_desc não
  // estiver homologado o direito é 0 e o operador precisa contar mesmo assim.
  // Resta o piso: nunca abaixo de zero. O parâmetro continua na assinatura
  // porque as chamadas o informam, mas não limita mais.
  function clampCafeAttendedQty(nextValue, _entitledQty) {
    if (!Number.isFinite(nextValue)) return 0;
    return Math.max(0, Math.trunc(nextValue));
  }

  function cafeMissingQty(card) {
    return Math.max(0, card.entitlement.entitledQty - card.attendedQty);
  }

  /** Mesma lista da RPC operacional_cafe_set_atendimento. */
  function canRoleWriteCafeAttendance(role) {
    var r = String(role || "").trim().toLowerCase();
    return r === "cafe" || r === "recepcao" || r === "admin";
  }

  function assertCanWriteCafeAttendance(input) {
    if (!canRoleWriteCafeAttendance(input.role)) {
      return { ok: false, error: "cafe_write_forbidden_role" };
    }
    if (!canRegisterCafeAttendanceForDate(input.cafeDateYmd, input.now)) {
      return { ok: false, error: "cafe_write_forbidden_future_date" };
    }
    if (input.dayStatus === "concluido") {
      return { ok: false, error: "cafe_write_forbidden_dia_concluido" };
    }
    // O direito NÃO barra mais o + / −: registrar quem tomou café é contagem
    // operacional, não cobrança. Espelha a RPC.
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Fechamento do serviço do dia (espelha cafe-day-closure.ts e as RPCs
  // operacional_cafe_fechar_dia / operacional_cafe_reabrir_dia).
  // O fechamento é um fato registrado, nunca inferido de atendidos = previstos.
  // -------------------------------------------------------------------------
  function buildOpenCafeDay(dateYmd) {
    return {
      dateYmd: dateYmd,
      status: "aberto",
      closedAt: null,
      closedByName: null,
      reopenedAt: null,
    };
  }

  function parseCafeDayClosure(dateYmd, row) {
    var status = String((row && row.status) || "aberto").trim().toLowerCase();
    if (status !== "concluido") return buildOpenCafeDay(dateYmd);
    var nome = String((row && row.concluido_por_nome) || "").trim();
    return {
      dateYmd: dateYmd,
      status: "concluido",
      closedAt: (row && row.concluido_em) || null,
      closedByName: nome || null,
      reopenedAt: (row && row.reaberto_em) || null,
    };
  }

  function isCafeDayClosed(closure) {
    return !!closure && closure.status === "concluido";
  }

  function canCloseCafeDay(input) {
    if (!canRoleWriteCafeAttendance(input.role)) return false;
    if (!canRegisterCafeAttendanceForDate(input.cafeDateYmd, input.now)) return false;
    return !isCafeDayClosed(input.closure);
  }

  function canReopenCafeDay(input) {
    if (String((input && input.role) || "").trim().toLowerCase() !== "admin") return false;
    return isCafeDayClosed(input && input.closure);
  }

  function cafeDayStatusLabel(closure) {
    return isCafeDayClosed(closure) ? "Concluído" : "Em andamento";
  }

  function formatCafeClosureTime(isoTimestamp) {
    if (!isoTimestamp) return "";
    var date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }

  function cafeClosureSummaryLine(closure) {
    if (!isCafeDayClosed(closure)) return "";
    var hora = formatCafeClosureTime(closure.closedAt);
    var nome = String(closure.closedByName || "").trim();
    if (hora && nome) return "Concluído às " + hora + " por " + nome;
    if (hora) return "Concluído às " + hora;
    if (nome) return "Concluído por " + nome;
    return "Serviço concluído";
  }

  function summarizeCafeKpis(cards) {
    var expectedGuests = 0;
    var attendedGuests = 0;
    var completeApartments = 0;
    var withBreakfast = 0;
    var withoutBreakfast = 0;
    var unknownPlan = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var entitled = Math.max(0, card.entitlement.entitledQty);
      if (card.entitlement.kind === "incluido" || card.entitlement.kind === "avulso_pago") {
        withBreakfast += 1;
      } else if (card.entitlement.kind === "sem_cafe") {
        withoutBreakfast += 1;
      } else {
        unknownPlan += 1;
      }
      var attended = clampCafeAttendedQty(card.attendedQty, entitled);
      // Atendidos é contagem real do operador: vale mesmo sem direito apurado.
      attendedGuests += attended;
      // Previstos e "atendimento completo" continuam dependendo do direito
      // oficial — sem ele não há total a comparar e nada é presumido.
      if (entitled <= 0) continue;
      expectedGuests += entitled;
      if (attended >= entitled) completeApartments += 1;
    }
    return {
      apartments: cards.length,
      expectedGuests: expectedGuests,
      attendedGuests: attendedGuests,
      missingGuests: Math.max(0, expectedGuests - attendedGuests),
      completeApartments: completeApartments,
      withBreakfast: withBreakfast,
      withoutBreakfast: withoutBreakfast,
      unknownPlan: unknownPlan,
    };
  }

  /**
   * "Marcar todos" só existe com total oficial: sem direito apurado não há
   * "todos" a marcar e presumir direito a café é exatamente o que não se faz.
   * A UI desabilita o botão por aqui; a RPC recusa pelo mesmo motivo.
   */
  function canMarkAllCafeAttendance(entitlement) {
    if (!entitlement) return false;
    if (entitlement.kind !== "incluido" && entitlement.kind !== "avulso_pago") return false;
    return Math.max(0, entitlement.entitledQty) > 0;
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
    if (entitlement.kind === "incluido") return "Café incluso";
    if (entitlement.kind === "sem_cafe") return "Sem café";
    return "Não identificado";
  }

  function cafeGuestLine(entitlement) {
    var n = entitlement.guestCount;
    var base = n === 1 ? "1 hóspede" : n + " hóspedes";
    if (entitlement.kind === "avulso_pago") {
      var n2 = entitlement.paidExtraQty;
      return base + " · " + (n2 === 1 ? "1 café avulso pago" : n2 + " cafés avulsos pagos");
    }
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
    normalizeMealPlanDesc: normalizeMealPlanDesc,
    classifyMealPlanDesc: classifyMealPlanDesc,
    canRoleWriteCafeAttendance: canRoleWriteCafeAttendance,
    canMarkAllCafeAttendance: canMarkAllCafeAttendance,
    assertCanWriteCafeAttendance: assertCanWriteCafeAttendance,
    buildOpenCafeDay: buildOpenCafeDay,
    parseCafeDayClosure: parseCafeDayClosure,
    isCafeDayClosed: isCafeDayClosed,
    canCloseCafeDay: canCloseCafeDay,
    canReopenCafeDay: canReopenCafeDay,
    cafeDayStatusLabel: cafeDayStatusLabel,
    formatCafeClosureTime: formatCafeClosureTime,
    cafeClosureSummaryLine: cafeClosureSummaryLine,
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
