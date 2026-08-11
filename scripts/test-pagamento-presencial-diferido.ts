/**
 * Testes A–R: pagamento presencial diferido (domínio puro, sem I/O).
 */
import assert from "node:assert/strict";
import {
  canShowPresencialDiferidoButton,
  evaluatePresencialDiferidoOnFirstAccess,
  isDiaUtilCorumba,
  resolvePresencialDiferidoRegra,
  resolvePresencialDiferidoUiLabel,
  utcIsoToHotelLocalParts,
} from "../src/lib/domain/yes-hotel/pagamento-presencial-diferido";
import { hotelLocalToUtcIso } from "../src/lib/domain/yes-hotel/hotel-timezone";
import { isCorumbaApplicableHoliday, easterSundayYmd } from "../src/lib/domain/yes-hotel/corumba-calendar";
import { decideAccessGrace } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import {
  buildInternalFirstAccessMessage,
  buildWelcomePendingMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages";

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

// Mensagens DigiSac / welcome
{
  const welcome = buildWelcomePendingMessage({
    payment_pending: true,
    fnrh_pending: false,
    presencial_diferido_efetivado: true,
  });
  assert.ok(welcome);
  assert.match(welcome!.body, /09:00/);
  assert.ok(!/1 hora/i.test(welcome!.body));

  const internal = buildInternalFirstAccessMessage({
    apartment_number: "34",
    reservation_code: "ABC",
    guest_main_name: "Breno",
    payment_pending: true,
    fnrh_pending: false,
    grace_started: true,
    presencial_diferido_efetivado: true,
  });
  assert.match(internal.body, /presencial diferido/i);
  assert.match(internal.body, /09:00/);
  assert.match(internal.body, /NÃO se aplica|NAO se aplica|não se aplica/i);
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

console.log("OK test-pagamento-presencial-diferido (A–R)");
