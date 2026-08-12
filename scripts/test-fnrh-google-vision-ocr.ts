/**
 * Testes Google Vision OCR + factory + normalize + fail-safe.
 * Sem I/O real; fetch/token mockados. Sem secrets reais.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  FNRH_OCR_GOOGLE_MODEL,
  FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
  resolveFnrhOcrModelMeta,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-confidence";
import {
  canRunNewOcrAttempt,
  sha256HexOfBytes,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-idempotency";
import {
  extractExplicitValidCpf,
  isValidCpf,
  normalizeGoogleVisionText,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-normalize-google";
import {
  createFnrhOcrProvider,
  NoopFnrhOcrProvider,
  resolveFnrhOcrProviderName,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-port";
import { GoogleVisionOcrProvider } from "../src/lib/domain/yes-hotel/fnrh-ocr-google-vision";
import { AzureDocumentIntelligenceOcrProvider } from "../src/lib/domain/yes-hotel/fnrh-ocr-azure";
import {
  shouldApplySuggestedValue,
  preferFieldOrigin,
} from "../src/lib/domain/yes-hotel/fnrh-field-provenance";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

/** CPF válido conhecido (checksum ok) — sintético, não é identidade real de terceiro. */
const VALID_CPF = "52998224725";
const INVALID_CPF = "11111111111";

function mockFetchSequence(
  steps: Array<{
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
    text?: string;
  }>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: {
        get(name: string) {
          const key = Object.keys(step.headers || {}).find(
            (k) => k.toLowerCase() === name.toLowerCase(),
          );
          return key ? step.headers![key] : null;
        },
      },
      async json() {
        return step.json ?? {};
      },
      async text() {
        return step.text ?? JSON.stringify(step.json ?? {});
      },
    } as Response;
  }) as typeof fetch;
}

function visionSuccessBody(fullText: string) {
  return {
    responses: [
      {
        fullTextAnnotation: {
          text: fullText,
          pages: [{ property: {} }],
        },
      },
    ],
  };
}

function samplePkcs8Pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

function assertNoSecretLeak(payload: unknown, secrets: string[]) {
  const dumped = JSON.stringify(payload);
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    assert.equal(dumped.includes(s), false, "secret leaked in payload");
  }
}

async function main() {
  console.log("\n=== FNRH Google Vision OCR ===\n");

  const pem = samplePkcs8Pem();
  const fakeSecrets = {
    projectId: "yes-hotel-ocr",
    email: "yes-hotel-vision-ocr@yes-hotel-ocr.iam.gserviceaccount.com",
    key: pem,
  };

  // 1 OCR OFF → noop
  {
    const p = createFnrhOcrProvider({
      enabled: false,
      provider: "google",
      googleProjectId: fakeSecrets.projectId,
      googleClientEmail: fakeSecrets.email,
      googlePrivateKey: fakeSecrets.key,
    });
    assert.ok(p instanceof NoopFnrhOcrProvider);
    ok("1 OCR OFF → noop");
  }

  // 2 google + secrets → Google provider
  {
    assert.equal(resolveFnrhOcrProviderName("google"), "google");
    assert.equal(resolveFnrhOcrProviderName("google_vision"), "google");
    const p = createFnrhOcrProvider({
      enabled: true,
      provider: "google",
      googleProjectId: fakeSecrets.projectId,
      googleClientEmail: fakeSecrets.email,
      googlePrivateKey: fakeSecrets.key,
      googleAccessTokenProvider: async () => "test-token",
      fetchImpl: mockFetchSequence([{ status: 200, json: visionSuccessBody("NOME: TESTE") }]),
    });
    assert.ok(p instanceof GoogleVisionOcrProvider);
    assert.equal(p.name, "google");
    ok("2 provider google + secrets → Google provider");
  }

  // 3 google + secret ausente → noop
  {
    const p = createFnrhOcrProvider({
      enabled: true,
      provider: "google",
      googleProjectId: fakeSecrets.projectId,
      googleClientEmail: fakeSecrets.email,
      googlePrivateKey: "",
    });
    assert.ok(p instanceof NoopFnrhOcrProvider);
    ok("3 provider google + secret ausente → noop");
  }

  // 4 desconhecido → noop
  {
    assert.equal(resolveFnrhOcrProviderName("openai"), "noop");
    const p = createFnrhOcrProvider({ enabled: true, provider: "openai" });
    assert.ok(p instanceof NoopFnrhOcrProvider);
    ok("4 provider desconhecido → noop");
  }

  // 5 auth mockada + 6 Vision sucesso
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "mock-access-token",
      fetchImpl: mockFetchSequence([
        {
          status: 200,
          json: visionSuccessBody(
            "NOME: MARIA TESTE SILVA\nDATA DE NASCIMENTO: 01/02/1990\nSEXO: F\nCPF: 529.982.247-25\n",
          ),
        },
      ]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "cpf",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, "google");
    assert.equal(r.model, FNRH_OCR_GOOGLE_MODEL);
    assert.equal(r.skipped, false);
    assert.ok(r.suggested_fields.hospede_nome);
    assert.equal(r.suggested_fields.data_nascimento, "1990-02-01");
    assert.equal(r.suggested_fields.cpf, VALID_CPF);
    assertNoSecretLeak(r, [pem, "mock-access-token"]);
    ok("5 auth Google mockada");
    ok("6 Vision sucesso");
  }

  // 7 Vision 400
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 400, json: { error: { message: "bad" } } }]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "google_http_400");
    ok("7 Vision 400");
  }

  // 8 401/403
  {
    const p401 = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 401, json: {} }]),
    });
    const r401 = await p401.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r401.reason, "google_auth_http_401");

    const p403 = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 403, json: {} }]),
    });
    const r403 = await p403.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r403.reason, "google_auth_http_403");
    ok("8 Vision 401/403");
  }

  // 9 429
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 429, json: {} }]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r.reason, "google_throttled_429");
    ok("9 Vision 429");
  }

  // 10 500
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 500, json: {} }]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r.reason, "google_http_5xx");
    ok("10 Vision 500");
  }

  // 11 timeout
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      timeoutMs: 30,
      accessTokenProvider: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return "tok";
      },
      fetchImpl: mockFetchSequence([]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /timeout|google_/);
    ok("11 timeout");
  }

  // 12 resposta sem texto
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "tok",
      fetchImpl: mockFetchSequence([{ status: 200, json: { responses: [{}] } }]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([9]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "google_no_text");
    ok("12 resposta sem texto");
  }

  // 13 CPF inválido ignorado
  {
    assert.equal(isValidCpf(INVALID_CPF), false);
    assert.equal(extractExplicitValidCpf(`CPF: ${INVALID_CPF}`), null);
    const n = normalizeGoogleVisionText({
      fullText: `NOME: ALGUEM\nCPF: 111.111.111-11\n`,
      requested_document_type: "cpf",
    });
    assert.equal(n.suggested_fields.cpf, undefined);
    assert.notEqual(n.suggested_fields.documento_numero, INVALID_CPF);
    ok("13 CPF inválido ignorado");
  }

  // 14 CPF válido explícito
  {
    assert.equal(isValidCpf(VALID_CPF), true);
    assert.equal(extractExplicitValidCpf("CPF: 529.982.247-25"), VALID_CPF);
    // 11 dígitos soltos sem rótulo → não inventa
    assert.equal(extractExplicitValidCpf("52998224725"), null);
    const n = normalizeGoogleVisionText({
      fullText: "NOME: FULANO TESTE\nCPF: 529.982.247-25\n",
      requested_document_type: "cpf",
    });
    assert.equal(n.suggested_fields.cpf, VALID_CPF);
    assert.equal(n.suggested_fields.documento_numero, VALID_CPF);
    ok("14 CPF válido explicitamente presente");
  }

  // 15 manual > ocr
  {
    assert.equal(preferFieldOrigin("manual", "ocr"), "manual");
    assert.equal(
      shouldApplySuggestedValue({
        currentValue: "JULIO CESAR",
        currentOrigin: "manual",
        suggestedOrigin: "ocr",
      }),
      false,
    );
    ok("15 manual prevalece sobre OCR");
  }

  // 16 idempotência
  {
    const hash = await sha256HexOfBytes(new Uint8Array([7, 7, 7]));
    assert.equal(hash.length, 64);
    const gate = canRunNewOcrAttempt({
      priorAttempts: 0,
      maxAttempts: FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
      hasSuccessfulIdempotentHit: true,
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "ocr_idempotent_hit");
    ok("16 idempotência");
  }

  // 17 limite tentativas
  {
    const gate = canRunNewOcrAttempt({
      priorAttempts: 3,
      maxAttempts: FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
      hasSuccessfulIdempotentHit: false,
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "ocr_attempt_limit");
    ok("17 limite de tentativas");
  }

  // 18 Azure continua na factory
  {
    const p = createFnrhOcrProvider({
      enabled: true,
      provider: "azure",
      azureEndpoint: "https://example.cognitiveservices.azure.com",
      azureKey: "test-key",
      fetchImpl: mockFetchSequence([
        { status: 202, headers: { "Operation-Location": "https://example/op/1" } },
        {
          status: 200,
          json: {
            status: "succeeded",
            analyzeResult: { pages: [{}], documents: [] },
          },
        },
      ]),
    });
    assert.ok(p instanceof AzureDocumentIntelligenceOcrProvider);
    const meta = resolveFnrhOcrModelMeta("google");
    assert.equal(meta.model, FNRH_OCR_GOOGLE_MODEL);
    ok("18 Azure continua na factory + meta google dinâmica");
  }

  // 19 nenhum secret em resultado
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: fakeSecrets.key,
      accessTokenProvider: async () => "super-secret-token-xyz",
      fetchImpl: mockFetchSequence([
        { status: 200, json: visionSuccessBody("NOME: X") },
      ]),
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([1]),
    });
    assertNoSecretLeak(r, [pem, "super-secret-token-xyz", fakeSecrets.email]);
    ok("19 nenhum secret em resultado OCR");
  }

  // 20 upload path fail-safe: OCR falha não impede suggested_fields vazio (contrato)
  {
    const p = new GoogleVisionOcrProvider({
      projectId: fakeSecrets.projectId,
      clientEmail: fakeSecrets.email,
      privateKeyPem: "INVALID_PEM",
    });
    const r = await p.extract({
      storage_ref: "x",
      document_type: "rg",
      bytes: new Uint8Array([1]),
    });
    // soft-skip / fail — nunca lança; upload pode seguir
    assert.equal(typeof r.ok, "boolean");
    assert.deepEqual(r.suggested_fields, {});
    assert.equal(r.provenance, "ocr");
    ok("20 OCR falha retorna contrato seguro (upload não quebra)");
  }

  console.log(`\n=== ${passed}/20 Google Vision OCR checks OK ===\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
