/**
 * Fixtures explícitas do modo ?demo=1.
 * Nunca são enviadas ao Supabase e só são consumidas após autenticação/autorização.
 */
(function (global) {
  "use strict";

  function addDaysYmd(ymd, days) {
    var match = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error("Data demo inválida.");
    var date = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
    );
    return (
      date.getUTCFullYear() +
      "-" +
      String(date.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getUTCDate()).padStart(2, "0")
    );
  }

  function localIso(ymd, hour, minute) {
    return (
      ymd +
      "T" +
      String(hour).padStart(2, "0") +
      ":" +
      String(minute || 0).padStart(2, "0") +
      ":00-04:00"
    );
  }

  function base(id, apartmentCode, mainGuestName, totalGuests, serviceYmd) {
    return {
      id: "demo-cafe-" + id,
      scenario: id,
      apartmentCode: apartmentCode,
      mainGuestName: mainGuestName,
      totalGuests: totalGuests,
      checkInYmd: addDaysYmd(serviceYmd, -1),
      checkOutYmd: addDaysYmd(serviceYmd, 1),
      statusReserva: "ativa",
      pagamentoStatus: "pago",
      attendedQty: 0,
    };
  }

  function createDataset(serviceYmd) {
    var deadline = localIso(serviceYmd, 9, 0);
    return [
      Object.assign(base("A", "34", "Breno Santoriano", 1, serviceYmd), {
        kind: "incluido",
      }),
      Object.assign(base("B", "33", "Teste Sem Café", 2, serviceYmd), {
        kind: "sem_cafe",
      }),
      Object.assign(base("C", "32", "Teste Café Avulso", 2, serviceYmd), {
        kind: "avulso_pago",
        paidExtraQty: 1,
      }),
      Object.assign(base("D", "31", "Teste PPD Antes 09h", 2, serviceYmd), {
        kind: "incluido",
        pagamentoStatus: "pendente",
        ppdEfetivado: true,
        ppdDeadlineEm: deadline,
        demoNowIso: localIso(serviceYmd, 8, 15),
        operacionalValorTotal: 250,
      }),
      Object.assign(base("F", "30", "Teste PPD Suspenso", 1, serviceYmd), {
        kind: "incluido",
        pagamentoStatus: "pendente",
        ppdEfetivado: true,
        ppdDeadlineEm: deadline,
        ppdBloqueadoEm: localIso(serviceYmd, 9, 1),
        demoNowIso: localIso(serviceYmd, 9, 15),
        operacionalValorTotal: 250,
      }),
      Object.assign(base("G", "29", "Teste PPD Regularizado", 1, serviceYmd), {
        kind: "incluido",
        pagamentoStatus: "pago",
        ppdEfetivado: true,
        ppdDeadlineEm: deadline,
        ppdRegularizadoEm: localIso(serviceYmd, 8, 40),
        demoNowIso: localIso(serviceYmd, 8, 45),
        operacionalValorTotal: 250,
      }),
      Object.assign(base("H", "28", "Teste HITS Não Mapeado", 1, serviceYmd), {
        kind: "nao_mapeado",
      }),
      Object.assign(base("E", "27", "Teste PPD Prazo Vencido", 2, serviceYmd), {
        kind: "incluido",
        pagamentoStatus: "pendente",
        ppdEfetivado: true,
        ppdDeadlineEm: deadline,
        demoNowIso: localIso(serviceYmd, 9, 5),
        operacionalValorTotal: 250,
      }),
    ];
  }

  global.YesHotelCafeDemo = Object.freeze({
    createDataset: createDataset,
  });
})(typeof window !== "undefined" ? window : globalThis);
