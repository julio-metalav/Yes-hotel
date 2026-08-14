/**
 * Testes A–L: PPD → café da manhã (mensagem + alerta operacional).
 * Sem I/O real / sem envio DigiSac.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildInternalFirstAccessMessage,
  buildWelcomePendingMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages.ts";
import {
  buildCafePpdAlertView,
  resolveCafePpdOperationalState,
  resolvePpdChargeAmount,
  shouldShowCafePpdAlert,
} from "../src/lib/domain/yes-hotel/cafe-ppd-alert.ts";
import {
  buildGuestPaymentDeferredBreakfastMessage,
  formatPpdDeadlineGuestPhrase,
  guestPaymentDeferredBreakfastIdempotencyKey,
  GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
} from "../src/lib/domain/yes-hotel/guest-payment-deferred-breakfast.ts";
import { evaluatePresencialDiferidoOnFirstAccess } from "../src/lib/domain/yes-hotel/pagamento-presencial-diferido.ts";
import { hotelLocalToUtcIso } from "../src/lib/domain/yes-hotel/hotel-timezone.ts";
import { decideAccessGrace } from "../src/lib/domain/yes-hotel/first-room-access-policy.ts";
import { pendingMessageAvailableAt } from "../src/lib/application/yes-hotel/enqueue-guest-first-access-welcome.ts";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator.ts";
import { ACCESS_EVENT_SOURCE_POLLING } from "../src/lib/integrations/ttlock/access-ingest/constants.ts";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory.ts";

const CHECKIN = "2026-08-11"; // terça (dia útil)

function localIso(ymd: string, hour: number, minute = 0): string {
  return hotelLocalToUtcIso(ymd, hour, minute, 0);
}

function ok(label: string) {
  console.log(`  OK ${label}`);
}

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: "cred-ppd",
      logical_destination: "APT-34",
      lock_type: "apartamento" as const,
      lock_id: 16274746,
      remote_keyboard_pwd_id: 103343466,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-a",
      credential_id: "cred-ppd",
      logical_destination: "GATE-EXT",
      lock_type: "portao_externo" as const,
      lock_id: 1,
      remote_keyboard_pwd_id: 11,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-b",
      credential_id: "cred-ppd",
      logical_destination: "GATE-INT",
      lock_type: "portao_interno" as const,
      lock_id: 2,
      remote_keyboard_pwd_id: 22,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
  ];
}

async function main() {
  console.log("== A) PPD pré-autorizado, acesso antes do cutoff → não efetiva ==");
  {
    const occurred = localIso(CHECKIN, 19, 0);
    const evalBefore = evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: occurred,
    });
    assert.equal(evalBefore.efetivada, false);

    const grace = decideAccessGrace({
      event_accepted: true,
      first_access_already_registered: false,
      grace_already_started: false,
      payment_pending: true,
      fnrh_pending: false,
      pending_reasons: ["pagamento"],
      occurred_at: occurred,
      pagamento_presencial_diferido_autorizado: true,
    });
    assert.equal(grace.grace_mode, "standard_1h");
    assert.ok(!grace.pending_snapshot.includes("pagamento_presencial_diferido"));
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: false,
        ppdAutorizado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
      }),
      false,
    );
    ok("sem efetivação e lista café sem alerta");
  }

  console.log("== B) PPD efetivado → welcome + ~1 min café (orquestrador) ==");
  {
    const occurred = localIso(CHECKIN, 20, 5);
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "res-ppd-b",
        credential_id: "cred-ppd",
        credential_item_id: "item-apt",
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 1,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: {
        payment_status: "pendente",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
        pagamento_presencial_diferido_autorizado: true,
      },
      items: threeItems(),
      now: new Date(occurred),
    });
    h.ports.presencialDiferidoFeatureEnabled = true;
    h.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34",
          reservation_code: "HITS-PPD",
          guest_main_name: "Breno",
          parking_spot: "34",
          wifi_ssid: "YES-34",
          wifi_password: "segredo34",
        };
      },
    };

    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: "poll:ppd-b",
        idempotency_key: "ppd-b-idem",
        occurred_at: occurred,
        lock_id: 16274746,
        record_type: 4,
        success: true,
      },
      h.ports,
    );
    assert.equal(r.status, "grace_started");

    const welcome = h.state.accessOutbox.filter(
      (o) => o.event_type === "guest_first_access_welcome",
    );
    assert.equal(welcome.length, 2);
    assert.ok(
      welcome.every((o) => Date.parse(o.available_at) === Date.parse(occurred)),
    );

    const breakfast = h.state.accessOutbox.filter(
      (o) => o.event_type === GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
    );
    assert.equal(breakfast.length, 2);
    const pendingAt = pendingMessageAvailableAt(occurred);
    assert.ok(breakfast.every((o) => o.available_at === pendingAt));
    assert.match(String(breakfast[0]?.payload?.body ?? ""), /café da manhã/i);
    assert.match(String(breakfast[0]?.payload?.body ?? ""), /09h/);
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "guest_welcome_pending")
        .length,
      0,
    );

    const internal = h.state.accessOutbox.find(
      (o) => o.event_type === "internal_first_access",
    );
    assert.ok(internal);
    assert.match(String(internal?.payload?.body ?? ""), /café da manhã/i);
    assert.match(String(internal?.payload?.body ?? ""), /HITS/);

    const r2 = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: "poll:ppd-b",
        idempotency_key: "ppd-b-idem",
        occurred_at: occurred,
        lock_id: 16274746,
        record_type: 4,
        success: true,
      },
      h.ports,
    );
    assert.equal(r2.status, "already_started");
    assert.equal(
      h.state.accessOutbox.filter(
        (o) => o.event_type === GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
      ).length,
      2,
    );
    ok("welcome imediato + café +1min WA/email; replay sem duplicar");
  }

  console.log("== C/D/E) Lista café: alerta + valor ==");
  {
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
      }),
      true,
    );
    const withValue = resolvePpdChargeAmount({ hitsReservationTotalAmount: 420 });
    assert.equal(withValue.source, "hits_reservation_total");
    assert.match(withValue.displayLabel, /420/);
    const view = buildCafePpdAlertView({
      charge: withValue,
    });
    assert.equal(
      view.badgeLabel.replace(/\s/g, " "),
      "DIÁRIA PENDENTE: R$ 420,00",
    );

    const missing = resolvePpdChargeAmount({});
    assert.equal(missing.source, "none");
    assert.equal(missing.displayLabel, "valor a confirmar");
    const viewMissing = buildCafePpdAlertView({
      charge: missing,
    });
    assert.equal(viewMissing.badgeLabel, "DIÁRIA PENDENTE");
    ok("alerta simples + valor confiável + fallback sem valor");
  }

  console.log("== F) HITS pago → alerta some ==");
  {
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pago",
        statusReserva: "ativa",
      }),
      false,
    );
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
        ppdRegularizadoEm: "2026-08-12T12:00:00.000Z",
      }),
      false,
    );
    ok("pago/regularizado sem alerta");
  }

  console.log("== G) Pagar.me paid → não aparece ==");
  {
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
        pagarmeObrigacaoLiquidada: true,
      }),
      false,
    );
    ok("pagarme paid protegido");
  }

  console.log("== H) PPD bloqueado → mesma cobrança simples ==");
  {
    assert.equal(
      shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
        ppdBloqueadoEm: "2026-08-12T08:00:00.000Z",
      }),
      true,
    );
    const state = resolveCafePpdOperationalState({
      ppdEfetivado: true,
      pagamentoStatus: "pendente",
      statusReserva: "ativa",
      ppdBloqueadoEm: "2026-08-12T08:00:00.000Z",
    });
    assert.equal(state, "suspended");
    const view = buildCafePpdAlertView({
      charge: resolvePpdChargeAmount({ hitsReservationTotalAmount: 250 }),
      state,
    });
    assert.equal(
      view.badgeLabel.replace(/\s/g, " "),
      "DIÁRIA PENDENTE: R$ 250,00",
    );
    ok("bloqueado mantém somente cobrança da diária");
  }

  console.log("== I/J) Exactly-once keys + multicanal ==");
  {
    const nowIso = localIso(CHECKIN, 20, 10);
    const d = evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: nowIso,
    });
    const msg = buildGuestPaymentDeferredBreakfastMessage({
      deadlineIso: d.deadlineIso!,
      nowIso,
    });
    assert.equal(msg.kind, GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT);
    assert.ok(msg.body.includes("09h"));
    assert.ok(msg.body_html.includes("09h"));
    assert.equal(
      guestPaymentDeferredBreakfastIdempotencyKey("r1", "whatsapp"),
      "guest_payment_deferred_breakfast:r1",
    );
    assert.equal(
      guestPaymentDeferredBreakfastIdempotencyKey("r1", "email"),
      "guest_payment_deferred_breakfast:r1:email",
    );
    ok("WA+email mesma essência + keys");
  }

  console.log("== K) internal_first_access PPD café ==");
  {
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
    assert.match(internal.body, /café da manhã/i);
    assert.match(internal.body, /09h/);
    assert.match(internal.body, /HITS/);
    assert.match(internal.body, /Apto 34/);
    assert.ok(!/1 hora/i.test(internal.body));
    ok("internal com cobrança café");
  }

  console.log("== L) Welcome pending não mistura PPD; café UI read-only pagamento ==");
  {
    assert.equal(
      buildWelcomePendingMessage({
        payment_pending: true,
        fnrh_pending: false,
        presencial_diferido_efetivado: true,
      }),
      null,
    );
    const fnrhOnly = buildWelcomePendingMessage({
      payment_pending: true,
      fnrh_pending: true,
      presencial_diferido_efetivado: true,
    });
    assert.ok(fnrhOnly);
    assert.equal(fnrhOnly!.kind, "welcome_fnrh_only");
    assert.match(fnrhOnly!.body, /fichas/i);

    const js = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
    const policyJs = readFileSync(join(process.cwd(), "ui/yes-cafe-policy.js"), "utf8");
    assert.equal(/\.(update|upsert)\s*\(\s*\{[^}]*pagamento_status/s.test(js), false);
    assert.match(js, /ppdAlert|ppd-cafe-alert/);
    assert.match(js, /pagamento_presencial_diferido_efetivado/);
    assert.match(policyJs, /DIÁRIA PENDENTE/);
    assert.doesNotMatch(policyJs, /regularizar no HITS/);
    ok("sem mistura welcome + café não altera pagamento_status");
  }

  console.log("== Deadline amanhã vs data ==");
  {
    const access = localIso(CHECKIN, 20, 0);
    const d = evaluatePresencialDiferidoOnFirstAccess({
      autorizado: true,
      firstAccessAtIso: access,
    });
    const phrase = formatPpdDeadlineGuestPhrase(d.deadlineIso!, access);
    assert.equal(phrase.usesAmanha, true);
    assert.match(phrase.phrase, /amanhã/);

    const morningDeadlineDay = hotelLocalToUtcIso("2026-08-12", 7, 0, 0);
    const phrase2 = formatPpdDeadlineGuestPhrase(d.deadlineIso!, morningDeadlineDay);
    assert.equal(phrase2.usesAmanha, false);
    assert.match(phrase2.phrase, /09h de 12\/08/);
    ok("frase de prazo a partir do deadline real");
  }

  console.log("== Policy browser espelhada ==");
  {
    const src = readFileSync(join(process.cwd(), "ui/yes-cafe-policy.js"), "utf8");
    const sandbox: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    const run = new Function(
      "window",
      "globalThis",
      src + "\nreturn globalThis.YesHotelCafePolicy;",
    );
    const policy = run(sandbox, sandbox) as {
      shouldShowCafePpdAlert: (i: unknown) => boolean;
      resolvePpdChargeAmount: (i: unknown) => { source: string; displayLabel: string };
    };
    assert.equal(
      policy.shouldShowCafePpdAlert({
        ppdEfetivado: true,
        pagamentoStatus: "pendente",
        statusReserva: "ativa",
      }),
      true,
    );
    assert.equal(policy.resolvePpdChargeAmount({}).source, "none");
    ok("yes-cafe-policy.js alinhada");
  }

  console.log("\nOK test-ppd-cafe-da-manha (A–L)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
