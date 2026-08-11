/**
 * Testes obrigatórios CP5 — first-room-access marca entrou_no_apto + timestamp canônico.
 * A–G conforme escopo E2E.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const RES = "80a2d708-5bcc-4af3-856d-505f234055e0";
const CRED = "51ef41da-b454-4957-862d-3cdc4560938c";
const OCCURRED = "2026-08-11T20:00:00.000Z";
const FROM = "2026-08-11T17:00:00.000Z";
const UNTIL = "2026-08-12T15:00:00.000Z";

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: CRED,
      logical_destination: "APT-34",
      lock_type: "apartamento" as const,
      lock_id: 16274746,
      remote_keyboard_pwd_id: 1001,
    },
    {
      id: "item-ext",
      credential_id: CRED,
      logical_destination: "GATE-1967-EXTERNAL",
      lock_type: "portao_externo" as const,
      lock_id: 10939258,
      remote_keyboard_pwd_id: 1002,
    },
    {
      id: "item-int",
      credential_id: CRED,
      logical_destination: "GATE-1967-INTERNAL",
      lock_type: "portao_interno" as const,
      lock_id: 10939408,
      remote_keyboard_pwd_id: 1003,
    },
  ];
}

function okCorrelation() {
  return {
    correlated: true,
    reservation_id: RES,
    credential_id: CRED,
    credential_item_id: "item-apt",
    logical_destination: "APT-34",
    lock_type: "apartamento" as const,
    within_reservation_window: true,
    keyboard_pwd_id: 1001,
    original_valid_from: FROM,
    original_valid_until: UNTIL,
  };
}

function paidClearPending() {
  return {
    payment_status: "pago" as const,
    guests: [{ id: "p1", role: "principal_adulto" as const, fnrh_status: "completed" as const }],
  };
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    source: "ttlock_notify",
    source_event_id: "src-1",
    idempotency_key: "idem-1",
    occurred_at: OCCURRED,
    lock_id: 16274746,
    keyboard_pwd_id: 1001,
    record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success: true,
    raw_payload_sanitized: { recordType: 4, success: 1, lockId: 16274746 },
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("\n=== first-room-access entrou_no_apto A–G ===\n");

  // SQL migration asserts
  {
    const sql = readFileSync(
      resolve("supabase/migrations/20260811222435_first_room_access_set_entrou_no_apto.sql"),
      "utf8",
    );
    assert.match(sql, /entrou_no_apto = true/);
    assert.match(sql, /first_access_at/);
    assert.match(sql, /processed_no_pending exige reservation_id/);
    assert.ok(!/create trigger/i.test(sql), "deve ser RPC transacional, não trigger");
    ok("migration RPC (não trigger) marca entrou_no_apto + first_access_at");
  }

  // A + B + E + F — primeiro unlock válido pago
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paidClearPending(),
      items: threeItems(),
    });
    assert.equal(h.state.reservationEntered[RES], undefined);
    const r = await processFirstRoomAccessEvent(baseInput(), h.ports);
    assert.equal(r.status, "processed_no_pending");
    assert.equal(r.first_access_at, OCCURRED);
    assert.equal(h.state.reservationEntered[RES]?.entrou_no_apto, true);
    assert.equal(h.state.reservationEntered[RES]?.first_access_at, OCCURRED);
    assert.equal(h.state.tolerances.length, 0);
    const internal = h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access");
    assert.equal(internal.length, 1);
    assert.equal(h.state.events.filter((e) => e.processing_status === "processed").length, 1);
    ok("A/B/E/F primeiro unlock pago → entrou + timestamp + 1 internal + 0 tolerância");
  }

  // C — replay mesmo evento
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paidClearPending(),
      items: threeItems(),
    });
    const a = await processFirstRoomAccessEvent(baseInput(), h.ports);
    const b = await processFirstRoomAccessEvent(baseInput(), h.ports);
    assert.equal(a.status, "processed_no_pending");
    assert.equal(b.status, "processed_no_pending");
    assert.equal(b.event_id, a.event_id);
    assert.equal(h.state.events.length, 1);
    assert.equal(h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length, 1);
    assert.equal(h.state.reservationEntered[RES]?.first_access_at, OCCURRED);
    ok("C replay mesmo evento → no-op / sem duplicação");
  }

  // D + E — segundo unlock real
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paidClearPending(),
      items: threeItems(),
    });
    const a = await processFirstRoomAccessEvent(baseInput(), h.ports);
    const b = await processFirstRoomAccessEvent(
      baseInput({
        source_event_id: "src-2",
        idempotency_key: "idem-2",
        occurred_at: "2026-08-11T21:00:00.000Z",
      }),
      h.ports,
    );
    assert.equal(a.status, "processed_no_pending");
    assert.equal(b.status, "already_started");
    assert.equal(h.state.reservationEntered[RES]?.first_access_at, OCCURRED);
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length, 1);
    assert.equal(h.state.events.filter((e) => e.processing_status === "processed").length, 1);
    ok("D/E segundo unlock → already_started; 1 internal; timestamp único");
  }

  // G — falha correlação não marca entrou_no_apto
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: false,
        reservation_id: undefined,
        credential_id: undefined,
        credential_item_id: undefined,
        logical_destination: undefined,
        lock_type: undefined,
        within_reservation_window: false,
      },
      pending: paidClearPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-uncorr" }), h.ports);
    assert.equal(r.status, "ignored");
    assert.equal(Object.keys(h.state.reservationEntered).length, 0);
    assert.equal(h.state.accessOutbox.length, 0);
    assert.equal(h.state.tolerances.length, 0);
    ok("G correlação falha → não marca entrou_no_apto");
  }

  console.log(`\n${passed} assertions OK\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
