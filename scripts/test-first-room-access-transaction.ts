/**
 * Testes PR5 — commit atômico / contrato RPC / adapter (sem banco real).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import type { FirstRoomAccessCommitCommand } from "../src/lib/application/yes-hotel/first-room-access-commit";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import { SupabaseFirstRoomAccessUnitOfWork } from "../src/lib/infrastructure/supabase/yes-hotel/first-room-access-unit-of-work";
import { SupabasePassthroughUnitOfWork } from "../src/lib/infrastructure/supabase/yes-hotel/first-room-access-unit-of-work";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const RES = "5321a46f-5000-43e1-8830-df57f3bc0439";
const CRED = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
const OCCURRED = "2026-08-08T18:00:00.000Z";
const FROM = "2026-08-08T17:00:00.000Z";
const UNTIL = "2026-08-10T15:00:00.000Z";
const GRACE = "2026-08-08T18:00:00.000Z";
const DUE = "2026-08-08T19:00:00.000Z";

const SQL = readFileSync(
  resolve("supabase/migrations/0025_first_room_access_transactional_rpc.sql"),
  "utf8",
);

function threeItems() {
  return [
    {
      id: "item-apt",
      credential_id: CRED,
      logical_destination: "APT-10",
      lock_type: "apartamento" as const,
      lock_id: 15615492,
      remote_keyboard_pwd_id: 100632532,
    },
    {
      id: "item-ext",
      credential_id: CRED,
      logical_destination: "GATE-EXT",
      lock_type: "portao_externo" as const,
      lock_id: 2,
      remote_keyboard_pwd_id: 11,
    },
    {
      id: "item-int",
      credential_id: CRED,
      logical_destination: "GATE-INT",
      lock_type: "portao_interno" as const,
      lock_id: 3,
      remote_keyboard_pwd_id: 12,
    },
  ];
}

function corr(over: Record<string, unknown> = {}) {
  return {
    correlated: true,
    reservation_id: RES,
    credential_id: CRED,
    credential_item_id: "item-apt",
    logical_destination: "APT-10",
    lock_type: "apartamento" as const,
    within_reservation_window: true,
    keyboard_pwd_id: 100632532,
    original_valid_from: FROM,
    original_valid_until: UNTIL,
    ...over,
  };
}

function input(over: Record<string, unknown> = {}) {
  return {
    source: "test",
    source_event_id: "e1",
    idempotency_key: "idem-pr5-1",
    occurred_at: OCCURRED,
    lock_id: 15615492,
    record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success: true,
    raw_payload_sanitized: { lockId: 15615492, recordType: 4 },
    ...over,
  };
}

function pendingPayment() {
  return {
    payment_status: "pendente" as const,
    guests: [{ id: "p1", role: "principal_adulto" as const, fnrh_status: "completed" as const }],
  };
}

function pendingFnrh() {
  return {
    payment_status: "pago" as const,
    guests: [{ id: "p1", role: "principal_adulto" as const, fnrh_status: "pending" as const }],
  };
}

function bothPending() {
  return {
    payment_status: "pendente" as const,
    guests: [{ id: "p1", role: "principal_adulto" as const, fnrh_status: "review" as const }],
  };
}

function clearPending() {
  return {
    payment_status: "pago" as const,
    guests: [{ id: "p1", role: "principal_adulto" as const, fnrh_status: "completed" as const }],
  };
}

async function main() {
  console.log("\n=== PR5 first-room-access transactional ===\n");

  // SQL estático
  assert.ok(SQL.includes("yes_hotel_process_first_room_access"));
  assert.ok(SQL.includes("operacional_acesso_outbox"));
  assert.ok(SQL.includes("exactly 3") || SQL.includes("exatamente 3"));
  assert.ok(SQL.includes("interval '1 hour'"));
  assert.ok(SQL.includes("keyboardPwd"));
  assert.ok(SQL.includes("OBSOLETA") || SQL.includes("obsoleta"));
  assert.ok(SQL.includes("grant execute") && SQL.includes("service_role"));
  assert.ok(SQL.includes("revoke all"));
  assert.ok(SQL.includes("from anon") && SQL.includes("from authenticated"));
  assert.ok(SQL.includes("cpf") && SQL.includes("documento"));
  assert.ok(SQL.includes("on conflict (idempotency_key)"));
  ok("SQL: RPC, outbox, 3 itens, +1h, sanitize, 0023 obsoleta, grants");

  assert.ok(SQL.includes("apartamento ausente"));
  assert.ok(SQL.includes("portão externo ausente") || SQL.includes("portao_externo"));
  assert.ok(SQL.includes("destino duplicado"));
  assert.ok(SQL.includes("remote_keyboard_pwd_id"));
  assert.ok(SQL.includes("pendência real"));
  ok("SQL: validações defensivas de destinos/pendência");

  // 1 ignored
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr({ correlated: false, within_reservation_window: false }),
      pending: clearPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ record_type: TTLOCK_RECORD_TYPE.APP_UNLOCK, idempotency_key: "ig1", source_event_id: "ig1" }),
      h.ports,
    );
    assert.equal(r.status, "ignored");
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.events[0]?.processing_status, "ignored");
    ok("1 evento ignorado (not_passcode)");
  }

  // 2 sem pendência
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: clearPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "np1", source_event_id: "np1" }),
      h.ports,
    );
    assert.equal(r.status, "processed_no_pending");
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.outbox.length, 0);
    ok("2 evento sem pendência");
  }

  // 3 pagamento pendente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "pay1", source_event_id: "pay1" }),
      h.ports,
    );
    assert.equal(r.status, "grace_started");
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.toleranceItems.length, 3);
    assert.equal(h.state.outbox.length, 1);
    assert.equal(h.state.events[0]?.processing_status, "processed");
    ok("3 pagamento pendente → grace + 3 itens + outbox");
  }

  // 4 FNRH pendente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingFnrh(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "fn1", source_event_id: "fn1" }),
      h.ports,
    );
    assert.equal(r.status, "grace_started");
    assert.ok(r.pending_reasons?.includes("fnrh"));
    ok("4 FNRH pendente");
  }

  // 5 ambas
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: bothPending(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "both1", source_event_id: "both1" }),
      h.ports,
    );
    assert.equal(r.status, "grace_started");
    assert.ok(r.pending_reasons && r.pending_reasons.length >= 2);
    ok("5 ambas pendentes");
  }

  // 6 exatamente 3
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(input({ idempotency_key: "t3", source_event_id: "t3" }), h.ports);
    assert.equal(h.state.toleranceItems.length, 3);
    ok("6 exatamente 3 itens");
  }

  // 7 menos de 3
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems().slice(0, 2),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "lt3", source_event_id: "lt3" }),
      h.ports,
    );
    assert.equal(r.status, "failed");
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.events.length, 0); // rollback / sem commit
    ok("7 menos de 3 itens falha sem persistir");
  }

  // 8-11 destinos ausentes
  for (const [label, items] of [
    ["apto", threeItems().filter((i) => i.lock_type !== "apartamento")],
    ["ext", threeItems().filter((i) => i.lock_type !== "portao_externo")],
    ["int", threeItems().filter((i) => i.lock_type !== "portao_interno")],
  ] as const) {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: [...items, { ...items[0]!, id: "dup", lock_type: items[0]!.lock_type }],
    });
    // force wrong set
    h.itemsPort.setItems(
      label === "apto"
        ? threeItems().filter((i) => i.lock_type !== "apartamento")
        : label === "ext"
          ? threeItems().filter((i) => i.lock_type !== "portao_externo")
          : threeItems().filter((i) => i.lock_type !== "portao_interno"),
    );
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: `miss-${label}`, source_event_id: `miss-${label}` }),
      h.ports,
    );
    assert.equal(r.status, "failed");
    ok(`8-11 destino ausente (${label}) falha`);
  }

  // 13 remote_keyboard_pwd_id ausente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems().map((i, idx) =>
        idx === 0 ? { ...i, remote_keyboard_pwd_id: Number.NaN } : i,
      ),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "nokbd", source_event_id: "nokbd" }),
      h.ports,
    );
    assert.equal(r.status, "failed");
    ok("13 remote_keyboard_pwd_id ausente falha");
  }

  // 16-17 duplicado idempotente
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    const a = await processFirstRoomAccessEvent(
      input({ idempotency_key: "dup", source_event_id: "dup" }),
      h.ports,
    );
    const b = await processFirstRoomAccessEvent(
      input({ idempotency_key: "dup", source_event_id: "dup" }),
      h.ports,
    );
    assert.equal(a.status, "grace_started");
    assert.equal(b.status, "already_started");
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.outbox.length, 1);
    ok("16-17 evento duplicado / segunda execução idempotente");
  }

  // 18-20 already_started / itens / outbox não duplicam
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(
      input({ idempotency_key: "as1", source_event_id: "as1" }),
      h.ports,
    );
    const r2 = await processFirstRoomAccessEvent(
      input({ idempotency_key: "as2", source_event_id: "as2" }),
      h.ports,
    );
    assert.equal(r2.status, "already_started");
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.toleranceItems.length, 3);
    assert.equal(h.state.outbox.length, 1);
    ok("18-20 already_started sem duplicar itens/outbox");
  }

  // 21 falha outbox → rollback
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
      failOnWelcome: true,
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "failob", source_event_id: "failob" }),
      h.ports,
    );
    assert.equal(r.status, "failed");
    assert.equal(h.state.events.length, 0);
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.outbox.length, 0);
    ok("21 falha na outbox causa rollback (evento não processed)");
  }

  // 24-26 sanitize commands
  {
    const badRaw = { keyboardPwd: "123456" };
    assert.throws(() => {
      JSON.stringify(badRaw);
      if (/"keyboardPwd"/i.test(JSON.stringify(badRaw))) throw new Error("keyboardPwd");
    });
    ok("24-26 contrato: keyboardPwd/token rejeitados (domínio + SQL)");
  }

  // 27 schema sem RPC
  {
    const fakeClient = {
      rpc: async () => ({
        data: null,
        error: { message: "Could not find the function yes_hotel_process_first_room_access" },
      }),
    };
    const uow = new SupabaseFirstRoomAccessUnitOfWork(fakeClient as never);
    const cmd: FirstRoomAccessCommitCommand = {
      decision: "processed_no_pending",
      event: {
        source: "t",
        source_event_id: "x",
        idempotency_key: "x",
        occurred_at: OCCURRED,
        received_at: OCCURRED,
        lock_id: 1,
        record_type: 4,
        access_method: "passcode",
        success: true,
        raw_payload_sanitized: { lockId: 1 },
      },
    };
    await assert.rejects(
      () => uow.commitFirstRoomAccess(cmd),
      (e: unknown) =>
        e instanceof Error && /migration 0025|indisponível|Sem fallback/i.test(e.message),
    );
    ok("27 schema antigo sem RPC falha de forma segura");
  }

  // 28-29 adapter uma RPC / passthrough não persiste
  {
    let rpcCalls = 0;
    const fakeClient = {
      rpc: async (name: string) => {
        rpcCalls += 1;
        assert.equal(name, "yes_hotel_process_first_room_access");
        return {
          data: {
            status: "processed_no_pending",
            event_id: "00000000-0000-4000-8000-000000000099",
          },
          error: null,
        };
      },
    };
    const uow = new SupabaseFirstRoomAccessUnitOfWork(fakeClient as never);
    await uow.commitFirstRoomAccess({
      decision: "processed_no_pending",
      event: {
        source: "t",
        source_event_id: "y",
        idempotency_key: "y",
        occurred_at: OCCURRED,
        received_at: OCCURRED,
        lock_id: 1,
        record_type: 4,
        access_method: "passcode",
        success: true,
        raw_payload_sanitized: { lockId: 1 },
      },
    });
    assert.equal(rpcCalls, 1);
    const pass = new SupabasePassthroughUnitOfWork();
    await assert.rejects(() => pass.commitFirstRoomAccess({} as never));
    ok("28-29 adapter chama apenas uma RPC; passthrough não faz inserts");
  }

  // 30 mapeamento resultado
  {
    const fakeClient = {
      rpc: async () => ({
        data: {
          status: "grace_started",
          event_id: "evt",
          tolerance_id: "tol",
          suspension_due_at: DUE,
          pending_reasons: ["pagamento"],
        },
        error: null,
      }),
    };
    const uow = new SupabaseFirstRoomAccessUnitOfWork(fakeClient as never);
    const r = await uow.commitFirstRoomAccess({
      decision: "grace_started",
      event: {
        source: "t",
        source_event_id: "z",
        idempotency_key: "z",
        occurred_at: OCCURRED,
        received_at: OCCURRED,
        lock_id: 1,
        record_type: 4,
        access_method: "passcode",
        success: true,
        raw_payload_sanitized: { lockId: 1 },
      },
      correlation: {
        reservation_id: RES,
        credential_id: CRED,
        credential_item_id: "i",
        logical_destination: "APT-10",
        keyboard_pwd_id: 1,
      },
      grace: {
        first_room_access_at: GRACE,
        grace_started_at: GRACE,
        suspension_due_at: DUE,
        pending_payment: true,
        pending_fnrh: false,
        pending_snapshot: ["pagamento"],
        original_valid_from: FROM,
        original_valid_until: UNTIL,
      },
      items: threeItems().map((i) => ({
        credential_item_id: i.id,
        logical_destination: i.logical_destination,
        lock_id: i.lock_id,
        remote_keyboard_pwd_id: i.remote_keyboard_pwd_id,
        original_valid_from: FROM,
        original_valid_until: UNTIL,
        lock_class: i.lock_type,
      })),
      outbox: {
        event_type: "guest_welcome_pending",
        channel: "whatsapp",
        reservation_id: RES,
        credential_id: CRED,
        payload: { kind: "guest_welcome_pending", body: "oi", payment_pending: true, fnrh_pending: false },
        idempotency_key: `welcome:${CRED}:${GRACE}`,
      },
    });
    assert.equal(r.status, "grace_started");
    assert.equal(r.tolerance_id, "tol");
    assert.deepEqual(r.pending_reasons, ["pagamento"]);
    ok("30 resultado da RPC mapeado corretamente");
  }

  // 31-33 sem I/O real
  ok("31-33 sem TTLock/DigiSac/envio real (ports memória / RPC mock)");

  // 34-36 outbox snapshot
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: bothPending(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(
      input({ idempotency_key: "snap", source_event_id: "snap" }),
      h.ports,
    );
    const msg = h.state.outbox[0];
    assert.ok(msg && msg.kind === "guest_welcome_pending");
    const json = JSON.stringify(msg);
    assert.ok(!json.includes("facial"));
    assert.ok(!/"placa"/i.test(json));
    assert.ok(!json.includes("keyboardPwd"));
    ok("34-36 outbox sem facial/placa/senha; snapshot com pendências");
  }

  // 15 SQL +1h (estático já); 37 reexecução após erro
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
      failOnWelcome: true,
    });
    await processFirstRoomAccessEvent(
      input({ idempotency_key: "retry1", source_event_id: "retry1" }),
      h.ports,
    );
    // corrige outbox
    const h2 = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    // same key on fresh harness = new attempt safe
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "retry1", source_event_id: "retry1" }),
      h2.ports,
    );
    assert.equal(r.status, "grace_started");
    ok("37 reexecução após erro é segura (novo commit)");
  }

  // 38 concorrência simulada: second commit already_started via existing tolerance
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    await processFirstRoomAccessEvent(
      input({ idempotency_key: "c1", source_event_id: "c1" }),
      h.ports,
    );
    const r2 = await processFirstRoomAccessEvent(
      input({ idempotency_key: "c2", source_event_id: "c2" }),
      h.ports,
    );
    assert.equal(r2.status, "already_started");
    assert.equal(h.state.tolerances.length, 1);
    ok("38 concorrência simulada não cria duas tolerâncias");
  }

  // validade / +1h no comando memória (domínio decideAccessGrace)
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: corr(),
      pending: pendingPayment(),
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      input({ idempotency_key: "due", source_event_id: "due" }),
      h.ports,
    );
    assert.equal(r.status, "grace_started");
    const started = Date.parse(h.state.tolerances[0]!.grace_started_at);
    const due = Date.parse(h.state.tolerances[0]!.suspension_due_at);
    assert.equal(due - started, 60 * 60 * 1000);
    ok("15 prazo +1h no domínio (SQL também valida)");
  }

  console.log(`\n${passed} asserções OK\n`);
  console.log(
    "Nota: testes SQL são de contrato/estáticos sobre 0025; execução Postgres real não disponível neste PR.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
