/**
 * Incidente real de 25/09/2026, apartamentos 02 e 09.
 *
 * Os hospedes digitaram a senha e abriram a porta. No Yes nao aconteceu nada:
 * nem `entrou_no_apto`, nem boas-vindas, nem aviso para a recepcao.
 *
 * Causa provada em producao, em dois pontos que se somavam:
 *
 * 1. `buildReservationPendingInputFromRows` lancava excecao quando um hospede
 *    estava sem `guest_role` seguro. O orquestrador capturava e devolvia
 *    `status: "failed"` SEM persistir nada.
 * 2. O poller so freava em `status === "error"`. `"failed"` contava como
 *    processado, a marca d'agua passava por cima do registro e ele ficava
 *    para tras para sempre -- com o ciclo se reportando saudavel
 *    (`lote_failed = 0`, `last_error = null`).
 *
 * Evidencia: apto 02 lock 13865804 lockDate 18:10:27; apto 09 lock 15615070
 * com tentativa `success=false` as 18:09:40 e a abertura boa as 18:09:48.
 */
import assert from "node:assert/strict";

import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory.ts";
import { buildReservationPendingInputFromRows } from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper.ts";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state.ts";
import type { CorrelatedRoomAccessResult } from "../src/lib/application/yes-hotel/first-room-access-types.ts";
import { TTLOCK_RECORD_TYPE } from "../src/lib/domain/yes-hotel/first-room-access-policy.ts";
import {
  pollOneLock,
  type PollCheckpoint,
  type PollCheckpointStore,
} from "../src/lib/integrations/ttlock/access-ingest/index.ts";
import type { TtlockClient } from "../src/lib/integrations/ttlock/client.ts";
import { TEST_ENV } from "../src/lib/integrations/ttlock/access-ingest/testing/fixtures.ts";

function ok(label: string) {
  console.log("  OK  " + label);
}

const POLL_ENV = { ...TEST_ENV, YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED: "true" };

const APTO_02 = {
  numero: "02",
  lock: 13865804,
  reserva: "00000002-0000-4000-8000-000000000002",
  credencial: "c0000002-0000-4000-8000-000000000002",
  item: "a0000002-0000-4000-8000-000000000002",
  senha: "482910",
  abertura: Date.parse("2026-09-25T22:10:27.000Z"),
};

const APTO_09 = {
  numero: "09",
  lock: 15615070,
  reserva: "00000009-0000-4000-8000-000000000009",
  credencial: "c0000009-0000-4000-8000-000000000009",
  item: "a0000009-0000-4000-8000-000000000009",
  senha: "731254",
  tentativa: Date.parse("2026-09-25T22:09:40.000Z"),
  abertura: Date.parse("2026-09-25T22:09:48.000Z"),
};

type Apto = typeof APTO_02;

function correlacao(apto: { numero: string; reserva: string; credencial: string; item: string }): CorrelatedRoomAccessResult {
  return {
    correlated: true,
    reservation_id: apto.reserva,
    credential_id: apto.credencial,
    credential_item_id: apto.item,
    logical_destination: "APT-" + apto.numero,
    lock_type: "apartamento",
    within_reservation_window: true,
    keyboard_pwd_id: 900000 + Number(apto.numero),
    original_valid_from: "2026-09-25T16:00:00.000Z",
    original_valid_until: "2026-09-27T14:00:00.000Z",
  };
}

/** `pending` do harness aceita as mesmas linhas cruas que vem do banco. */
function harness(apto: Apto, pending: Record<string, unknown>) {
  return createFirstRoomAccessMemoryHarness({
    correlation: correlacao(apto),
    pending: pending as never,
    items: [
      {
        id: apto.item,
        credential_id: apto.credencial,
        logical_destination: "APT-" + apto.numero,
        lock_type: "apartamento" as const,
        lock_id: apto.lock,
        remote_keyboard_pwd_id: 900000 + Number(apto.numero),
      },
      {
        id: "ext-" + apto.numero,
        credential_id: apto.credencial,
        logical_destination: "GATE-1947-EXTERNAL",
        lock_type: "portao_externo" as const,
        lock_id: 25709122,
        remote_keyboard_pwd_id: 800001,
      },
      {
        id: "int-" + apto.numero,
        credential_id: apto.credencial,
        logical_destination: "GATE-1947-INTERNAL",
        lock_type: "portao_interno" as const,
        lock_id: 25709168,
        remote_keyboard_pwd_id: 800002,
      },
    ],
  });
}

function registro(senha: string, lockDate: number, recordId: number, success = 1) {
  return {
    recordType: TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK,
    success,
    keyboardPwd: senha,
    lockDate,
    serverDate: lockDate + 1000,
    recordId,
  };
}

function clienteFake(list: Record<string, unknown>[]): TtlockClient {
  return { isAvailable: () => true, listLockRecords: async () => ({ list }) } as unknown as TtlockClient;
}

function store(seed: PollCheckpoint): PollCheckpointStore & { cps: Map<number, PollCheckpoint> } {
  const cps = new Map<number, PollCheckpoint>([[seed.lock_id, { ...seed }]]);
  return {
    cps,
    async listCandidateApartmentLockIds() { return [...cps.keys()]; },
    async getCheckpoint(lockId) { return cps.get(lockId) ?? null; },
    async upsertCheckpoint(input) {
      cps.set(input.lock_id, {
        lock_id: input.lock_id,
        last_lock_date_ms: input.last_lock_date_ms,
        last_record_id: input.last_record_id ?? null,
      });
    },
  };
}

function contar(outbox: Array<{ event_type: string; channel: string }>) {
  const por = (t: string) => outbox.filter((o) => o.event_type === t);
  return {
    interno: por("internal_first_access").length,
    boasVindas: por("guest_first_access_welcome").filter((o) => o.channel === "whatsapp").length,
    boasVindasEmail: por("guest_first_access_welcome").filter((o) => o.channel === "email").length,
  };
}

async function main() {
  console.log("\n== 1. Hospede sem classificacao segura nao derruba mais nada ==");
  {
    // Linha crua do banco, exatamente o caso de PROD: schema PR4 presente
    // (`requires_classification` e booleano) e `guest_role` nulo.
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        {
          id: "h1",
          guest_role: null,
          requires_classification: true,
          fnrh_lifecycle_status: "pending",
          fnrh_required: true,
          has_whatsapp: true,
          has_email: false,
        } as never,
      ],
    });

    const estado = evaluateReservationPendingState(input);
    // Conservador: ficha PENDENTE. Nunca "completa".
    assert.equal(estado.fnrh_pending, true, "sem classificacao tem de contar como pendencia");
    // E nao mascara pagamento: `pago` continua `pago`.
    assert.equal(estado.payment_pending, false, "pagamento foi alterado indevidamente");
    assert.equal(input.guests.length, 1);
    assert.equal(input.guests[0]!.fnrh_status, "pending");
    // Nao inventa responsavel.
    assert.equal(input.guests[0]!.role, "acompanhante_adulto");
    ok("classificacao ausente vira pendencia conservadora, sem excecao");
  }

  console.log("\n== 2. Apto 02: primeira abertura com hospede sem classificacao ==");
  {
    const h = harness(APTO_02, {
      payment_status: "pago",
      guests: [{ id: "h1", role: "acompanhante_adulto", fnrh_status: "pending" }],
    });
    const cp = store({
      lock_id: APTO_02.lock,
      last_lock_date_ms: APTO_02.abertura - 600_000,
      last_record_id: "1831447430",
    });

    const r = await pollOneLock({
      lockId: APTO_02.lock,
      client: clienteFake([registro(APTO_02.senha, APTO_02.abertura, 1831447436)]),
      ports: h.ports,
      store: cp,
      env: POLL_ENV,
      nowMs: APTO_02.abertura + 60_000,
    });

    assert.equal(r.failed, 0, "o registro voltou a falhar");
    assert.equal(r.processed, 1);
    assert.equal(h.state.events.length, 1, "o evento tem de existir no banco");
    assert.equal(h.state.events[0]!.processing_status, "processed");

    const entrada = h.state.reservationEntered[APTO_02.reserva];
    assert.ok(entrada, "entrou_no_apto nao foi registrado");
    assert.equal(entrada.entrou_no_apto, true);
    assert.equal(entrada.first_access_at, new Date(APTO_02.abertura).toISOString());

    const c = contar(h.state.accessOutbox);
    assert.equal(c.boasVindas, 1, "boas-vindas ao hospede");
    assert.equal(c.interno, 1, "aviso da recepcao");
    // Pendencia de ficha: a regra de 1h existente entra em acao.
    assert.equal(h.state.tolerances.length, 1, "tolerancia deveria ter sido aberta");
    ok("apto 02: entrada registrada, 1 boas-vindas, 1 aviso e tolerancia de 1h");
  }

  console.log("\n== 3. Apto 09: tentativa falha nao consome a abertura boa ==");
  {
    const h = harness(APTO_09, {
      payment_status: "pago",
      guests: [{ id: "h1", role: "principal_adulto", fnrh_status: "completed" }],
    });
    const cp = store({
      lock_id: APTO_09.lock,
      last_lock_date_ms: APTO_09.tentativa - 600_000,
      last_record_id: "1806027150",
    });

    const r = await pollOneLock({
      lockId: APTO_09.lock,
      client: clienteFake([
        registro(APTO_09.senha, APTO_09.tentativa, 1806027152, 0),
        registro(APTO_09.senha, APTO_09.abertura, 1806027158, 1),
      ]),
      ports: h.ports,
      store: cp,
      env: POLL_ENV,
      nowMs: APTO_09.abertura + 60_000,
    });

    assert.equal(r.processed, 2, "os dois registros deveriam ter sido processados");
    assert.equal(r.failed, 0);
    // A tentativa vira linha ignorada; a abertura boa vira entrada.
    const ignorados = h.state.events.filter((e) => e.processing_status === "ignored");
    const processados = h.state.events.filter((e) => e.processing_status === "processed");
    assert.equal(ignorados.length, 1, "a tentativa falha tem de ficar registrada");
    assert.equal(ignorados[0]!.ignored_reason, "unsuccessful");
    assert.equal(processados.length, 1, "a abertura boa nao virou evento processado");

    const entrada = h.state.reservationEntered[APTO_09.reserva];
    assert.ok(entrada, "entrou_no_apto nao foi registrado");
    assert.equal(entrada.first_access_at, new Date(APTO_09.abertura).toISOString());

    const c = contar(h.state.accessOutbox);
    assert.equal(c.boasVindas, 1);
    assert.equal(c.boasVindasEmail, 1);
    assert.equal(c.interno, 1);
    assert.equal(cp.cps.get(APTO_09.lock)!.last_lock_date_ms, APTO_09.abertura);
    ok("apto 09: tentativa registrada, abertura processada, 1 de cada mensagem");
  }

  console.log("\n== 4. `failed` nao pode consumir registro (o defeito do poller) ==");
  {
    const h = harness(APTO_02, {
      payment_status: "pago",
      guests: [{ id: "h1", role: "acompanhante_adulto", fnrh_status: "pending" }],
    });
    // Qualquer excecao dentro do orquestrador vira `status: "failed"` sem
    // persistir. Reproduz a forma exata do incidente, sem depender de QUAL
    // excecao foi -- porque o contrato do checkpoint nao pode depender disso.
    let tentativas = 0;
    h.ports.pending = {
      async getReservationPendingInput() {
        tentativas += 1;
        throw new Error("Hóspede h1 sem classificação segura (guest_role).");
      },
    } as never;

    const watermarkInicial = APTO_02.abertura - 600_000;
    const upserts: Array<Record<string, unknown>> = [];
    const cpBase = store({
      lock_id: APTO_02.lock,
      last_lock_date_ms: watermarkInicial,
      last_record_id: "1831447430",
    });
    const cp: PollCheckpointStore & { cps: Map<number, PollCheckpoint> } = {
      cps: cpBase.cps,
      listCandidateApartmentLockIds: cpBase.listCandidateApartmentLockIds,
      getCheckpoint: cpBase.getCheckpoint,
      async upsertCheckpoint(input) {
        upserts.push({ ...input });
        return cpBase.upsertCheckpoint(input);
      },
    };

    const rodar = () =>
      pollOneLock({
        lockId: APTO_02.lock,
        client: clienteFake([registro(APTO_02.senha, APTO_02.abertura, 1831447436)]),
        ports: h.ports,
        store: cp,
        env: POLL_ENV,
        nowMs: APTO_02.abertura + 60_000,
      });

    const r1 = await rodar();
    assert.equal(r1.failed, 1, "`failed` tem de contar como falha");
    assert.equal(r1.processed, 0, "`failed` nao pode contar como processado");
    assert.equal(h.state.events.length, 0, "nada foi persistido, como esperado");

    // A marca d'agua fica onde estava: o registro continua pendente.
    const depois = cp.cps.get(APTO_02.lock)!;
    assert.equal(depois.last_lock_date_ms, watermarkInicial, "a marca d'agua avancou sobre um registro perdido");
    assert.equal(depois.last_record_id, "1831447430", "last_record_id foi atualizado para um registro que nao virou linha");

    // E o erro fica gravado, em vez de sumir com o corpo HTTP do cron.
    const ultimo = upserts[upserts.length - 1]!;
    assert.ok(
      String(ultimo.last_error ?? "").includes("classifica"),
      "last_error deveria trazer a mensagem util: " + String(ultimo.last_error),
    );

    // Retry do ciclo seguinte tenta O MESMO registro de novo.
    const r2 = await rodar();
    assert.equal(r2.newer, 1, "o registro deveria continuar elegivel no proximo ciclo");
    assert.equal(tentativas, 2, "o retry nao reprocessou o mesmo registro");
    ok("registro que falhou nao e consumido, grava erro e volta no proximo ciclo");
  }

  console.log("\nIncidente 02/09: contrato verificado.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
