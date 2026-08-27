import assert from "node:assert/strict";
import { test } from "node:test";
import { HitsApiError, HitsError } from "../../../src/lib/integrations/hits/errors.ts";
import {
  createHitsFixtureFetch,
  fixtureGuestsList,
  fixtureReservationDetails,
  fixtureReservationsList,
} from "../../../src/lib/integrations/hits/fixtures.ts";
import type { HitsConfig } from "../../../src/lib/integrations/hits/config.ts";
import {
  HITS_WEBCHECKIN_GUESTS_PUT_PATH,
  hitsWebCheckinGuestsPostPath,
} from "../../../src/lib/integrations/hits/types.ts";
import { buildApp, GATEWAY_BODY_LIMIT_BYTES } from "../src/app.ts";
import { loadGatewayConfig } from "../src/config.ts";
import { createHitsReadClient, type HitsReadClient } from "../src/hits-client.ts";
import {
  HITS_ARRIVING_BY,
  HITS_CONTACT_TYPES,
  HITS_DOCUMENT_TYPES,
  HITS_GENDERS,
  isHitsGuestWriteEnabled,
  parseGuestsPostBody,
  parseGuestsPutBody,
} from "../src/guest-write.ts";

const TOKEN = "test-gateway-token-not-a-real-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECRET = "synthetic-shared-secret-not-real";

function syntheticHitsConfig(overrides: Partial<HitsConfig> = {}): HitsConfig {
  return {
    apiBaseUrl: "https://hits.example.invalid",
    sharedAccessSecret: SECRET,
    propertyId: "00000000-0000-4000-8000-000000000002",
    integrationEnabled: true,
    checkinEnabled: false,
    requestTimeoutMs: 1000,
    apiVersion: "1",
    tenantName: "dev",
    propertyCode: "2",
    partnerUserId: "0",
    clientId: "synthetic-client",
    languageCode: "pt-BR",
    scopes: ["WebCheckIn"],
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
    ...overrides,
  };
}

const validPost = {
  guests: [
    {
      name: "Hospede Sintetico Homolog",
      doc: "00000000000",
      docType: 2,
      contact: "sintetico@example.invalid",
      contactType: 2,
    },
  ],
};

const validPut = {
  idEntity: 700001,
  idReservation: 900001,
  name: "Hospede Sintetico Homolog",
};

async function withApp(
  hitsClient: HitsReadClient | null,
  fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>,
  extra: {
    guestWriteEnabled?: boolean;
    enableRateLimit?: boolean;
    rateLimitMax?: number;
  } = {},
): Promise<void> {
  const app = await buildApp({
    gatewayToken: TOKEN,
    hitsClient,
    secretsToRedact: [TOKEN, SECRET],
    logger: false,
    enableRateLimit: extra.enableRateLimit ?? false,
    rateLimitMax: extra.rateLimitMax,
    guestWriteEnabled: extra.guestWriteEnabled === true,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("escrita bloqueada por padrão (POST e PUT → 403, sem HITS)", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      called += 1;
      return {};
    },
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(mock, async (app) => {
    const post = await app.inject({
      method: "POST",
      url: "/v1/reservations/900001/guests",
      headers: AUTH,
      payload: validPost,
    });
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().code, "guest_write_disabled");

    const put = await app.inject({
      method: "PUT",
      url: "/v1/guests",
      headers: AUTH,
      payload: validPut,
    });
    assert.equal(put.statusCode, 403);
    assert.equal(put.json().code, "guest_write_disabled");
    assert.equal(called, 0);
  });
});

test("flag ativa com tenant diferente de dev continua bloqueada", () => {
  const ready = {
    GATEWAY_TOKEN: TOKEN,
    HITS_API_BASE_URL: "https://hits.example.invalid",
    HITS_SHARED_ACCESS_SECRET: SECRET,
    HITS_PROPERTY_ID: "00000000-0000-4000-8000-000000000002",
    HITS_TENANT_NAME: "prod",
    HITS_PROPERTY_CODE: "2",
    HITS_CLIENT_ID: "synthetic-client",
    HITS_GUEST_WRITE_ENABLED: "true",
  };
  const cfg = loadGatewayConfig(ready);
  assert.equal(cfg.hitsReady, true);
  assert.equal(cfg.guestWriteEnabled, false);

  const sandbox = loadGatewayConfig({
    ...ready,
    HITS_TENANT_NAME: "dev",
  });
  assert.equal(sandbox.guestWriteEnabled, true);
  assert.equal(
    loadGatewayConfig({
      ...ready,
      HITS_TENANT_NAME: "dev",
      HITS_GUEST_WRITE_ENABLED: " true",
    }).guestWriteEnabled,
    false,
  );
  assert.equal(
    loadGatewayConfig({
      ...ready,
      HITS_TENANT_NAME: "dev",
      HITS_GUEST_WRITE_ENABLED: "true ",
    }).guestWriteEnabled,
    false,
  );
  assert.equal(
    loadGatewayConfig({
      ...ready,
      HITS_TENANT_NAME: "dev",
      HITS_GUEST_WRITE_ENABLED: "TRUE",
    }).guestWriteEnabled,
    false,
  );
  assert.equal(
    isHitsGuestWriteEnabled({
      hitsReady: true,
      tenantName: "HOMO",
      guestWriteFlag: "true",
    }),
    false,
  );
  assert.equal(
    isHitsGuestWriteEnabled({
      hitsReady: true,
      tenantName: "DEV",
      guestWriteFlag: "true",
    }),
    true,
  );
  assert.equal(
    isHitsGuestWriteEnabled({
      hitsReady: true,
      tenantName: "dev",
      guestWriteFlag: "TRUE",
    }),
    false,
  );
});

test("POST/PUT sem Authorization retornam 401", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      throw new Error("não deve chamar HITS");
    },
    putGuest: async () => {
      throw new Error("não deve chamar HITS");
    },
  };
  await withApp(
    mock,
    async (app) => {
      const post = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        payload: validPost,
      });
      assert.equal(post.statusCode, 401);
      assert.equal(post.json().code, "unauthorized");

      const put = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        payload: validPut,
      });
      assert.equal(put.statusCode, 401);
      assert.equal(put.json().code, "unauthorized");
    },
    { guestWriteEnabled: true },
  );
});

test("POST válido encaminha path e body oficiais sem idEntity", async () => {
  const captured: { url?: string; method?: string; body?: unknown } = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.includes("/Datashare/WebCheckinOut/Guests")) {
      captured.url = url;
      captured.method = method;
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
    }
    return createHitsFixtureFetch("happy")(input, init);
  }) as typeof fetch;

  const client = createHitsReadClient(syntheticHitsConfig(), { fetchImpl: fetchImpl as never });
  await withApp(
    client,
    async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: {
          guests: [
            {
              name: "Hospede Sintetico Homolog",
              doc: "00000000000",
              docType: 2,
              idEntity: 99,
            },
          ],
        },
      });
      assert.equal(res.statusCode, 400, "idEntity no item deve ser rejeitado antes do HITS");

      const ok = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: validPost,
      });
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.json(), { ok: true, request_id: ok.json().request_id });
      assert.equal(typeof ok.json().request_id, "string");
      assert.equal(ok.body.includes("synthetic"), false);
      assert.equal(captured.method, "POST");
      assert.equal(
        captured.url,
        `https://hits.example.invalid${hitsWebCheckinGuestsPostPath("900001")}`,
      );
      assert.deepEqual(captured.body, validPost);
      assert.equal(JSON.stringify(captured.body).includes("idEntity"), false);
    },
    { guestWriteEnabled: true },
  );
});

test("POST rejeita campo desconhecido", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const extraBody = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: { guests: [{ name: "Sintetico" }], reservationId: 900001 },
      });
      assert.equal(extraBody.statusCode, 400);

      const extraGuest = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: { guests: [{ name: "Sintetico", email: "x@example.invalid" }] },
      });
      assert.equal(extraGuest.statusCode, 400);
      assert.equal(called, 0);
    },
    { guestWriteEnabled: true },
  );
});

test("POST rejeita documento sem docType e vice-versa", async () => {
  assert.equal(parseGuestsPostBody({ guests: [{ name: "A", doc: "1" }] }).ok, false);
  assert.equal(parseGuestsPostBody({ guests: [{ name: "A", docType: 2 }] }).ok, false);
  assert.equal(
    parseGuestsPostBody({ guests: [{ name: "A", doc: "1", docType: 2 }] }).ok,
    true,
  );
});

test("POST rejeita contato sem contactType e vice-versa", async () => {
  assert.equal(
    parseGuestsPostBody({ guests: [{ name: "A", contact: "x@example.invalid" }] }).ok,
    false,
  );
  assert.equal(parseGuestsPostBody({ guests: [{ name: "A", contactType: 1 }] }).ok, false);
  assert.equal(
    parseGuestsPostBody({
      guests: [{ name: "A", contact: "x@example.invalid", contactType: 2 }],
    }).ok,
    true,
  );
});

test("PUT exige idEntity e idReservation positivos", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const missing = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: { name: "Sintetico" },
      });
      assert.equal(missing.statusCode, 400);

      const zero = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: { idEntity: 0, idReservation: 900001, name: "Sintetico" },
      });
      assert.equal(zero.statusCode, 400);

      const neg = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: { idEntity: 1, idReservation: -1, name: "Sintetico" },
      });
      assert.equal(neg.statusCode, 400);
      assert.equal(called, 0);
    },
    { guestWriteEnabled: true },
  );
});

test("PUT exige algum campo para atualização", () => {
  const onlyIds = parseGuestsPutBody({ idEntity: 1, idReservation: 2 });
  assert.equal(onlyIds.ok, false);
  if (!onlyIds.ok) {
    assert.match(onlyIds.message, /atualização/);
  }
});

test("PUT rejeita campos desconhecidos e encaminha DTO válido", async () => {
  const captured: { url?: string; method?: string; body?: unknown } = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.includes("/Datashare/WebCheckinOut/Guests") && method === "PUT") {
      captured.url = url;
      captured.method = method;
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
    }
    return createHitsFixtureFetch("happy")(input, init);
  }) as typeof fetch;
  const client = createHitsReadClient(syntheticHitsConfig(), { fetchImpl: fetchImpl as never });

  await withApp(
    client,
    async (app) => {
      const unknown = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: { ...validPut, unexpected: true },
      });
      assert.equal(unknown.statusCode, 400);

      const ok = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: validPut,
      });
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.json(), { ok: true, request_id: ok.json().request_id });
      assert.equal(typeof ok.json().request_id, "string");
      assert.equal(captured.method, "PUT");
      assert.equal(captured.url, `https://hits.example.invalid${HITS_WEBCHECKIN_GUESTS_PUT_PATH}`);
      assert.deepEqual(captured.body, validPut);
    },
    { guestWriteEnabled: true },
  );
});

test("validação dos enums Swagger V1", () => {
  for (const docType of HITS_DOCUMENT_TYPES) {
    assert.equal(
      parseGuestsPostBody({ guests: [{ name: "A", doc: "x", docType }] }).ok,
      true,
      `docType ${docType}`,
    );
  }
  assert.equal(
    parseGuestsPostBody({ guests: [{ name: "A", doc: "x", docType: 8 }] }).ok,
    false,
  );
  for (const contactType of HITS_CONTACT_TYPES) {
    assert.equal(
      parseGuestsPostBody({
        guests: [{ name: "A", contact: "x@example.invalid", contactType }],
      }).ok,
      true,
    );
  }
  assert.equal(
    parseGuestsPostBody({
      guests: [{ name: "A", contact: "x@example.invalid", contactType: 5 }],
    }).ok,
    false,
  );

  assert.equal(parseGuestsPutBody({ ...validPut, gender: 0 }).ok, true);
  assert.equal(parseGuestsPutBody({ ...validPut, gender: 2 }).ok, false);
  for (const gender of HITS_GENDERS) {
    assert.equal(parseGuestsPutBody({ ...validPut, gender }).ok, true);
  }
  assert.equal(parseGuestsPutBody({ ...validPut, title: 5 }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, lang: 4 }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, purposeTrip: 8 }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, arrivingBy: 6 }).ok, false);
  for (const arrivingBy of HITS_ARRIVING_BY) {
    assert.equal(parseGuestsPutBody({ ...validPut, arrivingBy }).ok, true);
  }
  assert.equal(parseGuestsPutBody({ ...validPut, accessibilityType: 6 }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, accessibilityType: 1 }).ok, true);
});

test("guestForeign aceita boolean e rejeita objeto, string e null", () => {
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: true }).ok, true);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: false }).ok, true);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: { countryId: 1 } }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: "true" }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: null }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: 1 }).ok, false);
  assert.equal(parseGuestsPutBody({ ...validPut, guestForeign: [] }).ok, false);
});

test("notes aceita array e null; rejeita objeto isolado e campos extras", () => {
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      notes: [{ noteTypeId: 1, note: "observacao sintetica" }],
    }).ok,
    true,
  );
  assert.equal(parseGuestsPutBody({ ...validPut, notes: [{ noteTypeId: 1, note: null }] }).ok, true);
  assert.equal(parseGuestsPutBody({ ...validPut, notes: null }).ok, true);
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      notes: { noteTypeId: 1, note: "observacao sintetica" },
    }).ok,
    false,
  );
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      notes: [{ noteTypeId: 1, note: "x", extra: true }],
    }).ok,
    false,
  );
  assert.equal(parseGuestsPutBody({ ...validPut, notes: [{ note: "x" }] }).ok, false);
});

test("addresses aceita array e null; rejeita objeto isolado, primary e extras", () => {
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      addresses: [
        {
          address: "Rua Sintetica",
          zipCode: "00000-000",
          city: "Cidade",
          state: "MS",
          country: "BR",
          number: "0",
          neighborhood: "Centro",
          details: null,
        },
      ],
    }).ok,
    true,
  );
  assert.equal(parseGuestsPutBody({ ...validPut, addresses: null }).ok, true);
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      addresses: {
        address: "Rua Sintetica",
        zipCode: "00000-000",
        city: "Cidade",
        state: "MS",
        country: "BR",
        number: "0",
        neighborhood: "Centro",
        details: "apto",
      },
    }).ok,
    false,
  );
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      addresses: [{ address: "Rua", primary: true }],
    }).ok,
    false,
  );
  assert.equal(
    parseGuestsPutBody({
      ...validPut,
      addresses: [{ address: "Rua", street: "nao-existe" }],
    }).ok,
    false,
  );
});

test("paths oficiais do HITS", () => {
  assert.equal(HITS_WEBCHECKIN_GUESTS_PUT_PATH, "/Datashare/WebCheckinOut/Guests");
  assert.equal(
    hitsWebCheckinGuestsPostPath("900001"),
    "/Datashare/WebCheckinOut/Guests/900001",
  );
});

test("POST e PUT não fazem retry após 503 ou timeout", async () => {
  async function countMutations(kind: "503" | "timeout"): Promise<number> {
    let mutations = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      const isGuestWrite =
        url.includes("/Datashare/WebCheckinOut/Guests") &&
        (method === "POST" || method === "PUT");
      if (isGuestWrite) {
        mutations += 1;
        if (kind === "timeout") {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        return new Response(JSON.stringify({ title: "Server Error" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return createHitsFixtureFetch("happy")(input, init);
    }) as typeof fetch;
    const client = createHitsReadClient(syntheticHitsConfig(), { fetchImpl: fetchImpl as never });
    await withApp(
      client,
      async (app) => {
        const post = await app.inject({
          method: "POST",
          url: "/v1/reservations/900001/guests",
          headers: AUTH,
          payload: validPost,
        });
        const put = await app.inject({
          method: "PUT",
          url: "/v1/guests",
          headers: AUTH,
          payload: validPut,
        });
        if (kind === "503") {
          assert.equal(post.statusCode, 502);
          assert.equal(put.statusCode, 502);
        } else {
          assert.equal(post.statusCode, 504);
          assert.equal(put.statusCode, 504);
        }
      },
      { guestWriteEnabled: true },
    );
    return mutations;
  }

  assert.equal(await countMutations("503"), 2);
  assert.equal(await countMutations("timeout"), 2);
});

test("erros de escrita não vazam secrets nem PII", async () => {
  const pii = "HOSPEDE-REAL-NAO-DEVE-VAZAR";
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      throw new HitsApiError(`falha ${SECRET} token=${TOKEN} nome=${pii}`, 400, {
        name: pii,
        doc: "12345678901",
        authorization: `Bearer ${TOKEN}`,
        HITS_SHARED_ACCESS_SECRET: SECRET,
      });
    },
  };
  await withApp(
    mock,
    async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: validPost,
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().code, "hits_validation_failed");
      const text = res.body;
      assert.equal(text.includes(TOKEN), false);
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(pii), false);
      assert.equal(text.includes("12345678901"), false);
      assert.equal(text.toLowerCase().includes("bearer "), false);
      assert.equal(text.includes("stack"), false);
    },
    { guestWriteEnabled: true },
  );
});

test("HITS 409 → 409 hits_conflict sanitizado", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    putGuest: async () => {
      throw new HitsApiError("HITS HTTP 409", 409, { detail: "duplicate guest" });
    },
  };
  await withApp(
    mock,
    async (app) => {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: validPut,
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, "hits_conflict");
      assert.equal(res.body.includes("duplicate guest"), false);
    },
    { guestWriteEnabled: true },
  );
});

test("GETs existentes continuam funcionando com escrita habilitada", async () => {
  const client = createHitsReadClient(syntheticHitsConfig(), {
    fetchImpl: createHitsFixtureFetch("happy") as never,
  });
  await withApp(
    client,
    async (app) => {
      const list = await app.inject({
        method: "GET",
        url: "/v1/reservations?Type=2&Status=1",
        headers: AUTH,
      });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json(), fixtureReservationsList);

      const detail = await app.inject({
        method: "GET",
        url: "/v1/reservations/900001",
        headers: AUTH,
      });
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(detail.json(), fixtureReservationDetails);

      const guests = await app.inject({
        method: "GET",
        url: "/v1/guests?EntityId=700001",
        headers: AUTH,
      });
      assert.equal(guests.statusCode, 200);
      assert.deepEqual(guests.json(), fixtureGuestsList);
    },
    { guestWriteEnabled: true },
  );
});

test("HITS 400 em GET preserva o mapeamento anterior", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new HitsApiError("HITS HTTP 400", 400, {
        name: "HOSPEDE-GET-NAO-DEVE-VAZAR",
        detail: "bad request",
      });
    },
    getReservation: async () => ({}),
  };
  await withApp(mock, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reservations",
      headers: AUTH,
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().code, "hits_bad_request");
    assert.equal(res.body.includes("HOSPEDE-GET-NAO-DEVE-VAZAR"), false);
  });
});

test("POST/PUT de sucesso não expõem body nem PII do HITS", async () => {
  const upstreamPii = "HOSPEDE-UPSTREAM-NAO-DEVE-APARECER";
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => ({
      name: upstreamPii,
      doc: "99999999999",
      contact: "vazamento@example.invalid",
      addresses: [{ address: "Rua vazamento" }],
    }),
    putGuest: async () => ({
      name: upstreamPii,
      doc: "88888888888",
      token: TOKEN,
    }),
  };
  await withApp(
    mock,
    async (app) => {
      const post = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: validPost,
      });
      assert.equal(post.statusCode, 200);
      assert.deepEqual(Object.keys(post.json()).sort(), ["ok", "request_id"]);
      assert.equal(post.json().ok, true);
      assert.equal(post.body.includes(upstreamPii), false);
      assert.equal(post.body.includes("99999999999"), false);
      assert.equal(post.body.includes("vazamento@example.invalid"), false);
      assert.equal(post.body.includes("Rua vazamento"), false);

      const put = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: validPut,
      });
      assert.equal(put.statusCode, 200);
      assert.deepEqual(Object.keys(put.json()).sort(), ["ok", "request_id"]);
      assert.equal(put.json().ok, true);
      assert.equal(put.body.includes(upstreamPii), false);
      assert.equal(put.body.includes("88888888888"), false);
      assert.equal(put.body.includes(TOKEN), false);
    },
    { guestWriteEnabled: true },
  );
});

test("HITS 400 em escrita vira 422; HITS 409 em escrita vira 409", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      throw new HitsApiError("HITS HTTP 400", 400, { name: "PAX-NAO-VAZAR" });
    },
    putGuest: async () => {
      throw new HitsApiError("HITS HTTP 409", 409, { detail: "duplicate guest" });
    },
  };
  await withApp(
    mock,
    async (app) => {
      const post = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: AUTH,
        payload: validPost,
      });
      assert.equal(post.statusCode, 422);
      assert.equal(post.json().code, "hits_validation_failed");
      assert.equal(post.body.includes("PAX-NAO-VAZAR"), false);

      const put = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: validPut,
      });
      assert.equal(put.statusCode, 409);
      assert.equal(put.json().code, "hits_conflict");
      assert.equal(put.body.includes("duplicate guest"), false);
    },
    { guestWriteEnabled: true },
  );
});

test("timeout de escrita mapeia HitsError timeout", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    putGuest: async () => {
      throw new HitsError({
        code: "timeout",
        message: "Timeout HITS após 1000ms.",
        httpStatus: null,
        retryable: true,
      });
    },
  };
  await withApp(
    mock,
    async (app) => {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: AUTH,
        payload: validPut,
      });
      assert.equal(res.statusCode, 504);
      assert.equal(res.json().code, "gateway_timeout");
    },
    { guestWriteEnabled: true },
  );
});

test("HITS_GUEST_WRITE_ENABLED exige valor bruto exatamente true", () => {
  const base = {
    GATEWAY_TOKEN: TOKEN,
    HITS_API_BASE_URL: "https://hits.example.invalid",
    HITS_SHARED_ACCESS_SECRET: SECRET,
    HITS_PROPERTY_ID: "00000000-0000-4000-8000-000000000002",
    HITS_TENANT_NAME: "dev",
    HITS_PROPERTY_CODE: "2",
    HITS_CLIENT_ID: "synthetic-client",
  };
  assert.equal(
    loadGatewayConfig({ ...base, HITS_GUEST_WRITE_ENABLED: "true" }).guestWriteEnabled,
    true,
  );
  assert.equal(
    loadGatewayConfig({ ...base, HITS_GUEST_WRITE_ENABLED: " true" }).guestWriteEnabled,
    false,
  );
  assert.equal(
    loadGatewayConfig({ ...base, HITS_GUEST_WRITE_ENABLED: "true " }).guestWriteEnabled,
    false,
  );
  assert.equal(
    loadGatewayConfig({ ...base, HITS_GUEST_WRITE_ENABLED: "TRUE" }).guestWriteEnabled,
    false,
  );
  assert.equal(
    loadGatewayConfig({ ...base, HITS_GUEST_WRITE_ENABLED: "true\n" }).guestWriteEnabled,
    false,
  );
});

test("JSON inválido ou body vazio nas rotas com body → 400 sanitizado, sem HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      called += 1;
      return {};
    },
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const jsonHeaders = {
        ...AUTH,
        "content-type": "application/json",
      };
      const invalidPost = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: jsonHeaders,
        payload: "{not-json",
      });
      assert.equal(invalidPost.statusCode, 400);
      assert.equal(invalidPost.json().code, "bad_request");
      assert.equal(invalidPost.json().ok, false);
      assert.equal(invalidPost.body.includes("FST_ERR"), false);
      assert.equal(invalidPost.body.includes("stack"), false);
      assert.equal(invalidPost.body.toLowerCase().includes("syntax"), false);
      assert.equal(invalidPost.body.includes(TOKEN), false);

      const emptyPut = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: jsonHeaders,
        payload: "",
      });
      assert.equal(emptyPut.statusCode, 400);
      assert.equal(emptyPut.json().code, "bad_request");
      assert.equal(emptyPut.body.includes("cannot be empty"), false);
      assert.equal(called, 0);
    },
    { guestWriteEnabled: true },
  );
});

test("content-type incompatível nas rotas com body → 415, sem HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      called += 1;
      return {};
    },
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/reservations/900001/guests",
        headers: { ...AUTH, "content-type": "application/xml" },
        payload: "<guests/>",
      });
      assert.equal(res.statusCode, 415);
      assert.equal(res.json().code, "unsupported_media_type");
      assert.equal(res.body.includes("Unsupported Media Type"), false);
      assert.equal(res.body.includes(TOKEN), false);
      assert.equal(called, 0);
    },
    { guestWriteEnabled: true },
  );
});

test("body acima do limite → 413 sanitizado, sem HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    postReservationGuests: async () => {
      called += 1;
      return {};
    },
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const oversized = `{"name":"${"x".repeat(GATEWAY_BODY_LIMIT_BYTES)}}`;
      const res = await app.inject({
        method: "PUT",
        url: "/v1/guests",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: oversized,
      });
      assert.equal(res.statusCode, 413);
      assert.equal(res.json().code, "payload_too_large");
      assert.equal(res.body.includes("too large"), false);
      assert.equal(res.body.includes("stack"), false);
      assert.equal(res.body.includes(TOKEN), false);
      assert.equal(called, 0);
    },
    { guestWriteEnabled: true },
  );
});

test("429 em rota com body permanece rate_limited sanitizado, sem HITS extra", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    putGuest: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(
    mock,
    async (app) => {
      const hit = () =>
        app.inject({
          method: "PUT",
          url: "/v1/guests",
          headers: AUTH,
          payload: validPut,
        });
      const first = await hit();
      assert.equal(first.statusCode, 200);
      const blocked = await hit();
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().code, "rate_limited");
      assert.equal(blocked.json().retryable, true);
      assert.equal(blocked.body.includes("stack"), false);
      assert.equal(called, 1);
    },
    { guestWriteEnabled: true, enableRateLimit: true, rateLimitMax: 1 },
  );
});
