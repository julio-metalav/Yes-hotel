/**
 * Fixtures sintéticas da tela Gestão → Saúde do Hotel.
 * NÃO é payload HITS. NÃO lê Supabase. NÃO é dado financeiro real.
 * Agrupamento de canal espelha src/lib/management/channel.ts (Booking Engine ≠ OTA).
 */
(function attachYesHotelGestaoSaudeDemo(globalScope) {
  var DEMO_BANNER = "DADOS DEMONSTRATIVOS — aguardando integração gerencial";

  /**
   * Espelho de channelGroup() da fundação. Booking Engine e Direto = grupo direct.
   * B2B permanece separado. Nunca usar includes("booking").
   */
  function channelGroup(kind) {
    if (kind === "direct" || kind === "booking_engine" || kind === "manual") return "direct";
    if (kind === "ota") return "ota";
    if (kind === "b2b") return "b2b";
    return "other";
  }

  function trend(current, previous) {
    if (previous == null || previous === 0) {
      return { deltaLabel: "sem base anterior", direction: "flat", pct: null };
    }
    var pct = (current - previous) / Math.abs(previous);
    var direction = pct > 0.004 ? "up" : pct < -0.004 ? "down" : "flat";
    var sign = pct > 0 ? "+" : "";
    return {
      pct: pct,
      direction: direction,
      deltaLabel: sign + (pct * 100).toFixed(1).replace(".", ",") + "% vs período anterior",
    };
  }

  var CHANNEL_ROWS = [
    {
      code: "direct",
      kind: "direct",
      label: "Direto",
      reservations: 28,
      lodgingRevenueCents: 6_720_000,
    },
    {
      code: "booking_engine",
      kind: "booking_engine",
      label: "Booking Engine",
      reservations: 11,
      lodgingRevenueCents: 2_640_000,
    },
    {
      code: "booking",
      kind: "ota",
      label: "Booking.com",
      reservations: 32,
      lodgingRevenueCents: 6_400_000,
    },
    {
      code: "expedia",
      kind: "ota",
      label: "Expedia",
      reservations: 14,
      lodgingRevenueCents: 2_800_000,
    },
    {
      code: "b2b",
      kind: "b2b",
      label: "B2B",
      reservations: 9,
      lodgingRevenueCents: 2_080_000,
    },
  ].map(function (row) {
    var roomNights = row.kind === "b2b" ? 36 : row.reservations * 3;
    return {
      code: row.code,
      kind: row.kind,
      label: row.label,
      reservations: row.reservations,
      lodgingRevenueCents: row.lodgingRevenueCents,
      group: channelGroup(row.kind),
      roomNights: roomNights,
      adrCents: Math.round(row.lodgingRevenueCents / roomNights),
    };
  });

  var MONTH = {
    label: "Agosto 2026 (demo)",
    lodgingRevenueCents: 18_640_000,
    previousLodgingRevenueCents: 17_200_000,
    occupancy: 0.62,
    previousOccupancy: 0.58,
    adrCents: 24_800,
    previousAdrCents: 23_900,
    revparCents: 15_376,
    previousRevparCents: 13_862,
    reservationCount: 94,
    previousReservationCount: 88,
    receivablesOpenCents: 1_245_000,
    previousReceivablesOpenCents: 980_000,
    overdueReceivablesCents: 320_000,
  };

  var OTB_30 = {
    label: "Próximos 30 dias",
    occupancyBooked: 0.48,
    historicalOccupancy: 0.62,
    contractedRevenueCents: 14_200_000,
    futureAdrCents: 25_500,
    futureReservations: 61,
  };

  var ALERT_INPUT = {
    futureOccupancy: OTB_30.occupancyBooked,
    historicalOccupancy: OTB_30.historicalOccupancy,
    currentAdrCents: MONTH.adrCents,
    previousAdrCents: MONTH.previousAdrCents,
    currentCancelRate: 0.04,
    previousCancelRate: 0.04,
    currentDirectShare: 0.31,
    previousDirectShare: 0.41,
    otaShare: 0.49,
    overdueCents: MONTH.overdueReceivablesCents,
    b2bRevenueDeltaRatio: -0.04,
    highValueInactiveCount: 0,
  };

  var THRESHOLDS = {
    occupancyGap: 0.1,
    adrDropRatio: 0.08,
    cancelRateIncrease: 0.05,
    directShareDrop: 0.08,
    otaShareMax: 0.7,
    overdueCents: 1,
    b2bDropRatio: 0.25,
  };

  /** Espelho reduzido de evaluateManagementAlerts (sem IA). Máximo 5 itens na UI. */
  function evaluateDemoAlerts(input, thresholds) {
    var alerts = [];
    if (
      input.futureOccupancy != null &&
      input.historicalOccupancy != null &&
      input.historicalOccupancy - input.futureOccupancy >= thresholds.occupancyGap
    ) {
      alerts.push({
        code: "future_occupancy_below_history",
        severity: "warning",
        message: "Ocupação futura abaixo da média histórica.",
      });
    }
    if (input.overdueCents >= thresholds.overdueCents) {
      alerts.push({
        code: "overdue_receivables",
        severity: input.overdueCents >= 100_000 ? "critical" : "warning",
        message: "Há contas a receber vencidas.",
      });
    }
    if (
      input.currentDirectShare != null &&
      input.previousDirectShare != null &&
      input.previousDirectShare - input.currentDirectShare >= thresholds.directShareDrop
    ) {
      alerts.push({
        code: "direct_reservations_down",
        severity: "warning",
        message: "Queda de participação de reservas diretas.",
      });
    }
    if (input.otaShare != null && input.otaShare > thresholds.otaShareMax) {
      alerts.push({
        code: "ota_share_excessive",
        severity: "warning",
        message: "Participação OTA acima do limiar.",
      });
    }
    if (
      input.currentAdrCents != null &&
      input.previousAdrCents != null &&
      input.previousAdrCents > 0 &&
      input.currentAdrCents > input.previousAdrCents
    ) {
      alerts.push({
        code: "adr_growth_info",
        severity: "info",
        message: "ADR em crescimento frente ao período anterior.",
      });
    }
    return alerts.slice(0, 5);
  }

  function buildDashboard() {
    var totalReservations = CHANNEL_ROWS.reduce(function (s, r) {
      return s + r.reservations;
    }, 0);
    var totalRevenue = CHANNEL_ROWS.reduce(function (s, r) {
      return s + r.lodgingRevenueCents;
    }, 0);

    return {
      demo: true,
      source: "synthetic_fixture",
      banner: DEMO_BANNER,
      periodLabel: MONTH.label,
      kpis: [
        {
          id: "revenue",
          label: "Receita do mês",
          valueCents: MONTH.lodgingRevenueCents,
          format: "money",
          trend: trend(MONTH.lodgingRevenueCents, MONTH.previousLodgingRevenueCents),
        },
        {
          id: "occupancy",
          label: "Ocupação",
          valueRatio: MONTH.occupancy,
          format: "pct",
          trend: trend(MONTH.occupancy, MONTH.previousOccupancy),
        },
        {
          id: "adr",
          label: "ADR",
          valueCents: MONTH.adrCents,
          format: "money",
          trend: trend(MONTH.adrCents, MONTH.previousAdrCents),
        },
        {
          id: "revpar",
          label: "RevPAR",
          valueCents: MONTH.revparCents,
          format: "money",
          trend: trend(MONTH.revparCents, MONTH.previousRevparCents),
        },
        {
          id: "reservations",
          label: "Reservas no mês",
          valueCount: MONTH.reservationCount,
          format: "count",
          trend: trend(MONTH.reservationCount, MONTH.previousReservationCount),
        },
        {
          id: "receivables",
          label: "Contas a receber",
          valueCents: MONTH.receivablesOpenCents,
          format: "money",
          note: "Inclui vencidos (demo)",
          trend: trend(MONTH.receivablesOpenCents, MONTH.previousReceivablesOpenCents),
        },
      ],
      otb: {
        title: "Próximos 30 dias",
        occupancyBooked: OTB_30.occupancyBooked,
        contractedRevenueCents: OTB_30.contractedRevenueCents,
        futureAdrCents: OTB_30.futureAdrCents,
        futureReservations: OTB_30.futureReservations,
      },
      channels: CHANNEL_ROWS.map(function (row) {
        return {
          code: row.code,
          kind: row.kind,
          group: row.group,
          label: row.label,
          reservations: row.reservations,
          lodgingRevenueCents: row.lodgingRevenueCents,
          adrCents: row.adrCents,
          shareOfReservations: totalReservations ? row.reservations / totalReservations : 0,
          shareOfRevenue: totalRevenue ? row.lodgingRevenueCents / totalRevenue : 0,
        };
      }),
      alerts: evaluateDemoAlerts(ALERT_INPUT, THRESHOLDS),
    };
  }

  globalScope.YesHotelGestaoSaudeDemo = {
    DEMO_BANNER: DEMO_BANNER,
    channelGroup: channelGroup,
    CHANNEL_ROWS: CHANNEL_ROWS,
    evaluateDemoAlerts: evaluateDemoAlerts,
    buildDashboard: buildDashboard,
  };
})(typeof window !== "undefined" ? window : globalThis);
