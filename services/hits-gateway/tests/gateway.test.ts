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
import { GATEWAY_VERSION } from "../src/version.ts";
import { buildApp } from "../src/app.ts";
import { createHitsReadClient, type HitsReadClient } from "../src/hits-client.ts";
import {
  parseGuestListQuery,
  parseReservationId,
  parseReservationListQuery,
} from "../src/query.ts";
import { loadGatewayConfig } from "../src/config.ts";

const TOKEN = "test-gateway-token-not-a-real-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function syntheticHitsConfig(): HitsConfig {
  return {
    apiBaseUrl: "https://hits.example.invalid",
    sharedAccessSecret: "synthetic-shared-secret-not-real",
    propertyId: "00000000-0000-4000-8000-000000000002",
    integrationEnabled: true,
    checkinEnabled: false,
    requestTimeoutMs: 1000,
    apiVersion: "1",
    tenantName: "synthetic-tenant",
    propertyCode: "2",
    partnerUserId: "0",
    clientId: "synthetic-client",
    languageCode: "pt-BR",
    scopes: ["WebCheckIn"],
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
  };
}

async function withApp(
  hitsClient: HitsReadClient | null,
  fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>,
  extra: { enableRateLimit?: boolean; rateLimitMax?: number } = {},
): Promise<void> {
  const app = await buildApp({
    gatewayToken: TOKEN,
    hitsClient,
    secretsToRedact: [TOKEN, "synthetic-shared-secret-not-real"],
    logger: false,
    enableRateLimit: extra.enableRateLimit ?? false,
    rateLimitMax: extra.rateLimitMax,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("GET /health sem token: 200, resposta mínima sem secrets", async () => {
  await withApp(null, async (app) => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      status: "ok",
      service: "hits-gateway",
      version: GATEWAY_VERSION,
    });
    const text = res.body;
    assert.equal(text.includes(TOKEN), false);
    assert.equal("hits_ready" in body, false);
    assert.equal("ok" in body, false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "env"), false);
    assert.equal(text.toLowerCase().includes("secret"), false);
    assert.equal(text.includes("Authorization"), false);
    assert.equal(text.includes("property"), false);
  });
});

test("GET /v1/reservations sem Authorization → 401", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new Error("não deve chamar HITS");
    },
    getReservation: async () => {
      throw new Error("não deve chamar HITS");
    },
  };
  await withApp(mock, async (app) => {
    const res = await app.inject({ method: "GET", url: "/v1/reservations" });
    assert.equal(res.statusCode, 401);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.code, "unauthorized");
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
  });
});

test("token incorreto → 401", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new Error("não deve chamar HITS");
    },
    getReservation: async () => {
      throw new Error("não deve chamar HITS");
    },
  };
  await withApp(mock, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reservations",
      headers: { authorization: "Bearer wrong-token-value-xxxx" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "unauthorized");
  });
});

test("token válido → HitsClient real com fetch mockado (lista)", async () => {
  const client = createHitsReadClient(syntheticHitsConfig(), {
    fetchImpl: createHitsFixtureFetch("happy") as never,
  });
  await withApp(client, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reservations?Type=2&Status=1&foo=bar",
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body, fixtureReservationsList);
  });
});

test("GET /v1/reservations/:id com id válido (HitsClient mockado)", async () => {
  const client = createHitsReadClient(syntheticHitsConfig(), {
    fetchImpl: createHitsFixtureFetch("happy") as never,
  });
  await withApp(client, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reservations/900001",
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), fixtureReservationDetails);
  });
});

test("GET /v1/guests com token válido consulta o HitsClient", async () => {
  const client = createHitsReadClient(syntheticHitsConfig(), {
    fetchImpl: createHitsFixtureFetch("happy") as never,
  });
  await withApp(client, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/guests?EntityId=700001&Page=0&Size=100&ignored=value",
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), fixtureGuestsList);
  });
});

test("GET /v1/guests rejeita filtros inválidos sem chamar HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    listGuests: async () => {
      called += 1;
      return [];
    },
  };
  await withApp(mock, async (app) => {
    const badDocType = await app.inject({
      method: "GET",
      url: "/v1/guests?DocType=9",
      headers: AUTH,
    });
    assert.equal(badDocType.statusCode, 400);

    const badDoc = await app.inject({
      method: "GET",
      url: "/v1/guests?Doc=123%26redirect%3Dhttps%3A%2F%2Fevil.example",
      headers: AUTH,
    });
    assert.equal(badDoc.statusCode, 400);
    assert.equal(called, 0);
  });
});

test("GET /v1/reservations/:id rejeita id inválido", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => {
      called += 1;
      return [];
    },
    getReservation: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(mock, async (app) => {
    const slash = await app.inject({
      method: "GET",
      url: "/v1/reservations/abc/def",
      headers: AUTH,
    });
    assert.equal(slash.statusCode, 404);

    const dots = await app.inject({
      method: "GET",
      url: "/v1/reservations/..",
      headers: AUTH,
    });
    // Fastify normaliza ".." fora da rota :id → 404, sem encaminhar ao HITS.
    assert.equal(dots.statusCode, 404);

    const bang = await app.inject({
      method: "GET",
      url: "/v1/reservations/id!",
      headers: AUTH,
    });
    assert.equal(bang.statusCode, 400);
    assert.equal(called, 0);
  });
});

test("erro upstream → resposta sanitizada sem stack", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new HitsApiError("HITS HTTP 500 em GET https://hits.example.invalid/Datashare", 500, {
        title: "Server Error",
        stack: "Error: secret-stack",
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
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.code, "hits_server_error");
    const text = res.body;
    assert.equal(text.includes("secret-stack"), false);
    assert.equal(text.includes("stack"), false);
    assert.equal(text.includes("hits.example.invalid"), false);
  });
});

test("timeout upstream → 504", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new HitsError({
        code: "timeout",
        message: "Timeout HITS após 1000ms.",
        httpStatus: null,
        retryable: true,
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
    assert.equal(res.statusCode, 504);
    assert.equal(res.json().code, "gateway_timeout");
    assert.equal(res.json().retryable, true);
  });
});

test("POST/PUT/PATCH/DELETE em reservas → 405 e não chama HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => {
      called += 1;
      return [];
    },
    getReservation: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(mock, async (app) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const list = await app.inject({ method, url: "/v1/reservations", headers: AUTH });
      assert.equal(list.statusCode, 405, method);
      assert.equal(list.json().code, "method_not_allowed");

      const detail = await app.inject({
        method,
        url: "/v1/reservations/900001",
        headers: AUTH,
      });
      assert.equal(detail.statusCode, 405, `${method} detail`);
    }
    assert.equal(called, 0);
  });
});

test("POST/PATCH/DELETE em /v1/guests → 405; PUT padrão → 403 sem chamar HITS", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
    listGuests: async () => {
      called += 1;
      return [];
    },
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
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/v1/guests", headers: AUTH });
      assert.equal(res.statusCode, 405, method);
      assert.equal(res.json().code, "method_not_allowed");
    }
    const put = await app.inject({
      method: "PUT",
      url: "/v1/guests",
      headers: AUTH,
      payload: { idEntity: 1, idReservation: 2, name: "Sintético" },
    });
    assert.equal(put.statusCode, 403);
    assert.equal(put.json().code, "guest_write_disabled");
    assert.equal(called, 0);
  });
});

test("rotas HITS cruas não existem no gateway", async () => {
  let called = 0;
  const mock: HitsReadClient = {
    listReservations: async () => {
      called += 1;
      return [];
    },
    getReservation: async () => {
      called += 1;
      return {};
    },
  };
  await withApp(mock, async (app) => {
    const authorize = await app.inject({
      method: "POST",
      url: "/Authorize",
      headers: AUTH,
      payload: { secret: "should-not-forward" },
    });
    assert.equal(authorize.statusCode, 404);

    const datashare = await app.inject({
      method: "GET",
      url: "/Datashare/WebCheckinOut/Reservations",
      headers: AUTH,
    });
    assert.equal(datashare.statusCode, 404);
    assert.equal(called, 0);
  });
});

test("sem credenciais HITS → 503 autenticado", async () => {
  await withApp(null, async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reservations",
      headers: AUTH,
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "hits_not_configured");
  });
});

test("query allowlist: Type inválido 400; extras ignorados", () => {
  const bad = parseReservationListQuery({ Type: "9" });
  assert.equal(bad.ok, false);

  const ok = parseReservationListQuery({
    Type: "2",
    Status: "1",
    InitialDate: "2026-03-01",
    FinalDate: "2026-03-31",
    Page: "0",
    Size: "20",
    foo: "bar",
    url: "https://evil.example",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.value, {
      type: 2,
      status: 1,
      initialDate: "2026-03-01",
      finalDate: "2026-03-31",
      page: 0,
      size: 20,
    });
  }
});

test("query de hóspedes: allowlist, enums e teto de paginação", () => {
  assert.equal(parseGuestListQuery({ DocType: "9" }).ok, false);
  assert.equal(parseGuestListQuery({ EntityId: "abc" }).ok, false);
  assert.equal(parseGuestListQuery({ Email: "invalido" }).ok, false);

  const ok = parseGuestListQuery({
    EntityId: "700001",
    Since: "2026-08-19T10:30:00Z",
    DocType: "2",
    Doc: "123.456.789-00",
    Email: "guest@example.invalid",
    Page: "0",
    Size: "999",
    url: "https://evil.example",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.value, {
      entityId: "700001",
      since: "2026-08-19T10:30:00Z",
      docType: 2,
      doc: "123.456.789-00",
      email: "guest@example.invalid",
      page: 0,
      size: 100,
    });
  }
});

test("parseReservationId", () => {
  assert.equal(parseReservationId("900001").ok, true);
  assert.equal(parseReservationId("").ok, false);
  assert.equal(parseReservationId("../etc").ok, false);
  assert.equal(parseReservationId("a/b").ok, false);
});

test("loadGatewayConfig não defaulta URL de produção e não liga check-in", () => {
  const cfg = loadGatewayConfig({
    GATEWAY_TOKEN: TOKEN,
    NODE_ENV: "test",
  });
  assert.equal(cfg.hitsReady, false);
  assert.equal(cfg.hits.apiBaseUrl, "");
  assert.equal(cfg.hits.checkinEnabled, false);
  assert.equal(cfg.hits.integrationEnabled, false);
  assert.equal(cfg.guestWriteEnabled, false);
  assert.equal(cfg.port, 3001);
});

test("loadGatewayConfig ready só com contrato confirmado", () => {
  const cfg = loadGatewayConfig({
    GATEWAY_TOKEN: TOKEN,
    HITS_API_BASE_URL: "https://hits.example.invalid",
    HITS_SHARED_ACCESS_SECRET: "synthetic-shared-secret-not-real",
    HITS_PROPERTY_ID: "00000000-0000-4000-8000-000000000002",
    HITS_TENANT_NAME: "synthetic-tenant",
    HITS_PROPERTY_CODE: "2",
    HITS_CLIENT_ID: "synthetic-client",
  });
  assert.equal(cfg.hitsReady, true);
  assert.equal(cfg.hits.integrationEnabled, true);
  assert.equal(cfg.hits.checkinEnabled, false);
  assert.equal(cfg.guestWriteEnabled, false);
  assert.equal(cfg.hits.apiBaseUrl, "https://hits.example.invalid");
});

test("trustProxy restrito: X-Forwarded-For de IP não confiável não spoofa rate-limit", async () => {
  const mock: HitsReadClient = {
    listReservations: async () => [],
    getReservation: async () => ({}),
  };
  await withApp(
    mock,
    async (app) => {
      const hit = async (xff: string) =>
        app.inject({
          method: "GET",
          url: "/v1/reservations",
          remoteAddress: "203.0.113.10",
          headers: { "x-forwarded-for": xff },
        });
      for (let i = 0; i < 3; i += 1) {
        const res = await hit(`198.51.100.${i}`);
        assert.equal(res.statusCode, 401);
      }
      const blocked = await hit("198.51.100.99");
      assert.equal(blocked.statusCode, 429);
    },
    { enableRateLimit: true, rateLimitMax: 3 },
  );
});

test("erro autenticado não ecoa GATEWAY_TOKEN nem secret HITS", async () => {
  const secret = "synthetic-shared-secret-not-real";
  const mock: HitsReadClient = {
    listReservations: async () => {
      throw new HitsApiError(`falha ${secret} token=${TOKEN}`, 500, {
        authorization: `Bearer ${TOKEN}`,
        HITS_SHARED_ACCESS_SECRET: secret,
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
    assert.equal(res.body.includes(TOKEN), false);
    assert.equal(res.body.includes(secret), false);
    assert.equal(res.body.toLowerCase().includes("bearer "), false);
  });
});
