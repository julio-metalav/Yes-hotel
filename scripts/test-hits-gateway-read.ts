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
