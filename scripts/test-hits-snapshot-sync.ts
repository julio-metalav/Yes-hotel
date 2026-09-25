/**
 * Testes: sync do snapshot operacional HITS (lógica pura da Edge).
 * Sem rede, sem banco: RPC falsa injetada. Prova a ordem start → leitura →
 * apply | fail, a allowlist de campos e que uma falha de leitura nunca chega
 * ao apply (o snapshot anterior fica intacto por construção).
 */
import assert from "node:assert/strict";
import {
  HITS_SNAPSHOT_RPC_APPLY,
  HITS_SNAPSHOT_RPC_FAIL,
  HITS_SNAPSHOT_RPC_START,
  bearerRole,
  runHitsSnapshotSync,
  shouldPersistSnapshot,
  toSnapshotRows,
  type SnapshotRpc,
} from "../src/lib/integrations/hits/hits-snapshot-sync.ts";
import type {
  FetchHitsSandboxReservationsResult,
  HitsSandboxReservationRow,
} from "../src/lib/integrations/hits/hits-gateway-read.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

function jwt(role: string): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  return `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify({ role, iss: "supabase" }))}.sig`;
}

const ROW: HitsSandboxReservationRow = {
  external_reservation_id: "17613",
  apartamento: "07",
  hospede_principal: "Hospede Sintetico",
  check_in: "2026-09-20",
  check_out: "2026-09-23",
  status_reserva: "ativa",
  total_hospedes: 2,
  ciclo_hits: "confirmada",
  meal_plan_desc: "Café da Manhã",
};

function readResult(
  rows: HitsSandboxReservationRow[],
  failed: Array<{ external_reservation_id: string; code: string }> = [],
): FetchHitsSandboxReservationsResult {
  return {
    rows,
    page: 1,
    size: 20,
    pages_fetched: 2,
    stopped_reason: "last_page",
    failed,
    listing_complete: true,
    elapsed_ms: 0,
  };
}

type Call = { fn: string; args: Record<string, unknown> };

function fakeRpc(plan: {
  startError?: boolean;
  applyError?: boolean;
  applyData?: unknown;
  throwOnStart?: boolean;
}): { rpc: SnapshotRpc; calls: Call[] } {
  const calls: Call[] = [];
  const rpc: SnapshotRpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === HITS_SNAPSHOT_RPC_START) {
      if (plan.throwOnStart) throw new Error("start explodiu");
      return { data: null, error: plan.startError ? { message: "start falhou" } : null };
    }
    if (fn === HITS_SNAPSHOT_RPC_APPLY) {
      if (plan.applyError) return { data: null, error: { message: "apply falhou" } };
      return { data: plan.applyData ?? [{ rows_upserted: 2, rows_removed: 1 }], error: null };
    }
    if (fn === HITS_SNAPSHOT_RPC_FAIL) return { data: null, error: null };
    throw new Error("rpc inesperada: " + fn);
  };
  return { rpc, calls };
}

async function main() {
  console.log("\n== Papel do Bearer ==");
  {
    assert.equal(bearerRole("Bearer " + jwt("anon")), "anon");
    assert.equal(bearerRole("Bearer " + jwt("authenticated")), "authenticated");
    assert.equal(bearerRole("bearer " + jwt("service_role")), "service_role");
    assert.equal(bearerRole("Bearer sb_publishable_abc"), "", "chave não-JWT → sem papel");
    assert.equal(bearerRole(null), "");
    assert.equal(bearerRole("Bearer a.b"), "", "payload inválido não lança");
    ok("role do JWT decodificado sem verificar assinatura; não-JWT vira vazio");
  }

  console.log("\n== Decisão de persistir ==");
  {
    const anon = "Bearer " + jwt("anon");
    const user = "Bearer " + jwt("authenticated");
    const q = (s: string) => new URLSearchParams(s);

    assert.deepEqual(
      shouldPersistSnapshot({ writeEnabled: undefined, searchParams: q(""), authorization: anon }),
      { persist: false, reason: "flag_off" },
    );
    assert.deepEqual(
      shouldPersistSnapshot({ writeEnabled: "TRUE", searchParams: q(""), authorization: anon }),
      { persist: false, reason: "flag_off" },
    );
    assert.deepEqual(
      shouldPersistSnapshot({ writeEnabled: "1", searchParams: q(""), authorization: anon }),
      { persist: false, reason: "flag_off" },
    );
    ok("trava exige exatamente 'true'");

    for (const qs of ["ids=1", "date_from=2026-09-24", "date_to=2026-10-24", "page=2", "size=5"]) {
      assert.deepEqual(
        shouldPersistSnapshot({ writeEnabled: "true", searchParams: q(qs), authorization: anon }),
        { persist: false, reason: "has_query_params" },
        qs,
      );
    }
    ok("qualquer parâmetro ad hoc (ids/janela/paginação) nunca grava o snapshot");

    assert.deepEqual(
      shouldPersistSnapshot({ writeEnabled: "true", searchParams: q(""), authorization: user }),
      { persist: false, reason: "user_session_caller" },
    );
    ok("sessão de usuário (página antiga aberta) nunca grava");

    assert.deepEqual(
      shouldPersistSnapshot({ writeEnabled: "true", searchParams: q(""), authorization: anon }),
      { persist: true },
    );
    assert.deepEqual(
      shouldPersistSnapshot({
        writeEnabled: "true",
        searchParams: q(""),
        authorization: "Bearer sb_publishable_x",
      }),
      { persist: true },
    );
    ok("forma do scheduler (anon key ou chave publishable, sem params) grava");
  }

  console.log("\n== Allowlist de campos ==");
  {
    const sujo = {
      ...ROW,
      contactPhone: "+55 67 9",
      contactMail: "x@y",
      docCpfCnpjPassport: "000",
      reservationBalanceDue: 100,
      rawSanitized: { tudo: true },
    } as unknown as HitsSandboxReservationRow;
    const [linha] = toSnapshotRows([sujo]);
    assert.deepEqual(Object.keys(linha!).sort(), [
      "apartamento",
      "check_in",
      "check_out",
      "ciclo_hits",
      "external_reservation_id",
      "hospede_principal",
      "meal_plan_desc",
      "status_reserva",
      "total_hospedes",
    ]);
    ok("só os 9 campos da tela (com o plano de refeição); contato, documento, financeiro e raw nunca passam");

    assert.equal(toSnapshotRows([{ ...ROW, external_reservation_id: " " }]).length, 0);
    assert.equal(toSnapshotRows([{ ...ROW, total_hospedes: 0 }])[0]!.total_hospedes, 1);
    assert.equal(
      toSnapshotRows([{ ...ROW, ciclo_hits: "hospedada" }])[0]!.ciclo_hits,
      "hospedada",
    );
    assert.equal(
      toSnapshotRows([{ ...ROW, status_reserva: "cancelada" }])[0]!.status_reserva,
      "cancelada",
    );
    assert.equal(
      toSnapshotRows([{ ...ROW, check_in: "2026-09-20T00:00:00-04:00" }])[0]!.check_in,
      "2026-09-20",
    );
    ok("sem id é descartada; pax mínimo 1; datas cortadas em YYYY-MM-DD");
  }

  console.log("\n== Ciclo completo: start → leitura → apply ==");
  {
    const { rpc, calls } = fakeRpc({});
    let reads = 0;
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-1",
      read: async () => {
        reads += 1;
        return readResult([ROW, { ...ROW, external_reservation_id: "17614" }]);
      },
    });
    assert.equal(reads, 1, "uma leitura HITS por ciclo");
    assert.deepEqual(
      calls.map((c) => c.fn),
      [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY],
    );
    assert.equal(calls[0]!.args.p_batch_id, "b-1");
    const apply = calls[1]!.args;
    assert.equal(apply.p_batch_id, "b-1");
    assert.equal(apply.p_status, "ok");
    assert.deepEqual(apply.p_failed_ids, []);
    assert.equal(apply.p_stopped_reason, "last_page");
    assert.equal((apply.p_rows as unknown[]).length, 2);
    assert.ok(out.result, "resposta da Edge continua com o resultado da leitura");
    assert.equal(out.readError, null);
    assert.deepEqual(out.snapshot, {
      persisted: true,
      batch_id: "b-1",
      status: "ok",
      returned_count: 2,
      detail_count: 2,
      rows_upserted: 2,
      rows_changed: 0,
      rows_removed: 1,
      failed_count: 0,
      start_error: null,
    });
    assert.equal(apply.p_returned_count, 2, "telemetria: ids devolvidos");
    assert.equal(apply.p_detail_count, 2, "telemetria: detalhes lidos");
    ok("sucesso: start, uma leitura, apply com o lote completo e status ok");
  }
  {
    const { rpc, calls } = fakeRpc({ applyData: { rows_upserted: 3, rows_removed: 0 } });
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-2",
      read: async () =>
        readResult([ROW], [{ external_reservation_id: "17999", code: "timeout" }]),
    });
    const apply = calls[1]!.args;
    assert.equal(apply.p_status, "partial");
    assert.deepEqual(apply.p_failed_ids, ["17999"]);
    assert.equal(out.snapshot.persisted, true);
    if (out.snapshot.persisted) {
      assert.equal(out.snapshot.status, "partial");
      assert.equal(out.snapshot.failed_count, 1);
      assert.equal(out.snapshot.rows_upserted, 3, "data como objeto também é lido");
    }
    ok("detalhe falho → status partial e ids preservados (a RPC mantém a fotografia deles)");
  }

  console.log("\n== Orçamento de tempo (time_budget) ==");
  {
    // Detalhes cortados pelo orçamento: listagem completa → apply partial com
    // os ids não lidos preservados (mesmo caminho de um detalhe falho).
    const { rpc, calls } = fakeRpc({});
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-tb-1",
      read: async () => ({
        ...readResult([ROW], [
          { external_reservation_id: "17990", code: "time_budget" },
          { external_reservation_id: "17991", code: "time_budget" },
        ]),
        stopped_reason: "time_budget",
        elapsed_ms: 110_400,
      }),
    });
    assert.deepEqual(
      calls.map((c) => c.fn),
      [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY],
    );
    const apply = calls[1]!.args;
    assert.equal(apply.p_status, "partial");
    assert.equal(apply.p_stopped_reason, "time_budget");
    assert.deepEqual(apply.p_failed_ids, ["17990", "17991"]);
    assert.equal((apply.p_rows as unknown[]).length, 1);
    assert.equal(out.snapshot.persisted, true);
    ok("time_budget nos detalhes → apply partial; ids não lidos preservados pela RPC");
  }
  {
    // Orçamento acabou ANTES de a listagem terminar: conjunto de ids
    // desconhecido → nunca apply (apagaria reservas válidas); só fail.
    const { rpc, calls } = fakeRpc({});
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-tb-2",
      read: async () => ({
        ...readResult([], []),
        stopped_reason: "time_budget",
        listing_complete: false,
        elapsed_ms: 110_100,
      }),
    });
    assert.deepEqual(
      calls.map((c) => c.fn),
      [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_FAIL],
    );
    assert.match(String(calls[1]!.args.p_error), /listagem incompleta/);
    assert.ok(out.result, "a Edge ainda responde 200 com o que leu");
    assert.equal(out.snapshot.persisted, false);
    if (!out.snapshot.persisted) assert.equal(out.snapshot.stage, "listing_incomplete");
    ok("time_budget na listagem → só fail; snapshot inteiro preservado, sem apply");
  }

  console.log("\n== Falha de leitura: fail, nunca apply ==");
  {
    const { rpc, calls } = fakeRpc({});
    const boom = new Error("Timeout HITS após 12000ms.");
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-3",
      read: async () => {
        throw boom;
      },
    });
    assert.deepEqual(
      calls.map((c) => c.fn),
      [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_FAIL],
    );
    assert.equal(calls[1]!.args.p_batch_id, "b-3");
    assert.equal(calls[1]!.args.p_error, "Timeout HITS após 12000ms.");
    assert.equal(out.result, null);
    assert.equal(out.readError, boom, "a Edge devolve 502 como antes");
    assert.deepEqual(out.snapshot, {
      persisted: false,
      batch_id: "b-3",
      stage: "read",
      error: "Timeout HITS após 12000ms.",
    });
    ok("leitura falhou → só hits_snapshot_sync_fail; apply jamais é chamado");
  }
  {
    const { rpc, calls } = fakeRpc({});
    await runHitsSnapshotSync({
      rpc,
      batchId: "b-4",
      read: async () => {
        throw new Error("x".repeat(1000));
      },
    });
    assert.equal(String(calls[1]!.args.p_error).length, 300, "mensagem cortada em 300");
    ok("mensagem de erro limitada (mesmo teto da RPC)");
  }

  console.log("\n== Falhas nas RPCs não derrubam a leitura ==");
  {
    const { rpc, calls } = fakeRpc({ startError: true });
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-5",
      read: async () => readResult([ROW]),
    });
    assert.deepEqual(
      calls.map((c) => c.fn),
      [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY],
    );
    assert.equal(out.snapshot.persisted, true);
    if (out.snapshot.persisted) assert.equal(out.snapshot.start_error, "start falhou");
    ok("start com erro: leitura e apply seguem; erro fica registrado no retorno");
  }
  {
    const { rpc } = fakeRpc({ throwOnStart: true });
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-6",
      read: async () => readResult([ROW]),
    });
    assert.equal(out.snapshot.persisted, true);
    ok("start lançando exceção também não interrompe o ciclo");
  }
  {
    const { rpc } = fakeRpc({ applyError: true });
    const out = await runHitsSnapshotSync({
      rpc,
      batchId: "b-7",
      read: async () => readResult([ROW]),
    });
    assert.ok(out.result, "a Edge ainda responde as linhas lidas");
    assert.deepEqual(out.snapshot, {
      persisted: false,
      batch_id: "b-7",
      stage: "apply",
      error: "apply falhou",
    });
    ok("apply com erro: resposta segue, snapshot marcado como não persistido");
  }

  console.log(`\nOK test-hits-snapshot-sync (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
