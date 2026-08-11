/**
 * Testes PR3 — TTLock access ingest (flag, auth, sanitize, idempotência, correlação, adapters).
 * Sem I/O real TTLock/DigiSac/Supabase remoto.
 */
import assert from "node:assert/strict";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state";
import {
  ACCESS_EVENT_SOURCE_NOTIFY,
  ACCESS_EVENT_SOURCE_POLLING,
  MAX_NOTIFY_PAYLOAD_BYTES,
  MAX_NOTIFY_RECORDS,
  TTLOCK_NOTIFY_SUCCESS_BODY,
  buildIdempotencyKey,
  buildSafeIngestLog,
  buildSourceEventId,
  handleTtlockAccessIngest,
  isTtlockAccessIngestEnabled,
  parseTtlockAccessNotifyPayload,
  sanitizeNotifyPayload,
  assertSanitizedPayloadSafe,
  validateTtlockAccessWebhookAuth,
  TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER,
} from "../src/lib/integrations/ttlock/access-ingest";
import {
  FIX_CRED_ID,
  FIX_ITEM_APT,
  FIX_LOCK_APT,
  FIX_LOCK_GATE,
  FIX_OCCURRED_MS,
  FIX_PWD,
  FIX_PWD_OTHER,
  FIX_RES_ID,
  TEST_ENV,
  TEST_ENV_FLAG_OFF,
  notifyPayload,
  record,
} from "../src/lib/integrations/ttlock/access-ingest/testing/fixtures";
import { correlateApartmentPasscodeCandidates } from "../src/lib/infrastructure/supabase/yes-hotel/credential-correlation-logic";
import {
  buildReservationPendingInputFromRows,
  FirstRoomAccessConfigurationError,
  mapPaymentStatusFromDb,
} from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper";
import type { FirstRoomAccessPorts } from "../src/lib/application/yes-hotel/first-room-access-ports";
import type { CorrelationCandidate } from "../src/lib/infrastructure/supabase/yes-hotel/credential-correlation-logic";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function authHeaders(secret = TEST_ENV.TTLOCK_ACCESS_WEBHOOK_SECRET) {
  return { [TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER]: secret };
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

function baseCandidate(overrides: Partial<CorrelationCandidate> = {}): CorrelationCandidate {
  return {
    credential_item_id: FIX_ITEM_APT,
    credential_id: FIX_CRED_ID,
    reservation_id: FIX_RES_ID,
    logical_destination: "APT-10",
    lock_id: FIX_LOCK_APT,
    remote_keyboard_pwd_id: 100632532,
    status_provisionamento: "provisionado",
    credential_status: "provisionada",
    codigo_credencial: FIX_PWD,
    valido_de: "2026-08-08T17:00:00.000Z",
    valido_ate: "2026-08-10T15:00:00.000Z",
    ...overrides,
  };
}

function harnessPending(payment: "pago" | "pendente" = "pendente") {
  return createFirstRoomAccessMemoryHarness({
    correlation: {
      correlated: true,
      reservation_id: FIX_RES_ID,
      credential_id: FIX_CRED_ID,
      credential_item_id: FIX_ITEM_APT,
      logical_destination: "APT-10",
      lock_type: "apartamento",
      within_reservation_window: true,
      keyboard_pwd_id: 100632532,
      original_valid_from: "2026-08-08T17:00:00.000Z",
      original_valid_until: "2026-08-10T15:00:00.000Z",
    },
    pending: {
      payment_status: payment,
      guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
    },
    items: threeItems(),
  });
}

async function ingest(
  body: unknown,
  opts: {
    env?: Record<string, string | undefined>;
    ports?: FirstRoomAccessPorts | null;
    headers?: Record<string, string>;
    url?: string;
  } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return handleTtlockAccessIngest(
    {
      method: "POST",
      url: opts.url ?? "http://local/ttlock-access-ingest",
      headers: opts.headers ?? authHeaders(),
      body,
      rawByteLength: Buffer.byteLength(raw, "utf8"),
      env: opts.env ?? TEST_ENV,
    },
    opts.ports === undefined ? harnessPending().ports : opts.ports,
  );
}

async function main() {
  console.log("\n=== PR3 ttlock-access-ingest ===\n");

  // 1 feature flag off
  {
    assert.equal(isTtlockAccessIngestEnabled(TEST_ENV_FLAG_OFF), false);
    assert.equal(isTtlockAccessIngestEnabled({}), false);
    const h = harnessPending();
    const res = await ingest(notifyPayload(), { env: TEST_ENV_FLAG_OFF, ports: h.ports });
    assert.equal(res.bodyText, TTLOCK_NOTIFY_SUCCESS_BODY);
    assert.equal(res.status, 200);
    assert.equal(res.meta.ingest_enabled, false);
    assert.equal(h.state.events.length, 0);
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(res.meta.log_safe.event, "ingest_disabled");
    const safe = buildSafeIngestLog(res.meta);
    assert.equal("auth_ok" in safe, false);
    ok("1 feature flag desligada — ack sem persistir");
  }

  // Flag off: mesmo ack com ou sem segredo (anti-oráculo)
  {
    const h = harnessPending();
    const withSecret = await ingest(notifyPayload(), {
      env: TEST_ENV_FLAG_OFF,
      ports: h.ports,
      headers: authHeaders(),
    });
    const withoutSecret = await ingest(notifyPayload(), {
      env: TEST_ENV_FLAG_OFF,
      ports: h.ports,
      headers: {},
    });
    const wrongSecret = await ingest(notifyPayload(), {
      env: TEST_ENV_FLAG_OFF,
      ports: h.ports,
      headers: authHeaders("wrong"),
    });
    assert.equal(withSecret.status, withoutSecret.status);
    assert.equal(withSecret.bodyText, withoutSecret.bodyText);
    assert.equal(wrongSecret.status, withoutSecret.status);
    assert.equal(wrongSecret.bodyText, withoutSecret.bodyText);
    assert.equal(h.state.events.length, 0);
    ok("1b flag off não revela se segredo está correto/incorreto");
  }

  // 30 none processing when flag off (already covered) + explicit
  {
    const h = harnessPending();
    await ingest(notifyPayload(), { env: { ...TEST_ENV, YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED: "TRUE" }, ports: h.ports });
    assert.equal(h.state.events.length, 0); // case-sensitive: TRUE ≠ true
    ok("30 flag case-sensitive — TRUE não ativa");
  }

  // 2 auth ausente (somente com flag ligada)
  {
    const res = await ingest(notifyPayload(), { headers: {} });
    assert.equal(res.status, 401);
    assert.equal(res.meta.auth_ok, false);
    assert.equal(res.meta.ingest_enabled, true);
    ok("2 autenticação ausente com flag ligada");
  }

  // 3 auth inválida (somente com flag ligada)
  {
    const res = await ingest(notifyPayload(), { headers: authHeaders("wrong") });
    assert.equal(res.status, 401);
    ok("3 autenticação inválida com flag ligada");
  }

  // auth helper missing env secret
  {
    const r = validateTtlockAccessWebhookAuth({
      headerSecret: "x",
      env: {},
    });
    assert.equal(r.ok, false);
    ok("auth: secret de ambiente ausente");
  }

  // 4 payload malformado
  {
    const res = await ingest({ lockId: "x", records: "nope" });
    assert.equal(res.bodyText, TTLOCK_NOTIFY_SUCCESS_BODY);
    assert.equal(res.meta.log_safe.code, "malformed");
    ok("4 payload malformado");
  }

  // 5 lote vazio
  {
    const res = await ingest({ lockId: FIX_LOCK_APT, records: [] });
    assert.equal(res.meta.log_safe.code, "empty_batch");
    ok("5 lote vazio");
  }

  // 6 recordType=4 válido → grace
  {
    const h = harnessPending("pendente");
    const res = await ingest(notifyPayload(), { ports: h.ports });
    assert.equal(res.bodyText, TTLOCK_NOTIFY_SUCCESS_BODY);
    assert.ok(h.state.events.length >= 1);
    assert.equal(h.state.tolerances.length, 1);
    assert.ok(!JSON.stringify(h.state.events).includes(FIX_PWD));
    ok("6 recordType=4 válido inicia tolerância");
  }

  // 7 portão ignorado
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: FIX_RES_ID,
        credential_id: FIX_CRED_ID,
        credential_item_id: "gate",
        logical_destination: "GATE-1947-EXTERNAL",
        lock_type: "portao_externo",
        within_reservation_window: true,
        original_valid_from: "2026-08-08T17:00:00.000Z",
        original_valid_until: "2026-08-10T15:00:00.000Z",
      },
      pending: {
        payment_status: "pendente",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
    });
    await ingest(notifyPayload({ lockId: FIX_LOCK_GATE }), { ports: h.ports });
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.events[0]?.processing_status, "ignored");
    assert.equal(h.state.events[0]?.ignored_reason, "not_apartment");
    ok("7 portão ignorado");
  }

  // 8 app/admin/cartão/chave
  for (const [label, rt] of [
    ["app", TTLOCK_RECORD_TYPE.APP_UNLOCK],
    ["cartao", TTLOCK_RECORD_TYPE.IC_CARD_UNLOCK],
    ["chave", TTLOCK_RECORD_TYPE.MECHANICAL_KEY],
  ] as const) {
    const h = harnessPending();
    await ingest(notifyPayload({ records: [record({ recordType: rt })] }), { ports: h.ports });
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.events[0]?.ignored_reason, "not_passcode");
    ok(`8 ${label} ignorado`);
  }

  // 9 senha inválida
  {
    const h = harnessPending();
    await ingest(
      notifyPayload({ records: [record({ recordType: TTLOCK_RECORD_TYPE.INVALID_PASSCODE })] }),
      { ports: h.ports },
    );
    assert.equal(h.state.events[0]?.ignored_reason, "not_passcode");
    ok("9 senha inválida (recordType 48) ignorada");
  }

  // 10 fora da janela
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: FIX_RES_ID,
        credential_id: FIX_CRED_ID,
        credential_item_id: FIX_ITEM_APT,
        logical_destination: "APT-10",
        lock_type: "apartamento",
        within_reservation_window: false,
        original_valid_from: "2026-08-08T17:00:00.000Z",
        original_valid_until: "2026-08-10T15:00:00.000Z",
      },
      pending: {
        payment_status: "pendente",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
    });
    await ingest(notifyPayload(), { ports: h.ports });
    assert.equal(h.state.events[0]?.ignored_reason, "outside_window");
    ok("10 evento fora da janela ignorado");
  }

  // 11 correlação segura
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [baseCandidate()],
      occurred_at: "2026-08-08T18:00:00.000Z",
      ephemeral_keyboard_pwd: FIX_PWD,
    });
    assert.equal(r.correlated, true);
    assert.equal(r.credential_id, FIX_CRED_ID);
    ok("11 correlação segura com senha em memória");
  }

  // 12 nenhuma correspondência
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [baseCandidate()],
      occurred_at: "2026-08-08T18:00:00.000Z",
      ephemeral_keyboard_pwd: FIX_PWD_OTHER,
    });
    assert.equal(r.correlated, false);
    assert.notEqual(r.ambiguous, true);
    assert.equal(r.lock_type, "apartamento");
    ok("12 nenhuma correspondência");
  }

  // 13 ambígua
  {
    const r = correlateApartmentPasscodeCandidates({
      candidates: [
        baseCandidate(),
        baseCandidate({
          credential_item_id: "other",
          credential_id: "cred-2",
          reservation_id: "res-2",
          codigo_credencial: FIX_PWD,
        }),
      ],
      occurred_at: "2026-08-08T18:00:00.000Z",
      ephemeral_keyboard_pwd: FIX_PWD,
    });
    assert.equal(r.ambiguous, true);
    assert.equal(r.correlated, false);
    ok("13 correspondência ambígua");
  }

  // 14/15/16 keyboardPwd nunca persistido / logado / sanitizado
  {
    const parsed = parseTtlockAccessNotifyPayload(notifyPayload());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("parse");
    assert.equal(parsed.parsed.records[0]?.keyboardPwd, FIX_PWD);
    const san = sanitizeNotifyPayload(parsed.parsed);
    const json = JSON.stringify(san);
    assert.ok(!json.includes(FIX_PWD));
    assert.ok(!/"keyboardPwd"/i.test(json));
    assertSanitizedPayloadSafe(san);
    const h = harnessPending();
    const res = await ingest(notifyPayload(), { ports: h.ports });
    const log = JSON.stringify(buildSafeIngestLog(res.meta));
    assert.ok(!log.includes(FIX_PWD));
    assert.ok(!log.includes("keyboardPwd"));
    assert.ok(!JSON.stringify(h.state.events).includes(FIX_PWD));
    ok("14-16 keyboardPwd nunca persistido/logado; raw sanitizado");
  }

  // 17 duplicado idempotente
  {
    const h = harnessPending("pendente");
    await ingest(notifyPayload(), { ports: h.ports });
    await ingest(notifyPayload(), { ports: h.ports });
    assert.equal(h.state.tolerances.length, 1);
    assert.equal(h.state.events.length, 1);
    ok("17 evento duplicado idempotente");
  }

  // 18 Notify e polling mesma idempotency key
  {
    const material = {
      lockId: FIX_LOCK_APT,
      lockDate: FIX_OCCURRED_MS,
      recordType: 4,
      success: true,
      ephemeralKeyboardPwd: FIX_PWD,
    };
    const k1 = await buildIdempotencyKey(material, TEST_ENV);
    const k2 = await buildIdempotencyKey(material, TEST_ENV);
    assert.equal(k1, k2);
    const rec = {
      recordType: 4,
      success: true,
      lockDate: FIX_OCCURRED_MS,
      index: 0,
      keyboardPwd: FIX_PWD,
    };
    const sNotify = buildSourceEventId(ACCESS_EVENT_SOURCE_NOTIFY, FIX_LOCK_APT, rec);
    const sPoll = buildSourceEventId(ACCESS_EVENT_SOURCE_POLLING, FIX_LOCK_APT, rec);
    assert.notEqual(sNotify, sPoll);
    assert.ok(sNotify.startsWith("ttlock_notify"));
    assert.ok(sPoll.startsWith("ttlock_polling"));
    ok("18 Notify/polling: mesma idempotency_key, source_event_id distinto");
  }

  // 19 um record falha e demais continuam
  {
    const h = harnessPending("pendente");
    let calls = 0;
    const original = h.ports.correlation.correlateRoomPasscodeEvent.bind(h.ports.correlation);
    h.ports.correlation.correlateRoomPasscodeEvent = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("falha isolada record0");
      return original(input);
    };
    const body = notifyPayload({
      records: [
        record({ lockDate: FIX_OCCURRED_MS }),
        record({ lockDate: FIX_OCCURRED_MS + 1 }),
      ],
    });
    const res = await ingest(body, { ports: h.ports });
    assert.ok(res.meta.failed >= 1);
    assert.ok(res.meta.processed >= 1);
    assert.ok(res.meta.results.some((r) => r.status === "failed" || r.status === "error"));
    assert.ok(res.meta.results.some((r) => r.status === "grace_started" || r.status === "processed_no_pending" || r.status === "ignored"));
    assert.equal(res.bodyText, TTLOCK_NOTIFY_SUCCESS_BODY);
    ok("19 falha isolada não derruba lote");
  }

  // 20 limite tamanho
  {
    const r = parseTtlockAccessNotifyPayload(notifyPayload(), {
      rawByteLength: MAX_NOTIFY_PAYLOAD_BYTES + 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "too_large");
    ok("20 limite de tamanho");
  }

  // 21 limite quantidade
  {
    const records = Array.from({ length: MAX_NOTIFY_RECORDS + 1 }, (_, i) =>
      record({ lockDate: FIX_OCCURRED_MS + i }),
    );
    const r = parseTtlockAccessNotifyPayload({ lockId: FIX_LOCK_APT, records });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "too_many_records");
    ok("21 limite de quantidade de records");
  }

  // 22-23 pagamento
  {
    assert.equal(mapPaymentStatusFromDb("pago"), "pago");
    const paid = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        {
          id: "1",
          principal: true,
          fnrh_status: "confirmado_hospede",
          role: "principal_adulto",
        },
      ],
    });
    assert.equal(evaluateReservationPendingState(paid).payment_pending, false);

    const partial = buildReservationPendingInputFromRows({
      pagamento_status: "parcial",
      guests: [
        { id: "1", principal: true, fnrh_status: "confirmado_hospede", role: "principal_adulto" },
      ],
    });
    assert.equal(evaluateReservationPendingState(partial).payment_pending, true);

    const unk = buildReservationPendingInputFromRows({
      pagamento_status: "desconhecido",
      guests: [
        { id: "1", principal: true, fnrh_status: "confirmado_hospede", role: "principal_adulto" },
      ],
    });
    assert.equal(evaluateReservationPendingState(unk).payment_pending, true);
    ok("22-23 adapter pendência mapeia pago; parcial/desconhecido pendentes");
  }

  // 24 FNRH incompleta
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        { id: "1", principal: true, fnrh_status: "pendente", role: "principal_adulto" },
      ],
    });
    assert.equal(evaluateReservationPendingState(input).fnrh_pending, true);
    ok("24 FNRH incompleta");
  }

  // 25 menor concluído pelo responsável
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        {
          id: "m1",
          principal: false,
          fnrh_status: "confirmado_hospede",
          role: "menor",
          completed_by_guardian: true,
        },
      ],
    });
    assert.equal(evaluateReservationPendingState(input).fnrh_pending, false);
    ok("25 menor concluído pelo responsável");
  }

  // schema lacuna → config error
  {
    assert.throws(
      () =>
        buildReservationPendingInputFromRows({
          pagamento_status: "pago",
          guests: [{ id: "x", principal: true, fnrh_status: "pendente" }],
        }),
      (e: unknown) => e instanceof FirstRoomAccessConfigurationError,
    );
    ok("schema FNRH incompleto → ConfigurationError");
  }

  // 26 item sem remote_keyboard_pwd_id
  {
    const h = harnessPending("pendente");
    h.itemsPort.setItems([
      { ...threeItems()[0]!, remote_keyboard_pwd_id: Number.NaN },
      threeItems()[1]!,
      threeItems()[2]!,
    ]);
    // NaN fails Number.isFinite in validateThreeTargets
    await ingest(notifyPayload(), { ports: h.ports });
    assert.equal(h.state.tolerances.length, 0);
    // PR5: falha antes do commit atômico — nenhum evento parcial.
    assert.equal(h.state.events.length, 0);
    ok("26 item sem remote_keyboard_pwd_id impede tolerância");
  }

  // 27 ausência de exatamente 3 itens
  {
    const h = harnessPending("pendente");
    h.itemsPort.setItems([threeItems()[0]!]);
    await ingest(notifyPayload(), { ports: h.ports });
    assert.equal(h.state.tolerances.length, 0);
    assert.equal(h.state.events.length, 0);
    ok("27 ausência de 3 itens impede tolerância");
  }

  // 28/29 nenhuma chamada TTLock/DigiSac — garantido por ausência de clients; outbox só memória
  {
    const h = harnessPending("pendente");
    await ingest(notifyPayload(), { ports: h.ports });
    assert.ok(h.state.outbox.some((m) => m.kind === "guest_welcome_pending"));
    ok("28-29 sem TTLock/DigiSac; outbox apenas enfileira");
  }

  // ambiguous via orchestrator
  {
    const h = createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: false,
        ambiguous: true,
        within_reservation_window: false,
      },
      pending: {
        payment_status: "pendente",
        guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
      },
      items: threeItems(),
    });
    const r = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_NOTIFY,
        source_event_id: "amb-1",
        idempotency_key: "amb-key-1",
        occurred_at: "2026-08-08T18:00:00.000Z",
        lock_id: FIX_LOCK_APT,
        record_type: 4,
        success: true,
      },
      h.ports,
    );
    assert.equal(r.status, "ignored");
    assert.equal(r.ignored_reason, "ambiguous");
    ok("orquestrador: ambiguous → ignored + alert");
  }

  // unsuccessful success=0
  {
    const h = harnessPending();
    await ingest(notifyPayload({ records: [record({ success: 0 })] }), { ports: h.ports });
    assert.equal(h.state.events[0]?.ignored_reason, "unsuccessful");
    ok("success=0 ignorado");
  }

  console.log(`\n${passed} asserções OK\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
