/**
 * Compatibilidade FNRH: lifecycle PR4 × status legado.
 * Casos A–G da correção urgente (E2E Breno / APT-34).
 */
import assert from "node:assert/strict";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state";
import {
  buildInternalFirstAccessMessage,
  buildWelcomePendingMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages";
import {
  buildReservationPendingInputFromRows,
  resolveEffectiveFnrhStatusSource,
} from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { ACCESS_EVENT_SOURCE_POLLING } from "../src/lib/integrations/ttlock/access-ingest/constants";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const G1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function pr4Guest(
  overrides: Partial<Parameters<typeof buildReservationPendingInputFromRows>[0]["guests"][number]> = {},
) {
  return {
    id: G1,
    principal: true,
    guest_role: "primary_adult" as const,
    fnrh_status: null as string | null,
    fnrh_lifecycle_status: null as string | null,
    has_required_core_fields: null as boolean | null,
    has_required_documents: null as boolean | null,
    confirmation_source: null as string | null,
    has_whatsapp: true,
    requires_classification: false,
    ...overrides,
  };
}

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: "cred-1",
      logical_destination: "APT-34",
      lock_id: 16274746,
      remote_keyboard_pwd_id: 103343466,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-a",
      credential_id: "cred-1",
      logical_destination: "PORTAO-A",
      lock_id: 1,
      remote_keyboard_pwd_id: 11,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
    {
      id: "item-gate-b",
      credential_id: "cred-1",
      logical_destination: "PORTAO-B",
      lock_id: 2,
      remote_keyboard_pwd_id: 22,
      valid_from: "2026-08-11T17:00:00.000Z",
      valid_until: "2026-08-12T15:00:00.000Z",
    },
  ];
}

async function main() {
  console.log("\n=== FNRH legacy × lifecycle compat (A–G) ===\n");

  // Resolve helper
  {
    const a = resolveEffectiveFnrhStatusSource({
      fnrh_lifecycle_status: null,
      fnrh_status: "confirmado_hospede",
    });
    assert.equal(a.source, "legacy");
    assert.equal(a.value, "confirmado_hospede");

    const b = resolveEffectiveFnrhStatusSource({
      fnrh_lifecycle_status: "completed",
      fnrh_status: "rascunho",
    });
    assert.equal(b.source, "lifecycle");
    assert.equal(b.value, "completed");

    const c = resolveEffectiveFnrhStatusSource({
      fnrh_lifecycle_status: "draft",
      fnrh_status: "confirmado_hospede",
    });
    assert.equal(c.source, "lifecycle");
    assert.equal(c.value, "draft");
    ok("resolveEffectiveFnrhStatusSource: lifecycle prevalece; null → legado");
  }

  // A. lifecycle=null + status=confirmado_hospede => completo
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [pr4Guest({ fnrh_status: "confirmado_hospede", fnrh_lifecycle_status: null })],
    });
    assert.equal(input.guests[0]?.fnrh_status, "completed");
    const pending = evaluateReservationPendingState(input);
    assert.equal(pending.fnrh_pending, false);
    assert.equal(pending.all_clear, true);
    ok("A lifecycle=null + confirmado_hospede => completo");
  }

  // B. lifecycle explícito completo => completo
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        pr4Guest({
          fnrh_status: "rascunho",
          fnrh_lifecycle_status: "completed",
          confirmation_source: "guest",
          completed_by_guest_id: G1,
          has_required_core_fields: true,
          has_required_documents: true,
        }),
      ],
    });
    assert.equal(input.guests[0]?.fnrh_status, "completed");
    assert.equal(evaluateReservationPendingState(input).fnrh_pending, false);
    ok("B lifecycle explícito completed => completo");
  }

  // C. lifecycle explícito pendente + status=confirmado_hospede => respeitar lifecycle
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        pr4Guest({
          fnrh_status: "confirmado_hospede",
          fnrh_lifecycle_status: "draft",
          has_required_core_fields: true,
          has_required_documents: true,
        }),
      ],
    });
    assert.notEqual(input.guests[0]?.fnrh_status, "completed");
    assert.equal(evaluateReservationPendingState(input).fnrh_pending, true);
    ok("C lifecycle explícito incompleto prevalece sobre legado completo");
  }

  // D. lifecycle=null + status pendente/rascunho => pendente
  {
    for (const legacy of ["pendente", "rascunho", "nao_iniciado"] as const) {
      const input = buildReservationPendingInputFromRows({
        pagamento_status: "pago",
        guests: [pr4Guest({ fnrh_status: legacy, fnrh_lifecycle_status: null })],
      });
      assert.equal(
        evaluateReservationPendingState(input).fnrh_pending,
        true,
        `esperado pendente para ${legacy}`,
      );
    }
    ok("D lifecycle=null + status legado incompleto => pendente");
  }

  // E. 1 hóspede / 1 confirmado_hospede => fnrh_pending=false
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [pr4Guest({ fnrh_status: "confirmado_hospede", fnrh_lifecycle_status: null })],
    });
    const pending = evaluateReservationPendingState(input);
    assert.equal(pending.fnrh_summary.required, 1);
    assert.equal(pending.fnrh_summary.completed, 1);
    assert.equal(pending.fnrh_pending, false);
    ok("E 1/1 confirmado_hospede => fnrh_pending=false");
  }

  // F. pago + FNRH completa => processed_no_pending + ZERO tolerância
  {
    const mapped = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [pr4Guest({ fnrh_status: "confirmado_hospede", fnrh_lifecycle_status: null })],
    });
    const pendingEval = evaluateReservationPendingState(mapped);
    assert.equal(pendingEval.fnrh_pending, false);
    assert.equal(pendingEval.payment_pending, false);

    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "80a2d708-5bcc-4af3-856d-505f234055e0",
        credential_id: "cred-1",
        credential_item_id: "item-apt",
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 103343466,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: mapped,
      items: threeItems(),
      now: new Date("2026-08-11T23:20:00.000Z"),
    });
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: `${ACCESS_EVENT_SOURCE_POLLING}:native:fnrh-compat-f`,
        idempotency_key: "fnrh-compat-f-idem",
        occurred_at: "2026-08-11T23:20:00.000Z",
        lock_id: 16274746,
        record_type: 4,
        success: true,
        raw_payload_sanitized: { lockId: 16274746 },
      },
      h.ports,
    );
    assert.equal(r.status, "processed_no_pending");
    assert.equal(h.state.tolerances.length, 0);
    ok("F pago + FNRH completa => processed_no_pending + 0 tolerância");
  }

  // G. primeiro acesso completo => internal correto; SEM guest_welcome_pending
  {
    const mapped = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [pr4Guest({ fnrh_status: "confirmado_hospede", fnrh_lifecycle_status: null })],
    });
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: "80a2d708-5bcc-4af3-856d-505f234055e0",
        credential_id: "cred-1",
        credential_item_id: "item-apt",
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 103343466,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: mapped,
      items: threeItems(),
      now: new Date("2026-08-11T23:20:00.000Z"),
    });
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: `${ACCESS_EVENT_SOURCE_POLLING}:native:fnrh-compat-g`,
        idempotency_key: "fnrh-compat-g-idem",
        occurred_at: "2026-08-11T23:20:00.000Z",
        lock_id: 16274746,
        record_type: 4,
        success: true,
        raw_payload_sanitized: { lockId: 16274746 },
      },
      h.ports,
    );
    assert.equal(r.status, "processed_no_pending");
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "guest_welcome_pending").length,
      0,
    );
    assert.equal(
      h.state.outbox.filter((m) => m.kind === "guest_welcome_pending").length,
      0,
    );
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length,
      1,
    );

    const internal = buildInternalFirstAccessMessage({
      apartment_number: "34",
      reservation_code: "HITS-FAKE-E2E",
      guest_main_name: "Breno",
      payment_pending: false,
      fnrh_pending: false,
      grace_started: false,
    });
    assert.match(internal.body, /Sem pendências/);
    assert.equal(buildWelcomePendingMessage({ payment_pending: false, fnrh_pending: false }), null);
    ok("G internal_first_access correto; sem guest_welcome_pending falso");
  }

  console.log(`\n${passed} casos OK\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
