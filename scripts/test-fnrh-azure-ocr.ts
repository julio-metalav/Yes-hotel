/**
 * Testes Azure OCR provider + normalize + confidence + idempotência + provenance.
 * Sem I/O real; fetch mockado. Sem secrets.
 */
import assert from "node:assert/strict";
import {
  classifyOcrConfidence,
  FNRH_OCR_AZURE_API_VERSION,
  FNRH_OCR_AZURE_MODEL,
  FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
  shouldAutofillFromConfidence,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-confidence";
import {
  mergeFrontBackNormalized,
  normalizeAzureIdDocumentResult,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-normalize";
import {
  canRunNewOcrAttempt,
  sha256HexOfBytes,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-idempotency";
import {
  createFnrhOcrProvider,
  NoopFnrhOcrProvider,
  resolveFnrhOcrProviderName,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-port";
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

function azureFixturePassport() {
  return {
    status: "succeeded",
    analyzeResult: {
      pages: [{ pageNumber: 1 }],
      documents: [
        {
          docType: "idDocument.passport",
          confidence: 0.99,
          fields: {
            FirstName: { valueString: "JENNIFER", confidence: 0.98 },
            LastName: { valueString: "BROOKS", confidence: 0.97 },
            DocumentNumber: { valueString: "340020013", confidence: 0.96 },
            DateOfBirth: { valueDate: "1980-01-01", confidence: 0.95 },
            DateOfExpiration: { valueDate: "2019-05-05", confidence: 0.94 },
            Sex: { valueString: "F", confidence: 0.93 },
            Nationality: { valueCountryRegion: "USA", confidence: 0.92 },
            CountryRegion: { valueCountryRegion: "USA", confidence: 0.91 },
          },
        },
      ],
    },
  };
}

function mockFetchSequence(
  steps: Array<{
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
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
        return JSON.stringify(step.json ?? {});
      },
    } as Response;
  }) as typeof fetch;
}

async function main() {
  console.log("\n=== FNRH Azure OCR provider (A–T) ===\n");

  // A disabled => noop
  {
    const p = createFnrhOcrProvider({ enabled: false, provider: "azure", azureEndpoint: "https://x", azureKey: "k" });
    assert.ok(p instanceof NoopFnrhOcrProvider);
    const r = await p.extract({ storage_ref: "a", document_type: "rg" });
    assert.equal(r.skipped, true);
    ok("A provider disabled => noop/fallback");
  }

  // B azure ativo (factory)
  {
    assert.equal(resolveFnrhOcrProviderName("azure"), "azure");
    const p = createFnrhOcrProvider({
      enabled: true,
      provider: "azure",
      azureEndpoint: "https://example.cognitiveservices.azure.com",
      azureKey: "test-key",
      fetchImpl: mockFetchSequence([
        {
          status: 202,
          headers: { "Operation-Location": "https://example/op/1" },
        },
        { status: 200, json: azureFixturePassport() },
      ]),
    });
    assert.ok(p instanceof AzureDocumentIntelligenceOcrProvider);
    ok("B provider Azure ativo (factory)");
  }

  // C–G analyze + polling succeeded/failed/timeout
  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "k",
      timeoutMs: 2000,
      pollIntervalMs: 50,
      fetchImpl: mockFetchSequence([
        { status: 202, headers: { "Operation-Location": "https://example/op/1" } },
        { status: 200, json: azureFixturePassport() },
      ]),
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await p.extract({ storage_ref: "x", document_type: "passport", bytes });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
    assert.equal(r.provider, "azure");
    assert.equal(r.model, FNRH_OCR_AZURE_MODEL);
    assert.equal(r.api_version, FNRH_OCR_AZURE_API_VERSION);
    assert.ok(r.suggested_fields.hospede_nome?.includes("JENNIFER"));
    assert.equal(r.suggested_fields.documento_tipo, "passport");
    ok("C/D/E analyze + polling succeeded");
  }

  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "k",
      timeoutMs: 500,
      pollIntervalMs: 20,
      fetchImpl: mockFetchSequence([
        { status: 202, headers: { "Operation-Location": "https://example/op/1" } },
        { status: 200, json: { status: "failed" } },
      ]),
    });
    const r = await p.extract({ storage_ref: "x", document_type: "rg", bytes: new Uint8Array([9]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "azure_analyze_failed");
    ok("F failed");
  }

  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "k",
      timeoutMs: 120,
      pollIntervalMs: 40,
      fetchImpl: mockFetchSequence([
        { status: 202, headers: { "Operation-Location": "https://example/op/1" } },
        { status: 200, json: { status: "running" } },
        { status: 200, json: { status: "running" } },
        { status: 200, json: { status: "running" } },
        { status: 200, json: { status: "running" } },
      ]),
    });
    const r = await p.extract({ storage_ref: "x", document_type: "rg", bytes: new Uint8Array([9]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "azure_timeout");
    ok("G timeout");
  }

  // H 429
  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "k",
      timeoutMs: 3000,
      pollIntervalMs: 20,
      fetchImpl: mockFetchSequence([
        { status: 429 },
        { status: 429 },
      ]),
    });
    const r = await p.extract({ storage_ref: "x", document_type: "rg", bytes: new Uint8Array([1]) });
    assert.equal(r.reason, "azure_throttled_429");
    ok("H 429");
  }

  // I 5xx
  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "k",
      fetchImpl: mockFetchSequence([{ status: 503 }]),
    });
    const r = await p.extract({ storage_ref: "x", document_type: "rg", bytes: new Uint8Array([1]) });
    assert.equal(r.reason, "azure_http_5xx");
    ok("I 5xx");
  }

  // J resposta incompleta
  {
    const n = normalizeAzureIdDocumentResult({
      analyzeResult: { documents: [], pages: [] },
      requested_document_type: "rg",
    });
    assert.deepEqual(n.suggested_fields, {});
    ok("J resposta incompleta");
  }

  // K confidence
  {
    assert.equal(classifyOcrConfidence(0.9), "high");
    assert.equal(classifyOcrConfidence(0.7), "medium");
    assert.equal(classifyOcrConfidence(0.2), "low");
    assert.deepEqual(shouldAutofillFromConfidence("low"), { apply: false, needs_review: false });
    assert.deepEqual(shouldAutofillFromConfidence("medium"), { apply: true, needs_review: true });
    ok("K confidence");
  }

  // L normalização + S passaporte
  {
    const n = normalizeAzureIdDocumentResult({
      analyzeResult: azureFixturePassport().analyzeResult,
      requested_document_type: "passport",
    });
    assert.equal(n.suggested_fields.documento_tipo, "passport");
    assert.equal(n.suggested_fields.data_nascimento, "1980-01-01");
    assert.equal(n.pages_processed, 1);
    // PersonalNumber ausente → não inventa CPF
    assert.equal((n.suggested_fields as { cpf?: string }).cpf, undefined);
    ok("L/S normalização passaporte (sem inventar CPF)");
  }

  // M manual prevalece
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
    assert.equal(
      shouldApplySuggestedValue({
        currentValue: "",
        currentOrigin: "manual",
        suggestedOrigin: "ocr",
      }),
      true,
    );
    ok("M manual prevalece sobre ocr");
  }

  // N idempotência
  {
    const a = await sha256HexOfBytes(new Uint8Array([1, 2, 3]));
    const b = await sha256HexOfBytes(new Uint8Array([1, 2, 3]));
    assert.equal(a, b);
    assert.equal(a.length, 64);
    const deny = canRunNewOcrAttempt({
      priorAttempts: 1,
      maxAttempts: FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
      hasSuccessfulIdempotentHit: true,
    });
    assert.equal(deny.allowed, false);
    assert.equal(deny.reason, "ocr_idempotent_hit");
    ok("N idempotência content_hash + hit");
  }

  // O limite tentativas
  {
    const lim = canRunNewOcrAttempt({
      priorAttempts: 3,
      maxAttempts: FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
      hasSuccessfulIdempotentHit: false,
    });
    assert.equal(lim.allowed, false);
    assert.equal(lim.reason, "ocr_attempt_limit");
    ok("O limite de tentativas");
  }

  // P/Q sem secret/PII em result reasons (sanidade)
  {
    const p = new AzureDocumentIntelligenceOcrProvider({
      endpoint: "https://example.cognitiveservices.azure.com",
      key: "SUPER_SECRET_KEY_DO_NOT_LEAK",
      fetchImpl: mockFetchSequence([{ status: 400 }]),
    });
    const r = await p.extract({ storage_ref: "x", document_type: "rg", bytes: new Uint8Array([1]) });
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes("SUPER_SECRET_KEY_DO_NOT_LEAK"));
    assert.ok(!dump.includes("Ocp-Apim"));
    ok("P/Q nenhum secret em resultado OCR");
  }

  // R front/back RG merge
  {
    const front = normalizeAzureIdDocumentResult({
      analyzeResult: {
        pages: [{}],
        documents: [
          {
            docType: "idDocument.nationalIdentityCard",
            confidence: 0.9,
            fields: {
              FirstName: { valueString: "ANA", confidence: 0.9 },
              LastName: { valueString: "SILVA", confidence: 0.9 },
              DocumentNumber: { valueString: "MG123", confidence: 0.8 },
            },
          },
        ],
      },
      requested_document_type: "rg",
    });
    const back = normalizeAzureIdDocumentResult({
      analyzeResult: {
        pages: [{}],
        documents: [
          {
            docType: "idDocument.nationalIdentityCard",
            confidence: 0.88,
            fields: {
              FirstName: { valueString: "ANA", confidence: 0.88 },
              LastName: { valueString: "SOUZA", confidence: 0.87 },
              DocumentNumber: { valueString: "MG123", confidence: 0.85 },
            },
          },
        ],
      },
      requested_document_type: "rg",
    });
    const merged = mergeFrontBackNormalized(front, back);
    assert.equal(merged.pages_processed, 2);
    assert.ok(merged.needs_review_fields.includes("hospede_nome"));
    ok("R front/back RG conflito → review");
  }

  // T fallback manual (noop path)
  {
    const p = createFnrhOcrProvider(true); // sem env azure → noop
    assert.ok(p instanceof NoopFnrhOcrProvider);
    ok("T fallback manual (noop sem credenciais)");
  }

  console.log(`\n=== ${passed} checks Azure OCR OK ===\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
