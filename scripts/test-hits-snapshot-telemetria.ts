/**
 * Telemetria inequívoca do ciclo do snapshot HITS.
 *
 * 1. Migration 20260927090000: colunas novas, comentário de compatibilidade em
 *    last_rows_count, CTE `changed` só com campos funcionais, sem RLS/policy/
 *    scheduler, RPCs só service_role.
 * 2. Modelo em memória da RPC (mesma regra: dedupe → changed contra o estado
 *    anterior → upsert → remoção) cruzado com o SQL versionado (lista de
 *    campos comparados é a mesma) — cenários 1–5 do pedido.
 * 3. Módulo TS: returned/detail/changed no resultado e nos argumentos das
 *    RPCs, completa e incremental; falhas continuam em failed_count.
 * Sem rede, sem banco.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HITS_SNAPSHOT_CAMPOS_FUNCIONAIS,
  HITS_SNAPSHOT_RPC_APPLY,
  HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL,
  HITS_SNAPSHOT_RPC_START,
  runHitsSnapshotSync,
  toSnapshotRows,
  type HitsSnapshotRow,
  type SnapshotRpc,
} from "../src/lib/integrations/hits/hits-snapshot-sync.ts";
import type { HitsSandboxReservationRow } from "../src/lib/integrations/hits/hits-gateway-read.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Modelo em memória da RPC de apply (completa e incremental) — a MESMA regra
// do SQL: dedupe por id (incremental ignora canceladas), `changed` = linha nova
// ou algum campo funcional diferente do armazenado ANTES do upsert, upsert de
// todas as linhas do lote (idênticas incluídas), remoção (completa: ausentes e
// não falhas; incremental: canceladas explícitas).
// ---------------------------------------------------------------------------
type Snap = Map<string, HitsSnapshotRow & { batch_id: string }>;
function applyModel(
  snap: Snap,
  modo: "full" | "incremental",
  batch: string,
  rows: HitsSnapshotRow[],
  failedIds: string[] = [],
  cancelledIds: string[] = [],
): { rows_upserted: number; rows_changed: number; rows_removed: number } {
  const dedup = new Map<string, HitsSnapshotRow>();
  for (const r of rows) {
    if (modo === "incremental" && r.status_reserva === "cancelada") continue;
    if (!dedup.has(r.external_reservation_id)) dedup.set(r.external_reservation_id, r);
  }
  let changed = 0;
  for (const [id, r] of dedup) {
    const s = snap.get(id);
    if (!s || HITS_SNAPSHOT_CAMPOS_FUNCIONAIS.some((k) => String(s[k]) !== String(r[k]))) changed += 1;
  }
  for (const [id, r] of dedup) snap.set(id, { ...r, batch_id: batch });
  let removed = 0;
  if (modo === "full") {
    for (const [id, s] of [...snap]) {
      if (s.batch_id !== batch && !failedIds.includes(id)) { snap.delete(id); removed += 1; }
    }
  } else {
    for (const id of cancelledIds) if (snap.delete(id)) removed += 1;
  }
  return { rows_upserted: dedup.size, rows_changed: changed, rows_removed: removed };
}

const row = (id: string, patch: Partial<HitsSnapshotRow> = {}): HitsSnapshotRow => ({
  external_reservation_id: id,
  apartamento: "0" + id.slice(-1),
  hospede_principal: "Hóspede " + id,
  check_in: "2026-09-26",
  check_out: "2026-09-28",
  status_reserva: "ativa",
  ciclo_hits: "confirmada",
  total_hospedes: 2,
  ...patch,
});
const sete = () => ["3401", "3402", "3403", "3404", "3405", "3406", "3407"].map((id) => row(id));

async function main() {
  console.log("\n== 1. Migration: telemetria explícita, sem tocar população/RLS/scheduler ==");
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith("_hits_snapshot_telemetria.sql"));
  assert.equal(files.length, 1, "exatamente uma migration de telemetria");
  const sql = read("supabase/migrations/" + files[0]!);
  const sqlCode = sql.replace(/^\s*--.*$/gm, "");
  {
    assert.ok(files[0]! > "20260926090000_", "timestamp posterior às existentes");
    for (const col of ["last_returned_count", "last_detail_count", "last_upserted_count", "last_changed_count", "last_removed_count"]) {
      assert.match(sqlCode, new RegExp(`add column if not exists ${col} integer`), col);
      assert.match(sql, new RegExp(`comment on column public\\.hits_snapshot_sync_state\\.${col} is`), col + ": comentário");
    }
    assert.match(sql, /comment on column public\.hits_snapshot_sync_state\.last_rows_count is\s*'COMPATIBILIDADE: linhas processadas\/submetidas/);
    assert.match(sql.slice(sql.indexOf("last_rows_count is"), sql.indexOf("last_success_rows_count is")), /NÃO é "reservas alteradas" — ver last_changed_count/, "last_rows_count carrega a ressalva explícita");
    assert.doesNotMatch(sqlCode, /drop column|alter column|rename/i, "só adiciona colunas");
    ok("5 colunas novas (integer, nullable → dados existentes preservados) + comentários; last_rows_count marcado como compatibilidade");
  }
  {
    assert.doesNotMatch(sqlCode, /policy|row level security|enable rls|cron\.|pg_cron|schedule/i, "sem RLS/policy/scheduler");
    assert.doesNotMatch(sqlCode, /operacional_reservas|operacional_hospedes|\bfnrh_|cafe|\bui_/i, "não toca tabelas fora do snapshot");
    assert.doesNotMatch(sqlCode, /truncate|alter table public\.hits_reservas_snapshot/i, "população/tabela do snapshot intocadas");
    for (const fn of [
      "hits_snapshot_sync_apply(uuid, jsonb, text[], text, text, integer, integer)",
      "hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz, integer, integer)",
    ]) {
      assert.ok(sql.includes(`revoke all on function public.${fn}\n  from public, anon, authenticated;`), fn + ": revoke");
      assert.ok(sql.includes(`grant execute on function public.${fn}\n  to service_role;`), fn + ": grant só service_role");
    }
    assert.match(sqlCode, /drop function if exists public\.hits_snapshot_sync_apply\(uuid, jsonb, text\[\], text, text\);/, "assinatura antiga derrubada (sem sobrecarga ambígua)");
    assert.match(sqlCode, /drop function if exists public\.hits_snapshot_sync_apply_incremental\(uuid, jsonb, text\[\], text\[\], text, text, timestamptz\);/);
    assert.equal((sqlCode.match(/create or replace function/g) ?? []).length, 2, "só as 2 RPCs de apply");
    for (const head of ["hits_snapshot_sync_apply(", "hits_snapshot_sync_apply_incremental("]) {
      const i = sqlCode.indexOf("create or replace function public." + head);
      const cab = sqlCode.slice(i, sqlCode.indexOf("as $$", i));
      assert.match(cab, /security definer/); assert.match(cab, /set search_path = ''/);
      assert.match(cab, /returns table \(rows_upserted integer, rows_removed integer, rows_changed integer\)/);
    }
    ok("RPCs: security definer, search_path vazio, EXECUTE só service_role, retorno com rows_changed; sem RLS/scheduler/população");
  }
  {
    // CTE changed: só campos funcionais, avaliada contra o estado anterior; técnicos fora.
    const corpos = [...sqlCode.matchAll(/changed as \(([\s\S]*?)\n  \),/g)].map((m) => m[1]!);
    assert.equal(corpos.length, 2, "CTE changed nas duas RPCs");
    for (const c of corpos) {
      assert.match(c, /left join public\.hits_reservas_snapshot s on s\.external_reservation_id = d\.external_reservation_id/);
      assert.match(c, /where s\.external_reservation_id is null/, "linha nova conta como alteração");
      const comparados = [...c.matchAll(/or s\.([a-z_]+) is distinct from d\.\1/g)].map((m) => m[1]);
      assert.deepEqual(comparados, [...HITS_SNAPSHOT_CAMPOS_FUNCIONAIS], "SQL compara exatamente os campos funcionais do módulo TS");
      for (const tec of ["batch_id", "last_seen_at", "updated_at", "first_seen_at", "source"]) {
        assert.equal(c.includes(tec), false, "campo técnico não conta como alteração: " + tec);
      }
    }
    // A CTE precede o insert no MESMO statement (vê o estado anterior) e alimenta v_changed.
    for (const head of ["hits_snapshot_sync_apply(", "hits_snapshot_sync_apply_incremental("]) {
      const i = sqlCode.indexOf("create or replace function public." + head);
      const corpo = sqlCode.slice(i, sqlCode.indexOf("$$;", i));
      assert.ok(corpo.indexOf("changed as (") < corpo.indexOf("ins as ("), head + ": changed antes do upsert");
      assert.match(corpo, /select \(select count\(\*\) from ins\), \(select count\(\*\) from changed\)\s*\n\s*into v_upserted, v_changed;/);
      assert.match(corpo, /last_rows_count = v_upserted,/, head + ": compatibilidade preservada");
      assert.match(corpo, /last_upserted_count = v_upserted,/);
      assert.match(corpo, /last_changed_count = v_changed,/);
      assert.match(corpo, /last_removed_count = v_removed,/);
      assert.match(corpo, /last_returned_count = p_returned_count,/);
      assert.match(corpo, /last_detail_count = p_detail_count,/);
      assert.match(corpo, /last_failed_count = coalesce\(array_length\(v_failed_ids, 1\), 0\),/, "failed inalterado");
    }
    const inc = sqlCode.slice(sqlCode.indexOf("hits_snapshot_sync_apply_incremental("));
    assert.match(inc, /where s\.external_reservation_id = any \(v_cancelled_ids\)/, "incremental remove só canceladas explícitas");
    assert.doesNotMatch(inc, /batch_id <> p_batch_id/, "incremental nunca remove por ausência");
    assert.match(inc, /when p_status = 'ok' and p_cursor_at is not null then p_cursor_at/, "cursor inalterado");
    const full = sqlCode.slice(sqlCode.indexOf("hits_snapshot_sync_apply("), sqlCode.indexOf("hits_snapshot_sync_apply_incremental("));
    assert.match(full, /where s\.batch_id <> p_batch_id\s*\n\s*and not \(s\.external_reservation_id = any \(v_failed_ids\)\)/, "completa remove ausentes não falhas (como antes)");
    ok("changed = nova OU campo funcional diferente (7 campos = HITS_SNAPSHOT_CAMPOS_FUNCIONAIS), avaliado antes do upsert; remoção/cursor/failed como antes");
  }

  console.log("\n== 2. Semântica dos contadores (modelo = regra do SQL) ==");
  {
    // 1. ciclo devolve 7 linhas idênticas já existentes → processadas 7, changed 0
    const snap: Snap = new Map();
    const c0 = applyModel(snap, "incremental", "b0", sete());
    assert.deepEqual(c0, { rows_upserted: 7, rows_changed: 7, rows_removed: 0 }, "primeira vez: 7 novas = 7 alteradas");
    const c1 = applyModel(snap, "incremental", "b1", sete());
    assert.deepEqual(c1, { rows_upserted: 7, rows_changed: 0, rows_removed: 0 });
    ok("1. 7 linhas idênticas reprocessadas → upserted/processadas = 7, changed = 0 (o '7' do painel não é '7 alteradas')");

    // 2. 7 voltam, 1 mudou de apartamento → changed 1
    const r2 = sete(); r2[2] = row("3403", { apartamento: "15" });
    assert.deepEqual(applyModel(snap, "incremental", "b2", r2), { rows_upserted: 7, rows_changed: 1, rows_removed: 0 });
    ok("2. 7 linhas, 1 com apartamento diferente → changed = 1");

    // mudanças em cada campo funcional contam; técnicos não existem no lote
    for (const [k, v] of [["hospede_principal", "Outro Nome"], ["check_in", "2026-09-27"], ["check_out", "2026-09-29"], ["ciclo_hits", "hospedada"], ["total_hospedes", 3]] as const) {
      const r = sete().map((x) => (x.external_reservation_id === "3403" ? { ...x, apartamento: "15" } : x));
      const alvo = r.find((x) => x.external_reservation_id === "3405")!;
      (alvo as Record<string, unknown>)[k] = v;
      const before = new Map(snap);
      const c = applyModel(before, "incremental", "bx", r);
      assert.equal(c.rows_changed, 1, "campo funcional muda → 1: " + k);
    }
    ok("datas, hóspede principal, ciclo e total de hóspedes contam como alteração real");

    // 3. reserva nova → changed += 1
    const r3 = [...sete().map((x) => (x.external_reservation_id === "3403" ? { ...x, apartamento: "15" } : x)), row("3408")];
    assert.deepEqual(applyModel(snap, "incremental", "b3", r3), { rows_upserted: 8, rows_changed: 1, rows_removed: 0 });
    ok("3. reserva nova → changed += 1 (as 7 iguais não contam)");

    // 4. cancelamento: incremental remove só explícitas; completa remove ausentes
    assert.deepEqual(applyModel(snap, "incremental", "b4", [], [], ["3408"]), { rows_upserted: 0, rows_changed: 0, rows_removed: 1 });
    assert.equal(snap.has("3408"), false);
    const rowsCancelada = [row("3401", { status_reserva: "cancelada" })];
    assert.deepEqual(applyModel(snap, "incremental", "b4b", rowsCancelada, [], ["3401"]), { rows_upserted: 0, rows_changed: 0, rows_removed: 1 }, "cancelada nunca vira linha na incremental");
    const snapFull: Snap = new Map(snap);
    const full = applyModel(snapFull, "full", "bf", sete().slice(0, 4).map((x) => (x.external_reservation_id === "3403" ? { ...x, apartamento: "15" } : x)), ["3405"]);
    assert.deepEqual(full, { rows_upserted: 4, rows_changed: 1, rows_removed: 2 }, "completa: 3406 e 3407 ausentes removidas; 3405 falha preservada; 3401 volta como nova (changed 1); 3403 já na versão nova não muda");
    assert.equal(snapFull.has("3405"), true, "falha preservada na completa");
    assert.equal(snapFull.has("3406") || snapFull.has("3407"), false);
    ok("4. removed_count: incremental = canceladas explícitas; completa = ausentes não falhas");

    // 5. duplicidade na listagem não infla
    const dup = [...sete(), ...sete().slice(0, 3)];
    const snapD: Snap = new Map();
    applyModel(snapD, "incremental", "d0", sete());
    assert.deepEqual(applyModel(snapD, "incremental", "d1", dup), { rows_upserted: 7, rows_changed: 0, rows_removed: 0 });
    assert.equal(toSnapshotRows(dup as unknown as HitsSandboxReservationRow[]).length, 10, "o mapeamento não deduplica; a RPC (dedup) sim");
    ok("5. 10 linhas com 3 repetidas → upserted 7, changed 0");
  }

  console.log("\n== 3. Módulo TS: contadores no resultado e nos argumentos das RPCs ==");
  {
    const rowsLidas = (ids: string[]): HitsSandboxReservationRow[] =>
      ids.map((id) => ({ external_reservation_id: id, apartamento: "01", hospede_principal: "H", check_in: "2026-09-26", check_out: "2026-09-28", status_reserva: "ativa", ciclo_hits: "confirmada", total_hospedes: 1 }) as unknown as HitsSandboxReservationRow);
    const base = { page: 1, size: 50, pages_fetched: 1, stopped_reason: "last_page" as const, listing_complete: true, elapsed_ms: 5 };
    function fakeRpc(changed: number) {
      const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const rpc: SnapshotRpc = async (fn, args) => {
        calls.push({ fn, args });
        if (fn === HITS_SNAPSHOT_RPC_APPLY || fn === HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL) {
          const rows = (args.p_rows as unknown[]).length;
          const removed = ((args.p_cancelled_ids as string[] | undefined) ?? []).length;
          return { data: [{ rows_upserted: rows, rows_changed: changed, rows_removed: removed }], error: null };
        }
        return { data: null, error: null };
      };
      return { rpc, calls };
    }

    // Completa: 7 lidas + 2 falhas → returned 9, detail 7, upserted 7, changed 0 (idênticas), failed 2.
    {
      const { rpc, calls } = fakeRpc(0);
      const out = await runHitsSnapshotSync({
        rpc, batchId: "b-t1",
        read: async () => ({ ...base, rows: rowsLidas(["1", "2", "3", "4", "5", "6", "7"]), failed: [{ external_reservation_id: "8", code: "timeout" }, { external_reservation_id: "9", code: "time_budget" }] }),
      });
      assert.deepEqual(calls.map((c) => c.fn), [HITS_SNAPSHOT_RPC_START, HITS_SNAPSHOT_RPC_APPLY], "fluxo completo inalterado");
      const a = calls[1]!.args;
      assert.equal(a.p_returned_count, 9); assert.equal(a.p_detail_count, 7);
      assert.deepEqual(a.p_failed_ids, ["8", "9"]); assert.equal(a.p_status, "partial");
      assert.equal(out.snapshot.persisted, true);
      if (out.snapshot.persisted) {
        assert.equal(out.snapshot.returned_count, 9); assert.equal(out.snapshot.detail_count, 7);
        assert.equal(out.snapshot.rows_upserted, 7); assert.equal(out.snapshot.rows_changed, 0);
        assert.equal(out.snapshot.failed_count, 2, "6. falha de detalhe: failed_count continua correto"); assert.equal(out.snapshot.rows_removed, 0);
      }
      ok("6/7. completa: returned 9 = detail 7 + failed 2; upserted 7 ≠ changed 0; failed preservado");
    }
    // Incremental: 3 lidas + 1 cancelada + 1 falha → returned 5, detail 4, removed 1, changed vindo da RPC.
    {
      const { rpc, calls } = fakeRpc(1);
      const out = await runHitsSnapshotSync({
        rpc, batchId: "b-t2", nowMs: () => Date.parse("2026-09-25T15:00:00Z"),
        read: async () => ({ ...base, rows: [], failed: [] }),
        readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
        readIncremental: async (window) => ({ ...base, rows: rowsLidas(["3401", "3402", "3403"]), failed: [{ external_reservation_id: "3409", code: "timeout" }], cancelled_ids: ["3302"], window }),
      });
      const a = calls[1]!.args;
      assert.equal(calls[1]!.fn, HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL);
      assert.equal(a.p_returned_count, 5); assert.equal(a.p_detail_count, 4);
      assert.deepEqual(a.p_cancelled_ids, ["3302"]); assert.deepEqual(a.p_failed_ids, ["3409"]);
      assert.equal(a.p_cursor_at, null, "partial: cursor não avança (inalterado)");
      assert.equal(out.snapshot.persisted, true);
      if (out.snapshot.persisted) {
        assert.equal(out.snapshot.mode, "incremental");
        assert.equal(out.snapshot.returned_count, 5); assert.equal(out.snapshot.detail_count, 4);
        assert.equal(out.snapshot.rows_upserted, 3); assert.equal(out.snapshot.rows_changed, 1);
        assert.equal(out.snapshot.rows_removed, 1); assert.equal(out.snapshot.cancelled_count, 1); assert.equal(out.snapshot.failed_count, 1);
      }
      ok("8. incremental: returned 5 = 3 linhas + 1 cancelada + 1 falha; changed vem da RPC; cursor/remoção como antes");
    }
    // Sem contagens de PII: só números nos argumentos novos.
    {
      const { rpc, calls } = fakeRpc(0);
      await runHitsSnapshotSync({ rpc, batchId: "b-t3", read: async () => ({ ...base, rows: rowsLidas(["1"]), failed: [] }) });
      const novos = Object.keys(calls[1]!.args).filter((k) => !["p_batch_id", "p_rows", "p_failed_ids", "p_status", "p_stopped_reason"].includes(k));
      assert.deepEqual(novos.sort(), ["p_detail_count", "p_returned_count"], "só 2 argumentos novos, numéricos");
      for (const k of novos) assert.equal(typeof calls[1]!.args[k], "number");
      ok("argumentos novos são só contagens (sem ids/PII)");
    }
  }

  console.log("\n== 3b. Cancelada explícita = GET de detalhe concluído ==");
  {
    // Fluxo do leitor (hits-gateway-read): a listagem Type=2/Status=2 só dá o
    // id; o status 2 é confirmado NO DETALHE (GET /v1/reservations/:id) e só
    // então o id vai para cancelled_ids. Logo detail_count = rows + cancelled é
    // literalmente "GETs de detalhe concluídos com sucesso".
    const reader = read("src/lib/integrations/hits/hits-gateway-read.ts").replace(/^\s*\/\/.*$/gm, "");
    const iGet = reader.indexOf("url: `${config.baseUrl}/v1/reservations/${encodeURIComponent(id)}`");
    const iDivert = reader.indexOf("if (divertCancelled && row.status_reserva === \"cancelada\") {");
    assert.ok(iGet > -1 && iDivert > iGet, "cancelada é desviada DEPOIS do GET de detalhe, no mesmo try");
    assert.match(reader.slice(iDivert, iDivert + 200), /cancelledIds\.push\(row\.external_reservation_id\);\s*continue;/);
    const listagem = reader.slice(reader.indexOf("for (const summary of items) {"), reader.indexOf("if (hitCap) {"));
    assert.doesNotMatch(listagem, /cancelledIds|cancelada/, "a listagem NÃO decide cancelamento: todo id listado vai para o GET de detalhe");
    ok("Status=2 na listagem não é tratado sem detalhe: o cancelamento é confirmado no GET de detalhe → cancelada conta em detail_count (e em removed), falha não");

    // Dinâmico, com o leitor real e transporte falso: 1 ativa + 1 cancelada + 1 detalhe falho
    // → 3 GETs de detalhe tentados, 2 concluídos: detail 2, returned 3, removed 1, upserted 1.
    const { fetchHitsUpdatedReservations } = await import("../src/lib/integrations/hits/hits-gateway-read.ts");
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      const u = new URL(url); calls.push(u.pathname + (u.pathname === "/v1/reservations" ? "?Status=" + u.searchParams.get("Status") : ""));
      if (u.pathname === "/v1/reservations") {
        const st = Number(u.searchParams.get("Status"));
        const page = Number(u.searchParams.get("Page") ?? "1");
        const items = page === 1 ? (st === 1 ? [{ idReservation: 3407, checkOut: "2026-09-27" }, { idReservation: 3409, checkOut: "2026-09-27" }] : st === 2 ? [{ idReservation: 3302, checkOut: "2026-09-27" }] : []) : [];
        return new Response(JSON.stringify({ data: items }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const id = u.pathname.split("/").pop();
      if (id === "3409") return new Response("{}", { status: 500 });
      const detail = { idReservation: Number(id), status: id === "3302" ? 2 : 1, contactName: "x", rooms: [{ code: "01", checkIn: "2026-09-26", checkOut: "2026-09-27", pax: 1, status: id === "3302" ? 2 : 1 }], guests: [] };
      return new Response(JSON.stringify(detail), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    let t = 0;
    const res = await fetchHitsUpdatedReservations({
      config: { baseUrl: "https://gw.test", token: "t".repeat(32), requestTimeoutMs: 5_000, enabled: true, prodReadEnabled: false },
      fetchImpl: fetchImpl as never,
      sleepImpl: async (ms: number) => { t += ms; },
      nowMs: () => t,
      updatedFrom: "2026-09-25",
      updatedTo: "2026-09-26",
      todayYmd: "2026-09-25",
    });
    // (o transporte repete o GET falho por retry; conta-se por id)
    const gets = [...new Set(calls.filter((c) => c.startsWith("/v1/reservations/")))];
    assert.deepEqual(gets.sort(), ["/v1/reservations/3302", "/v1/reservations/3407", "/v1/reservations/3409"], "3 ids com GET de detalhe tentado (a cancelada inclusive)");
    assert.deepEqual(res.rows.map((r) => r.external_reservation_id), ["3407"]);
    assert.deepEqual(res.cancelled_ids, ["3302"]);
    assert.deepEqual(res.failed.map((f) => f.external_reservation_id), ["3409"]);
    const { rpc, calls: rpcCalls } = (() => {
      const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const rpc: SnapshotRpc = async (fn, args) => { c.push({ fn, args }); return fn === HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL ? { data: [{ rows_upserted: 1, rows_changed: 1, rows_removed: 1 }], error: null } : { data: null, error: null }; };
      return { rpc, calls: c };
    })();
    const out = await runHitsSnapshotSync({
      rpc, batchId: "b-3b", nowMs: () => Date.parse("2026-09-25T15:00:00Z"),
      read: async () => { throw new Error("não deve ler completa"); },
      readState: async () => ({ last_cursor_at: "2026-09-25T14:50:00Z" }),
      readIncremental: async () => res,
    });
    const a = rpcCalls[1]!.args;
    assert.equal(a.p_detail_count, 2, "detail = 2 GETs concluídos (ativa + cancelada); a falha não conta");
    assert.equal(a.p_returned_count, 3, "returned = 3 ids listados");
    assert.equal(out.snapshot.persisted && out.snapshot.rows_removed, 1);
    assert.equal(out.snapshot.persisted && out.snapshot.rows_upserted, 1);
    assert.equal(out.snapshot.persisted && out.snapshot.failed_count, 1);
    ok("leitor real: 1 ativa + 1 cancelada + 1 falha → returned 3, detail 2, upserted 1, removed 1, failed 1");
  }

  console.log("\n== 4. Nada além da telemetria ==");
  {
    const mod = read("src/lib/integrations/hits/hits-snapshot-sync.ts");
    assert.doesNotMatch(mod, /fetch\(|supabase-js|createClient/, "módulo continua sem rede");
    const edge = read("supabase/functions/hits-reservations-preview/index.ts");
    assert.match(
      edge,
      /if \(autoMaterializarEnabled && run\.snapshot\.persisted\) \{\s*materializacao = await executarCicloContatoEMaterializacao\(\{[\s\S]*?rows: result\.rows,/,
      "9. materialização automática inalterada (mesmo gancho pós-snapshot, mesmas entradas)",
    );
    assert.doesNotMatch(edge, /rows_changed|returned_count|detail_count/, "Edge não precisa mudar: repassa `snapshot` como está");
    const ui = read("ui/yes-hits-sandbox-preview.js");
    assert.match(ui, /last_rows_count, last_failed_count, last_success_at/, "UI: contrato de leitura preservado");
    const docs = read("docs/YES_HOTEL_HITS_SNAPSHOT_HOMO_V1.md");
    assert.match(docs, /`last_rows_count` \*\*não\*\* é "reservas alteradas"/);
    assert.match(docs, /\| `last_changed_count` \|/);
    ok("9. materialização, Edge, UI e scheduler intocados; docs registram a semântica");
  }

  console.log(`\nOK test-hits-snapshot-telemetria (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
