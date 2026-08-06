/**
 * Testes do dispatcher operacional_acesso_outbox (sem rede).
 * Mock somente por injeção explícita; flags off não marcam sent.
 */
import assert from "node:assert/strict";
import {
  createMockAccessCommunicationSender,
  dispatchAccessOutboxBatch,
} from "../src/lib/application/yes-hotel/access-outbox-dispatcher";
import {
  createFirstRoomAccessMemoryHarness,
  FixedClock,
} from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { enqueueInternalFirstAccessMessage } from "../src/lib/application/yes-hotel/enqueue-internal-first-access";
import {
  assertMessageHasNoTechnicalJargon,
  buildAccessSuspendedMessage,
  buildInternalFirstAccessMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages";
import type { AccessToleranceFlags } from "../src/lib/domain/yes-hotel/access-tolerance-flags";
import {
  buildProductionAccessCommunicationSender,
  createDigisacAccessCommunicationSender,
  createResendAccessCommunicationSender,
  digisacConfigComplete,
  readDigisacSenderConfig,
  readResendSenderConfig,
  resendConfigComplete,
} from "../src/lib/infrastructure/comunicacao/access-communication-senders";
import { assertSanitizedPayloadSafe } from "../src/lib/integrations/ttlock/access-ingest/sanitize";
import { getAccessToleranceFlags } from "../src/lib/domain/yes-hotel/access-tolerance-flags";

async function main() {
  const RES_ID = "5321a46f-5000-43e1-8830-df57f3bc0439";
  const NOW = "2026-08-08T19:10:00.000Z";

  /** Flags com canais “reais” liberados só para teste + mock injetado. */
  const FLAGS_SEND: AccessToleranceFlags = {
    processorEnabled: false,
    ttlockSuspensionEnabled: false,
    outboxDispatchEnabled: true,
    digisacRealEnabled: true,
    emailRealEnabled: true,
    homologLockIdFilter: null,
    digisacInternalNumber: "6721800225",
  };

  const FLAGS_OFF: AccessToleranceFlags = {
    ...FLAGS_SEND,
    digisacRealEnabled: false,
    emailRealEnabled: false,
  };

  function baseHarness() {
    return createFirstRoomAccessMemoryHarness({
      correlation: {
        correlated: true,
        reservation_id: RES_ID,
        credential_id: "cred-1",
        within_reservation_window: true,
      },
      pending: {
        payment_status: "pendente",
        guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "pending" }],
      },
      items: [],
      now: new Date(NOW),
    });
  }

  let cases = 0;
  function ok(name: string) {
    cases += 1;
    console.log("  ok", name);
  }

  // flag canal desligada → disabled, não sent
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "flagoff-wa",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999", email: "a@b.com" }),
      },
      { flags: FLAGS_OFF },
    );
    assert.equal(results[0].status, "disabled");
    assert.equal(h.state.accessOutbox[0].status, "pending");
    ok("flag digisac desligada nao marca sent");
  }

  // mensagem interna com mock injetado + flag real
  {
    const h = baseHarness();
    const msg = buildInternalFirstAccessMessage({
      apartment_number: "02",
      reservation_code: "12345",
      guest_main_name: "João da Silva",
      payment_pending: true,
      fnrh_pending: true,
      grace_started: true,
    });
    assertMessageHasNoTechnicalJargon(msg.body);
    await enqueueInternalFirstAccessMessage({
      queue: h.outboxQueue,
      reservation_id: RES_ID,
      credential_id: "cred-1",
      tolerance_id: "tol-1",
      apartment_number: "02",
      reservation_code: "12345",
      guest_main_name: "João da Silva",
      payment_pending: true,
      fnrh_pending: true,
      grace_started: true,
      nowIso: NOW,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999999999", email: "a@b.com" }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "sent");
    assert.equal(h.state.accessOutbox[0].last_error, null);
    ok("mock injetado marca sent; last_error limpo");
  }

  // whatsapp + email
  {
    const h = baseHarness();
    const body = buildAccessSuspendedMessage().body;
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: "cred-1",
      access_event_id: null,
      tolerance_id: "tol-1",
      recipient_ref: null,
      template: "access_suspended",
      payload: { body },
      idempotency_key: "susp:wa",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "email",
      reservation_id: RES_ID,
      credential_id: "cred-1",
      access_event_id: null,
      tolerance_id: "tol-1",
      recipient_ref: null,
      template: "access_suspended",
      payload: { body, subject: "Yes Hotel" },
      idempotency_key: "susp:em",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999999999", email: "a@b.com" }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results.filter((r) => r.status === "sent").length, 2);
    ok("whatsapp e email independentes");
  }

  // ausência de e-mail
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "email",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "access_suspended",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "noemail",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999999999", email: null }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results[0].status, "skipped");
    assert.equal(results[0].error, "email_ausente");
    ok("ausencia de email skipped");
  }

  // ausência de telefone
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "access_suspended",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "nophone",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: null, email: "a@b.com" }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].error, "telefone_ausente");
    assert.ok(h.state.accessOutbox[0].processed_at);
    ok("ausencia de telefone terminal");
  }

  // falha transitória whatsapp / email ok
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "failwa",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "email",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body, subject: "s" },
      idempotency_key: "failem",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender({ failWhatsapp: true }),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999", email: "a@b.com" }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results.find((r) => r.channel === "whatsapp")!.status, "failed");
    assert.equal(results.find((r) => r.channel === "email")!.status, "sent");
    ok("falha transitória whatsapp; email ok");
  }

  // composição produção sem config → disabled (não mock ok)
  {
    const sender = buildProductionAccessCommunicationSender(
      { digisacRealEnabled: true, emailRealEnabled: true },
      { DIGISAC_USE_MOCK: "false" },
    );
    const wa = await sender.sendWhatsapp({
      recipient_ref: "67999",
      body: "oi",
      idempotency_key: "x",
    });
    assert.equal(wa.ok, false);
    assert.match(String(wa.error), /digisac_config_incomplete|digisac/);
    const cfg = readDigisacSenderConfig({});
    assert.equal(digisacConfigComplete(cfg), false);
    assert.equal(resendConfigComplete(readResendSenderConfig({})), false);
    ok("config ausente nao marca sucesso");
  }

  // DigiSac real selecionado com flag+config; fetch double
  {
    let called = 0;
    const digi = createDigisacAccessCommunicationSender(
      {
        useMock: false,
        apiBaseUrl: "https://example.test",
        apiToken: "tok",
        serviceId: "svc",
        userId: "usr",
      },
      (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    );
    const r = await digi.sendWhatsapp({
      recipient_ref: "67999999999",
      body: "Sua senha foi temporariamente suspensa",
      idempotency_key: "k",
    });
    assert.equal(r.ok, true);
    assert.equal(called, 1);
    ok("sender DigiSac real com double");
  }

  // Resend real com double
  {
    let called = 0;
    const resend = createResendAccessCommunicationSender(
      { apiKey: "re_test", fromEmail: "hotel@example.com" },
      (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    );
    const r = await resend.sendEmail({
      recipient_ref: "a@b.com",
      subject: "s",
      body: "A senha foi restaurada",
      idempotency_key: "k",
    });
    assert.equal(r.ok, true);
    assert.equal(called, 1);
    ok("sender Resend real com double");
  }

  // flags env: ausência DIGISAC_USE_MOCK não ativa real
  {
    const f = getAccessToleranceFlags({
      YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED: "true",
    });
    assert.equal(f.digisacRealEnabled, false);
    const f2 = getAccessToleranceFlags({
      YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED: "true",
      DIGISAC_USE_MOCK: "false",
    });
    assert.equal(f2.digisacRealEnabled, true);
    ok("DIGISAC_USE_MOCK ausente fail-closed");
  }

  // reclaim processing antigo
  {
    const h = baseHarness();
    const id = await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "stale-proc",
      status: "processing",
      attempts: 1,
      available_at: "2026-08-08T18:00:00.000Z",
      processed_at: null,
      last_error: "old",
    });
    const listed = await h.outboxQueue.listAvailable(NOW, 10);
    assert.ok(listed.some((r) => r.id === id));
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67999", email: null }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results[0].status, "sent");
    assert.equal(h.state.accessOutbox[0].last_error, null);
    ok("processing antigo reclaimed");
  }

  // processing recente não reclaimed
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "fresh-proc",
      status: "processing",
      attempts: 1,
      available_at: "2026-08-08T20:00:00.000Z",
      processed_at: null,
      last_error: null,
    });
    const listed = await h.outboxQueue.listAvailable(NOW, 10);
    assert.equal(listed.length, 0);
    ok("processing recente nao reclaimed");
  }

  // sent não volta
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "alreadysent",
      status: "sent",
      attempts: 1,
      available_at: NOW,
      processed_at: NOW,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: h.clock,
        resolveRecipients: async () => ({ phone_digits: "67", email: null }),
      },
      { flags: FLAGS_SEND },
    );
    assert.equal(results.length, 0);
    ok("item sent nao reprocessa");
  }

  // dispatcher flag off
  {
    const h = baseHarness();
    await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "disp-off",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const results = await dispatchAccessOutboxBatch(
      {
        queue: h.outboxQueue,
        sender: createMockAccessCommunicationSender(),
        clock: new FixedClock(new Date(NOW)),
        resolveRecipients: async () => ({ phone_digits: "67", email: null }),
      },
      { flags: { ...FLAGS_SEND, outboxDispatchEnabled: false } },
    );
    assert.equal(results.length, 0);
    ok("flag dispatcher desligada");
  }

  // sanitização: texto com senha ok
  {
    assertSanitizedPayloadSafe({ body: "Sua senha foi temporariamente suspensa" });
    assert.throws(() => assertSanitizedPayloadSafe({ password: "x" }));
    ok("template com senha permitido; chave password bloqueada");
  }

  // dedupe
  {
    const h = baseHarness();
    const id1 = await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "dup-key",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    const id2 = await h.outboxQueue.enqueue({
      event_type: "guest_access_suspended",
      channel: "whatsapp",
      reservation_id: RES_ID,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "x",
      payload: { body: buildAccessSuspendedMessage().body },
      idempotency_key: "dup-key",
      status: "pending",
      attempts: 0,
      available_at: NOW,
      processed_at: null,
      last_error: null,
    });
    assert.equal(id1, id2);
    assert.equal(h.state.accessOutbox.length, 1);
    ok("deduplicacao por idempotency_key");
  }

  console.log(`OK test-access-outbox-dispatcher (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
