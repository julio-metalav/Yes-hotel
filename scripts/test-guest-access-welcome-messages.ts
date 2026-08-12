/**
 * Testes: guest_access_ready + guest_first_access_welcome (pré-chegada / pós-entrada).
 */
import assert from "node:assert/strict";
import {
  buildGuestAccessReadyMessage,
  buildGuestFirstAccessWelcomeMessage,
  formatCheckinDateLabelPtBr,
  guestAccessReadyIdempotencyKey,
  guestFirstAccessWelcomeIdempotencyKey,
  isBeforeCheckinActivationHour,
  isFinanceiroLiberadoParaAcesso,
  resolveParkingSpot,
  shouldIncludeWifiBlock,
} from "../src/lib/domain/yes-hotel/guest-access-messages";
import { formatTtlockPasscodeForGuest } from "../src/lib/domain/yes-hotel/ttlock-credential-format";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { ACCESS_EVENT_SOURCE_POLLING } from "../src/lib/integrations/ttlock/access-ingest/constants";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { assertSanitizedPayloadSafe } from "../src/lib/integrations/ttlock/access-ingest/sanitize";
import { pendingMessageAvailableAt } from "../src/lib/application/yes-hotel/enqueue-guest-first-access-welcome";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: "cred-1",
      logical_destination: "APT-34",
      lock_type: "apartamento" as const,
      lock_id: 16274746,
      remote_keyboard_pwd_id: 103343466,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-a",
      credential_id: "cred-1",
      logical_destination: "GATE-EXT",
      lock_type: "portao_externo" as const,
      lock_id: 1,
      remote_keyboard_pwd_id: 11,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-b",
      credential_id: "cred-1",
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
  console.log("\n=== Comunicação acesso + boas-vindas ===\n");

  // Pré-chegada A–G (domínio)
  {
    const msg = buildGuestAccessReadyMessage({
      guest_first_name: "Breno Santoriano",
      apartment_number: "34",
      passcode: "1134",
      parking_spot: resolveParkingSpot({ apartment_number: "34" }),
      checkin_date_label: "14/08/2026",
      before_activation: true,
    });
    assert.match(msg.body, /Olá, Breno!/);
    assert.match(msg.body, /Apartamento: 34/);
    assert.match(msg.body, /1134#/);
    assert.match(msg.body, /\(digite 1134 \+ #\)/);
    assert.match(msg.body, /ativa a partir das 13h do dia 14\/08\/2026/);
    assert.match(msg.body, /Sua vaga é a 34/);
    assert.match(msg.body, /99088-1337/);
    assert.doesNotMatch(msg.body, /Wi-Fi|wifi|Café da manhã|fuma/i);
    assert.equal(msg.subject, "Seu acesso ao Yes Hotel — Apartamento 34");
    ok("pré A/E/F/G texto acesso + PIN 1134# + sem Wi-Fi");
  }

  {
    const after = buildGuestAccessReadyMessage({
      guest_first_name: "Ana",
      apartment_number: "12",
      passcode: "2211",
      parking_spot: "12",
      checkin_date_label: "11/08/2026",
      before_activation: false,
    });
    assert.match(after.body, /Sua senha já está ativa/);
    ok("pré C texto 13h — senha já ativa");
  }

  {
    assert.equal(
      guestAccessReadyIdempotencyKey("r1"),
      guestAccessReadyIdempotencyKey("r1"),
    );
    assert.notEqual(
      guestAccessReadyIdempotencyKey("r1"),
      guestAccessReadyIdempotencyKey("r2"),
    );
    ok("pré B/D idempotency key única por reserva");
  }

  {
    const checkin = "2026-08-14T17:00:00.000Z"; // 13h CG
    assert.equal(
      isBeforeCheckinActivationHour(checkin, "2026-08-11T12:00:00.000Z"),
      true,
    );
    assert.equal(
      isBeforeCheckinActivationHour(checkin, "2026-08-14T17:05:00.000Z"),
      false,
    );
    ok("pré ativação antes/depois 13h");
  }

  {
    assert.equal(isFinanceiroLiberadoParaAcesso({ pagamento_status: "pago" }), true);
    assert.equal(
      isFinanceiroLiberadoParaAcesso({
        pagamento_status: "pendente",
        classificacao_comissionamento: "comissionada",
      }),
      true,
    );
    assert.equal(
      isFinanceiroLiberadoParaAcesso({
        pagamento_status: "pendente",
        classificacao_comissionamento: "desconhecida",
      }),
      true,
    );
    assert.equal(
      isFinanceiroLiberadoParaAcesso({
        pagamento_status: "pendente",
        classificacao_comissionamento: "nao_comissionada",
      }),
      false,
    );
    ok("financeiro liberado (pago/comissionada/desconhecida)");
  }

  {
    const pin = formatTtlockPasscodeForGuest("1134");
    assert.equal(pin.technical, "1134");
    assert.equal(pin.displayWithHash, "1134#");
    ok("formatTtlockPasscodeForGuest 1134#");
  }

  // Pós-entrada welcome
  {
    const withWifi = buildGuestFirstAccessWelcomeMessage({
      guest_first_name: "Breno",
      apartment_number: "34",
      parking_spot: "34",
      wifi_ssid: "YES-34",
      wifi_password: "segredo34",
    });
    assert.match(withWifi.body, /Bem-vindo ao Yes Hotel, Breno!/);
    assert.match(withWifi.body, /Rede: YES-34/);
    assert.match(withWifi.body, /Senha: segredo34/);
    assert.match(withWifi.body, /faixa amarela próxima ao portão/);
    assert.match(withWifi.body, /placas “Restaurante”/);
    assert.doesNotMatch(withWifi.body, /embaixo do roteador/i);
    assertSanitizedPayloadSafe({ body: withWifi.body });
    ok("pós C/K/L Wi-Fi + textos corretos + sanitize OK");
  }

  {
    const noWifi = buildGuestFirstAccessWelcomeMessage({
      guest_first_name: "Breno",
      apartment_number: "34",
      parking_spot: "34",
      wifi_ssid: null,
      wifi_password: null,
    });
    assert.doesNotMatch(noWifi.body, /📶 Wi-Fi|Rede:|Senha:/);
    assert.equal(shouldIncludeWifiBlock("", "x"), false);
    ok("pós D Wi-Fi omitido quando ausente");
  }

  {
    const a34 = buildGuestFirstAccessWelcomeMessage({
      guest_first_name: "Breno",
      apartment_number: "34",
      parking_spot: "34",
      wifi_ssid: "YES-34",
      wifi_password: "p34",
    });
    const a12 = buildGuestFirstAccessWelcomeMessage({
      guest_first_name: "Outro",
      apartment_number: "12",
      parking_spot: "12",
      wifi_ssid: "YES-12",
      wifi_password: "p12",
    });
    assert.match(a34.body, /YES-34/);
    assert.doesNotMatch(a34.body, /YES-12|p12/);
    assert.match(a12.body, /YES-12/);
    ok("pós E apto 34 não recebe Wi-Fi de outro");
  }

  {
    const msg = buildGuestFirstAccessWelcomeMessage({
      guest_first_name: "Breno",
      apartment_number: "34",
      parking_spot: "34",
      wifi_ssid: "YES-34",
      wifi_password: "p34",
    });
    assert.equal(msg.body.includes("YES-34"), true);
    assert.equal(msg.body_html.includes("YES-34"), true);
    assert.equal(msg.subject, "Bem-vindo ao Yes Hotel — Apartamento 34");
    ok("pós F WA/e-mail mesmos dados");
  }

  {
    assert.equal(
      guestFirstAccessWelcomeIdempotencyKey("r1", "whatsapp"),
      "guest_first_access_welcome:r1",
    );
    assert.equal(
      guestFirstAccessWelcomeIdempotencyKey("r1", "email"),
      "guest_first_access_welcome:r1:email",
    );
    ok("pós O keys exactly-once");
  }

  {
    const now = "2026-08-11T23:20:00.000Z";
    const later = pendingMessageAvailableAt(now, 60_000);
    assert.equal(later, "2026-08-11T23:21:00.000Z");
    ok("pós H delay ~1min pendência");
  }

  // Orchestrator: pago + FNRH completa → welcome, sem pending
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "res-welcome-1",
        credential_id: "cred-1",
        credential_item_id: "item-apt",
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 1,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: {
        payment_status: "pago",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
      now: new Date("2026-08-11T23:20:00.000Z"),
    });
    h.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34",
          reservation_code: "HITS-1",
          guest_main_name: "Breno Santoriano",
          parking_spot: "34",
          wifi_ssid: "YES-34",
          wifi_password: "segredo34",
        };
      },
    };
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: "poll:welcome-a",
        idempotency_key: "welcome-a-idem",
        occurred_at: "2026-08-11T23:20:00.000Z",
        lock_id: 16274746,
        record_type: 4,
        success: true,
      },
      h.ports,
    );
    assert.equal(r.status, "processed_no_pending");
    const welcome = h.state.accessOutbox.filter(
      (o) => o.event_type === "guest_first_access_welcome",
    );
    assert.equal(welcome.length, 2); // wa + email
    assert.match(String(welcome[0]?.payload?.body ?? ""), /YES-34/);
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "guest_welcome_pending").length,
      0,
    );
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length,
      1,
    );
    ok("pós A/G/I welcome 1x + internal; sem pending");
  }

  // Orchestrator: pendência → welcome agora, pending +1min
  {
    const now = new Date("2026-08-11T23:20:00.000Z");
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "res-welcome-2",
        credential_id: "cred-1",
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
      },
      items: threeItems(),
      now,
    });
    h.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34",
          reservation_code: "HITS-2",
          guest_main_name: "Breno",
          parking_spot: "34",
          wifi_ssid: null,
          wifi_password: null,
        };
      },
    };
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: "poll:welcome-h",
        idempotency_key: "welcome-h-idem",
        occurred_at: "2026-08-11T23:20:00.000Z",
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
    const pending = h.state.accessOutbox.filter(
      (o) => o.event_type === "guest_welcome_pending",
    );
    assert.equal(welcome.length, 2);
    assert.ok(pending.length >= 1);
    for (const p of pending) {
      assert.ok(Date.parse(p.available_at) >= Date.parse(now.toISOString()) + 59_000);
    }
    for (const w of welcome) {
      assert.equal(w.available_at, now.toISOString());
    }
    ok("pós H welcome imediato; pendência depois");
  }

  // Replay não duplica welcome
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "res-welcome-3",
        credential_id: "cred-1",
        credential_item_id: "item-apt",
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 1,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: {
        payment_status: "pago",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
      now: new Date("2026-08-11T23:20:00.000Z"),
    });
    h.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34",
          reservation_code: "HITS-3",
          guest_main_name: "Breno",
        };
      },
    };
    const mk = (suffix: string) =>
      processFirstRoomAccessEvent(
        {
          source: ACCESS_EVENT_SOURCE_POLLING,
          source_event_id: `poll:replay-${suffix}`,
          idempotency_key: `welcome-replay-${suffix}`,
          occurred_at: new Date(
            Date.parse("2026-08-11T23:20:00.000Z") + (suffix === "2" ? 60_000 : 0),
          ).toISOString(),
          lock_id: 16274746,
          record_type: 4,
          success: true,
        },
        h.ports,
      );
    await mk("1");
    await mk("2");
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "guest_first_access_welcome").length,
      2,
    ); // wa+email once
    ok("pós B replay não duplica welcome");
  }

  void formatCheckinDateLabelPtBr;
  console.log(`\n${passed} casos OK\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
