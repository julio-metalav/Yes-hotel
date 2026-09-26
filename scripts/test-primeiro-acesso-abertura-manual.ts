/**
 * Primeira abertura da porta: boas-vindas, aviso de 1h e senha fora do fluxo Yes.
 *
 * Caso real 26/09/2026 apto 07: a TTLock registrou desbloqueio por código às
 * 08:40, antes da credencial do Yes existir e antes da janela das 13h. O poller
 * não consultava o lock e, no primeiro ciclo, descartava o dia. Senha que não
 * casa com codigo_credencial só vincula se a estadia liberada for única.
 */
import assert from "node:assert/strict";

import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import type { CorrelatedRoomAccessResult } from "../src/lib/application/yes-hotel/first-room-access-types";
import { classifyCommissionFromHits } from "../src/lib/domain/yes-hotel/reservation-financial-classification";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy";
import {
  associateUnlockToUniqueLiberatedStay,
  correlateApartmentPasscodeCandidates,
  shouldApplyLiberatedStayFallback,
  type CorrelationCandidate,
  type LiberatedStayCandidate,
} from "../src/lib/infrastructure/supabase/yes-hotel/credential-correlation-logic";
import { paymentStatusForFirstAccessGrace } from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper";
import {
  broaderPollCandidateLockIds,
  mergePollCandidateLockIds,
} from "../src/lib/integrations/ttlock/access-ingest/poll-candidates";

const RESERVA = "00000007-0000-4000-8000-000000000007";
const CRED = "c0000007-0000-4000-8000-000000000007";
const ITEM = "a0000007-0000-4000-8000-000000000007";
const LOCK = 15461754;
const PIN_YES = "4821";
const OCCURRED = "2026-09-26T12:40:24.000Z";
const NOW_ON_TIME = "2026-09-26T12:41:00.000Z";
const NOW_LATE = "2026-09-26T15:10:00.000Z";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function threeItems() {
  return [
    {
      id: ITEM,
      credential_id: CRED,
      logical_destination: "APT-07",
      lock_type: "apartamento" as const,
      lock_id: LOCK,
      remote_keyboard_pwd_id: 700001,
    },
    {
      id: "item-ext",
      credential_id: CRED,
      logical_destination: "GATE-1947-EXTERNAL",
      lock_type: "portao_externo" as const,
      lock_id: 25709122,
      remote_keyboard_pwd_id: 700002,
    },
    {
      id: "item-int",
      credential_id: CRED,
      logical_destination: "GATE-1947-INTERNAL",
      lock_type: "portao_interno" as const,
      lock_id: 25709168,
      remote_keyboard_pwd_id: 700003,
    },
  ];
}

function correlated(): CorrelatedRoomAccessResult {
  return {
    correlated: true,
    reservation_id: RESERVA,
    credential_id: CRED,
    credential_item_id: ITEM,
    logical_destination: "APT-07",
    lock_type: "apartamento",
    within_reservation_window: true,
    keyboard_pwd_id: 700001,
    original_valid_from: "2026-09-26T17:00:00.000Z",
    original_valid_until: "2026-09-27T15:00:00.000Z",
  };
}

function harness(opts: {
  pago: boolean;
  correlation?: CorrelatedRoomAccessResult;
  now?: string;
}) {
  const h = createFirstRoomAccessMemoryHarness({
    correlation: opts.correlation ?? correlated(),
    pending: {
      payment_status: opts.pago ? "pago" : "pendente",
      guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
    },
    items: threeItems(),
    now: new Date(opts.now ?? NOW_ON_TIME),
  });
  h.ports.reservationDisplay = {
    async getContext() {
      return {
        apartment_number: "07",
        reservation_code: "RES-07",
        guest_main_name: "hóspede",
        parking_spot: "07",
        wifi_ssid: null,
        wifi_password: null,
        checkout_horario: "11:00",
        telefone_recepcao: null,
        data_entrada: "2026-09-26",
        data_saida: "2026-09-27",
      };
    },
  };
  return h;
}

async function open(h: ReturnType<typeof harness>, suffix: string, occurred = OCCURRED) {
  return processFirstRoomAccessEvent(
    {
      source: "ttlock_polling",
      source_event_id: `ttlock_polling:test:${suffix}`,
      idempotency_key: `idem-${suffix}`,
      occurred_at: occurred,
      lock_id: LOCK,
      record_type: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
      success: true,
      raw_payload_sanitized: { lockId: LOCK, recordType: 4 },
    },
    h.ports,
  );
}

function welcomes(h: ReturnType<typeof harness>) {
  return h.state.accessOutbox.filter((o) => o.event_type === "guest_first_access_welcome");
}

function hourNotices(h: ReturnType<typeof harness>) {
  return h.state.outbox.filter((o) => o.kind === "guest_welcome_pending");
}

function stay(overrides: Partial<LiberatedStayCandidate> = {}): LiberatedStayCandidate {
  return {
    reservation_id: RESERVA,
    credential_id: CRED,
    credential_item_id: ITEM,
    logical_destination: "APT-07",
    lock_id: LOCK,
    remote_keyboard_pwd_id: 700001,
    status_provisionamento: "provisionado",
    credential_status: "provisionada",
    valido_de: "2026-09-26T17:00:00.000Z",
    valido_ate: "2026-09-27T15:00:00.000Z",
    acesso_liberado: true,
    status_reserva: "ativa",
    check_in_previsto: "2026-09-26",
    check_out_previsto: "2026-09-27",
    ...overrides,
  };
}

function yesCandidate(overrides: Partial<CorrelationCandidate> = {}): CorrelationCandidate {
  return {
    credential_item_id: ITEM,
    credential_id: CRED,
    reservation_id: RESERVA,
    logical_destination: "APT-07",
    lock_id: LOCK,
    remote_keyboard_pwd_id: 700001,
    status_provisionamento: "provisionado",
    credential_status: "provisionada",
    codigo_credencial: PIN_YES,
    valido_de: "2026-09-26T17:00:00.000Z",
    valido_ate: "2026-09-27T15:00:00.000Z",
    ...overrides,
  };
}

async function main() {
  console.log("\n=== Primeira abertura: boas-vindas, 1h, senha manual ===\n");

  {
    const h = harness({ pago: true });
    const r = await open(h, "pago");
    assert.equal(r.status, "processed_no_pending");
    assert.equal(h.state.reservationEntered[RESERVA]?.entrou_no_apto, true);
    assert.equal(welcomes(h).length, 2);
    assert.equal(hourNotices(h).length, 0);
    assert.equal(h.state.tolerances.length, 0);
    ok("1 pagamento ok: entrada, boas-vindas, sem aviso de 1h");
  }

  {
    const h = harness({ pago: false });
    const r = await open(h, "pendente");
    assert.equal(r.status, "grace_started");
    assert.equal(h.state.reservationEntered[RESERVA]?.entrou_no_apto, true);
    assert.equal(welcomes(h).length, 2);
    assert.equal(hourNotices(h).length, 1);
    assert.match(hourNotices(h)[0]!.body, /1 hora/);
    assert.equal(h.state.tolerances.length, 1);
    const due = Date.parse(h.state.tolerances[0]!.suspension_due_at);
    assert.equal(due - Date.parse(OCCURRED), 60 * 60 * 1000);
    ok("2 reserva direta pendente: boas-vindas e aviso de 1h");
  }

  {
    for (const canal of ["AIRBNB", "BOOKING", "EXPEDIA"]) {
      const cls = classifyCommissionFromHits({ salesChannel: canal });
      assert.equal(cls.classificacao, "comissionada", canal);
      assert.equal(
        paymentStatusForFirstAccessGrace({
          pagamento_status: "pendente",
          classificacao_comissionamento: cls.classificacao,
        }),
        "pago",
        canal,
      );
    }
    const b2b = classifyCommissionFromHits({ channelManager: "B2BRESERVAS" });
    assert.equal(b2b.classificacao, "comissionada");
    assert.equal(
      paymentStatusForFirstAccessGrace({
        pagamento_status: "pendente",
        classificacao_comissionamento: b2b.classificacao,
      }),
      "pago",
    );
    const direta = paymentStatusForFirstAccessGrace({
      pagamento_status: "pendente",
      classificacao_comissionamento: "nao_comissionada",
    });
    assert.equal(direta, "pendente");
    const estadoOta = evaluateReservationPendingState({
      payment_status: "pago",
      guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
    });
    assert.equal(estadoOta.payment_pending, false);
    const h = harness({ pago: true });
    await open(h, "ota");
    assert.equal(welcomes(h).length, 2);
    assert.equal(hourNotices(h).length, 0);
    ok("3 OTA/B2B comissionada: sem aviso de regularização");
  }

  {
    const h = harness({ pago: false });
    await open(h, "primeira");
    const second = await open(h, "segunda", "2026-09-26T12:55:00.000Z");
    assert.equal(second.status, "already_started");
    assert.equal(welcomes(h).length, 2);
    assert.equal(hourNotices(h).length, 1);
    ok("4 segunda abertura não duplica boas-vindas nem aviso de 1h");
  }

  {
    const none = associateUnlockToUniqueLiberatedStay({
      civil_date: "2026-09-26",
      candidates: [stay({ check_out_previsto: "2026-09-25" })],
    });
    assert.equal(none.correlated, false);
    assert.equal(none.diagnostic, "sem_reserva_associavel");
    const h = harness({
      pago: false,
      correlation: none,
    });
    const r = await open(h, "sem-reserva");
    assert.equal(r.status, "ignored");
    assert.equal(r.ignored_reason, "sem_reserva_associavel");
    assert.equal(welcomes(h).length, 0);
    assert.equal(hourNotices(h).length, 0);
    assert.equal(h.state.reservationEntered[RESERVA], undefined);
    ok("5 sem reserva associável: nenhuma mensagem, diagnóstico gravado");
  }

  {
    const manual = associateUnlockToUniqueLiberatedStay({
      civil_date: "2026-09-26",
      candidates: [
        stay(),
        stay({
          reservation_id: "00000099-0000-4000-8000-000000000099",
          credential_id: "c0000099-0000-4000-8000-000000000099",
          credential_item_id: "a0000099-0000-4000-8000-000000000099",
          acesso_liberado: false,
          check_in_previsto: "2026-09-24",
          check_out_previsto: "2026-09-26",
        }),
      ],
    });
    assert.equal(manual.correlated, true);
    assert.equal(manual.reservation_id, RESERVA);
    const h = harness({ pago: false, correlation: manual, now: NOW_LATE });
    const r = await open(h, "manual-tarde");
    assert.equal(r.status, "grace_started");
    assert.equal(welcomes(h).length, 2);
    assert.equal(hourNotices(h).length, 1);
    const due = Date.parse(h.state.tolerances[0]!.suspension_due_at);
    assert.ok(due > Date.parse(NOW_LATE), "prazo não pode nascer vencido");
    assert.equal(due - Date.parse(NOW_LATE), 60 * 60 * 1000);

    const ambiguous = associateUnlockToUniqueLiberatedStay({
      civil_date: "2026-09-26",
      candidates: [
        stay(),
        stay({
          reservation_id: "00000098-0000-4000-8000-000000000098",
          credential_id: "c0000098-0000-4000-8000-000000000098",
          credential_item_id: "a0000098-0000-4000-8000-000000000098",
          check_in_previsto: "2026-09-26",
          check_out_previsto: "2026-09-28",
        }),
      ],
    });
    assert.equal(ambiguous.correlated, false);
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.diagnostic, "reserva_ambigua");
    const hAmb = harness({ pago: false, correlation: ambiguous });
    const ignored = await open(hAmb, "ambiguo");
    assert.equal(ignored.status, "ignored");
    assert.equal(ignored.ignored_reason, "reserva_ambigua");
    assert.equal(welcomes(hAmb).length, 0);
    assert.equal(hourNotices(hAmb).length, 0);

    const wrongPin = correlateApartmentPasscodeCandidates({
      candidates: [yesCandidate()],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: "9999",
    });
    assert.equal(wrongPin.correlated, false);
    assert.equal(shouldApplyLiberatedStayFallback(wrongPin, true), true);

    const outside = correlateApartmentPasscodeCandidates({
      candidates: [yesCandidate()],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN_YES,
    });
    assert.equal(outside.diagnostic, "fora_da_validade_da_credencial");
    assert.equal(shouldApplyLiberatedStayFallback(outside, true), false);

    const known = correlateApartmentPasscodeCandidates({
      candidates: [
        yesCandidate({
          valido_de: "2026-09-26T12:00:00.000Z",
          valido_ate: "2026-09-27T15:00:00.000Z",
        }),
      ],
      occurred_at: OCCURRED,
      ephemeral_keyboard_pwd: PIN_YES,
    });
    assert.equal(known.correlated, true);
    assert.equal(shouldApplyLiberatedStayFallback(known, true), false);
    ok("6 senha manual: vínculo único segue; empate ou senha conhecida não inventa reserva");
  }

  {
    const now = Date.parse("2026-09-26T15:10:00.000Z");
    const ids = broaderPollCandidateLockIds(
      [
        {
          lock_id_ttlock: String(LOCK),
          codigo_logico_destino: "APT-07",
          credential_status: "provisionada",
          valido_ate: "2026-09-27T15:00:00.000Z",
          acesso_liberado: true,
          entrou_no_apto: false,
        },
        {
          lock_id_ttlock: "13865804",
          codigo_logico_destino: "APT-02",
          credential_status: "provisionada",
          valido_ate: "2026-09-27T15:00:00.000Z",
          acesso_liberado: true,
          entrou_no_apto: true,
        },
      ],
      now,
    );
    assert.deepEqual(ids, [LOCK]);
    assert.deepEqual(mergePollCandidateLockIds([13865804], ids), [13865804, LOCK]);
    ok("poller inclui lock com acesso liberado antes do valido_de");
  }

  console.log(`\nOK test-primeiro-acesso-abertura-manual (${passed} casos)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
