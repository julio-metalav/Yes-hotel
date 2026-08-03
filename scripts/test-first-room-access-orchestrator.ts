/**
 * Testes do orquestrador de primeiro acesso (ports in-memory, sem I/O real).
 */
import assert from "node:assert/strict";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import type { ProcessFirstRoomAccessInput } from "../src/lib/application/yes-hotel/first-room-access-types";
import type { ReservationPendingStateInput } from "../src/lib/domain/yes-hotel/reservation-pending-state";

const RES_ID = "5321a46f-5000-43e1-8830-df57f3bc0439";
const CRED_ID = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
const OCCURRED = "2026-08-08T18:00:00.000Z";
const VALID_FROM = "2026-08-08T17:00:00.000Z";
const VALID_UNTIL = "2026-08-10T15:00:00.000Z";

function paidClearPending(): ReservationPendingStateInput {
  return {
    payment_status: "pago",
    guests: [
      {
        id: "p1",
        role: "principal_adulto",
        fnrh_status: "completed",
      },
    ],
  };
}

function paymentPending(): ReservationPendingStateInput {
  return {
    payment_status: "pendente",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
  };
}

function fnrhPending(): ReservationPendingStateInput {
  return {
    payment_status: "pago",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "pending" }],
  };
}

function bothPending(): ReservationPendingStateInput {
  return {
    payment_status: "pendente",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "review" }],
  };
}

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: CRED_ID,
      logical_destination: "APT-10",
      lock_type: "apartamento" as const,
      lock_id: 15615492,
      remote_keyboard_pwd_id: 100632532,
    },
    {
      id: "item-ext",
      credential_id: CRED_ID,
      logical_destination: "GATE-1947-EXTERNAL",
      lock_type: "portao_externo" as const,
      lock_id: 25709122,
      remote_keyboard_pwd_id: 23895126,
    },
    {
      id: "item-int",
      credential_id: CRED_ID,
      logical_destination: "GATE-1947-INTERNAL",
      lock_type: "portao_interno" as const,
      lock_id: 25709168,
      remote_keyboard_pwd_id: 23894770,
    },
  ];
}

function okCorrelation(overrides: Record<string, unknown> = {}) {
  return {
    correlated: true,
    reservation_id: RES_ID,
    credential_id: CRED_ID,
    credential_item_id: "item-apt",
    logical_destination: "APT-10",
    lock_type: "apartamento" as const,
    within_reservation_window: true,
    keyboard_pwd_id: 100632532,
    original_valid_from: VALID_FROM,
    original_valid_until: VALID_UNTIL,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ProcessFirstRoomAccessInput> = {}): ProcessFirstRoomAccessInput {
  return {
    source: "test",
    source_event_id: "src-evt-1",
    idempotency_key: "idem-1",
    occurred_at: OCCURRED,
    lock_id: 15615492,
    keyboard_pwd_id: 100632532,
    record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success: true,
    raw_payload_sanitized: { recordType: 4, success: 1, lockId: 15615492 },
    ...overrides,
  };
}

function assertNoPassword(obj: unknown): void {
  const json = JSON.stringify(obj);
  assert.ok(!/"keyboardPwd"\s*:/i.test(json));
  assert.ok(!/"senha"\s*:\s*"/i.test(json));
  assert.ok(!/"password"\s*:\s*"/i.test(json));
}

async function main(): Promise<void> {
  // 6) sem pendências
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paidClearPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput(), h.ports);
    assert.equal(r.status, "processed_no_pending");
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.outbox.length, 0);
    assert.equal(h.state.events[0].processing_status, "processed");
    assertNoPassword(r);
  }

  // 7) pagamento pendente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-pay" }), h.ports);
    assert.equal(r.status, "grace_started");
    assert.equal(r.suspension_due_at, "2026-08-08T19:00:00.000Z");
    assert.ok(r.pending_reasons?.includes("pagamento"));
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.toleranceItems.length, 3);
    assert.equal(h.state.outbox.length, 1);
    assert.equal(h.state.outbox[0].kind, "guest_welcome_pending");
  }

  // 8) FNRH pendente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: fnrhPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-fnrh" }), h.ports);
    assert.equal(r.status, "grace_started");
    assert.ok(r.pending_reasons?.includes("fnrh"));
  }

  // 9) ambas + snapshot
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: bothPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-both" }), h.ports);
    assert.equal(r.status, "grace_started");
    assert.deepEqual(h.state.tolerances[0].pending_snapshot.slice().sort(), [
      "fnrh",
      "pagamento",
    ]);
  }

  // 1) duplicado idempotente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    const a = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-dup" }), h.ports);
    const b = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-dup" }), h.ports);
    assert.equal(a.status, "grace_started");
    assert.equal(b.status, "already_started");
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.outbox.length, 1);
  }

  // 11) segundo evento mesma credencial
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-a" }), h.ports);
    const r2 = await processFirstRoomAccessEvent(
      baseInput({
        idempotency_key: "idem-b",
        source_event_id: "src-evt-2",
        occurred_at: "2026-08-08T18:20:00.000Z",
      }),
      h.ports,
    );
    assert.equal(r2.status, "already_started");
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.tolerances[0].suspension_due_at, "2026-08-08T19:00:00.000Z");
  }

  // 2) portão
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation({
        lock_type: "portao_externo",
        logical_destination: "GATE-1947-EXTERNAL",
      }),
      pending: paymentPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      baseInput({ idempotency_key: "idem-gate", lock_id: 25709122 }),
      h.ports,
    );
    assert.equal(r.status, "ignored");
    assert.equal(r.ignored_reason, "not_apartment");
    assert.equal(h.state.tolerances.length, 0);
  }

  // 3) app/admin
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    const app = await processFirstRoomAccessEvent(
      baseInput({
        idempotency_key: "idem-app",
        record_type: TTLOCK_RECORD_TYPE.APP_UNLOCK,
      }),
      h.ports,
    );
    assert.equal(app.ignored_reason, "not_passcode");
    const adm = await processFirstRoomAccessEvent(
      baseInput({
        idempotency_key: "idem-adm",
        source_event_id: "adm",
        is_admin_operator: true,
      }),
      h.ports,
    );
    assert.equal(adm.ignored_reason, "not_passcode");
  }

  // 4) não correlacionado
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: false,
        within_reservation_window: true,
        lock_type: "apartamento",
      },
      pending: paymentPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-unc" }), h.ports);
    assert.equal(r.status, "ignored");
    assert.equal(r.ignored_reason, "uncorrelated");
  }

  // 5) fora da janela
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation({ within_reservation_window: false }),
      pending: paymentPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-win" }), h.ports);
    assert.equal(r.ignored_reason, "outside_window");
  }

  // 12) exatamente 3 itens
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-3" }), h.ports);
    assert.equal(h.state.toleranceItems.length, 3);
    const dests = h.state.toleranceItems.map((i) => i.logical_destination).sort();
    assert.deepEqual(dests, ["APT-10", "GATE-1947-EXTERNAL", "GATE-1947-INTERNAL"]);
  }

  // 13) ausência apartamento
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems().filter((i) => i.lock_type !== "apartamento"),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-noapt" }), h.ports);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /apartamento/i);
    assert.equal(h.state.tolerances.length, 0);
    // PR5: falha antes do commit atômico — nenhum evento parcial.
    assert.equal(h.state.events.length, 0);
  }

  // 14) ausência portão
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems().filter((i) => i.lock_type !== "portao_externo"),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-nogate" }), h.ports);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /portão externo|portao externo/i);
  }

  // 15) sem remote_keyboard_pwd_id
  {
    const items = threeItems();
    items[1] = { ...items[1], remote_keyboard_pwd_id: Number.NaN };
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items,
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-nopwd" }), h.ports);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /remote_keyboard_pwd_id/);
  }

  // 16) mensagem única outbox
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-msg" }), h.ports);
    await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-msg" }), h.ports);
    assert.equal(h.state.outbox.filter((m) => m.kind === "guest_welcome_pending").length, 1);
  }

  // 17) falha outbox → rollback
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
      failOnWelcome: true,
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-outbox" }), h.ports);
    assert.equal(r.status, "failed");
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.toleranceItems.length, 0);
    assert.equal(h.state.outbox.length, 0);
    // PR5: rollback integral — evento também desfeito.
    assert.equal(h.state.events.length, 0);
  }

  // 18–19) falha item + evento não processed
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems().slice(0, 1),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-items" }), h.ports);
    assert.equal(r.status, "failed");
    assert.equal(h.state.events.length, 0);
  }

  // 20–21, 25) sem senha + snapshot
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: bothPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-sec" }), h.ports);
    assertNoPassword(r);
    assertNoPassword(h.state.events);
    assertNoPassword(h.state.tolerances);
    assertNoPassword(h.state.toleranceItems);
    assertNoPassword(h.state.outbox);
    assert.ok(h.state.tolerances[0].pending_snapshot.includes("pagamento"));
    assert.ok(h.state.tolerances[0].pending_snapshot.includes("fnrh"));
  }

  // 22) emergencial não elimina pendência
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: {
        payment_status: "pendente",
        emergency_access: true,
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-em" }), h.ports);
    assert.equal(r.status, "grace_started");
  }

  // 23) facial/placa não no snapshot
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: {
        payment_status: "pago",
        guests: [
          {
            id: "p1",
            role: "principal_adulto",
            fnrh_status: "completed",
            has_facial: false,
            has_placa: false,
          },
        ],
      },
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-face" }), h.ports);
    assert.equal(r.status, "processed_no_pending");
  }

  // 24) menor concluído pelo responsável
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: {
        payment_status: "pago",
        guests: [
          { id: "p1", role: "principal_adulto", fnrh_status: "completed" },
          {
            id: "m1",
            role: "menor",
            fnrh_status: "completed",
            completed_by_guardian: true,
            has_phone: false,
            has_email: false,
          },
        ],
      },
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-menor" }), h.ports);
    assert.equal(r.status, "processed_no_pending");
  }

  // 26) horários UTC
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: okCorrelation(),
      pending: paymentPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(baseInput({ idempotency_key: "idem-utc" }), h.ports);
    assert.ok(r.suspension_due_at?.endsWith("Z"));
    assert.equal(h.state.tolerances[0].grace_started_at, OCCURRED);
  }

  // 10) prazo +1h
  {
    assert.equal(
      new Date("2026-08-08T19:00:00.000Z").getTime() - new Date(OCCURRED).getTime(),
      3600_000,
    );
  }

  console.log("OK test-first-room-access-orchestrator");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
