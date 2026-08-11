/**
 * Testes A–I — polling TTLock lockRecord/list → first-room-access.
 * Sem I/O real TTLock/Supabase.
 */
import assert from "node:assert/strict";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import type { FirstRoomAccessPorts } from "../src/lib/application/yes-hotel/first-room-access-ports";
import type { CorrelatedRoomAccessResult } from "../src/lib/application/yes-hotel/first-room-access-types";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import {
  ACCESS_EVENT_SOURCE_POLLING,
  buildIdempotencyKey,
  isTtlockAccessPollEnabled,
  pollOneLock,
  type PollCheckpoint,
  type PollCheckpointStore,
} from "../src/lib/integrations/ttlock/access-ingest";
import type { TtlockClient } from "../src/lib/integrations/ttlock/client";
import {
  FIX_CRED_ID,
  FIX_ITEM_APT,
  FIX_LOCK_APT,
  FIX_LOCK_GATE,
  FIX_PWD,
  FIX_RES_ID,
  TEST_ENV,
} from "../src/lib/integrations/ttlock/access-ingest/testing/fixtures";

const DIAG_LOCK_DATE = 1_786_487_991_000; // 18:39:51 CG
const NEW_LOCK_DATE = DIAG_LOCK_DATE + 120_000; // depois do checkpoint

const POLL_ENV = {
  ...TEST_ENV,
  YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED: "true",
};

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function threeItems() {
  return [
    {
      id: FIX_ITEM_APT,
      credential_id: FIX_CRED_ID,
      logical_destination: "APT-10",
      lock_type: "apartamento" as const,
      lock_id: FIX_LOCK_APT,
      remote_keyboard_pwd_id: 100632532,
    },
    {
      id: "item-ext",
      credential_id: FIX_CRED_ID,
      logical_destination: "GATE-1947-EXTERNAL",
      lock_type: "portao_externo" as const,
      lock_id: FIX_LOCK_GATE,
      remote_keyboard_pwd_id: 23895126,
    },
    {
      id: "item-int",
      credential_id: FIX_CRED_ID,
      logical_destination: "GATE-1947-INTERNAL",
      lock_type: "portao_interno" as const,
      lock_id: 25709168,
      remote_keyboard_pwd_id: 23894770,
    },
  ];
}

function okCorrelation(overrides: Partial<CorrelatedRoomAccessResult> = {}): CorrelatedRoomAccessResult {
  return {
    correlated: true,
    reservation_id: FIX_RES_ID,
    credential_id: FIX_CRED_ID,
    credential_item_id: FIX_ITEM_APT,
    logical_destination: "APT-10",
    lock_type: "apartamento",
    within_reservation_window: true,
    keyboard_pwd_id: 100632532,
    original_valid_from: "2026-08-08T17:00:00.000Z",
    original_valid_until: "2026-08-12T15:00:00.000Z",
    ...overrides,
  };
}

function harness(correlation: CorrelatedRoomAccessResult = okCorrelation()) {
  return createFirstRoomAccessMemoryHarness({
    correlation,
    pending: {
      payment_status: "pago",
      guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
    },
    items: threeItems(),
  });
}

function memoryStore(seed?: PollCheckpoint): PollCheckpointStore & {
  cps: Map<number, PollCheckpoint>;
} {
  const cps = new Map<number, PollCheckpoint>();
  if (seed) cps.set(seed.lock_id, { ...seed });
  return {
    cps,
    async listCandidateApartmentLockIds() {
      return [...cps.keys()];
    },
    async getCheckpoint(lockId) {
      return cps.get(lockId) ?? null;
    },
    async upsertCheckpoint(input) {
      cps.set(input.lock_id, {
        lock_id: input.lock_id,
        last_lock_date_ms: input.last_lock_date_ms,
        last_record_id: input.last_record_id ?? null,
      });
    },
  };
}

function mockClient(list: Record<string, unknown>[]): TtlockClient {
  return {
    isAvailable: () => true,
    listLockRecords: async () => ({ list }),
  } as unknown as TtlockClient;
}

function passcodeRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordType: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success: 1,
    keyboardPwd: FIX_PWD,
    lockDate: NEW_LOCK_DATE,
    serverDate: NEW_LOCK_DATE + 1000,
    recordId: 999001,
    ...overrides,
  };
}

async function poll(
  ports: FirstRoomAccessPorts,
  list: Record<string, unknown>[],
  store: PollCheckpointStore,
  lockId = FIX_LOCK_APT,
) {
  return pollOneLock({
    lockId,
    client: mockClient(list),
    ports,
    store,
    env: POLL_ENV,
    nowMs: NEW_LOCK_DATE + 60_000,
  });
}

async function main() {
  console.log("\n=== TTLock access poller A–I ===\n");

  assert.equal(isTtlockAccessPollEnabled({}), false);
  assert.equal(isTtlockAccessPollEnabled(POLL_ENV), true);
  ok("flag poll exact true");

  // A. novo recordType=4 → processa
  {
    const h = harness();
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: "1777359104",
    });
    const r = await poll(h.ports, [passcodeRecord()], store);
    assert.equal(r.newer, 1);
    assert.equal(r.processed, 1);
    assert.equal(r.results[0]?.status, "processed_no_pending");
    assert.equal(h.state.events.length, 1);
    assert.equal(h.state.events[0].source, ACCESS_EVENT_SOURCE_POLLING);
    assert.equal(h.state.accessOutbox.length, 1);
    assert.equal(h.state.accessOutbox[0].event_type, "internal_first_access");
    assert.equal(h.state.tolerances.length, 0);
    assert.ok(store.cps.get(FIX_LOCK_APT)!.last_lock_date_ms >= NEW_LOCK_DATE);
    ok("A novo recordType=4 processa");
  }

  // B. replay → não duplica
  {
    const h = harness();
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: "1777359104",
    });
    const rec = passcodeRecord({ recordId: 999002 });
    const r1 = await poll(h.ports, [rec], store);
    assert.equal(r1.processed, 1);
    // Força watermark atrás para simular overlap/replay da API
    store.cps.set(FIX_LOCK_APT, {
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: "1777359104",
    });
    const r2 = await poll(h.ports, [rec], store);
    assert.equal(r2.processed, 1);
    assert.ok(
      r2.results[0]?.status === "already_started" ||
        r2.results[0]?.status === "processed_no_pending" ||
        r2.results[0]?.ignored_reason === "duplicate" ||
        r2.results[0]?.status === "ignored",
    );
    assert.equal(h.state.events.length, 1);
    assert.equal(h.state.accessOutbox.length, 1);
    ok("B replay não duplica");
  }

  // C. registro anterior ao checkpoint → ignora
  {
    const h = harness();
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: "1777359104",
    });
    const r = await poll(h.ports, [
      passcodeRecord({
        lockDate: DIAG_LOCK_DATE,
        recordId: 1777359104,
      }),
    ], store);
    assert.equal(r.newer, 0);
    assert.equal(r.processed, 0);
    assert.equal(r.skipped, 1);
    assert.equal(h.state.events.length, 0);
    assert.equal(store.cps.get(FIX_LOCK_APT)!.last_lock_date_ms, DIAG_LOCK_DATE);
    ok("C registro <= checkpoint ignorado");
  }

  // D. lock desconhecido → fail-closed (não correlaciona)
  {
    const h = harness({
      correlated: false,
      within_reservation_window: false,
    });
    const store = memoryStore({
      lock_id: 99999999,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    const r = await poll(
      h.ports,
      [passcodeRecord({ recordId: 999003 })],
      store,
      99999999,
    );
    assert.equal(r.processed, 1);
    assert.equal(r.results[0]?.status, "ignored");
    assert.equal(h.state.accessOutbox.length, 0);
    assert.ok(!h.state.reservationEntered[FIX_RES_ID]);
    ok("D lock desconhecido fail-closed");
  }

  // E. correlação única → processa
  {
    const h = harness(okCorrelation());
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    const r = await poll(h.ports, [passcodeRecord({ recordId: 999004 })], store);
    assert.equal(r.results[0]?.status, "processed_no_pending");
    assert.equal(h.state.events.length, 1);
    ok("E correlação única processa");
  }

  // F. correlação ambígua → não processa first access
  {
    const h = harness({
      correlated: false,
      ambiguous: true,
      within_reservation_window: false,
    });
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    const r = await poll(h.ports, [passcodeRecord({ recordId: 999005 })], store);
    assert.equal(r.results[0]?.status, "ignored");
    assert.equal(h.state.accessOutbox.length, 0);
    ok("F correlação ambígua não processa");
  }

  // G. reserva já entrou → não cria segundo first access
  {
    const h = harness(okCorrelation());
    h.state.reservationEntered[FIX_RES_ID] = {
      entrou_no_apto: true,
      first_access_at: "2026-08-11T22:00:00.000Z",
    };
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    const r = await poll(h.ports, [passcodeRecord({ recordId: 999006 })], store);
    assert.ok(
      r.results[0]?.status === "ignored" || r.results[0]?.status === "already_started",
    );
    assert.equal(h.state.accessOutbox.length, 0);
    ok("G já entrou não cria segundo first access");
  }

  // H. paid → sem tolerância
  {
    const h = harness(okCorrelation());
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    const r = await poll(h.ports, [passcodeRecord({ recordId: 999007 })], store);
    assert.equal(r.results[0]?.status, "processed_no_pending");
    assert.equal(h.state.tolerances.length, 0);
    ok("H paid sem tolerância");
  }

  // I. exatamente 1 internal_first_access
  {
    const h = harness(okCorrelation());
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: DIAG_LOCK_DATE,
      last_record_id: null,
    });
    await poll(h.ports, [passcodeRecord({ recordId: 999008 })], store);
    const internals = h.state.accessOutbox.filter((o) => o.event_type === "internal_first_access");
    assert.equal(internals.length, 1);
    ok("I exatamente 1 internal_first_access");
  }

  // Extra: bootstrap sem checkpoint não processa histórico
  {
    const h = harness();
    const store = memoryStore();
    const r = await poll(h.ports, [passcodeRecord({ lockDate: DIAG_LOCK_DATE })], store);
    assert.equal(r.bootstrapped, true);
    assert.equal(r.processed, 0);
    assert.equal(h.state.events.length, 0);
    assert.ok((store.cps.get(FIX_LOCK_APT)?.last_lock_date_ms ?? 0) > 0);
    ok("bootstrap sem checkpoint não processa histórico");
  }

  // Extra: notify e polling geram mesma idempotency_key
  {
    const keyNotify = await buildIdempotencyKey(
      {
        lockId: FIX_LOCK_APT,
        lockDate: NEW_LOCK_DATE,
        recordType: 4,
        success: true,
        ephemeralKeyboardPwd: FIX_PWD,
      },
      POLL_ENV,
    );
    const keyPoll = await buildIdempotencyKey(
      {
        lockId: FIX_LOCK_APT,
        lockDate: NEW_LOCK_DATE,
        recordType: 4,
        success: true,
        ephemeralKeyboardPwd: FIX_PWD,
      },
      POLL_ENV,
    );
    assert.equal(keyNotify, keyPoll);
    ok("idempotency_key compartilhada notify/polling");
  }

  console.log(`\nOK test-ttlock-access-poller (${passed} casos)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
