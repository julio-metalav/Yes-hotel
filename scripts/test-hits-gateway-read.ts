/**
 * Testes: leitura de reservas do HITS Sandbox pelo gateway (somente GET).
 * Determinísticos, sem rede — fetch injetado.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HITS_GATEWAY_PROD_HOSTS,
  assertHitsGatewayReadReady,
  fetchHitsSandboxReservations,
  getHitsGatewayReadConfig,
  hitsGatewayReadStatus,
  hitsGatewayTargetsProd,
  toHitsSandboxRow,
  type HitsGatewayReadConfig,
} from "../src/lib/integrations/hits/hits-gateway-read";
import { normalizeHitsDetailToSynced } from "../src/lib/integrations/hits/normalize-hits-detail-to-synced";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const TOKEN = "t".repeat(32);
const PROD_URL = "https://hits-prod.yeshotel.com.br";
const HOMO_URL = "https://hits-homo.yeshotel.com.br";

function config(patch: Partial<HitsGatewayReadConfig> = {}): HitsGatewayReadConfig {
  return {
    baseUrl: "https://hits-homo.example",
    token: TOKEN,
    requestTimeoutMs: 5_000,
    enabled: true,
    prodReadEnabled: false,
    ...patch,
  };
}

function readRepo(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeFetch(
  routes: Record<string, { status?: number; body: unknown }>,
  calls: Call[],
) {
  return async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const path = url.replace("https://hits-homo.example", "");
    const key = Object.keys(routes).find((r) => path === r || path.startsWith(r + "?"));
    const route = key ? routes[key]! : { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Relógio falso: a cadência (1,1 s entre inícios) e o orçamento (110 s) usam
 * nowMs/sleepImpl injetados — os testes continuam instantâneos e determinísticos.
 * Cada chamada avança o relógio em `latencyMs` (default 0).
 */
function fakeClock(latencyMs = 0) {
  let t = 0;
  return {
    nowMs: () => t,
    sleepImpl: async (ms: number) => {
      t += ms;
    },
    tick: (ms: number) => {
      t += ms;
    },
    now: () => t,
    latencyMs,
  };
}

/** fetchHitsSandboxReservations com relógio falso (cadência e orçamento sem timers reais). */
function read(input: Parameters<typeof fetchHitsSandboxReservations>[0]) {
  const clock = fakeClock();
  const baseFetch = input.fetchImpl;
  const fetchImpl = baseFetch
    ? async (url: string, init: Parameters<typeof baseFetch>[1]) => {
        const res = await baseFetch(url, init);
        clock.tick(clock.latencyMs);
        return res;
      }
    : undefined;
  return fetchHitsSandboxReservations({
    nowMs: clock.nowMs,
    sleepImpl: clock.sleepImpl,
    ...input,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const DETAIL_17613 = {
  idReservation: 17613,
  contactName: "Hospede Sintetico",
  status: "1",
  dateUp: "2026-09-10T12:00:00Z",
  rooms: [{ checkIn: "2026-09-20", checkOut: "2026-09-23", code: "APT 07", pax: 2 }],
  guests: [
    { idEntity: 141501, name: "Hospede Sintetico", main: true },
    { idEntity: 141502, name: "Acompanhante Sintetico", main: false },
  ],
};

async function main() {
  console.log("\n== Config e gates (sem rede) ==");
  {
    const cfg = getHitsGatewayReadConfig({
      HITS_GATEWAY_URL: "https://hits-homo.example/",
      HITS_GATEWAY_TOKEN: TOKEN,
      HITS_GATEWAY_READ_ENABLED: "true",
    });
    assert.equal(cfg.baseUrl, "https://hits-homo.example");
    assert.equal(cfg.enabled, true);
    assert.equal(assertHitsGatewayReadReady(cfg).ok, true);
    ok("env válido → gateway pronto, sem barra final");
  }
  {
    const off = assertHitsGatewayReadReady(config({ enabled: false }));
    assert.equal(off.ok, false);
    assert.equal(off.ok === false && off.reason, "gateway_read_disabled");

    const noToken = assertHitsGatewayReadReady(config({ token: "" }));
    assert.equal(noToken.ok === false && noToken.reason, "gateway_missing_token");

    const noUrl = assertHitsGatewayReadReady(config({ baseUrl: "" }));
    assert.equal(noUrl.ok === false && noUrl.reason, "gateway_missing_url");
    ok("flag desligada / token ausente / url ausente bloqueiam");
  }
  {
    // 1. HOMO continua permitido, com ou sem a trava de produção.
    for (const prodReadEnabled of [false, true]) {
      const homo = assertHitsGatewayReadReady(config({ baseUrl: HOMO_URL, prodReadEnabled }));
      assert.equal(homo.ok, true, `HOMO deve passar com prodReadEnabled=${prodReadEnabled}`);
    }
    assert.equal(hitsGatewayTargetsProd(HOMO_URL), false);
    ok("HOMO (hits-homo.yeshotel.com.br) continua permitido");
  }
  {
    // 2. PROD sem a trava explícita é recusado — domínio, IP e variações de porta/caixa.
    assert.deepEqual([...HITS_GATEWAY_PROD_HOSTS], ["hits-prod.yeshotel.com.br", "167.172.2.24"]);
    for (const url of [
      PROD_URL,
      `${PROD_URL}:443`,
      "https://HITS-PROD.yeshotel.com.br",
      "http://167.172.2.24:3001",
      "https://167.172.2.24",
    ]) {
      const prod = assertHitsGatewayReadReady(config({ baseUrl: url }));
      assert.equal(prod.ok, false, `${url} sem trava deve ser recusado`);
      assert.equal(prod.ok === false && prod.reason, "gateway_prod_read_disabled");
      assert.equal(hitsGatewayTargetsProd(url), true);
    }
    ok("PROD (domínio e IP) sem HITS_GATEWAY_PROD_READ_ENABLED é recusado");
  }
  {
    // 3. PROD com a trava explícita `true` é permitido (somente leitura pelo gateway).
    const prod = assertHitsGatewayReadReady(config({ baseUrl: PROD_URL, prodReadEnabled: true }));
    assert.equal(prod.ok, true);
    const viaEnv = getHitsGatewayReadConfig({
      HITS_GATEWAY_URL: `${PROD_URL}/`,
      HITS_GATEWAY_TOKEN: TOKEN,
      HITS_GATEWAY_READ_ENABLED: "true",
      HITS_GATEWAY_PROD_READ_ENABLED: "true",
    });
    assert.equal(viaEnv.prodReadEnabled, true);
    assert.equal(assertHitsGatewayReadReady(viaEnv).ok, true);
    // A trava de produção não substitui a trava geral de leitura.
    const semLeitura = assertHitsGatewayReadReady(
      config({ baseUrl: PROD_URL, prodReadEnabled: true, enabled: false }),
    );
    assert.equal(semLeitura.ok === false && semLeitura.reason, "gateway_read_disabled");
    ok("PROD com HITS_GATEWAY_PROD_READ_ENABLED=true é permitido (e ainda exige READ_ENABLED)");
  }
  {
    // 4. Qualquer outro valor da trava não libera produção.
    for (const flag of ["", "TRUE", "True", " true", "true ", "1", "yes", "on", "false", "prod"]) {
      const cfg = getHitsGatewayReadConfig({
        HITS_GATEWAY_URL: PROD_URL,
        HITS_GATEWAY_TOKEN: TOKEN,
        HITS_GATEWAY_READ_ENABLED: "true",
        HITS_GATEWAY_PROD_READ_ENABLED: flag,
      });
      // `read()` faz trim: " true" vira "true" e libera — igual a READ_ENABLED. Os
      // demais valores precisam falhar.
      const trimmed = flag.trim();
      const gate = assertHitsGatewayReadReady(cfg);
      if (trimmed === "true") {
        assert.equal(gate.ok, true);
      } else {
        assert.equal(cfg.prodReadEnabled, false, `flag ${JSON.stringify(flag)} não pode liberar`);
        assert.equal(gate.ok === false && gate.reason, "gateway_prod_read_disabled");
      }
    }
    const ausente = getHitsGatewayReadConfig({
      HITS_GATEWAY_URL: PROD_URL,
      HITS_GATEWAY_TOKEN: TOKEN,
      HITS_GATEWAY_READ_ENABLED: "true",
    });
    assert.equal(ausente.prodReadEnabled, false);
    assert.equal(assertHitsGatewayReadReady(ausente).ok, false);
    ok("trava de produção só aceita exatamente \"true\" (ausente/outros valores recusam)");
  }
  {
    // 7. Nenhum segredo em status/erro: nem o token nem a URL do gateway.
    const cfg = config({ baseUrl: PROD_URL, prodReadEnabled: true });
    const status = hitsGatewayReadStatus(cfg);
    assert.equal(status.has_token, true);
    assert.equal(status.targets_prod, true);
    assert.equal(status.prod_read_enabled, true);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes("hits-prod"), false);
    const negado = assertHitsGatewayReadReady(config({ baseUrl: PROD_URL, token: "s3cr3t".repeat(6) }));
    assert.equal(negado.ok, false);
    assert.equal(negado.ok === false && negado.message.includes("s3cr3t"), false);
    ok("status/erro da trava não expõem token nem URL");
  }
  {
    // 8/9/10. A Edge continua GET-only, passa a trava só para a leitura, e a
    // materialização não conhece a flag (produção continua bloqueada lá).
    const edge = readRepo("supabase/functions/hits-reservations-preview/index.ts");
    assert.match(edge, /req\.method !== "GET"/);
    assert.match(edge, /"Access-Control-Allow-Methods": "GET, OPTIONS"/);
    assert.match(edge, /"HITS_GATEWAY_PROD_READ_ENABLED"/);
    assert.doesNotMatch(edge, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
    const materializar = readRepo("supabase/functions/hits-reserva-materializar/index.ts");
    assert.doesNotMatch(materializar, /HITS_GATEWAY_PROD_READ_ENABLED/);
    const leitor = readRepo("src/lib/integrations/hits/hits-gateway-read.ts");
    assert.doesNotMatch(leitor, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
    // A trava é lida só pelo leitor GET: nenhuma flag de escrita/check-in mora aqui.
    assert.doesNotMatch(leitor, /guestWriteEnabled|checkinEnabled|HITS_GUEST_WRITE_ENABLED|HITS_CHECKIN_ENABLED/);
    ok("Edge preview GET-only com a trava; materializar e leitor sem escrita/check-in");
  }

  console.log("\n== Leitura pelo gateway ==");
  {
    const calls: Call[] = [];
    const result = await read({
      config: config(),
      fetchImpl: fakeFetch(
        {
          "/v1/reservations": { body: { data: [{ idReservation: 17613 }] } },
          "/v1/reservations/17613": { body: DETAIL_17613 },
        },
        calls,
      ),
      dateFrom: "2026-09-15",
      dateTo: "2026-09-30",
    });

    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.external_reservation_id, "17613");
    assert.equal(row.apartamento, "07");
    assert.equal(row.hospede_principal, "Hospede Sintetico");
    assert.equal(row.check_in, "2026-09-20");
    assert.equal(row.check_out, "2026-09-23");
    assert.equal(row.status_reserva, "ativa");
    assert.equal(row.total_hospedes, 2);
    ok("linha traz idReservation, apto, hóspede, entrada, saída, status e pax");

    assert.equal(calls.every((c) => c.method === "GET"), true);
    ok("apenas GET — zero POST/PUT/PATCH/DELETE");

    assert.equal(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`), true);
    ok("Authorization Bearer do gateway montado no backend");

    // dateFrom é o dia operacional; a leitura recua 30 dias para pegar estadias
    // em curso, e o FinalDate recebido é mantido.
    assert.match(calls[0]!.url, /InitialDate=2026-08-16/);
    assert.match(calls[0]!.url, /FinalDate=2026-09-30/);
    ok("janela de datas repassada ao gateway (com lookback de 30 dias)");

    assert.match(calls[0]!.url, /(^|[?&])Type=0([&]|$)/);
    ok("Type=0 sempre enviado — sem ele o HITS responde 400");

    assert.match(calls[0]!.url, /(^|[?&])Page=1([&]|$)/);
    ok("paginação começa em 1, não em 0");

    assert.match(calls[0]!.url, /(^|[?&])Status=1([&]|$)/);
    ok("Status=1 sempre enviado — omitido, o HITS devolve 400");
  }
  {
    // Regressão do 400 real em HOMO:
    // {"errors":{"Status":["The field Status is invalid."]}}
    const calls: Call[] = [];
    await read({
      config: config(),
      fetchImpl: fakeFetch({ "/v1/reservations": { body: { data: [] } } }, calls),
      status: 2,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.match(calls[0]!.url, /(^|[?&])Status=2([&]|$)/);
    ok("Status do chamador é respeitado (2 = Canceled)");
  }
  {
    // Regressão do bad request em HOMO: sem datas, a query ia sem Type e com
    // Page=0 — combinação que o HITS recusa.
    const calls: Call[] = [];
    await read({
      config: config(),
      fetchImpl: fakeFetch(
        {
          "/v1/reservations": { body: { data: [] } },
        },
        calls,
      ),
      nowIso: "2026-09-15T00:00:00.000Z",
    });

    const url = calls[0]!.url;
    assert.match(url, /(^|[?&])Type=0([&]|$)/);
    assert.match(url, /InitialDate=2026-08-16/);
    assert.match(url, /FinalDate=2026-10-15/);
    assert.match(url, /(^|[?&])Page=1([&]|$)/);
    assert.doesNotMatch(url, /Page=0/);
    assert.match(url, /(^|[?&])Status=1([&]|$)/);
    assert.doesNotMatch(url, /Status=0/);
    ok("sem datas: janela default de 30 dias + Type=0 + Status=1 + Page=1");
  }
  {
    const calls: Call[] = [];
    await read({
      config: config(),
      fetchImpl: fakeFetch({ "/v1/reservations": { body: { data: [] } } }, calls),
      page: 0,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.match(calls[0]!.url, /(^|[?&])Page=1([&]|$)/);
    ok("Page=0 pedido pelo chamador é corrigido para 1");
  }
  {
    const calls: Call[] = [];
    const result = await read({
      config: config(),
      fetchImpl: fakeFetch({ "/v1/reservations/17613": { body: DETAIL_17613 } }, calls),
      reservationIds: ["17613", "17613", " "],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(calls.length, 1, "ids explícitos não chamam a listagem nem duplicam");
    assert.match(calls[0]!.url, /\/v1\/reservations\/17613$/);
    ok("ids explícitos: só o detalhe, deduplicado");
  }
  {
    const calls: Call[] = [];
    const result = await read({
      config: config(),
      fetchImpl: fakeFetch(
        {
          "/v1/reservations": {
            body: { data: [{ idReservation: 17613 }, { idReservation: 99999 }] },
          },
          "/v1/reservations/17613": { body: DETAIL_17613 },
          "/v1/reservations/99999": { status: 404, body: { code: "not_found" } },
        },
        calls,
      ),
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.external_reservation_id, "99999");
    assert.equal(JSON.stringify(result.failed).includes(TOKEN), false);
    ok("detalhe que falha não derruba a leitura e não vaza token");
  }
  {
    await assert.rejects(
      () =>
        fetchHitsSandboxReservations({
          config: config({ enabled: false }),
          fetchImpl: async () => {
            throw new Error("não deveria chamar rede");
          },
        }),
      /HITS_GATEWAY_READ_ENABLED/,
    );
    ok("flag desligada não chega a tocar a rede");
  }

  console.log("\n== Paginação ==");
  {
    // Regressão real: com Size=20 e só a página 1, a 17806 ficava de fora.
    const pageOf = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ idReservation: from + i }));
    const detailFor = (id: string) => ({
      ...DETAIL_17613,
      idReservation: Number(id),
      guests: [{ idEntity: 1, name: `Hospede ${id}`, main: true }],
    });

    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, method: init.method, headers: init.headers });
      const detail = url.match(/\/v1\/reservations\/(\d+)$/);
      if (detail) {
        return new Response(JSON.stringify(detailFor(detail[1]!)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const page = Number(new URL(url).searchParams.get("Page"));
      // 20 na página 1, 5 na página 2 (última). 17806 só existe na 2.
      // Faixa da página 1 não contém 17806 de propósito: ela só existe na 2.
      const body =
        page === 1
          ? { data: pageOf(20, 17700) }
          : page === 2
            ? { data: [...pageOf(4, 17810), { idReservation: 17806 }] }
            : { data: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await read({
      config: config(),
      fetchImpl,
      // Leitura única: estes casos são sobre paginação, não sobre ciclo.
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });

    assert.equal(result.pages_fetched, 2, "precisa buscar a página 2");
    assert.equal(result.stopped_reason, "last_page");
    assert.equal(result.rows.length, 25);
    ok("mais de 20 reservas: busca a página 2 e encerra na página incompleta");

    assert.ok(
      result.rows.some((r) => r.external_reservation_id === "17806"),
      "17806 não pode ser perdida por estar além da página 1",
    );
    ok("17806 aparece mesmo estando na segunda página");

    const listCalls = calls.filter((c) => !/\/v1\/reservations\/\d+$/.test(c.url));
    assert.equal(listCalls.length, 2, "uma chamada por página, sem paralelismo");
    assert.equal(calls.every((c) => c.method === "GET"), true);
    ok("listagem sequencial, só GET");
  }
  {
    const calls: Call[] = [];
    const result = await read({
      config: config(),
      fetchImpl: fakeFetch(
        {
          "/v1/reservations": { body: { data: [{ idReservation: 17613 }] } },
          "/v1/reservations/17613": { body: DETAIL_17613 },
        },
        calls,
      ),
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.pages_fetched, 1);
    assert.equal(result.stopped_reason, "last_page");
    ok("menos que Size encerra na primeira página");
  }
  {
    // Página 1 cheia, página 2 vazia.
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (/\/v1\/reservations\/\d+$/.test(url)) {
        return new Response(JSON.stringify(DETAIL_17613), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const page = Number(new URL(url).searchParams.get("Page"));
      const body =
        page === 1
          ? { data: Array.from({ length: 20 }, (_, i) => ({ idReservation: 17700 + i })) }
          : { data: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await read({
      config: config(),
      fetchImpl,
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.pages_fetched, 2);
    assert.equal(result.stopped_reason, "empty_page");
    ok("página vazia encerra a varredura");
  }
  {
    // Mesmo id repetido entre páginas não pode duplicar linha nem gastar detalhe duas vezes.
    const detailCalls: string[] = [];
    const fetchImpl = async (url: string) => {
      const detail = url.match(/\/v1\/reservations\/(\d+)$/);
      if (detail) {
        detailCalls.push(detail[1]!);
        return new Response(JSON.stringify({ ...DETAIL_17613, idReservation: Number(detail[1]) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const page = Number(new URL(url).searchParams.get("Page"));
      const repetido = Array.from({ length: 20 }, () => ({ idReservation: 17613 }));
      return new Response(JSON.stringify({ data: page <= 2 ? repetido : [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await read({
      config: config(),
      fetchImpl,
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.rows.length, 1, "dedupe entre e dentro das páginas");
    assert.equal(detailCalls.length, 1, "detalhe não é buscado duas vezes");
    ok("dedupe por idReservation entre páginas");
  }
  {
    // Fonte infinita: o limite defensivo precisa parar a varredura.
    let listCount = 0;
    const fetchImpl = async (url: string) => {
      if (/\/v1\/reservations\/\d+$/.test(url)) {
        const id = Number(url.match(/(\d+)$/)![1]);
        return new Response(JSON.stringify({ ...DETAIL_17613, idReservation: id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      listCount += 1;
      const base = 20000 + listCount * 100;
      return new Response(
        JSON.stringify({ data: Array.from({ length: 20 }, (_, i) => ({ idReservation: base + i })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await read({
      config: config(),
      fetchImpl,
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.stopped_reason, "max_reservations");
    assert.equal(result.rows.length, 50, "teto de reservas respeitado");
    assert.ok(listCount <= 10, "nunca passa do teto de páginas");
    ok("limite defensivo corta fonte infinita (50 reservas / 10 páginas)");
  }
  {
    // 429 na primeira tentativa da listagem: o transporte já repete uma vez.
    let attempts = 0;
    const fetchImpl = async (url: string) => {
      if (/\/v1\/reservations\/\d+$/.test(url)) {
        return new Response(JSON.stringify(DETAIL_17613), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ code: "rate_limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ data: [{ idReservation: 17613 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await read({
      config: config(),
      fetchImpl,
      status: 1,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.rows.length, 1);
    assert.equal(attempts, 2, "429 foi repetido uma vez pelo transporte");
    ok("429 na listagem respeita o retry existente com Retry-After");
  }

  console.log("\n== Ciclo de vida (Status 1 + 3) ==");
  {
    /** Mock por Status: cada leitura devolve a sua lista na página 1. */
    const byStatus = (lists: Record<string, number[]>, calls?: Call[]) =>
      async (url: string, init: { method: string; headers: Record<string, string> }) => {
        calls?.push({ url, method: init.method, headers: init.headers });
        const detail = url.match(/\/v1\/reservations\/(\d+)$/);
        if (detail) {
          return new Response(
            JSON.stringify({ ...DETAIL_17613, idReservation: Number(detail[1]) }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const params = new URL(url).searchParams;
        const ids = Number(params.get("Page")) === 1 ? (lists[params.get("Status")!] ?? []) : [];
        return new Response(
          JSON.stringify({ data: ids.map((id) => ({ idReservation: id })) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

    const janela = { dateFrom: "2026-09-15", dateTo: "2026-10-15" };
    {
      const calls: Call[] = [];
      const result = await read({
        config: config(),
        fetchImpl: byStatus({ "1": [17613], "3": [] }, calls),
        ...janela,
      });
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]!.ciclo_hits, "confirmada");
      ok("reserva só em Status=1 aparece como confirmada");

      const lists = calls.filter((c) => !/\/v1\/reservations\/\d+$/.test(c.url));
      assert.equal(lists.length, 2, "uma leitura por status, sequenciais");
      // Status=1 também recua 30 dias (estadias em curso sem check-in no HITS),
      // mantendo o FinalDate recebido.
      assert.match(lists[0]!.url, /Status=1&InitialDate=2026-08-16&FinalDate=2026-10-15/);
      // dia operacional − 30 = 2026-08-16; dia operacional + 1 = 2026-09-16.
      assert.match(lists[1]!.url, /Status=3&InitialDate=2026-08-16&FinalDate=2026-09-16/);
      ok("Status=1 usa from−30 até to; Status=3 usa from−30 até from+1");
    }
    {
      // REGRESSÃO: depois do check-in a reserva sai do Status=1 e não pode sumir.
      const result = await read({
        config: config(),
        fetchImpl: byStatus({ "1": [], "3": [17656] }),
        ...janela,
      });
      assert.equal(result.rows.length, 1, "17656 não pode sumir após o check-in");
      assert.equal(result.rows[0]!.external_reservation_id, "17656");
      assert.equal(result.rows[0]!.ciclo_hits, "hospedada");
      ok("17656 só em Status=3 continua aparecendo, como hospedada");
    }
    {
      // Transição: o HITS devolve a reserva nas duas listas.
      const calls: Call[] = [];
      const result = await read({
        config: config(),
        fetchImpl: byStatus({ "1": [17656], "3": [17656] }, calls),
        ...janela,
      });
      assert.equal(result.rows.length, 1, "uma única linha");
      assert.equal(result.rows[0]!.ciclo_hits, "hospedada", "Status=3 prevalece");
      const detalhes = calls.filter((c) => /\/v1\/reservations\/\d+$/.test(c.url));
      assert.equal(detalhes.length, 1, "e um único GET de detalhe");
      assert.equal(calls.every((c) => c.method === "GET"), true);
      ok("mesma id nos dois status gera uma linha só, sem escrita");
    }
  }

  console.log("\n== Estadias em curso sem check-in no HITS (caso 17792) ==");
  {
    /** Mock por Status com checkIn/checkOut no sumário, como o HITS devolve. */
    type Sum = { idReservation: number; checkIn?: string; checkOut?: string | null };
    const byStatusSum = (lists: Record<string, Sum[]>, calls: Call[]) =>
      async (url: string, init: { method: string; headers: Record<string, string> }) => {
        calls.push({ url, method: init.method, headers: init.headers });
        const detail = url.match(/\/v1\/reservations\/(\d+)$/);
        if (detail) {
          return new Response(
            JSON.stringify({ ...DETAIL_17613, idReservation: Number(detail[1]) }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const params = new URL(url).searchParams;
        const items = Number(params.get("Page")) === 1 ? (lists[params.get("Status")!] ?? []) : [];
        return new Response(JSON.stringify({ data: items }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
    const detalhesDe = (calls: Call[]) =>
      calls
        .map((c) => c.url.match(/\/v1\/reservations\/(\d+)$/)?.[1])
        .filter((x): x is string => !!x);
    // Dia operacional 16/09; janela recebida do painel 16/09..16/10.
    const hoje = { dateFrom: "2026-09-16", dateTo: "2026-10-16" };

    {
      const calls: Call[] = [];
      const r = await read({
        config: config(),
        fetchImpl: byStatusSum(
          {
            "1": [
              { idReservation: 17792, checkIn: "2026-09-09", checkOut: "2026-09-17" }, // em curso
              { idReservation: 17752, checkIn: "2026-09-09", checkOut: "2026-09-11" }, // encerrada
            ],
            "3": [],
          },
          calls,
        ),
        ...hoje,
      });
      const lists = calls.filter((c) => !/\/v1\/reservations\/\d+$/.test(c.url));
      assert.match(lists[0]!.url, /Status=1&InitialDate=2026-08-17&FinalDate=2026-10-16/);
      ok("Status=1 recua 30 dias a partir do dia operacional");

      assert.ok(r.rows.some((x) => x.external_reservation_id === "17792"), "17792 precisa entrar");
      assert.equal(r.rows[0]!.ciclo_hits, "confirmada", "continua Status=1: confirmada, não hospedada");
      ok("Status=1 09/09→17/09 com dia operacional 16/09 entra no feed");

      assert.deepEqual(detalhesDe(calls), ["17792"], "17752 encerrada não gera detalhe");
      assert.equal(r.rows.some((x) => x.external_reservation_id === "17752"), false);
      ok("Status=1 09/09→11/09 (encerrada) não gera GET de detalhe");
    }
    {
      const calls: Call[] = [];
      const r = await read({
        config: config(),
        fetchImpl: byStatusSum(
          {
            "1": [
              { idReservation: 17801, checkIn: "2026-09-10", checkOut: "2026-09-16" }, // sai hoje
              { idReservation: 17802, checkIn: "2026-09-10", checkOut: "" },           // vazio
              { idReservation: 17803, checkIn: "2026-09-10", checkOut: "abc" },        // inválido
              { idReservation: 17804, checkIn: "2026-09-10" },                         // ausente
              { idReservation: 17805, checkIn: "2026-09-10", checkOut: "2026-09-15T14:00:00" }, // ontem, com hora
            ],
            "3": [],
          },
          calls,
        ),
        ...hoje,
      });
      const ids = r.rows.map((x) => x.external_reservation_id).sort();
      assert.deepEqual(ids, ["17801", "17802", "17803", "17804"]);
      assert.deepEqual(detalhesDe(calls).sort(), ["17801", "17802", "17803", "17804"]);
      ok("check-out = dia operacional entra; vazio/inválido/ausente entram; ontem (mesmo com hora) não");
    }
    {
      // Status=3 continua funcionando e o filtro também poupa detalhe lá.
      const calls: Call[] = [];
      const r = await read({
        config: config(),
        fetchImpl: byStatusSum(
          {
            "1": [],
            "3": [
              { idReservation: 17656, checkIn: "2026-09-15", checkOut: "2026-09-18" }, // hospedada
              { idReservation: 17600, checkIn: "2026-08-20", checkOut: "2026-08-25" }, // já saiu
            ],
          },
          calls,
        ),
        ...hoje,
      });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0]!.external_reservation_id, "17656");
      assert.equal(r.rows[0]!.ciclo_hits, "hospedada");
      assert.deepEqual(detalhesDe(calls), ["17656"]);
      ok("Status=3: hospedada entra como hospedada; estadia encerrada não custa detalhe");
    }
    {
      // Dedupe entre as duas leituras segue: mesma id em 1 e 3 → 1 detalhe, hospedada.
      const calls: Call[] = [];
      const r = await read({
        config: config(),
        fetchImpl: byStatusSum(
          {
            "1": [{ idReservation: 17792, checkIn: "2026-09-09", checkOut: "2026-09-17" }],
            "3": [{ idReservation: 17792, checkIn: "2026-09-09", checkOut: "2026-09-17" }],
          },
          calls,
        ),
        ...hoje,
      });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0]!.ciclo_hits, "hospedada");
      assert.deepEqual(detalhesDe(calls), ["17792"]);
      ok("dedupe por idReservation entre leituras continua: um detalhe, Status=3 prevalece");
    }
  }

  console.log("\n== Mapeamento somente leitura ==");
  {
    const cancelada = normalizeHitsDetailToSynced(
      { ...DETAIL_17613, status: "2" } as Record<string, unknown>,
      null,
    );
    assert.equal(toHitsSandboxRow(cancelada).status_reserva, "cancelada");

    const semGuests = normalizeHitsDetailToSynced(
      {
        idReservation: 17613,
        contactName: "Só Contato",
        rooms: [{ checkIn: "2026-09-20", checkOut: "2026-09-21", code: null }],
        guests: [],
      } as Record<string, unknown>,
      null,
    );
    const row = toHitsSandboxRow(semGuests);
    assert.equal(row.total_hospedes, 1);
    assert.equal(row.apartamento, "");
    assert.equal(row.hospede_principal, "Só Contato");
    ok("cancelada, sem apto e sem guests degradam sem inventar dado");
  }
  {
    const doisAptos = normalizeHitsDetailToSynced(
      {
        idReservation: 17613,
        contactName: "Dois Quartos",
        rooms: [
          { checkIn: "2026-09-20", checkOut: "2026-09-23", code: "APT 07", pax: 2 },
          { checkIn: "2026-09-20", checkOut: "2026-09-23", code: "APT 08", pax: 1 },
        ],
        guests: [{ idEntity: 141501, name: "Dois Quartos", main: true }],
      } as Record<string, unknown>,
      null,
    );
    assert.equal(toHitsSandboxRow(doisAptos).external_reservation_id, "17613");
    ok("reserva com dois apartamentos continua sendo uma linha");
  }

  console.log(`\nOK test-hits-gateway-read (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
