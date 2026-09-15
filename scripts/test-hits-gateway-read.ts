/**
 * Testes: leitura de reservas do HITS Sandbox pelo gateway (somente GET).
 * Determinísticos, sem rede — fetch injetado.
 */
import assert from "node:assert/strict";
import {
  assertHitsGatewayReadReady,
  fetchHitsSandboxReservations,
  getHitsGatewayReadConfig,
  hitsGatewayReadStatus,
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

function config(patch: Partial<HitsGatewayReadConfig> = {}): HitsGatewayReadConfig {
  return {
    baseUrl: "https://hits-homo.example",
    token: TOKEN,
    requestTimeoutMs: 5_000,
    enabled: true,
    ...patch,
  };
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
    const prod = assertHitsGatewayReadReady(config({ baseUrl: "http://167.172.2.24:3001" }));
    assert.equal(prod.ok, false);
    assert.equal(prod.ok === false && prod.reason, "gateway_forbidden_host");
    ok("host de produção 167.172.2.24 é recusado");
  }
  {
    const status = hitsGatewayReadStatus(config());
    assert.equal(status.has_token, true);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    ok("status não expõe o token");
  }

  console.log("\n== Leitura pelo gateway ==");
  {
    const calls: Call[] = [];
    const result = await fetchHitsSandboxReservations({
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

    assert.match(calls[0]!.url, /InitialDate=2026-09-15/);
    assert.match(calls[0]!.url, /FinalDate=2026-09-30/);
    ok("janela de datas repassada ao gateway");

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
    await fetchHitsSandboxReservations({
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
    await fetchHitsSandboxReservations({
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
    assert.match(url, /InitialDate=2026-09-15/);
    assert.match(url, /FinalDate=2026-10-15/);
    assert.match(url, /(^|[?&])Page=1([&]|$)/);
    assert.doesNotMatch(url, /Page=0/);
    assert.match(url, /(^|[?&])Status=1([&]|$)/);
    assert.doesNotMatch(url, /Status=0/);
    ok("sem datas: janela default de 30 dias + Type=0 + Status=1 + Page=1");
  }
  {
    const calls: Call[] = [];
    await fetchHitsSandboxReservations({
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
    const result = await fetchHitsSandboxReservations({
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
    const result = await fetchHitsSandboxReservations({
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

    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl,
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
    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl: fakeFetch(
        {
          "/v1/reservations": { body: { data: [{ idReservation: 17613 }] } },
          "/v1/reservations/17613": { body: DETAIL_17613 },
        },
        calls,
      ),
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
    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl,
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
    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl,
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
    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl,
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
    const result = await fetchHitsSandboxReservations({
      config: config(),
      fetchImpl,
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    assert.equal(result.rows.length, 1);
    assert.equal(attempts, 2, "429 foi repetido uma vez pelo transporte");
    ok("429 na listagem respeita o retry existente com Retry-After");
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
