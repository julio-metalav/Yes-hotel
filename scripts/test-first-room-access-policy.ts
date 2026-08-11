/**
 * Testes: first-room-access-policy (sem I/O).
 */
import assert from "node:assert/strict";
import {
  decideAccessGrace,
  evaluateFirstRoomAccessEvent,
  TTLOCK_RECORD_TYPE,
  type NormalizedRoomAccessEvent,
} from "../src/lib/domain/yes-hotel/first-room-access-policy";

function baseEvent(
  overrides: Partial<NormalizedRoomAccessEvent> = {},
): NormalizedRoomAccessEvent {
  return {
    source_event_id: "evt-1",
    occurred_at: "2026-08-08T18:00:00.000Z",
    lock_id: 15615492,
    keyboard_pwd_id: 100632532,
    record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success: true,
    logical_destination: "APT-10",
    lock_type: "apartamento",
    reservation_id: "res-1",
    credential_id: "cred-1",
    credential_item_id: "item-apt",
    within_reservation_window: true,
    correlated: true,
    ...overrides,
  };
}

const freshCtx = {
  first_access_already_registered: false,
  event_already_processed: false,
  grace_already_started: false,
};

// 1) senha válida na porta do apartamento
{
  const d = evaluateFirstRoomAccessEvent(baseEvent(), freshCtx);
  assert.equal(d.accepted, true);
  assert.equal(d.should_register_first_access, true);
  assert.equal(d.decision, "accepted");
}

// 2) portão ignorado
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ lock_type: "portao_externo", logical_destination: "GATE-1947-EXTERNAL" }),
    freshCtx,
  );
  assert.equal(d.accepted, false);
  assert.equal(d.ignored_reason, "not_apartment");
}

{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ lock_type: "portao_interno", logical_destination: "GATE-1947-INTERNAL" }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_apartment");
}

// 3) app ignorado
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ record_type: TTLOCK_RECORD_TYPE.APP_UNLOCK }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_passcode");
}

// 4) administrativa ignorada
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ is_admin_operator: true }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_passcode");
}

// 5) cartão
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ record_type: TTLOCK_RECORD_TYPE.IC_CARD_UNLOCK }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_passcode");
}

// 6) chave mecânica
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ record_type: TTLOCK_RECORD_TYPE.MECHANICAL_KEY }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_passcode");
}

// 7) senha inválida / unsuccessful
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ success: false, record_type: TTLOCK_RECORD_TYPE.INVALID_PASSCODE }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "unsuccessful");
}

// 8) sem correlação (apto reconhecido)
{
  const d = evaluateFirstRoomAccessEvent(baseEvent({ correlated: false }), freshCtx);
  assert.equal(d.ignored_reason, "uncorrelated");
}

// 8b) lock desconhecido (sem lock_type/destino apto) → not_apartment
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({
      correlated: false,
      lock_type: undefined,
      logical_destination: undefined,
    }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "not_apartment");
}

// 9) fora da janela
{
  const d = evaluateFirstRoomAccessEvent(
    baseEvent({ within_reservation_window: false }),
    freshCtx,
  );
  assert.equal(d.ignored_reason, "outside_window");
}

// 10) duplicado não reinicia
{
  const d = evaluateFirstRoomAccessEvent(baseEvent(), {
    ...freshCtx,
    event_already_processed: true,
  });
  assert.equal(d.ignored_reason, "duplicate");
  assert.equal(d.should_register_first_access, false);
}

{
  const d = evaluateFirstRoomAccessEvent(baseEvent({ source_event_id: "evt-2" }), {
    first_access_already_registered: true,
    grace_already_started: false,
  });
  assert.equal(d.accepted, false);
  assert.ok(d.ignored_reason === "duplicate" || d.ignored_reason === "already_started");
}

// 11) sem pendência → não inicia tolerância (mas registra primeiro acesso)
{
  const access = evaluateFirstRoomAccessEvent(baseEvent(), freshCtx);
  assert.equal(access.accepted, true);
  const grace = decideAccessGrace({
    event_accepted: access.accepted,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: false,
    fnrh_pending: false,
    pending_reasons: [],
    occurred_at: baseEvent().occurred_at,
  });
  assert.equal(grace.start_grace, false);
  assert.equal(grace.register_first_access, true);
  assert.deepEqual(grace.pending_snapshot, []);
}

// 12–14) pendências iniciam tolerância + prazo +1h
{
  const occurred = "2026-08-08T18:00:00.000Z";
  const grace = decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: true,
    fnrh_pending: false,
    pending_reasons: ["pagamento"],
    occurred_at: occurred,
  });
  assert.equal(grace.start_grace, true);
  assert.equal(grace.grace_started_at, occurred);
  assert.equal(grace.suspension_due_at, "2026-08-08T19:00:00.000Z");
  assert.deepEqual(grace.pending_snapshot, ["pagamento"]);
}

{
  const grace = decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: false,
    fnrh_pending: true,
    pending_reasons: ["fnrh"],
    occurred_at: "2026-08-08T18:00:00.000Z",
  });
  assert.equal(grace.start_grace, true);
}

// já iniciada → não reinicia
{
  const grace = decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: true,
    grace_already_started: true,
    payment_pending: true,
    fnrh_pending: true,
    pending_reasons: ["pagamento", "fnrh"],
    occurred_at: "2026-08-08T18:30:00.000Z",
  });
  assert.equal(grace.start_grace, false);
}

// estrutura sem senha
{
  const json = JSON.stringify(baseEvent());
  assert.ok(!/passcode|password|senha|keyboardPwd[^_]/i.test(json));
}

console.log("OK test-first-room-access-policy");
