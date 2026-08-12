/**
 * Port OCR FNRH — interface, no-op e factory (azure | google | noop).
 */

import { AzureDocumentIntelligenceOcrProvider } from "./fnrh-ocr-azure.ts";
import type { FnrhOcrConfidenceBand } from "./fnrh-ocr-confidence.ts";
import {
  FNRH_OCR_AZURE_API_VERSION,
  FNRH_OCR_AZURE_MODEL,
  FNRH_OCR_GOOGLE_API_VERSION,
  FNRH_OCR_GOOGLE_MODEL,
} from "./fnrh-ocr-confidence.ts";
import { GoogleVisionOcrProvider } from "./fnrh-ocr-google-vision.ts";
import { isFnrhOcrEnabled } from "./fnrh-checkin-v2-policy.ts";

export type FnrhOcrDocumentSide = "front" | "back" | "single";

export type FnrhOcrRequest = {
  storage_ref: string;
  document_type: string;
  side?: FnrhOcrDocumentSide;
  mime_type?: string;
  /** Bytes do arquivo privado (preferencial; evita signed URL). */
  bytes?: Uint8Array;
  document_id?: string;
  reservation_id?: string;
  guest_id?: string;
  content_hash?: string;
};

export type FnrhOcrSuggestedFields = {
  hospede_nome?: string;
  documento_numero?: string;
  documento_tipo?: string;
  data_nascimento?: string;
  orgao_emissor?: string;
  pais_emissor?: string;
  sexo?: string;
  nacionalidade?: string;
  documento_validade?: string;
  /** CPF só quando explícito + checksum válido (Google). UI pode ignorar. */
  cpf?: string;
};

export type FnrhOcrResult = {
  ok: boolean;
  provider: string;
  model?: string;
  api_version?: string;
  suggested_fields: FnrhOcrSuggestedFields;
  confidence: Record<string, number>;
  field_bands?: Record<string, FnrhOcrConfidenceBand>;
  needs_review_fields?: string[];
  provenance: "ocr";
  skipped: boolean;
  reason?: string;
  pages_processed?: number;
  duration_ms?: number;
  analyzed_at?: string;
  document_doc_type?: string;
};

export interface FnrhOcrProvider {
  readonly name: string;
  extract(request: FnrhOcrRequest): Promise<FnrhOcrResult>;
}

/** No-op: OCR desligado / provider ausente / credenciais ausentes. */
export class NoopFnrhOcrProvider implements FnrhOcrProvider {
  readonly name = "noop";

  async extract(_request: FnrhOcrRequest): Promise<FnrhOcrResult> {
    return {
      ok: true,
      provider: this.name,
      model: "noop",
      suggested_fields: {},
      confidence: {},
      field_bands: {},
      needs_review_fields: [],
      provenance: "ocr",
      skipped: true,
      reason: "ocr_provider_unavailable",
      pages_processed: 0,
    };
  }
}

export type FnrhOcrProviderName = "azure" | "google" | "noop";

export type CreateFnrhOcrProviderOptions = {
  enabled?: boolean;
  /** azure | google | noop */
  provider?: string | null;
  azureEndpoint?: string | null;
  azureKey?: string | null;
  googleProjectId?: string | null;
  googleClientEmail?: string | null;
  googlePrivateKey?: string | null;
  fetchImpl?: typeof fetch;
  googleAccessTokenProvider?: () => Promise<string>;
};

function readEnv(name: string): string | null {
  if (typeof Deno !== "undefined") {
    return Deno.env.get(name) ?? null;
  }
  if (typeof process !== "undefined") {
    return process.env?.[name] ?? null;
  }
  return null;
}

export function resolveFnrhOcrProviderName(raw: string | null | undefined): FnrhOcrProviderName {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "azure") return "azure";
  if (v === "google" || v === "google_vision") return "google";
  if (v === "noop" || v === "") return "noop";
  return "noop";
}

/**
 * Factory fail-closed:
 * - FNRH_OCR_ENABLED !== "true" → noop
 * - provider desconhecido → noop
 * - credenciais ausentes → noop
 */
export function createFnrhOcrProvider(
  enabledOrOpts: boolean | CreateFnrhOcrProviderOptions = false,
): FnrhOcrProvider {
  const opts: CreateFnrhOcrProviderOptions =
    typeof enabledOrOpts === "boolean" ? { enabled: enabledOrOpts } : enabledOrOpts;

  const enabled = opts.enabled === true || isFnrhOcrEnabled(String(opts.enabled));
  const providerName = resolveFnrhOcrProviderName(
    opts.provider ?? readEnv("FNRH_OCR_PROVIDER"),
  );

  if (!enabled || providerName === "noop") {
    return new NoopFnrhOcrProvider();
  }

  if (providerName === "azure") {
    const endpoint =
      opts.azureEndpoint ?? readEnv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
    const key = opts.azureKey ?? readEnv("AZURE_DOCUMENT_INTELLIGENCE_KEY");
    if (!String(endpoint || "").trim() || !String(key || "").trim()) {
      return new NoopFnrhOcrProvider();
    }
    return new AzureDocumentIntelligenceOcrProvider({
      endpoint: String(endpoint),
      key: String(key),
      model: FNRH_OCR_AZURE_MODEL,
      apiVersion: FNRH_OCR_AZURE_API_VERSION,
      fetchImpl: opts.fetchImpl,
    });
  }

  if (providerName === "google") {
    const projectId = opts.googleProjectId ?? readEnv("GOOGLE_CLOUD_PROJECT_ID");
    const clientEmail =
      opts.googleClientEmail ?? readEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    const privateKey =
      opts.googlePrivateKey ?? readEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
    if (
      !String(projectId || "").trim() ||
      !String(clientEmail || "").trim() ||
      !String(privateKey || "").trim()
    ) {
      return new NoopFnrhOcrProvider();
    }
    return new GoogleVisionOcrProvider({
      projectId: String(projectId),
      clientEmail: String(clientEmail),
      privateKeyPem: String(privateKey),
      fetchImpl: opts.fetchImpl,
      accessTokenProvider: opts.googleAccessTokenProvider,
    });
  }

  return new NoopFnrhOcrProvider();
}

// Deno global typing for edge; ignored in Node.
declare const Deno: { env: { get(key: string): string | undefined } } | undefined;

// Re-export model constants used by edges/tests.
export {
  FNRH_OCR_AZURE_API_VERSION,
  FNRH_OCR_AZURE_MODEL,
  FNRH_OCR_GOOGLE_API_VERSION,
  FNRH_OCR_GOOGLE_MODEL,
};
