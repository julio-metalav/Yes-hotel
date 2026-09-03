/**
 * Ciclo de vida do token HITS — tempo e barreiras controlados, sem rede real.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HitsClient,
  HITS_SESSION_SAFE_TTL_MS,
} from "../../../src/lib/integrations/hits/client.ts";
import { HitsApiError } from "../../../src/lib/integrations/hits/errors.ts";
import {
  createHitsFixtureFetch,
  fixtureAuthorizeApproved,
  fixtureReservationsList,
} from "../../../src/lib/integrations/hits/fixtures.ts";
import type { HitsConfig } from "../../../src/lib/integrations/hits/config.ts";

const SECRET = "synthetic-shared-secret-not-real";
const HITS_TOKEN = fixtureAuthorizeApproved.token;

function syntheticHitsConfig(): HitsConfig {
  return {
    apiBaseUrl: "https://hits.example.invalid",
    sharedAccessSecret: SECRET,
    propertyId: "00000000-0000-4000-8000-000000000002",
    integrationEnabled: true,
    checkinEnabled: false,
    requestTimeoutMs: 1000,
    apiVersion: "1",
    tenantName: "develop",
    propertyCode: "2",
    partnerUserId: "0",
    clientId: "synthetic-client",
    languageCode: "pt-BR",
    scopes: ["WebCheckIn"],
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertNoSensitiveText(text: string): void {
  const lower = text.toLowerCase();
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(HITS_TOKEN), false);
  assert.equal(lower.includes("bearer "), false);
}

type CallLog = {
  authorize: number;
  datashareGet: number;
  guestPost: number;
  guestPut: number;
};

function createGate(): { arrived: Promise<void>; wait: Promise<void>; signal: () => void; open: () => void } {
  let signal!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { arrived, wait, signal, open };
}

function createClock(startMs = 1_700_000_000_000): { now: () => number; set: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
  };
}

function createRecordingFetch(
  handler: (ctx: { url: string; method: string }) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; log: CallLog } {
  const log: CallLog = {
    authorize: 0,
    datashareGet: 0,
    guestPost: 0,
    guestPut: 0,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.includes("/Authorize") && method === "POST") log.authorize += 1;
    if (url.includes("/Datashare/") && method === "GET") log.datashareGet += 1;
    if (url.includes("/Datashare/WebCheckinOut/Guests") && method === "POST") {
      log.guestPost += 1;
    }
    if (method === "PUT" && /\/Datashare\/WebCheckinOut\/Guests\/?(?:\?|$)/.test(url)) {
      log.guestPut += 1;
    }
    return handler({ url, method });
  }) as typeof fetch;
  return { fetchImpl, log };
}

const validPost = {
  guests: [
    {
      name: "Hospede Sintetico Homolog",
      doc: "00000000000",
      docType: 2 as const,
      contact: "sintetico@example.invalid",
      contactType: 2 as const,
    },
  ],
};

const validPut = {
  idEntity: 700001,
  idReservation: 900001,
  name: "Hospede Sintetico Homolog",
};

test("token dentro de 3h45 é reutilizado; no limite e após 3h45 ocorre nova autorização", async () => {
  const clock = createClock();
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
    now: clock.now,
  });

  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 1);
  assert.equal(log.datashareGet, 1);

  clock.set(clock.now() + HITS_SESSION_SAFE_TTL_MS - 1);
  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 1, "ainda dentro da janela: reutiliza o token");
  assert.equal(log.datashareGet, 2);

  clock.set(clock.now() + 1);
  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 2, "no limite de 3h45: nova autorização");
  assert.equal(log.datashareGet, 3);

  clock.set(clock.now() + HITS_SESSION_SAFE_TTL_MS + 1);
  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 3, "após 3h45: não reutiliza");
  assert.equal(log.datashareGet, 4);
});

test("duas requisições simultâneas sem sessão compartilham a mesma autorização", async () => {
  const authorizeGate = createGate();
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      authorizeGate.signal();
      await authorizeGate.wait;
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  const first = client.listWebCheckinReservations();
  await authorizeGate.arrived;
  const second = client.listWebCheckinReservations();
  assert.equal(log.authorize, 1, "autorização única em andamento");
  authorizeGate.open();
  const [a, b] = await Promise.all([first, second]);
  assert.ok(Array.isArray(a));
  assert.ok(Array.isArray(b));
  assert.equal(log.authorize, 1);
  assert.equal(log.datashareGet, 2);
});

test("HTTP 401 invalida a sessão, não repete a operação e a próxima requisição autoriza de novo", async () => {
  let datasharePhase = 0;
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    if (url.includes("/Datashare/WebCheckinOut/Reservations") && method === "GET") {
      datasharePhase += 1;
      if (datasharePhase === 1) {
        return jsonResponse(401, { title: "Unauthorized", detail: "expired (synthetic)" });
      }
      return jsonResponse(200, fixtureReservationsList);
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  await assert.rejects(
    () => client.listWebCheckinReservations(),
    (error: unknown) => {
      assert.ok(error instanceof HitsApiError);
      assert.equal(error.status, 401);
      assertNoSensitiveText(JSON.stringify(error.toJSON()));
      return true;
    },
  );
  assert.equal(log.authorize, 1);
  assert.equal(log.datashareGet, 1, "a operação 401 não é repetida");

  const list = await client.listWebCheckinReservations();
  assert.equal((list as unknown[]).length, fixtureReservationsList.length);
  assert.equal(log.authorize, 2, "próxima requisição independente obtém token novo");
  assert.equal(log.datashareGet, 2);
});

test("401 tardio da sessão A não apaga a sessão B", async () => {
  const first401 = createGate();
  const late401 = createGate();
  const lateHolds = [first401, late401];
  let sessionAReady = false;

  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    if (url.includes("/Datashare/WebCheckinOut/Reservations") && method === "GET") {
      if (!sessionAReady) {
        return jsonResponse(200, fixtureReservationsList);
      }
      const hold = lateHolds.shift();
      if (hold) {
        hold.signal();
        await hold.wait;
        return jsonResponse(401, { title: "Unauthorized", detail: "stale session A (synthetic)" });
      }
      return jsonResponse(200, fixtureReservationsList);
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 1);
  sessionAReady = true;

  const r1 = client.listWebCheckinReservations();
  const r2 = client.listWebCheckinReservations();
  await Promise.all([first401.arrived, late401.arrived]);

  const settled = (p: Promise<unknown>, id: string) =>
    p.then(
      () => ({ id, ok: true as const }),
      (error: unknown) => ({ id, ok: false as const, error }),
    );
  const r1Settled = settled(r1, "r1");
  const r2Settled = settled(r2, "r2");

  first401.open();
  const firstDone = await Promise.race([r1Settled, r2Settled]);
  assert.equal(firstDone.ok, false);
  assert.ok(firstDone.error instanceof HitsApiError);
  assert.equal(firstDone.error.status, 401);

  const withB = await client.listWebCheckinReservations();
  assert.ok(Array.isArray(withB));
  assert.equal(log.authorize, 2, "Authorize só para A e B");

  late401.open();
  const lateDone = firstDone.id === "r1" ? await r2Settled : await r1Settled;
  assert.equal(lateDone.ok, false);
  assert.ok(lateDone.error instanceof HitsApiError);
  assert.equal(lateDone.error.status, 401);

  const reusedB = await client.listWebCheckinReservations();
  assert.ok(Array.isArray(reusedB));
  assert.equal(log.authorize, 2, "401 tardio de A não apagou B");
  assert.equal(log.datashareGet, 5);
  assert.equal(log.guestPost, 0);
  assert.equal(log.guestPut, 0);
});

test("falha de autorização limpa a promessa e permite tentativa futura independente", async () => {
  let authorizePhase = 0;
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      authorizePhase += 1;
      if (authorizePhase === 1) {
        return jsonResponse(401, { title: "Unauthorized", detail: "secret rejected (synthetic)" });
      }
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  await assert.rejects(() => client.listWebCheckinReservations(), (error: unknown) => {
    assert.ok(error instanceof HitsApiError);
    assert.equal(error.status, 401);
    assertNoSensitiveText(String(error.message));
    return true;
  });
  assert.equal(log.authorize, 1);
  assert.equal(log.datashareGet, 0);

  const list = await client.listWebCheckinReservations();
  assert.ok(Array.isArray(list));
  assert.equal(log.authorize, 2);
  assert.equal(log.datashareGet, 1);
});

test("authorize() direto malsucedido não destrói sessão válida anterior", async () => {
  let authorizePhase = 0;
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      authorizePhase += 1;
      if (authorizePhase === 2) {
        return jsonResponse(401, { title: "Unauthorized", detail: "direct authorize failed (synthetic)" });
      }
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 1);
  assert.equal(log.datashareGet, 1);

  await assert.rejects(() => client.authorize(), (error: unknown) => {
    assert.ok(error instanceof HitsApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(log.authorize, 2);

  await client.listWebCheckinReservations();
  assert.equal(log.authorize, 2, "sessão A anterior foi preservada");
  assert.equal(log.datashareGet, 2);
});

test("POST e PUT de hóspedes não repetem após 401", async () => {
  const { fetchImpl, log } = createRecordingFetch(async ({ url, method }) => {
    if (url.includes("/Authorize") && method === "POST") {
      return jsonResponse(200, fixtureAuthorizeApproved);
    }
    if (url.includes("/Datashare/WebCheckinOut/Guests") && (method === "POST" || method === "PUT")) {
      return jsonResponse(401, { title: "Unauthorized" });
    }
    return createHitsFixtureFetch("happy")(url, { method });
  });
  const client = new HitsClient({
    config: syntheticHitsConfig(),
    fetchImpl,
  });

  await assert.rejects(() => client.postWebCheckinGuests("900001", validPost));
  assert.equal(log.guestPost, 1);
  assert.equal(log.authorize, 1);

  await assert.rejects(() => client.putWebCheckinGuests(validPut));
  assert.equal(log.guestPut, 1);
  assert.equal(log.authorize, 2, "PUT é requisição independente, não retry do POST");
  assert.equal(log.guestPost, 1);
  assert.equal(log.guestPut, 1);
});
