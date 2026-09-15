/**
 * Testes: retry de falha de rede transitória no transporte HITS.
 * Determinísticos, sem rede (fetch injetado).
 *
 * Invariante crítico: mutação (maxRetries 0) nunca repete, nem em ECONNRESET —
 * a escrita pode ter chegado ao HITS.
 */
import assert from "node:assert/strict";
import {
  createHitsTransport,
  retryableNetworkErrorCode,
  type HitsFetch,
} from "../src/lib/integrations/hits/transport";
import { HitsError } from "../src/lib/integrations/hits/errors";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const URL_LIST = "https://gw.example/v1/reservations?Type=0&Status=1";

/** Reproduz o que o fetch do Node sobe: TypeError com cause.code. */
function fetchFailed(code: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause?: unknown }).cause = Object.assign(new Error(code), {
    code,
    host: "api.hitspms.net",
    port: 443,
  });
  return err;
}

function okResponse(body: unknown = { data: [] }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch que falha nas primeiras `failures` tentativas e depois responde 200. */
function flakyFetch(failures: number, code: string, counter: { n: number }): HitsFetch {
  return async () => {
    counter.n += 1;
    if (counter.n <= failures) throw fetchFailed(code);
    return okResponse();
  };
}

async function main() {
  console.log("\n== Identificação do erro de rede ==");
  {
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]) {
      assert.equal(retryableNetworkErrorCode(fetchFailed(code)), code);
    }
    ok("os seis códigos transitórios são reconhecidos via cause");
  }
  {
    assert.equal(retryableNetworkErrorCode(new Error("qualquer coisa")), null);
    assert.equal(retryableNetworkErrorCode(fetchFailed("ECERTEXPIRED")), null);
    assert.equal(retryableNetworkErrorCode(null), null);
    assert.equal(retryableNetworkErrorCode({ code: 42 }), null);
    ok("erro desconhecido, código fora da lista e não-objeto → null");
  }
  {
    // Cadeia circular não pode travar a detecção.
    const a: Record<string, unknown> = { code: "X" };
    const b: Record<string, unknown> = { code: "Y", cause: a };
    a.cause = b;
    assert.equal(retryableNetworkErrorCode(a), null);
    ok("cadeia de causas circular não entra em laço");
  }

  console.log("\n== Retry no transporte ==");
  {
    const counter = { n: 0 };
    const transport = createHitsTransport(flakyFetch(1, "ECONNRESET", counter));
    const res = await transport.request({
      method: "GET",
      url: URL_LIST,
      timeoutMs: 5_000,
      maxRetries: 2,
    });
    assert.equal(res.httpStatus, 200);
    assert.equal(counter.n, 2, "uma falha + um sucesso");
    ok("ECONNRESET seguido de sucesso: repete e devolve 200");
  }
  {
    const counter = { n: 0 };
    const transport = createHitsTransport(flakyFetch(99, "ECONNRESET", counter));
    await assert.rejects(
      () =>
        transport.request({
          method: "GET",
          url: URL_LIST,
          timeoutMs: 5_000,
          maxRetries: 2,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HitsError, "deve virar HitsError, não TypeError");
        assert.equal(err.code, "network");
        assert.equal(err.retryable, true);
        assert.equal(err.httpStatus, null);
        assert.match(err.message, /ECONNRESET/);
        const details = err.details ?? {};
        assert.equal(details.networkCode, "ECONNRESET");
        // pathHint sem querystring; sem stack; sem host solto no payload.
        assert.equal(details.pathHint, "https://gw.example/v1/reservations");
        assert.equal(JSON.stringify(err.toJSON()).includes("stack"), false);
        return true;
      },
    );
    assert.equal(counter.n, 3, "1 tentativa + 2 retries");
    ok("ECONNRESET até esgotar: HitsError network sanitizado, sem estourar o limite");
  }
  {
    const counter = { n: 0 };
    const transport = createHitsTransport(async () => {
      counter.n += 1;
      throw new Error("colapso desconhecido");
    });
    await assert.rejects(
      () =>
        transport.request({
          method: "GET",
          url: URL_LIST,
          timeoutMs: 5_000,
          maxRetries: 2,
        }),
      /colapso desconhecido/,
    );
    assert.equal(counter.n, 1, "erro desconhecido não pode ser repetido");
    ok("erro desconhecido: uma tentativa só, erro original preservado");
  }
  {
    // Invariante de mutação: PUT/POST usam maxRetries 0.
    const counter = { n: 0 };
    const transport = createHitsTransport(flakyFetch(99, "ECONNRESET", counter));
    await assert.rejects(
      () =>
        transport.request({
          method: "PUT",
          url: "https://gw.example/v1/guests",
          body: { idEntity: 1, idReservation: 1 },
          timeoutMs: 5_000,
          maxRetries: 0,
        }),
      (err: unknown) => err instanceof HitsError && err.code === "network",
    );
    assert.equal(counter.n, 1, "mutação não repete nem em falha de rede");
    ok("PUT com maxRetries 0 não repete em ECONNRESET");
  }
  {
    const counter = { n: 0 };
    const transport = createHitsTransport(flakyFetch(1, "EHOSTUNREACH", counter));
    const res = await transport.request({
      method: "GET",
      url: URL_LIST,
      timeoutMs: 5_000,
      maxRetries: 1,
    });
    assert.equal(res.httpStatus, 200);
    assert.equal(counter.n, 2);
    ok("limite de retries respeitado com outro código transitório");
  }

  console.log(`\nOK test-hits-transport-network-retry (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
