/**
 * Testes: cadência mínima entre inícios de requisição ao gateway e orçamento
 * de tempo do ciclo de leitura HITS. Sem rede, sem timers reais: relógio e
 * sleep injetados; o fetch falso registra o instante de INÍCIO de cada
 * chamada e avança o relógio pela latência simulada.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HITS_GATEWAY_MIN_INTERVAL_MS,
  HITS_READ_TIME_BUDGET_MS,
  fetchHitsSandboxReservations,
  type HitsGatewayReadConfig,
} from "../src/lib/integrations/hits/hits-gateway-read";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const BASE = "https://hits-homo.example";

function config(): HitsGatewayReadConfig {
  return {
    baseUrl: BASE,
    token: "t".repeat(32),
    requestTimeoutMs: 5_000,
    enabled: true,
    prodReadEnabled: false,
  };
}

type Start = { t: number; path: string };

/**
 * Relógio falso + fetch que registra inícios.
 *   ids: reservas devolvidas pela listagem (1 página; `pageSize` controla paginação)
 *   latency(path, attempt): ms que a chamada "demora" (relógio avança)
 *   respond(path, attempt): status/headers/body opcionais para forçar 429/5xx
 */
function harness(opts: {
  ids: number[];
  pageSize?: number;
  latency?: (path: string, attempt: number) => number;
  respond?: (
    path: string,
    attempt: number,
  ) => { status: number; headers?: Record<string, string>; body?: unknown } | null;
}) {
  let t = 0;
  const starts: Start[] = [];
  const attempts = new Map<string, number>();
  const pageSize = opts.pageSize ?? 20;
  const nowMs = () => t;
  const sleepImpl = async (ms: number) => {
    t += ms;
  };
  const fetchImpl = async (url: string) => {
    const path = url.replace(BASE, "");
    const attempt = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, attempt);
    starts.push({ t, path });
    t += opts.latency ? opts.latency(path, attempt) : 0;
    const forced = opts.respond ? opts.respond(path, attempt) : null;
    if (forced) {
      return new Response(JSON.stringify(forced.body ?? { code: "forced" }), {
        status: forced.status,
        headers: { "Content-Type": "application/json", ...(forced.headers ?? {}) },
      });
    }
    const m = /^\/v1\/reservations\/(\d+)$/.exec(path);
    if (m) {
      return new Response(
        JSON.stringify({
          idReservation: Number(m[1]),
          contactName: "Sintetico " + m[1],
          status: "1",
          rooms: [{ checkIn: "2026-09-20", checkOut: "2026-09-23", code: "APT 07", pax: 1 }],
          guests: [{ idEntity: 1, name: "Sintetico " + m[1], main: true }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Listagem paginada: Page=N devolve a fatia N (1-based) de `ids`.
    const page = Number(new URL(url).searchParams.get("Page") ?? "1");
    const status = new URL(url).searchParams.get("Status");
    const slice = status === "3" ? [] : opts.ids.slice((page - 1) * pageSize, page * pageSize);
    return new Response(JSON.stringify({ data: slice.map((id) => ({ idReservation: id })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { nowMs, sleepImpl, fetchImpl, starts, now: () => t, attempts };
}

function gaps(starts: Start[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < starts.length; i += 1) out.push(starts[i]!.t - starts[i - 1]!.t);
  return out;
}

async function main() {
  console.log("\n== Constantes ==");
  {
    assert.equal(HITS_GATEWAY_MIN_INTERVAL_MS, 1_100);
    assert.equal(HITS_READ_TIME_BUDGET_MS, 110_000);
    ok("cadência 1 100 ms (≈54 req/min < 60/min do gateway) e orçamento 110 s (< 150 s da Edge)");
  }

  console.log("\n== Cadência entre inícios ==");
  {
    // Chamadas instantâneas: cada início espera até previous_start + 1100.
    const h = harness({ ids: [1, 2, 3] });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 3);
    assert.equal(r.failed.length, 0);
    // 1 listagem + 3 detalhes = 4 inícios, 3 intervalos.
    assert.equal(h.starts.length, 4);
    for (const g of gaps(h.starts)) assert.ok(g >= 1_100, `intervalo ${g} < 1100`);
    assert.equal(h.starts[1]!.t - h.starts[0]!.t, 1_100, "espera exatamente o que falta");
    assert.equal(r.elapsed_ms, 3 * 1_100);
    ok("duas chamadas rápidas: segundo início ≥ 1 100 ms após o primeiro (e assim por diante)");
  }
  {
    // Chamada anterior demorou 1 500 ms: a seguinte sai imediatamente, sem sono.
    const h = harness({ ids: [1], latency: () => 1_500 });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 1);
    assert.deepEqual(gaps(h.starts), [1_500], "nenhuma espera adicional");
    assert.equal(r.elapsed_ms, 3_000);
    ok("chamada > 1 100 ms: a próxima inicia na hora (cadência não é sleep fixo)");
  }
  {
    // Latência de 900 ms: só os 200 ms que faltam.
    const h = harness({ ids: [1], latency: () => 900 });
    await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.deepEqual(gaps(h.starts), [1_100]);
    ok("latência 900 ms → espera 200 ms → próximo início a 1 100 ms");
  }
  {
    // A cadência vale para a listagem também (várias páginas).
    const h = harness({ ids: [1, 2, 3, 4], pageSize: 2 });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1, size: 2 });
    assert.equal(r.pages_fetched, 3, "2 páginas cheias + 1 vazia/incompleta");
    for (const g of gaps(h.starts)) assert.ok(g >= 1_100);
    ok("páginas de listagem também respeitam a cadência");
  }

  console.log("\n== Retry sob cadência, Retry-After e orçamento ==");
  {
    // 429 com Retry-After: 2 no detalhe → o retry espera 2 000 ms (backoff) e
    // isso já satisfaz a cadência; a chamada seguinte volta ao passo de 1 100.
    const h = harness({
      ids: [1, 2],
      respond: (path, attempt) =>
        path === "/v1/reservations/1" && attempt === 1
          ? { status: 429, headers: { "Retry-After": "2" }, body: { code: "rate_limited" } }
          : null,
    });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.failed.length, 0);
    assert.equal(h.attempts.get("/v1/reservations/1"), 2);
    const s = h.starts.map((x) => x.t);
    // listagem 0 → detalhe1 (1ª) 1100 → retry 3100 (Retry-After 2 s) → detalhe2 4200
    assert.deepEqual(s, [0, 1_100, 3_100, 4_200]);
    ok("retry 429 respeita Retry-After (2 s) e a cadência continua depois dele");
  }
  {
    // 429 com Retry-After: 0 → backoff zero, mas a CADÊNCIA ainda segura o retry.
    const h = harness({
      ids: [1],
      respond: (path, attempt) =>
        path === "/v1/reservations/1" && attempt === 1
          ? { status: 429, headers: { "Retry-After": "0" }, body: { code: "rate_limited" } }
          : null,
    });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 1);
    assert.deepEqual(h.starts.map((x) => x.t), [0, 1_100, 2_200]);
    ok("retry também obedece à cadência mínima (nunca dispara antes de 1 100 ms)");
  }
  {
    // 5xx sem Retry-After: backoff 250 ms cabe dentro da cadência (retry a 1 100).
    const h = harness({
      ids: [1],
      respond: (path, attempt) =>
        path === "/v1/reservations/1" && attempt === 1 ? { status: 502, body: { code: "hits_server_error" } } : null,
    });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 1);
    assert.deepEqual(h.starts.map((x) => x.t), [0, 1_100, 2_200]);
    ok("retry 5xx: backoff existente (250 ms) + cadência → retry a 1 100 ms");
  }
  {
    // Backoff que não cabe no orçamento: não dorme além do prazo, desiste.
    // Orçamento 3 000 ms: listagem em 0, detalhe em 1 100 responde 429
    // Retry-After 60 → backoff 30 000 > restante → sem retry, falha registrada.
    const h = harness({
      ids: [1],
      respond: (path) =>
        path === "/v1/reservations/1"
          ? { status: 429, headers: { "Retry-After": "60" }, body: { code: "rate_limited" } }
          : null,
    });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1, timeBudgetMs: 3_000 });
    assert.equal(r.rows.length, 0);
    assert.deepEqual(r.failed, [{ external_reservation_id: "1", code: "rate_limited" }]);
    assert.equal(h.attempts.get("/v1/reservations/1"), 1, "sem segunda tentativa");
    assert.ok(h.now() <= 3_000, `relógio ${h.now()} passou do orçamento`);
    assert.equal(r.listing_complete, true);
    ok("retry nunca dorme além do orçamento restante: desiste e marca a falha");
  }

  console.log("\n== Orçamento global (time_budget) ==");
  {
    // Detalhes de 40 s: cabem 3 (inícios em 1 100, 41 100, 81 100); o 4º
    // começaria em 121 100 > 110 000 → não inicia; 4º e 5º ficam preservados.
    const h = harness({ ids: [1, 2, 3, 4, 5], latency: (p) => (p.startsWith("/v1/reservations/") ? 40_000 : 1_000) });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.rows.length, 3);
    assert.equal(r.stopped_reason, "time_budget");
    assert.equal(r.listing_complete, true, "listagem terminou antes do orçamento");
    assert.deepEqual(r.failed, [
      { external_reservation_id: "4", code: "time_budget" },
      { external_reservation_id: "5", code: "time_budget" },
    ]);
    for (const s of h.starts) assert.ok(s.t < HITS_READ_TIME_BUDGET_MS, `início a ${s.t} após o orçamento`);
    assert.equal(h.starts.length, 4, "1 listagem + 3 detalhes; nada mais é iniciado");
    ok("nenhuma chamada nova após 110 s; ids não processados entram como failed/time_budget");
  }
  {
    // A espera de cadência que ultrapassaria o prazo também não acontece.
    const h = harness({ ids: [1, 2], latency: (p) => (p.startsWith("/v1/reservations/") ? 400 : 0) });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1, timeBudgetMs: 2_000 });
    // listagem 0 → detalhe1 1 100 (até 1 500) → detalhe2 esperaria até 2 200 ≥ 2 000 → não inicia.
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.failed, [{ external_reservation_id: "2", code: "time_budget" }]);
    assert.ok(h.now() <= 2_000);
    ok("espera de cadência que estoura o orçamento não é feita: marca time_budget");
  }
  {
    // Orçamento acaba DURANTE a listagem: listing_complete=false, nenhum detalhe.
    const h = harness({ ids: [1, 2, 3, 4, 5, 6], pageSize: 1, latency: () => 2_000 });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1, size: 1, timeBudgetMs: 3_000 });
    assert.equal(r.stopped_reason, "time_budget");
    assert.equal(r.listing_complete, false);
    assert.equal(r.rows.length, 0);
    assert.ok(r.failed.every((f) => f.code === "time_budget"));
    for (const s of h.starts) assert.ok(s.t < 3_000);
    ok("orçamento durante a listagem → listing_complete=false (o sync preserva tudo)");
  }
  {
    // time_budget não é erro geral: a função devolve normalmente (nunca lança).
    const h = harness({ ids: [1], latency: () => 200_000 });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.equal(r.stopped_reason, "time_budget");
    assert.equal(r.pages_fetched, 1);
    ok("time_budget devolve resultado parcial, não exceção");
  }

  console.log("\n== Métricas e contrato preservados ==");
  {
    const h = harness({ ids: [1, 2] });
    const r = await fetchHitsSandboxReservations({ config: config(), fetchImpl: h.fetchImpl, nowMs: h.nowMs, sleepImpl: h.sleepImpl, status: 1 });
    assert.deepEqual(Object.keys(r).sort(), [
      "elapsed_ms",
      "failed",
      "listing_complete",
      "page",
      "pages_fetched",
      "rows",
      "size",
      "stopped_reason",
    ]);
    assert.equal(r.rows.length, 2);
    assert.equal(r.stopped_reason, "last_page");
    ok("count/pages_fetched/failed/stopped_reason preservados; listing_complete e elapsed_ms adicionados");
  }
  {
    const edge = readFileSync(join(process.cwd(), "supabase/functions/hits-reservations-preview/index.ts"), "utf8");
    assert.match(edge, /listing_complete: result\.listing_complete/);
    assert.match(edge, /elapsed_ms: result\.elapsed_ms/);
    const sync = readFileSync(join(process.cwd(), "src/lib/integrations/hits/hits-snapshot-sync.ts"), "utf8");
    assert.match(sync, /result\.listing_complete === false/);
    assert.match(sync, /listing_incomplete/);
    ok("Edge expõe listing_complete/elapsed_ms; sync nunca aplica com listagem incompleta");
  }

  console.log(`\nOK test-hits-read-cadence (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
