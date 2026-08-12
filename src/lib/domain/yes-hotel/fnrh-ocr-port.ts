/**
 * Port OCR FNRH — interface, no-op e factory (Azure | noop).
 */

import { AzureDocumentIntelligenceOcrProvider } from "./fnrh-ocr-azure.ts";
import type { FnrhOcrConfidenceBand } from "./fnrh-ocr-confidence.ts";
import { FNRH_OCR_AZURE_API_VERSION, FNRH_OCR_AZURE_MODEL } from "./fnrh-ocr-confidence.ts";
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

export type CreateFnrhOcrProviderOptions = {
  enabled?: boolean;
  /** azure | noop — default azure quando enabled+creds. */
  provider?: string | null;
  azureEndpoint?: string | null;
  azureKey?: string | null;
  fetchImpl?: typeof fetch;
};

export function resolveFnrhOcrProviderName(raw: string | null | undefined): "azure" | "noop" {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "azure") return "azure";
  if (v === "noop" || v === "") return "noop";
  return "noop";
}

/**
 * Factory fail-closed:
 * - FNRH_OCR_ENABLED !== "true" → noop
 * - provider != azure → noop
 * - endpoint/key ausentes → noop
 */
export function createFnrhOcrProvider(
  enabledOrOpts: boolean | CreateFnrhOcrProviderOptions = false,
): FnrhOcrProvider {
  const opts: CreateFnrhOcrProviderOptions =
    typeof enabledOrOpts === "boolean" ? { enabled: enabledOrOpts } : enabledOrOpts;

  const enabled = opts.enabled === true || isFnrhOcrEnabled(String(opts.enabled));
  // When called with boolean true from edge, also read env for provider/creds.
  const providerName = resolveFnrhOcrProviderName(
    opts.provider ??
      (typeof Deno !== "undefined"
        ? Deno.env.get("FNRH_OCR_PROVIDER")
        : typeof process !== "undefined"
          ? process.env?.FNRH_OCR_PROVIDER
          : null),
  );

  if (!enabled || providerName !== "azure") {
    return new NoopFnrhOcrProvider();
  }

  const endpoint =
    opts.azureEndpoint ??
    (typeof Deno !== "undefined"
      ? Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
      : typeof process !== "undefined"
        ? process.env?.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
        : null);
  const key =
    opts.azureKey ??
    (typeof Deno !== "undefined"
      ? Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_KEY")
      : typeof process !== "undefined"
        ? process.env?.AZURE_DOCUMENT_INTELLIGENCE_KEY
        : null);

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

// Deno global typing for edge; ignored in Node.
declare const Deno: { env: { get(key: string): string | undefined } } | undefined;
