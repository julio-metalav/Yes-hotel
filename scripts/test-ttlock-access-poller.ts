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
import {
  hotelLocalToUtcMs,
  startOfHotelCivilDayUtcMs,
  YES_HOTEL_UTC_OFFSET_MINUTES,
} from "../src/lib/domain/yes-hotel/hotel-timezone";
import { resolveTtlockRecordOccurredAt } from "../src/lib/domain/yes-hotel/ttlock-record-time";

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
    // Um aviso interno + boas-vindas do hospede nos dois canais. Cobrar total
    // 1 era o contrato de antes da boas-vindas no primeiro acesso, e escondia
    // justamente a mensagem que faltava.
    const tipos = h.state.accessOutbox.map((o) => o.event_type + ":" + o.channel).sort();
    assert.deepEqual(tipos, [
      "guest_first_access_welcome:email",
      "guest_first_access_welcome:whatsapp",
      "internal_first_access:whatsapp",
    ]);
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
    // O replay nao pode acrescentar nada: os mesmos tres do primeiro ciclo.
    const esperado = [
      "guest_first_access_welcome:email",
      "guest_first_access_welcome:whatsapp",
      "internal_first_access:whatsapp",
    ];
    assert.deepEqual(
      h.state.accessOutbox.map((o) => o.event_type + ":" + o.channel).sort(),
      esperado,
    );
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
    // A entrada nao pode ser remarcada nem a tolerancia reaberta.
    assert.equal(
      h.state.reservationEntered[FIX_RES_ID]!.first_access_at,
      "2026-08-11T22:00:00.000Z",
      "horario da primeira entrada foi reescrito",
    );
    assert.equal(h.state.tolerances.length, 0);
    // O outbox pode ser reparado, nunca duplicado: uma chave por mensagem.
    for (const tipo of ["internal_first_access", "guest_first_access_welcome"]) {
      const doTipo = h.state.accessOutbox.filter((o) => o.event_type === tipo);
      const chaves = new Set(doTipo.map((o) => o.idempotency_key));
      assert.equal(chaves.size, doTipo.length, "chave repetida em " + tipo);
    }
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

  // Bootstrap: dia civil anterior fica de fora; abertura do mesmo dia entra.
  {
    const nowMs = NEW_LOCK_DATE + 60_000;
    const dayStart = startOfHotelCivilDayUtcMs(nowMs);
    const hOld = harness();
    const storeOld = memoryStore();
    const old = await pollOneLock({
      lockId: FIX_LOCK_APT,
      client: mockClient([
        passcodeRecord({
          lockDate: dayStart - 10_000,
          serverDate: dayStart - 9_000,
          recordId: 1,
        }),
      ]),
      ports: hOld.ports,
      store: storeOld,
      env: POLL_ENV,
      nowMs,
    });
    assert.equal(old.bootstrapped, true);
    assert.equal(old.processed, 0);
    assert.equal(hOld.state.events.length, 0);
    assert.equal(storeOld.cps.get(FIX_LOCK_APT)?.last_lock_date_ms, dayStart - 1);
    ok("bootstrap não reprocessa o dia civil anterior");

    const hToday = harness();
    const storeToday = memoryStore();
    const today = await poll(hToday.ports, [passcodeRecord()], storeToday);
    assert.equal(today.bootstrapped, true);
    assert.equal(today.processed, 1);
    assert.equal(hToday.state.events.length, 1);
    ok("bootstrap processa abertura do dia civil corrente");
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

  {
    const lockMs = hotelLocalToUtcMs("2026-09-26", 13, 0, 0);
    const normal = resolveTtlockRecordOccurredAt({
      lockDateMs: lockMs,
      serverDateMs: lockMs + 1000,
      receivedAtMs: lockMs + 2000,
    });
    assert.equal(normal.usedFallback, false);
    assert.equal(normal.occurredAtMs, lockMs);
    assert.equal(normal.diagnostic, "lock_date");
    const shown = new Date(normal.occurredAtMs + YES_HOTEL_UTC_OFFSET_MINUTES * 60_000);
    assert.equal(shown.getUTCHours(), 13);
    ok("timestamp normal e UTC de Campo Grande não converte o fuso duas vezes");
  }

  {
    const watermark = Date.parse("2026-09-25T22:09:48.000Z");
    const serverMs = Date.parse("2026-09-26T14:05:00.000Z");
    const nowMs = Date.parse("2026-09-26T14:10:00.000Z");
    const skewed = resolveTtlockRecordOccurredAt({
      lockDateMs: watermark,
      serverDateMs: serverMs,
      receivedAtMs: nowMs,
    });
    assert.equal(skewed.usedFallback, true);
    assert.equal(skewed.diagnostic, "server_date_clock_skew");
    assert.equal(skewed.occurredAtMs, serverMs);
    assert.equal(skewed.rawLockDateMs, watermark);

    const future = resolveTtlockRecordOccurredAt({
      lockDateMs: nowMs + 60 * 60 * 1000,
      serverDateMs: nowMs - 1000,
      receivedAtMs: nowMs,
    });
    assert.equal(future.usedFallback, true);
    assert.equal(future.occurredAtMs, nowMs - 1000);

    const h = harness();
    const store = memoryStore({
      lock_id: FIX_LOCK_APT,
      last_lock_date_ms: watermark,
      last_record_id: "1806027158",
    });
    const rec = passcodeRecord({
      lockDate: watermark,
      serverDate: serverMs,
      recordId: 1806027200,
    });
    const first = await pollOneLock({
      lockId: FIX_LOCK_APT,
      client: mockClient([rec]),
      ports: h.ports,
      store,
      env: POLL_ENV,
      nowMs,
    });
    assert.equal(first.newer, 1);
    assert.equal(first.processed, 1);
    assert.equal(h.state.events.length, 1);
    assert.equal(h.state.events[0].occurred_at, new Date(serverMs).toISOString());
    const raw = h.state.events[0].raw_payload_sanitized as {
      occurred_at_resolution?: { raw_lock_date_ms?: number; diagnostic?: string };
    };
    assert.equal(raw.occurred_at_resolution?.raw_lock_date_ms, watermark);
    assert.equal(raw.occurred_at_resolution?.diagnostic, "server_date_clock_skew");
    const welcomesBefore = h.state.accessOutbox.filter((o) =>
      o.event_type === "guest_first_access_welcome",
    ).length;
    const second = await pollOneLock({
      lockId: FIX_LOCK_APT,
      client: mockClient([rec]),
      ports: h.ports,
      store,
      env: POLL_ENV,
      nowMs: nowMs + 60_000,
    });
    assert.equal(second.processed, 1);
    assert.equal(h.state.events.length, 1);
    const welcomesAfter = h.state.accessOutbox.filter((o) =>
      o.event_type === "guest_first_access_welcome",
    ).length;
    assert.equal(welcomesAfter, welcomesBefore);
    const stale = await pollOneLock({
      lockId: FIX_LOCK_APT,
      client: mockClient([
        passcodeRecord({
          lockDate: watermark - 8000,
          serverDate: watermark - 7000,
          recordId: 1806027100,
          success: 0,
        }),
      ]),
      ports: harness().ports,
      store: memoryStore({
        lock_id: FIX_LOCK_APT,
        last_lock_date_ms: watermark,
        last_record_id: null,
      }),
      env: POLL_ENV,
      nowMs,
    });
    assert.equal(stale.newer, 0);
    ok("relógio da fechadura em outro dia usa serverDate, guarda o bruto e não duplica");
  }

  console.log(`\nOK test-ttlock-access-poller (${passed} casos)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
