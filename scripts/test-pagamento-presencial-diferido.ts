/**
 * Testes A–R: pagamento presencial diferido (domínio puro, sem I/O).
 */
import assert from "node:assert/strict";
import {
  canShowPresencialDiferidoButton,
  evaluatePresencialDiferidoOnFirstAccess,
  isDiaUtilCorumba,
  isPagarmeObrigacaoLiquidadaForPpd,
  resolvePresencialDiferidoRegra,
  resolvePresencialDiferidoUiLabel,
  utcIsoToHotelLocalParts,
} from "../src/lib/domain/yes-hotel/pagamento-presencial-diferido";
import { hotelLocalToUtcIso } from "../src/lib/domain/yes-hotel/hotel-timezone";
import { isCorumbaApplicableHoliday, easterSundayYmd, carnivalMondayTuesdayYmd } from "../src/lib/domain/yes-hotel/corumba-calendar";
import { decideAccessGrace } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import {
  buildInternalFirstAccessMessage,
  buildWelcomePendingMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages";

function addDaysYmd(ymd: string, deltaDays: number): string {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays);
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const CHECKIN = "2026-08-11"; // terça-feira
assert.equal(isDiaUtilCorumba(CHECKIN), true);
assert.equal(resolvePresencialDiferidoRegra(CHECKIN), "util_19h");

const SAB = "2026-08-08"; // sábado
assert.equal(isDiaUtilCorumba(SAB), false);
assert.equal(resolvePresencialDiferidoRegra(SAB), "fim_semana_feriado_15h");

const DOM = "2026-08-09";
assert.equal(resolvePresencialDiferidoRegra(DOM), "fim_semana_feriado_15h");

// Feriado nacional em terça (Independência 2026-09-07 = segunda; use Tiradentes 2026-04-21 = terça)
const FERIADO_TER = "2026-04-21";
assert.equal(isCorumbaApplicableHoliday(FERIADO_TER), true);
assert.equal(isDiaUtilCorumba(FERIADO_TER), false);
assert.equal(resolvePresencialDiferidoRegra(FERIADO_TER), "fim_semana_feriado_15h");

assert.ok(easterSundayYmd(2026).match(/^\d{4}-\d{2}-\d{2}$/));

function localIso(ymd: string, h: number, m: number): string {
  return hotelLocalToUtcIso(ymd, h, m, 0);
}

function graceWith(occurred: string, autorizado: boolean) {
  return decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: true,
    fnrh_pending: false,
    pending_reasons: ["pagamento"],
    occurred_at: occurred,
    pagamento_presencial_diferido_autorizado: autorizado,
  });
}

// A) terça 18:59 marcado => NÃO efetiva => 1h
{
  const at = localIso(CHECKIN, 18, 59);
  const parts = utcIsoToHotelLocalParts(at);
  assert.equal(parts.hour, 18);
  assert.equal(parts.minute, 59);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  assert.equal(ev.efetivada, false);
  const g = graceWith(at, true);
  assert.equal(g.grace_mode, "standard_1h");
  assert.equal(g.suspension_due_at, new Date(new Date(at).getTime() + 3600_000).toISOString());
}

// B) terça 19:00 => NÃO efetiva
{
  const at = localIso(CHECKIN, 19, 0);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  assert.equal(ev.efetivada, false);
  assert.equal(graceWith(at, true).grace_mode, "standard_1h");
}

// C) terça 19:01 => efetiva => deadline 09:00 dia seguinte
{
  const at = localIso(CHECKIN, 19, 1);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  assert.equal(ev.efetivada, true);
  assert.equal(ev.regra, "util_19h");
  assert.equal(ev.deadlineIso, localIso("2026-08-12", 9, 0));
  const g = graceWith(at, true);
  assert.equal(g.grace_mode, "presencial_diferido_09h");
  assert.equal(g.suspension_due_at, ev.deadlineIso);
  assert.ok(g.pending_snapshot.includes("pagamento_presencial_diferido"));
}

// D) sábado 14:59 => regra normal
{
  const at = localIso(SAB, 14, 59);
  assert.equal(evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at }).efetivada, false);
  assert.equal(graceWith(at, true).grace_mode, "standard_1h");
}

// E) sábado 15:00 => regra normal
{
  const at = localIso(SAB, 15, 0);
  assert.equal(evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at }).efetivada, false);
}

// F) sábado 15:01 => diferido até 09:00
{
  const at = localIso(SAB, 15, 1);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  assert.equal(ev.efetivada, true);
  assert.equal(ev.regra, "fim_semana_feriado_15h");
  assert.equal(ev.deadlineIso, localIso("2026-08-09", 9, 0));
}

// G) domingo 16:00 => diferido
{
  const at = localIso(DOM, 16, 0);
  assert.equal(evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at }).efetivada, true);
}

// H) feriado terça 16:00 => regra 15h
{
  const at = localIso(FERIADO_TER, 16, 0);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  assert.equal(ev.efetivada, true);
  assert.equal(ev.regra, "fim_semana_feriado_15h");
}

// I) dia útil 20:00 + pago 08:30 => não bloqueia (deadline 09:00; pago antes)
{
  const at = localIso(CHECKIN, 20, 0);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  const paidAt = localIso("2026-08-12", 8, 30);
  assert.ok(new Date(paidAt).getTime() < new Date(ev.deadlineIso).getTime());
  assert.equal(
    resolvePresencialDiferidoUiLabel({
      autorizado: true,
      efetivado: true,
      pagamentoStatus: "pago",
      nowIso: paidAt,
    }),
    null,
  );
}

// J) dia útil 20:00 + ainda pendente 08:59 => acesso ativo
{
  const at = localIso(CHECKIN, 20, 0);
  const ev = evaluatePresencialDiferidoOnFirstAccess({ autorizado: true, firstAccessAtIso: at });
  const now = localIso("2026-08-12", 8, 59);
  assert.ok(new Date(now).getTime() < new Date(ev.deadlineIso).getTime());
  assert.equal(
    resolvePresencialDiferidoUiLabel({
      autorizado: true,
      efetivado: true,
      pagamentoStatus: "pendente",
      graceStatus: "active",
      nowIso: now,
    }),
    "Pagamento presencial até 09:00",
  );
}

// K) dia útil 20:00 + pendente às 09:00 => acesso suspenso
{
  const now = localIso("2026-08-12", 9, 0);
  assert.equal(
    resolvePresencialDiferidoUiLabel({
      autorizado: true,
      efetivado: true,
      pagamentoStatus: "pendente",
      graceStatus: "suspended",
      nowIso: now,
    }),
    "Pagamento vencido — acesso suspenso",
  );
  const due = localIso("2026-08-12", 9, 0);
  assert.ok(new Date(now).getTime() >= new Date(due).getTime());
}

// L) botão antes das 08:00 => não aparece
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso(CHECKIN, 7, 59),
    checkInYmd: CHECKIN,
    statusReserva: "ativa",
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "admin",
    featureEnabled: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "antes_das_08h");
}

// M) botão 08:00 no dia check-in => aparece se elegível
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso(CHECKIN, 8, 0),
    checkInYmd: CHECKIN,
    statusReserva: "ativa",
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "recepcao",
    featureEnabled: true,
  });
  assert.equal(d.allowed, true);
}

// N) botão dia anterior => não aparece
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso("2026-08-10", 10, 0),
    checkInYmd: CHECKIN,
    statusReserva: "ativa",
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "admin",
    featureEnabled: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "fora_do_dia_checkin");
}

// O) marcação sem primeiro acesso => não inicia prazo (só autorização)
{
  assert.equal(
    resolvePresencialDiferidoUiLabel({
      autorizado: true,
      efetivado: false,
      pagamentoStatus: "pendente",
      nowIso: localIso(CHECKIN, 10, 0),
    }),
    "Presencial diferido autorizado",
  );
}

// P) primeiro acesso antes do limite => não ganha exceção
{
  const g = graceWith(localIso(CHECKIN, 18, 0), true);
  assert.equal(g.grace_mode, "standard_1h");
  assert.ok(!g.pending_snapshot.includes("pagamento_presencial_diferido"));
}

// Q) reserva paga => botão não aparece
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso(CHECKIN, 10, 0),
    checkInYmd: CHECKIN,
    statusReserva: "ativa",
    pagamentoStatus: "pago",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "admin",
    featureEnabled: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "ja_pago");
}

// R) cancelada => botão não aparece
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso(CHECKIN, 10, 0),
    checkInYmd: CHECKIN,
    statusReserva: "cancelada",
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "admin",
    featureEnabled: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "reserva_inativa");
}

// Mensagens DigiSac / welcome — PPD usa guest_payment_deferred_breakfast
{
  const welcome = buildWelcomePendingMessage({
    payment_pending: true,
    fnrh_pending: false,
    presencial_diferido_efetivado: true,
  });
  assert.equal(welcome, null);

  const internal = buildInternalFirstAccessMessage({
    apartment_number: "34",
    reservation_code: "ABC",
    guest_main_name: "Breno",
    payment_pending: true,
    fnrh_pending: false,
    grace_started: true,
    presencial_diferido_efetivado: true,
    charge_valor_label: "confirmar no HITS",
  });
  assert.match(internal.body, /presencial diferido/i);
  assert.match(internal.body, /09h/);
  assert.match(internal.body, /café da manhã/i);
  assert.match(internal.body, /HITS/);
}

// Regressão: sem autorização => 1h
{
  const g = graceWith(localIso(CHECKIN, 20, 0), false);
  assert.equal(g.grace_mode, "standard_1h");
}

// Feature off: botão
{
  const d = canShowPresencialDiferidoButton({
    nowIso: localIso(CHECKIN, 10, 0),
    checkInYmd: CHECKIN,
    statusReserva: "ativa",
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "admin",
    featureEnabled: false,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "feature_off");
}

// ---- Calendário oficial (auditoria fontes MS / Corumbá Lei 2.986/2025) ----
{
  // 11/07 NÃO é feriado estadual (ex.: sexta 2025-07-11 = dia útil 19h)
  assert.equal(isCorumbaApplicableHoliday("2025-07-11"), false);
  assert.equal(isCorumbaApplicableHoliday("2026-07-11"), false);
  assert.equal(isDiaUtilCorumba("2025-07-11"), true);
  assert.equal(resolvePresencialDiferidoRegra("2025-07-11"), "util_19h");
  const gJul = evaluatePresencialDiferidoOnFirstAccess({
    autorizado: true,
    firstAccessAtIso: localIso("2025-07-11", 19, 1),
  });
  assert.equal(gJul.efetivada, true);
  assert.equal(gJul.regra, "util_19h");
  assert.equal(
    evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: localIso("2025-07-11", 18, 59),
    }).efetivada,
    false,
  );
  assert.equal(
    evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: localIso("2025-07-11", 19, 0),
    }).efetivada,
    false,
  );

  // 11/10 = feriado estadual Criação do MS
  assert.equal(isCorumbaApplicableHoliday("2026-10-11"), true);
  assert.equal(isDiaUtilCorumba("2026-10-11"), false);
  assert.equal(resolvePresencialDiferidoRegra("2026-10-11"), "fim_semana_feriado_15h");
  assert.equal(
    evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: localIso("2026-10-11", 15, 1),
    }).efetivada,
    true,
  );

  const municipais = ["2026-02-02", "2026-06-13", "2026-06-24", "2026-09-21"];
  for (const ymd of municipais) {
    assert.equal(isCorumbaApplicableHoliday(ymd), true, ymd);
    assert.equal(resolvePresencialDiferidoRegra(ymd), "fim_semana_feriado_15h", ymd);
    assert.equal(
      evaluatePresencialDiferidoOnFirstAccess({
        autorizado: true,
        firstAccessAtIso: localIso(ymd, 15, 1),
      }).efetivada,
      true,
      `${ymd} 15:01`,
    );
  }

  const easter2026 = easterSundayYmd(2026);
  const goodFriday = addDaysYmd(easter2026, -2);
  const corpus = addDaysYmd(easter2026, 60);
  assert.equal(isCorumbaApplicableHoliday(goodFriday), true);
  assert.equal(isCorumbaApplicableHoliday(corpus), true);
  assert.equal(
    evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: localIso(goodFriday, 15, 1),
    }).efetivada,
    true,
  );
  assert.equal(
    evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: localIso(corpus, 15, 1),
    }).efetivada,
    true,
  );

  // Carnaval seg/ter = NÃO feriado (ponto facultativo)
  const carn = carnivalMondayTuesdayYmd(2026);
  assert.equal(isCorumbaApplicableHoliday(carn.monday), false);
  assert.equal(isCorumbaApplicableHoliday(carn.tuesday), false);
  // Se cair em dia de semana, regra 19h
  if (resolvePresencialDiferidoRegra(carn.tuesday) === "util_19h") {
    assert.equal(
      evaluatePresencialDiferidoOnFirstAccess({
        autorizado: true,
        firstAccessAtIso: localIso(carn.tuesday, 18, 59),
      }).efetivada,
      false,
    );
    assert.equal(
      evaluatePresencialDiferidoOnFirstAccess({
        autorizado: true,
        firstAccessAtIso: localIso(carn.tuesday, 19, 0),
      }).efetivada,
      false,
    );
    assert.equal(
      evaluatePresencialDiferidoOnFirstAccess({
        autorizado: true,
        firstAccessAtIso: localIso(carn.tuesday, 19, 1),
      }).efetivada,
      true,
    );
  }
}

// ---- CP5 hotfix: PPD vs Pagar.me paid (A–F) ----
const baseEligible = {
  nowIso: localIso(CHECKIN, 10, 0),
  checkInYmd: CHECKIN,
  statusReserva: "ativa",
  pagamentoStatus: "pendente",
  classificacaoComissionamento: "nao_comissionada",
  perfilUsuario: "admin",
  featureEnabled: true,
} as const;

// A) HITS pendente + sem Pagar.me paid => PPD pode aparecer
{
  const d = canShowPresencialDiferidoButton({
    ...baseEligible,
    cobrancasPagarme: [],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
}

// B) HITS pendente + Pagar.me paid => botão NÃO aparece
{
  const d = canShowPresencialDiferidoButton({
    ...baseEligible,
    cobrancasPagarme: [{ status: "paid" }],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "pagarme_ja_pago");
  assert.equal(isPagarmeObrigacaoLiquidadaForPpd([{ status: "paid" }]), true);
}

// C) mesma condição via flag explícita (backend/UI) => rejeitada
{
  const d = canShowPresencialDiferidoButton({
    ...baseEligible,
    pagarmeObrigacaoLiquidada: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "pagarme_ja_pago");
}

// D) HITS pago => PPD não aparece
{
  const d = canShowPresencialDiferidoButton({
    ...baseEligible,
    pagamentoStatus: "pago",
    cobrancasPagarme: [],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "ja_pago");
}

// E) Pagar.me pending => não considerar paid
{
  assert.equal(isPagarmeObrigacaoLiquidadaForPpd([{ status: "pending" }]), false);
  const d = canShowPresencialDiferidoButton({
    ...baseEligible,
    cobrancasPagarme: [{ status: "pending" }],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
}

// F) refunded/chargeback => não tratar automaticamente como paid
{
  assert.equal(isPagarmeObrigacaoLiquidadaForPpd([{ status: "refunded" }]), false);
  assert.equal(isPagarmeObrigacaoLiquidadaForPpd([{ status: "chargeback" }]), false);
  const dRef = canShowPresencialDiferidoButton({
    ...baseEligible,
    cobrancasPagarme: [{ status: "refunded" }],
  });
  assert.equal(dRef.allowed, true);
  const dCb = canShowPresencialDiferidoButton({
    ...baseEligible,
    cobrancasPagarme: [{ status: "chargeback" }],
  });
  assert.equal(dCb.allowed, true);
}

console.log("OK test-pagamento-presencial-diferido (A–R + calendário + Pagar.me/PPD A–F)");
