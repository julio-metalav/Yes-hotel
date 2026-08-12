/**
 * Provider Azure Document Intelligence — prebuilt-idDocument (API 2024-11-30).
 * Server-side only. Sem URL pública permanente. Sem log de key/PII.
 */

import {
  FNRH_OCR_AZURE_API_VERSION,
  FNRH_OCR_AZURE_MODEL,
} from "./fnrh-ocr-confidence.ts";
import { normalizeAzureIdDocumentResult } from "./fnrh-ocr-normalize.ts";
import type {
  FnrhOcrProvider,
  FnrhOcrRequest,
  FnrhOcrResult,
} from "./fnrh-ocr-port.ts";

export type AzureDocumentIntelligenceConfig = {
  endpoint: string;
  key: string;
  model?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /** Timeout total do polling (ms). Default 45000. */
  timeoutMs?: number;
  /** Delay inicial entre polls (ms). Default 800. */
  pollIntervalMs?: number;
};

function sleep(ms: number, fetchImpl?: typeof fetch): Promise<void> {
  void fetchImpl;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEndpoint(endpoint: string): string {
  return String(endpoint || "").trim().replace(/\/+$/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class AzureDocumentIntelligenceOcrProvider implements FnrhOcrProvider {
  readonly name = "azure";
  private readonly endpoint: string;
  private readonly key: string;
  private readonly model: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: AzureDocumentIntelligenceConfig) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.key = String(config.key || "").trim();
    this.model = config.model || FNRH_OCR_AZURE_MODEL;
    this.apiVersion = config.apiVersion || FNRH_OCR_AZURE_API_VERSION;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 45_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 800;
  }

  async extract(request: FnrhOcrRequest): Promise<FnrhOcrResult> {
    if (!this.endpoint || !this.key) {
      return {
        ok: false,
        provider: this.name,
        model: this.model,
        api_version: this.apiVersion,
        suggested_fields: {},
        confidence: {},
        field_bands: {},
        needs_review_fields: [],
        provenance: "ocr",
        skipped: true,
        reason: "azure_credentials_missing",
        pages_processed: 0,
      };
    }
    if (!request.bytes || request.bytes.byteLength === 0) {
      return {
        ok: false,
        provider: this.name,
        model: this.model,
        api_version: this.apiVersion,
        suggested_fields: {},
        confidence: {},
        field_bands: {},
        needs_review_fields: [],
        provenance: "ocr",
        skipped: true,
        reason: "ocr_bytes_missing",
        pages_processed: 0,
      };
    }

    const started = Date.now();
    try {
      const analyzeUrl =
        `${this.endpoint}/documentintelligence/documentModels/${encodeURIComponent(this.model)}:analyze` +
        `?api-version=${encodeURIComponent(this.apiVersion)}`;

      const analyzeRes = await this.postAnalyze(analyzeUrl, request.bytes);
      if (analyzeRes.status === 429) {
        await sleep(1200, this.fetchImpl);
        const retry = await this.postAnalyze(analyzeUrl, request.bytes);
        if (retry.status === 429) {
          return this.fail("azure_throttled_429", started);
        }
        analyzeRes.status = retry.status;
        analyzeRes.operationLocation = retry.operationLocation;
        analyzeRes.bodyText = retry.bodyText;
      }

      if (analyzeRes.status >= 500) {
        return this.fail("azure_http_5xx", started);
      }
      if (analyzeRes.status !== 202 || !analyzeRes.operationLocation) {
        return this.fail("azure_analyze_rejected", started);
      }

      const polled = await this.pollResult(analyzeRes.operationLocation, started);
      if (!polled.ok) {
        return {
          ...polled.result,
          duration_ms: Date.now() - started,
        };
      }

      const normalized = normalizeAzureIdDocumentResult({
        analyzeResult: polled.analyzeResult,
        requested_document_type: request.document_type,
      });

      return {
        ok: true,
        provider: this.name,
        model: this.model,
        api_version: this.apiVersion,
        suggested_fields: normalized.suggested_fields,
        confidence: normalized.confidence,
        field_bands: normalized.field_bands,
        needs_review_fields: normalized.needs_review_fields,
        provenance: "ocr",
        skipped: false,
        pages_processed: normalized.pages_processed || 1,
        duration_ms: Date.now() - started,
        analyzed_at: new Date().toISOString(),
        document_doc_type: normalized.document_doc_type,
      };
    } catch {
      return this.fail("azure_network_error", started);
    }
  }

  private fail(reason: string, started: number): FnrhOcrResult {
    return {
      ok: false,
      provider: this.name,
      model: this.model,
      api_version: this.apiVersion,
      suggested_fields: {},
      confidence: {},
      field_bands: {},
      needs_review_fields: [],
      provenance: "ocr",
      skipped: false,
      reason,
      pages_processed: 0,
      duration_ms: Date.now() - started,
    };
  }

  private async postAnalyze(
    url: string,
    bytes: Uint8Array,
  ): Promise<{ status: number; operationLocation: string | null; bodyText: string }> {
    // Preferência: JSON base64Source (documentado GA) — evita quirks de octet-stream em proxies.
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": this.key,
      },
      body: JSON.stringify({ base64Source: bytesToBase64(bytes) }),
    });
    return {
      status: res.status,
      operationLocation: res.headers.get("operation-location") || res.headers.get("Operation-Location"),
      bodyText: "",
    };
  }

  private async pollResult(
    operationLocation: string,
    started: number,
  ): Promise<
    | { ok: true; analyzeResult: { documents?: unknown[]; pages?: unknown[] } }
    | { ok: false; result: FnrhOcrResult }
  > {
    let delay = this.pollIntervalMs;
    while (Date.now() - started < this.timeoutMs) {
      const res = await this.fetchImpl(operationLocation, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": this.key },
      });
      if (res.status === 429) {
        await sleep(Math.min(delay * 2, 5000), this.fetchImpl);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      if (res.status >= 500) {
        return { ok: false, result: this.fail("azure_poll_5xx", started) };
      }
      if (!res.ok) {
        return { ok: false, result: this.fail("azure_poll_http_error", started) };
      }
      const json = (await res.json()) as {
        status?: string;
        analyzeResult?: { documents?: unknown[]; pages?: unknown[] };
        error?: { code?: string };
      };
      const status = String(json.status || "").toLowerCase();
      if (status === "succeeded") {
        return { ok: true, analyzeResult: json.analyzeResult ?? { documents: [] } };
      }
      if (status === "failed") {
        return { ok: false, result: this.fail("azure_analyze_failed", started) };
      }
      // running / notStarted
      await sleep(delay, this.fetchImpl);
      delay = Math.min(Math.floor(delay * 1.5), 3000);
    }
    return { ok: false, result: this.fail("azure_timeout", started) };
  }
}
