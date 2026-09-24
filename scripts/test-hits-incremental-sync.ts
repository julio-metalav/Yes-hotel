/**
 * Testes: sincronização incremental do snapshot HITS (Type=2, cursor).
 * Sem rede, sem banco, sem timers reais: fetch falso + RPC falsa + relógio falso.
 *
 * Cobre: modo (completa × incremental), janela, zero alterações → zero detalhes,
 * uma alteração → 1 detalhe + 1 upsert, idempotência por sobreposição,
 * falha de detalhe → preservação e cursor parado, canceladas (Status=2) fora
 * do snapshot, cadência/orçamento preservados, e o "prova" de Status=2 na
 * listagem Type=2.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HITS_INCREMENTAL_STATUSES,
  HITS_LIST_TYPE_UPDATE_DATE,
  fetchHitsUpdatedReservations,
  type HitsGatewayReadConfig,
} from "../src/lib/integrations/hits/hits-gateway-read";
import {
  HITS_HOTEL_UTC_OFFSET_MINUTES,
  HITS_INCREMENTAL_CURSOR_MARGIN_MINUTES,
  hotelLocalYmd,
  HITS_SNAPSHOT_RPC_APPLY,
  HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL,
  HITS_SNAPSHOT_RPC_FAIL,
  HITS_SNAPSHOT_RPC_SET_CURSOR,
  HITS_SNAPSHOT_RPC_START,
  decideSyncMode,
  incrementalWindow,
  runHitsSnapshotSync,
  type SnapshotRpc,
} from "../src/lib/integrations/hits/hits-snapshot-sync";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const BASE = "https://hits-homo.example";
function config(): HitsGatewayReadConfig {
  return { baseUrl: BASE, token: "t".repeat(32), requestTimeoutMs: 5_000, enabled: true, prodReadEnabled: false };
}

type Call = { path: string; type: string | null; status: string | null; from: string | null; to: string | null };

/**
 * HITS falso por trás do gateway: `updated` = ids que mudaram na janela, com o
 * status HITS de cada um (1 confirmada, 2 cancelada, 3 hospedada). A listagem
 * Type=2/Status=S devolve os ids cujo status é S. O detalhe devolve status.
 */
function harness(opts: {
  updated: Array<{ id: number; status: 1 | 2 | 3; checkOut?: string }>;
  failDetail?: number[];
}) {
  let t = 0;
  const calls: Call[] = [];
  const nowMs = () => t;
  const sleepImpl = async (ms: number) => {
    t += ms;
  };
  const fetchImpl = async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    calls.push({
      path,
      type: u.searchParams.get("Type"),
      status: u.searchParams.get("Status"),
      from: u.searchParams.get("InitialDate"),
      to: u.searchParams.get("FinalDate"),
    });
    const m = /^\/v1\/reservations\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      if (opts.failDetail?.includes(id)) {
        return new Response(JSON.stringify({ code: "hits_server_error" }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
      const item = opts.updated.find((x) => x.id === id);
      return new Response(
        JSON.stringify({
          idReservation: id,
          status: item ? String(item.status) : "1",
          contactName: "Sintetico " + id,
          rooms: [{ checkIn: "2026-09-25", checkOut: item?.checkOut ?? "2026-09-27", code: "APT 0" + (id % 9), pax: 1 }],
          guests: [{ idEntity: 1, name: "Sintetico " + id, main: true }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const status = Number(u.searchParams.get("Status"));
    const page = Number(u.searchParams.get("Page") ?? "1");
    const slice = page === 1 ? opts.updated.filter((x) => x.status === status) : [];
    return new Response(
      JSON.stringify({ data: slice.map((x) => ({ idReservation: x.id, checkOut: x.checkOut ?? "2026-09-27", status: x.status })) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { nowMs, sleepImpl, fetchImpl, calls, now: () => t };
}

function fakeRpc(plan: { applyError?: boolean } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: SnapshotRpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === HITS_SNAPSHOT_RPC_APPLY || fn === HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL) {
      if (plan.applyError) return { data: null, error: { message: "apply falhou" } };
      const rows = (args.p_rows as unknown[]).length;
      const removed = ((args.p_cancelled_ids as string[] | undefined) ?? []).length;
      return { data: [{ rows_upserted: rows, rows_removed: fn === HITS_SNAPSHOT_RPC_APPLY ? 0 : removed }], error: null };
    }
    return { data: null, error: null };
  };
  return { rpc, calls };
}

const NOW = Date.parse("2026-09-25T15:00:00Z");

async function main() {
  console.log("\n== Modo e janela ==");
  {
    assert.equal(decideSyncMode({ cursorAt: null }), "full");
    assert.equal(decideSyncMode({ cursorAt: "" }), "full");
    assert.equal(decideSyncMode({ cursorAt: "lixo" }), "full");
    assert.equal(decideSyncMode({ cursorAt: "2026-09-25T14:50:00Z" }), "incremental");
    assert.equal(decideSyncMode({ cursorAt: "2026-09-01T14:00:00Z" }), "incremental", "cursor antigo continua incremental — sem completa automática");
    assert.equal(decideSyncMode({ cursorAt: "2025-01-01T00:00:00Z" }), "incremental");
    ok("sem cursor / cursor inválido → carga completa inicial; com cursor (mesmo antigo) → incremental, nunca completa automática");
  }
  {
    // Fuso do hotel: UTC−4 fixo (mesma premissa do scheduler). Cursor 14:50Z = 10:50 local.
    assert.equal(HITS_HOTEL_UTC_OFFSET_MINUTES, -240);
    assert.equal(HITS_INCREMENTAL_CURSOR_MARGIN_MINUTES, 60);
    assert.equal(hotelLocalYmd(Date.parse("2026-09-25T03:59:00Z")), "2026-09-24", "23:59 local ainda é dia 24");
    assert.equal(hotelLocalYmd(Date.parse("2026-09-25T04:00:00Z")), "2026-09-25", "00:00 local vira dia 25");

    // Meio do dia: InitialDate = dia local do cursor; FinalDate = dia local de agora + 1.
    const w = incrementalWindow({ cursorAt: "2026-09-25T14:50:00Z", nowMs: NOW });
    assert.deepEqual(w, { from: "2026-09-25", to: "2026-09-26" });
    // Primeira hora após a meia-noite local (00:30 local = 04:30Z): a margem de
    // 60 min leva o InitialDate ao dia anterior — cobre a virada + fuso do HITS.
    const w2 = incrementalWindow({ cursorAt: "2026-09-25T04:30:00Z", nowMs: Date.parse("2026-09-25T04:40:00Z") });
    assert.deepEqual(w2, { from: "2026-09-24", to: "2026-09-26" });
    // 01:30 local (05:30Z): margem já não cruza a meia-noite → só o dia atual.
    const w3 = incrementalWindow({ cursorAt: "2026-09-25T05:30:00Z", nowMs: Date.parse("2026-09-25T05:40:00Z") });
    assert.equal(w3.from, "2026-09-25");
    // Noite (23:30 local = 03:30Z do dia 26 em UTC): dias locais, não UTC.
    const w4 = incrementalWindow({ cursorAt: "2026-09-26T03:30:00Z", nowMs: Date.parse("2026-09-26T03:40:00Z") });
    assert.deepEqual(w4, { from: "2026-09-25", to: "2026-09-26" });
    ok("janela = dia local de (cursor − 60 min) .. dia local de agora + 1 (YYYY-MM-DD, UTC−4; o gateway só aceita dia)");
  }
  {
    assert.deepEqual([...HITS_INCREMENTAL_STATUSES], [1, 2, 3]);
    assert.equal(HITS_LIST_TYPE_UPDATE_DATE, 2);
    ok("incremental lista Type=2 nos status 1, 2 e 3 (Blocked fora)");
  }

  console.log("\n== Leitura incremental (fetchHitsUpdatedReservations) ==");
  {
    // Nenhuma alteração: 3 listagens (status 1/2/3), zero detalhes.
    const h = harness({ updated: [] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    const listings = h.calls.filter((c) => c.path === "/v1/reservations");
    const details = h.calls.filter((c) => c.path !== "/v1/reservations");
    assert.equal(listings.length, 3);
    assert.equal(details.length, 0);
    assert.deepEqual(listings.map((c) => c.type), ["2", "2", "2"]);
    assert.deepEqual(listings.map((c) => c.status), ["1", "2", "3"]);
    assert.ok(listings.every((c) => c.from === "2026-09-24" && c.to === "2026-09-26"));
    assert.equal(r.rows.length, 0);
    assert.equal(r.cancelled_ids.length, 0);
    assert.equal(r.listing_complete, true);
    assert.equal(r.stopped_reason, "empty_page", "última listagem (Status=3) veio vazia");
    assert.equal(r.elapsed_ms, 2 * 1_100, "cadência entre as 3 listagens");
    ok("nenhuma alteração: 3 listagens Type=2 (janela repassada), 0 detalhes");
  }
  {
    // Uma reserva alterada (confirmada): 1 detalhe, 1 linha.
    const h = harness({ updated: [{ id: 3407, status: 1 }] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    const details = h.calls.filter((c) => c.path.startsWith("/v1/reservations/"));
    assert.deepEqual(details.map((c) => c.path), ["/v1/reservations/3407"]);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.external_reservation_id, "3407");
    assert.equal(r.rows[0]!.ciclo_hits, "confirmada");
    ok("uma alteração: exatamente 1 detalhe e 1 linha");
  }
  {
    // Mesma reserva aparece em Status 1 e Status 3 (overlap/transição): 1 detalhe, hospedada prevalece.
    const h = harness({ updated: [{ id: 3316, status: 1 }, { id: 3316, status: 3 }] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    assert.equal(h.calls.filter((c) => c.path.startsWith("/v1/reservations/")).length, 1);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.ciclo_hits, "hospedada");
    ok("id repetido entre status → dedupe: 1 detalhe, Status=3 prevalece");
  }
  {
    // Status=2 no Type=2: cancelada detectada → cancelled_ids, nunca em rows.
    const h = harness({ updated: [{ id: 3302, status: 2 }, { id: 3407, status: 1 }] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    assert.ok(h.calls.some((c) => c.path === "/v1/reservations" && c.status === "2"), "Status=2 é consultado");
    assert.deepEqual(r.cancelled_ids, ["3302"]);
    assert.deepEqual(r.rows.map((x) => x.external_reservation_id), ["3407"]);
    ok("Status=2 consultável no Type=2; cancelada vai para cancelled_ids, não para rows");
  }
  {
    // Check-out já passado não custa detalhe (mesma regra da completa).
    const h = harness({ updated: [{ id: 1, status: 1, checkOut: "2026-09-20" }] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    assert.equal(h.calls.filter((c) => c.path.startsWith("/v1/reservations/")).length, 0);
    assert.equal(r.rows.length, 0);
    ok("alteração em reserva já encerrada (check-out < hoje) não custa detalhe");
  }
  {
    // Falha de detalhe → failed (preservada), o resto segue.
    const h = harness({ updated: [{ id: 1, status: 1 }, { id: 2, status: 1 }], failDetail: [1] });
    const r = await fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: "2026-09-24", updatedTo: "2026-09-26", todayYmd: "2026-09-25" });
    assert.deepEqual(r.failed, [{ external_reservation_id: "1", code: "server_error" }]);
    assert.deepEqual(r.rows.map((x) => x.external_reservation_id), ["2"]);
    ok("detalhe falho entra em failed; os demais são lidos");
  }

  console.log("\n== Ciclo com cursor (runHitsSnapshotSync) ==");
  const readFull = async () => ({
    rows: [], page: 1, size: 20, pages_fetched: 2, stopped_reason: "last_page" as const, failed: [],
    listing_complete: true, elapsed_ms: 0,
  });
  const inc = (h: ReturnType<typeof harness>) => (window: { from: string; to: string }, todayYmd: string) =>
    fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: window.from, updatedTo: window.to, todayYmd });

  {
    // Sem cursor → completa; após ok, fixa o cursor com set_cursor.
    const { rpc, calls } = fakeRpc();
    let fullReads = 0;
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-full", nowMs: () => NOW,
      read: async () => { fullReads += 1; return readFull(); },
      readState: async () => ({ last_cursor_at: null }),
      readIncremental: inc(harness({ updated: [] })),
    });
    assert.equal(fullReads, 1);
    assert.deepEqual(calls.map((c) => c.fn), [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY, HITS_SNAPSHOT_RPC_SET_CURSOR]);
    assert.equal(calls[2]!.args.p_cursor_at, "2026-09-25T15:00:00.000Z");
    assert.deepEqual(Object.keys(calls[2]!.args).sort(), ["p_batch_id", "p_cursor_at"]);
    assert.equal(out.snapshot.persisted, true);
    assert.equal(out.snapshot.mode, "full");
    assert.equal(out.snapshot.cursor_advanced, true);
    ok("sem cursor: ciclo completo (apply antigo) e cursor fixado no início do ciclo");
  }
  {
    // Cursor recente, nada mudou: incremental, 0 detalhes, apply_incremental com 0 linhas, cursor avança.
    const h = harness({ updated: [] });
    const { rpc, calls } = fakeRpc();
    let fullReads = 0;
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-inc-0", nowMs: () => NOW,
      read: async () => { fullReads += 1; return readFull(); },
      readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
      readIncremental: inc(h),
    });
    assert.equal(fullReads, 0, "completa não roda");
    assert.equal(h.calls.filter((c) => c.path.startsWith("/v1/reservations/")).length, 0);
    assert.deepEqual(calls.map((c) => c.fn), [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL]);
    const a = calls[1]!.args;
    assert.equal((a.p_rows as unknown[]).length, 0);
    assert.deepEqual(a.p_cancelled_ids, []);
    assert.equal(a.p_status, "ok");
    assert.equal(a.p_cursor_at, "2026-09-25T15:00:00.000Z");
    assert.equal(out.snapshot.mode, "incremental");
    assert.deepEqual(out.snapshot.window, { from: "2026-09-25", to: "2026-09-26" });
    assert.equal(out.snapshot.cursor_advanced, true);
    ok("nenhuma alteração: só listagem incremental, 0 detalhes, cursor avança");
  }
  {
    // Uma alteração + uma cancelada: 2 detalhes, 1 upsert, 1 remoção explícita.
    const h = harness({ updated: [{ id: 3407, status: 1 }, { id: 3302, status: 2 }] });
    const { rpc, calls } = fakeRpc();
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-inc-1", nowMs: () => NOW, read: readFull,
      readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
      readIncremental: inc(h),
    });
    const a = calls[1]!.args;
    assert.equal((a.p_rows as Array<{ external_reservation_id: string }>).map((r) => r.external_reservation_id).join(","), "3407");
    assert.deepEqual(a.p_cancelled_ids, ["3302"]);
    assert.equal(out.snapshot.persisted, true);
    if (out.snapshot.persisted) {
      assert.equal(out.snapshot.rows_upserted, 1);
      assert.equal(out.snapshot.rows_removed, 1);
      assert.equal(out.snapshot.cancelled_count, 1);
    }
    ok("uma alterada + uma cancelada: 1 upsert, 1 remoção explícita (status 2), nada por ausência");
  }
  {
    // Sobreposição: o mesmo evento lido em dois ciclos → mesmo upsert (idempotente).
    const h1 = harness({ updated: [{ id: 3407, status: 1 }] });
    const h2 = harness({ updated: [{ id: 3407, status: 1 }] });
    const { rpc, calls } = fakeRpc();
    await runHitsSnapshotSync({ rpc, batchId: "b-a", nowMs: () => NOW, read: readFull, readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }), readIncremental: inc(h1) });
    await runHitsSnapshotSync({ rpc, batchId: "b-b", nowMs: () => NOW + 600_000, read: readFull, readState: async () => ({ last_cursor_at: "2026-09-25T15:00:00Z" }), readIncremental: inc(h2) });
    const applies = calls.filter((c) => c.fn === HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL);
    assert.equal(applies.length, 2);
    const r1 = applies[0]!.args.p_rows as Array<Record<string, unknown>>;
    const r2 = applies[1]!.args.p_rows as Array<Record<string, unknown>>;
    assert.deepEqual(r1, r2, "mesmo conteúdo → upsert idempotente (PK external_reservation_id)");
    assert.equal(applies[1]!.args.p_cursor_at, "2026-09-25T15:10:00.000Z");
    ok("evento repetido por overlap: dois upserts idênticos, sem duplicar, cursor segue");
  }
  {
    // Falha de detalhe: partial, id em failed_ids (preservado), cursor NÃO avança.
    const h = harness({ updated: [{ id: 1, status: 1 }, { id: 2, status: 1 }], failDetail: [2] });
    const { rpc, calls } = fakeRpc();
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-partial", nowMs: () => NOW, read: readFull,
      readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
      readIncremental: inc(h),
    });
    const a = calls[1]!.args;
    assert.equal(a.p_status, "partial");
    assert.deepEqual(a.p_failed_ids, ["2"]);
    assert.equal(a.p_cursor_at, null, "cursor não avança em partial: a próxima janela recobre o id 2");
    assert.equal(out.snapshot.cursor_advanced, false);
    assert.equal((a.p_rows as unknown[]).length, 1);
    ok("falha de detalhe: snapshot anterior preservado (failed_ids) e cursor parado");
  }
  {
    // Orçamento acabou na listagem incremental → fail, sem apply, cursor parado.
    const h = harness({ updated: [] });
    const { rpc, calls } = fakeRpc();
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-tb", nowMs: () => NOW, read: readFull,
      readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
      readIncremental: (w, today) => fetchHitsUpdatedReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, updatedFrom: w.from, updatedTo: w.to, todayYmd: today, timeBudgetMs: 1_500 }),
    });
    assert.deepEqual(calls.map((c) => c.fn), [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_FAIL]);
    assert.equal(out.snapshot.persisted, false);
    if (!out.snapshot.persisted) assert.equal(out.snapshot.stage, "listing_incomplete");
    ok("listagem incremental incompleta (orçamento) → fail, nada aplicado, cursor parado");
  }
  {
    // Estado ilegível → completa (fail-safe).
    const { rpc, calls } = fakeRpc();
    let fullReads = 0;
    await runHitsSnapshotSync({
      rpc, batchId: "b-state-err", nowMs: () => NOW,
      read: async () => { fullReads += 1; return readFull(); },
      readState: async () => { throw new Error("state indisponível"); },
      readIncremental: inc(harness({ updated: [] })),
    });
    assert.equal(fullReads, 1);
    assert.equal(calls[1]!.fn, HITS_SNAPSHOT_RPC_APPLY);
    ok("estado do cursor ilegível → ciclo completo (fail-safe)");
  }
  {
    // Sem readState/readIncremental (env desligada): comportamento anterior, sem campos novos.
    const { rpc, calls } = fakeRpc();
    const out = await runHitsSnapshotSync({ rpc, batchId: "b-legacy", read: readFull });
    assert.deepEqual(calls.map((c) => c.fn), [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY]);
    assert.equal(out.snapshot.mode, undefined);
    ok("sem a trava incremental: ciclo completo idêntico ao anterior (sem set_cursor)");
  }

  console.log("\n== Contratos estáticos ==");
  {
    const edge = readFileSync(join(process.cwd(), "supabase/functions/hits-reservations-preview/index.ts"), "utf8");
    assert.match(edge, /HITS_SNAPSHOT_INCREMENTAL_ENABLED/);
    assert.match(edge, /fetchHitsUpdatedReservations\(/);
    assert.match(edge, /incrementalEnabled \? \{ readState: admin\.readState, readIncremental \} : \{\}/);
    assert.match(edge, /\.from\("hits_snapshot_sync_state"\)\s*\.select\("last_cursor_at"\)/);
    assert.doesNotMatch(edge, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/, "Edge escreve só por RPC");
    ok("Edge: incremental só com a env; cursor lido por select; escrita só via RPC");
  }
  {
    const files = require("node:fs").readdirSync(join(process.cwd(), "supabase/migrations")) as string[];
    const mig = files.filter((f) => f.endsWith("_hits_snapshot_incremental.sql"));
    assert.equal(mig.length, 1);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations", mig[0]!), "utf8");
    assert.match(sql, /add column if not exists last_cursor_at timestamptz/);
    assert.match(sql, /create or replace function public\.hits_snapshot_sync_apply_incremental\(/);
    assert.match(sql, /create or replace function public\.hits_snapshot_sync_set_cursor\(/);
    const inc = sql.slice(sql.indexOf("hits_snapshot_sync_apply_incremental("), sql.indexOf("comment on function public.hits_snapshot_sync_apply_incremental"));
    assert.match(inc, /where s\.external_reservation_id = any \(v_cancelled_ids\)/, "remove só canceladas explícitas");
    assert.doesNotMatch(inc, /batch_id <> p_batch_id/, "incremental NUNCA remove por ausência");
    assert.doesNotMatch(inc, /truncate/i);
    assert.match(inc, /when p_status = 'ok' and p_cursor_at is not null then p_cursor_at/, "cursor só em ok");
    assert.match(inc, /and status_reserva <> 'cancelada'/, "cancelada nunca vira linha");
    for (const fn of ["hits_snapshot_sync_set_cursor(uuid, timestamptz)", "hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz)"]) {
      assert.ok(sql.includes(`revoke all on function public.${fn}\n  from public, anon, authenticated;`), `${fn}: revoke`);
      assert.ok(sql.includes(`grant execute on function public.${fn}\n  to service_role;`), `${fn}: grant service_role`);
    }
    const sqlCode = sql.replace(/^\s*--.*$/gm, "");
    assert.doesNotMatch(sqlCode, /operacional_reservas|operacional_hospedes|\bfnrh_|\bui_/i, "não toca tabelas operacionais/FNRH/UI");
    assert.doesNotMatch(sqlCode, /drop function|alter function public\.hits_snapshot_sync_apply\(/, "RPC completa intocada");
    assert.doesNotMatch(sqlCode, /last_mode|full_scan/, "sem coluna/lógica além do cursor");
    assert.equal((sqlCode.match(/create or replace function/g) ?? []).length, 2, "exatamente 2 RPCs novas");
    assert.equal((sqlCode.match(/add column if not exists/g) ?? []).length, 1, "exatamente 1 coluna nova");
    const linhas = sql.split("\n").length;
    assert.ok(linhas <= 150, `migration deve ficar enxuta (${linhas} linhas; antes 221)`);
    ok(`migration mínima: 1 coluna (cursor) + 2 RPCs service_role, ${linhas} linhas; incremental remove só canceladas explícitas; RPC completa intocada`);
  }

  console.log(`\nOK test-hits-incremental-sync (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
