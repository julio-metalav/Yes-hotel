/**
 * Testes A–J — correlação TTLock por codigo_credencial + keyboardPwd.
 */
import assert from "node:assert/strict";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { evaluateFirstRoomAccessEvent } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import {
  ACCESS_EVENT_SOURCE_POLLING,
  buildIdempotencyKey,
} from "../src/lib/integrations/ttlock/access-ingest";
import {
  correlateApartmentPasscodeCandidates,
  type CorrelationCandidate,
} from "../src/lib/infrastructure/supabase/yes-hotel/credential-correlation-logic";

const BRENO_RES = "80a2d708-5bcc-4af3-856d-505f234055e0";
const BRENO_CRED = "51ef41da-b454-4957-862d-3cdc4560938c";
const BRENO_ITEM = "0501a9bd-17b2-4fb8-a86d-db6cf0db64fd";
const LOCK_34 = 16274746;
const PIN = "1134";
const OCCURRED = "2026-08-11T22:57:49.000Z";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function aptCandidate(overrides: Partial<CorrelationCandidate> = {}): CorrelationCandidate {
  return {
    credential_item_id: BRENO_ITEM,
    credential_id: BRENO_CRED,
    reservation_id: BRENO_RES,
    logical_destination: "APT-34",
    lock_id: LOCK_34,
    remote_keyboard_pwd_id: 103343466,
    status_provisionamento: "provisionado",
    credential_status: "provisionada",
    codigo_credencial: PIN,
    valido_de: "2026-08-11T17:00:00.000Z",
    valido_ate: "2026-08-12T15:00:00.000Z",
    ...overrides,
  };
}

function threeItems(credId = BRENO_CRED) {
  return [
    {
      id: BRENO_ITEM,
      credential_id: credId,
      logical_destination: "APT-34",
      lock_type: "apartamento" as const,
      lock_id: LOCK_34,
      remote_keyboard_pwd_id: 103343466,
    },
    {
      id: "item-ext",
      credential_id: credId,
      logical_destination: "GATE-1967-EXTERNAL",
      lock_type: "portao_externo" as const,
      lock_id: 10939258,
      remote_keyboard_pwd_id: 103343476,
    },
    {
      id: "item-int",
      credential_id: credId,
      logical_destination: "GATE-1967-INTERNAL",
      lock_type: "portao_interno" as const,
      lock_id: 10939408,
      remote_keyboard_pwd_id: 103343484,
    },
  ];
}

async function main() {
  console.log("\n=== TTLock correlation fix A–J ===\n");

  // A. lock apto + keyboardPwd correto
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [aptCandidate()],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(r.correlated, true);
    assert.equal(r.reservation_id, BRENO_RES);
    assert.equal(r.logical_destination, "APT-34");
    assert.equal(r.lock_type, "apartamento");
    ok("A lock apto + keyboardPwd correto");
  }

  // B. codigo_credencial presente no candidato
  {
    const c = aptCandidate();
    assert.equal(c.codigo_credencial, PIN);
    const r = correlateApartmentPasscodeCandidates({
      candidates: [c],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(r.correlated, true);
    // Sem codigo_credencial no candidato: mesmo com PIN correto → fail-closed
    const missing = correlateApartmentPasscodeCandidates({
      candidates: [aptCandidate({ codigo_credencial: null })],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(missing.correlated, false);
    assert.equal(missing.lock_type, "apartamento");
    ok("B codigo_credencial obrigatório no match");
  }

  // C. keyboardPwd incorreto => uncorrelated
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [aptCandidate()],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: "9999",
    });
    assert.equal(r.correlated, false);
    assert.equal(r.ambiguous, undefined);
    assert.equal(r.lock_type, "apartamento");
    const d = evaluateFirstRoomAccessEvent(
      {
        source_event_id: "x",
        occurred_at: OCCURRED,
        lock_id: LOCK_34,
        record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
        success: true,
        lock_type: "apartamento",
        within_reservation_window: false,
        correlated: false,
      },
      {
        first_access_already_registered: false,
        event_already_processed: false,
      },
    );
    assert.equal(d.ignored_reason, "uncorrelated");
    ok("C keyboardPwd incorreto → uncorrelated");
  }

  // D. lock apto sem reserva válida
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [
        aptCandidate({
          status_provisionamento: "revogado",
          credential_status: "revogada",
        }),
      ],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(r.correlated, false);
    assert.equal(r.lock_type, "apartamento");
    ok("D apto sem reserva válida → uncorrelated");
  }

  // E. lock desconhecido / não apartamento
  {
    const unknown = correlateApartmentPasscodeCandidates({
      candidates: [],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(unknown.correlated, false);
    assert.equal(unknown.lock_type, undefined);
    const gateOnly = correlateApartmentPasscodeCandidates({
      candidates: [
        aptCandidate({
          logical_destination: "GATE-1967-EXTERNAL",
          codigo_credencial: PIN,
        }),
      ],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(gateOnly.correlated, false);
    assert.equal(gateOnly.lock_type, undefined);
    const d = evaluateFirstRoomAccessEvent(
      {
        source_event_id: "y",
        occurred_at: OCCURRED,
        lock_id: 999,
        record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
        success: true,
        within_reservation_window: false,
        correlated: false,
      },
      { first_access_already_registered: false },
    );
    assert.equal(d.ignored_reason, "not_apartment");
    ok("E lock desconhecido/não apto → not_apartment");
  }

  // F. duas credenciais válidas → ambiguous
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [
        aptCandidate(),
        aptCandidate({
          credential_item_id: "other-item",
          credential_id: "other-cred",
          reservation_id: "11111111-1111-4111-8111-111111111111",
          codigo_credencial: PIN,
        }),
      ],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(r.ambiguous, true);
    assert.equal(r.correlated, false);
    ok("F duas candidatas → ambiguous");
  }

  // G. fora da validade → não correlaciona
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [
        aptCandidate({
          valido_de: "2026-08-01T17:00:00.000Z",
          valido_ate: "2026-08-02T15:00:00.000Z",
        }),
      ],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN,
    });
    assert.equal(r.correlated, false);
    assert.equal(r.lock_type, "apartamento");
    ok("G fora da validade → não correlaciona");
  }

  // H. Breno 16274746 + 1134
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [aptCandidate()],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: "1134",
    });
    assert.equal(r.correlated, true);
    assert.equal(r.reservation_id, BRENO_RES);
    assert.equal(r.logical_destination, "APT-34");
    ok("H Breno 16274746+1134 → APT-34");
  }

  // I. first access pago
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: BRENO_RES,
        credential_id: BRENO_CRED,
        credential_item_id: BRENO_ITEM,
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 103343466,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: {
        payment_status: "pago",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
      now: new Date("2026-08-11T23:00:00.000Z"),
    });
    const env = {
      TTLOCK_ACCESS_IDEMPOTENCY_SECRET: "test-corr-fix-secret",
    };
    const idem = await buildIdempotencyKey(
      {
        lockId: LOCK_34,
        lockDate: Date.parse(OCCURRED),
        recordType: 4,
        success: true,
        ephemeralKeyboardPwd: PIN,
      },
      env,
    );
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id: `${ACCESS_EVENT_SOURCE_POLLING}:native:test-new`,
        idempotency_key: idem,
        occurred_at: OCCURRED,
        lock_id: LOCK_34,
        record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
        success: true,
        raw_payload_sanitized: { lockId: LOCK_34, recordType: 4 },
      },
      h.ports,
    );
    assert.equal(r.status, "processed_no_pending");
    assert.equal(h.state.reservationEntered[BRENO_RES]?.entrou_no_apto, true);
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length,
      1,
    );
    assert.equal(h.state.tolerances.length, 0);
    ok("I pago → processed_no_pending + entrou + 1 outbox + tol 0");
  }

  // J. replay / segundo unlock
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: BRENO_RES,
        credential_id: BRENO_CRED,
        credential_item_id: BRENO_ITEM,
        logical_destination: "APT-34",
        lock_type: "apartamento",
        within_reservation_window: true,
        keyboard_pwd_id: 103343466,
        original_valid_from: "2026-08-11T17:00:00.000Z",
        original_valid_until: "2026-08-12T15:00:00.000Z",
      },
      pending: {
        payment_status: "pago",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
      now: new Date("2026-08-11T23:00:00.000Z"),
    });
    const env = { TTLOCK_ACCESS_IDEMPOTENCY_SECRET: "test-corr-fix-secret-j" };
    const mk = async (suffix: string) => {
      const idem = await buildIdempotencyKey(
        {
          lockId: LOCK_34,
          lockDate: Date.parse(OCCURRED) + (suffix === "2" ? 60_000 : 0),
          recordType: 4,
          success: true,
          ephemeralKeyboardPwd: PIN,
        },
        env,
      );
      return processFirstRoomAccessEvent(
        {
          source: ACCESS_EVENT_SOURCE_POLLING,
          source_event_id: `${ACCESS_EVENT_SOURCE_POLLING}:native:j-${suffix}`,
          idempotency_key: idem,
          occurred_at: new Date(Date.parse(OCCURRED) + (suffix === "2" ? 60_000 : 0)).toISOString(),
          lock_id: LOCK_34,
          record_type: 4,
          success: true,
          raw_payload_sanitized: { lockId: LOCK_34 },
        },
        h.ports,
      );
    };
    const r1 = await mk("1");
    assert.equal(r1.status, "processed_no_pending");
    const r2 = await mk("2");
    assert.ok(r2.status === "already_started" || r2.status === "ignored");
    assert.equal(
      h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access").length,
      1,
    );
    ok("J segundo unlock não cria 2º first-access");
  }

  console.log(`\nOK test-ttlock-correlation-fix (${passed} casos)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
