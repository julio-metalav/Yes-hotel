import assert from "node:assert/strict";
import { test } from "node:test";
import { HitsApiError } from "../../../src/lib/integrations/hits/errors.ts";
import { buildApp } from "../src/app.ts";
import type { HitsReadClient } from "../src/hits-client.ts";
import {
  RESERVATION_CACHE_STALE_MS,
  RESERVATION_CACHE_TTL_MS,
  ReservationListCache,
  reservationCacheKey,
} from "../src/reservation-cache.ts";

/**
 * Tempos próprios para os testes de comportamento: a lógica é verificada com
 * valores fixos, e não quebra quando os defaults forem recalibrados.
 * Os defaults têm teste separado, no fim do arquivo.
 */
const T_TTL = 30_000;
const T_STALE = 120_000;

/** Cache com os tempos do teste, independente dos defaults de produção. */
function testCache(now: () => number, patch: { maxEntries?: number } = {}) {
  return new ReservationListCache({ now, ttlMs: T_TTL, staleMs: T_STALE, ...patch });
}

const TOKEN = "test-gateway-token-not-a-real-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const LIST_URL = "/v1/reservations?Type=0&Status=1&InitialDate=2026-09-15&FinalDate=2026-09-18&Page=1&Size=20";

/** Relógio manual: nenhum teste depende de tempo real. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Upstream = {
  calls: number;
  client: HitsReadClient;
};

function upstream(
  handler: (call: number) => Promise<unknown>,
): Upstream {
  const state = { calls: 0 } as Upstream;
  state.client = {
    listReservations: async () => {
      state.calls += 1;
      return handler(state.calls);
    },
    getReservation: async () => ({ idReservation: 1 }),
  };
  return state;
}

async function withApp(
  hitsClient: HitsReadClient,
  listCache: ReservationListCache,
  fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>,
): Promise<void> {
  const app = await buildApp({
    gatewayToken: TOKEN,
    hitsClient,
    logger: false,
    enableRateLimit: false,
    listCache,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("primeira chamada vai ao upstream; segunda dentro de 30s usa cache", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => ({ data: [{ idReservation: 17806, call: n }] }));

  await withApp(up.client, cache, async (app) => {
    const first = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["x-cache"], "miss");
    assert.equal(up.calls, 1);

    clock.advance(29_000);
    const second = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers["x-cache"], "hit");
    assert.equal(up.calls, 1, "não pode tocar o HITS dentro do TTL");
    assert.deepEqual(second.json(), first.json());
  });
});

test("após o TTL a listagem consulta o HITS de novo", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => ({ data: [{ call: n }] }));

  await withApp(up.client, cache, async (app) => {
    await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    clock.advance(31_000);
    const res = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-cache"], "miss");
    assert.equal(up.calls, 2);
  });
});

test("429 do HITS com stale recente devolve stale, sem zerar a tela", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => {
    if (n === 1) return { data: [{ idReservation: 17806 }] };
    throw new HitsApiError("HITS HTTP 429", 429, {
      message: "Too many calls for same reservation page 1",
    });
  });

  await withApp(up.client, cache, async (app) => {
    const first = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(first.statusCode, 200);

    clock.advance(60_000); // fora do TTL, dentro da janela stale
    const res = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-cache"], "stale");
    assert.deepEqual(res.json(), first.json());
    assert.equal(up.calls, 2, "tentou o HITS antes de servir stale");
  });
});

test("429 sem stale mantém o erro mapeado", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async () => {
    throw new HitsApiError("HITS HTTP 429", 429, { message: "Too many calls" });
  });

  await withApp(up.client, cache, async (app) => {
    const res = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(res.statusCode, 429);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.code, "hits_rate_limited");
  });
});

test("stale expirado (>120s) não é servido", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => {
    if (n === 1) return { data: [{ idReservation: 17806 }] };
    throw new HitsApiError("HITS HTTP 429", 429, { message: "Too many calls" });
  });

  await withApp(up.client, cache, async (app) => {
    await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    clock.advance(121_000);
    const res = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(res.statusCode, 429);
  });
});

test("erro 5xx não é cacheado e não serve stale", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => {
    if (n === 1) return { data: [{ idReservation: 17806 }] };
    throw new HitsApiError("HITS HTTP 500", 500, { message: "boom" });
  });

  await withApp(up.client, cache, async (app) => {
    await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    clock.advance(60_000);
    const res = await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    assert.equal(res.statusCode, 502, "só 429 aceita stale");
    assert.equal((res.json() as Record<string, unknown>).code, "hits_server_error");
  });
});

test("parâmetros diferentes geram chaves diferentes", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async (n) => ({ data: [{ call: n }] }));

  await withApp(up.client, cache, async (app) => {
    await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    await app.inject({
      method: "GET",
      url: LIST_URL.replace("Page=1", "Page=2"),
      headers: AUTH,
    });
    await app.inject({
      method: "GET",
      url: LIST_URL.replace("Status=1", "Status=2"),
      headers: AUTH,
    });
    assert.equal(up.calls, 3, "Page e Status fazem parte da chave");
  });

  const base = { type: 0 as const, status: 1 as const, page: 1, size: 20 };
  assert.notEqual(
    reservationCacheKey(base),
    reservationCacheKey({ ...base, size: 100 }),
  );
  assert.notEqual(
    reservationCacheKey(base),
    reservationCacheKey({ ...base, initialDate: "2026-09-15" }),
  );
  assert.equal(reservationCacheKey(base), reservationCacheKey({ ...base }));
});

test("ordem dos parâmetros na querystring não muda a chave", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  const up = upstream(async () => ({ data: [] }));

  await withApp(up.client, cache, async (app) => {
    await app.inject({ method: "GET", url: LIST_URL, headers: AUTH });
    const reordered =
      "/v1/reservations?Size=20&Page=1&FinalDate=2026-09-18&InitialDate=2026-09-15&Status=1&Type=0";
    const res = await app.inject({ method: "GET", url: reordered, headers: AUTH });
    assert.equal(res.headers["x-cache"], "hit");
    assert.equal(up.calls, 1);
  });
});

test("detalhe e escrita nunca usam cache", async () => {
  const clock = fakeClock();
  const cache = testCache(clock.now);
  let detailCalls = 0;
  const client: HitsReadClient = {
    listReservations: async () => ({ data: [] }),
    getReservation: async () => {
      detailCalls += 1;
      return { idReservation: 17806 };
    },
  };

  await withApp(client, cache, async (app) => {
    await app.inject({ method: "GET", url: "/v1/reservations/17806", headers: AUTH });
    await app.inject({ method: "GET", url: "/v1/reservations/17806", headers: AUTH });
    assert.equal(detailCalls, 2, "detalhe não é cacheado");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/v1/reservations", headers: AUTH });
      assert.equal(res.statusCode, 405, `${method} continua bloqueado`);
    }
    assert.equal(cache.size, 0, "nenhuma escrita entrou no cache");
  });
});

test("cache respeita o teto de entradas", () => {
  const clock = fakeClock();
  const cache = testCache(clock.now, { maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) {
    cache.set(reservationCacheKey({ page: i }), { data: [i] });
  }
  assert.equal(cache.size, 3);
  assert.equal(cache.lookup(reservationCacheKey({ page: 0 })).state, "miss");
  assert.equal(cache.lookup(reservationCacheKey({ page: 9 })).state, "fresh");
});

test("defaults de produção: TTL 120s e stale 600s", () => {
  // Calibrado pelos logs do HOMO: a HITS recusava a mesma página aos 31s do
  // último 200 com "Too many calls for same reservation page 1".
  assert.equal(RESERVATION_CACHE_TTL_MS, 120_000);
  assert.equal(RESERVATION_CACHE_STALE_MS, 600_000);

  let now = 1_000_000;
  const cache = new ReservationListCache({ now: () => now });
  const key = reservationCacheKey({ type: 0, status: 1, page: 1, size: 20 });
  cache.set(key, { data: [] });

  // Onde o 429 acontecia antes: 31s agora ainda é fresh, sem tocar a HITS.
  now += 31_000;
  assert.equal(cache.lookup(key).state, "fresh", "31s não pode mais ir à HITS");

  now += 88_000; // 119s
  assert.equal(cache.lookup(key).state, "fresh");

  now += 2_000; // 121s
  assert.equal(cache.lookup(key).state, "stale", "após 120s tenta a HITS");

  now += 478_000; // 599s
  assert.equal(cache.lookup(key).state, "stale", "stale cobre até 600s");

  now += 2_000; // 601s
  assert.equal(cache.lookup(key).state, "miss");
});

test("relógio para trás invalida a entrada em vez de servir algo incerto", () => {
  let now = 1_000_000;
  const cache = new ReservationListCache({ now: () => now });
  const key = reservationCacheKey({ page: 1 });
  cache.set(key, { data: [] });
  now -= 5_000;
  assert.equal(cache.lookup(key).state, "miss");
});
