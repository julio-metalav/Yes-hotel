/**
 * Provider Google Cloud Vision — DOCUMENT_TEXT_DETECTION.
 * Server-side only. Auth via service account (JWT → access token).
 * Sem filesystem, sem GOOGLE_APPLICATION_CREDENTIALS, sem log de secrets/PII.
 */

import {
  FNRH_OCR_GOOGLE_API_VERSION,
  FNRH_OCR_GOOGLE_MODEL,
} from "./fnrh-ocr-confidence.ts";
import { normalizeGoogleVisionText } from "./fnrh-ocr-normalize-google.ts";
import type {
  FnrhOcrProvider,
  FnrhOcrRequest,
  FnrhOcrResult,
} from "./fnrh-ocr-port.ts";

export type GoogleVisionOcrConfig = {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  /** Timeout total (ms). Default 30000. */
  timeoutMs?: number;
  /** Injeta token (testes) — evita JWT real. */
  accessTokenProvider?: () => Promise<string>;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const VISION_SCOPE = "https://www.googleapis.com/auth/cloud-vision";

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

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;
  const b64 = bytesToBase64(bytes);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Normaliza PEM do secret (aceita \\n escapado). */
export function normalizeServiceAccountPrivateKeyPem(raw: string): string {
  let pem = String(raw || "").trim();
  if (!pem) return "";
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return pem.trim();
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  const normalized = normalizeServiceAccountPrivateKeyPem(pem);
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Der(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function createServiceAccountJwt(input: {
  clientEmail: string;
  privateKeyPem: string;
  nowSec?: number;
}): Promise<string> {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: input.clientEmail,
    scope: VISION_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned =
    `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await importRs256PrivateKey(input.privateKeyPem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class GoogleVisionOcrProvider implements FnrhOcrProvider {
  readonly name = "google";
  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKeyPem: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly accessTokenProvider?: () => Promise<string>;
  private readonly model = FNRH_OCR_GOOGLE_MODEL;
  private readonly apiVersion = FNRH_OCR_GOOGLE_API_VERSION;

  constructor(config: GoogleVisionOcrConfig) {
    this.projectId = String(config.projectId || "").trim();
    this.clientEmail = String(config.clientEmail || "").trim();
    this.privateKeyPem = normalizeServiceAccountPrivateKeyPem(config.privateKeyPem);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.accessTokenProvider = config.accessTokenProvider;
  }

  async extract(request: FnrhOcrRequest): Promise<FnrhOcrResult> {
    if (!this.projectId || !this.clientEmail || !this.privateKeyPem) {
      return this.softSkip("google_credentials_missing");
    }
    if (!request.bytes || request.bytes.byteLength === 0) {
      return this.softSkip("ocr_bytes_missing");
    }

    const started = Date.now();
    try {
      const token = await withTimeout(
        this.resolveAccessToken(),
        Math.min(this.timeoutMs, 12_000),
        "google_auth_timeout",
      );

      const visionBody = {
        requests: [
          {
            image: { content: bytesToBase64(request.bytes) },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      };

      const res = await withTimeout(
        this.fetchImpl(VISION_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": this.projectId,
          },
          body: JSON.stringify(visionBody),
        }),
        this.timeoutMs - (Date.now() - started),
        "google_vision_timeout",
      );

      if (res.status === 401 || res.status === 403) {
        return this.fail("google_auth_http_" + res.status, started);
      }
      if (res.status === 429) {
        return this.fail("google_throttled_429", started);
      }
      if (res.status >= 500) {
        return this.fail("google_http_5xx", started);
      }
      if (res.status === 400) {
        return this.fail("google_http_400", started);
      }
      if (!res.ok) {
        return this.fail("google_http_" + res.status, started);
      }

      const json = (await res.json()) as {
        responses?: Array<{
          fullTextAnnotation?: { text?: string; pages?: unknown[] };
          textAnnotations?: Array<{ description?: string }>;
          error?: { code?: number; message?: string; status?: string };
        }>;
        error?: { code?: number; status?: string };
      };

      if (json.error) {
        return this.fail("google_api_error", started);
      }

      const first = json.responses?.[0];
      if (first?.error) {
        const code = Number(first.error.code) || 0;
        if (code === 3 || code === 400) return this.fail("google_vision_invalid", started);
        if (code === 7 || code === 16) return this.fail("google_vision_auth", started);
        if (code === 8 || code === 429) return this.fail("google_throttled_429", started);
        if (code >= 500) return this.fail("google_vision_5xx", started);
        return this.fail("google_vision_error", started);
      }

      const fullText =
        first?.fullTextAnnotation?.text ||
        first?.textAnnotations?.[0]?.description ||
        "";

      if (!String(fullText).trim()) {
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
          reason: "google_no_text",
          pages_processed: 0,
          duration_ms: Date.now() - started,
        };
      }

      const pagesHint = Array.isArray(first?.fullTextAnnotation?.pages)
        ? first!.fullTextAnnotation!.pages!.length
        : 1;

      const normalized = normalizeGoogleVisionText({
        fullText,
        requested_document_type: request.document_type,
        pagesHint,
      });

      const fieldCount = Object.keys(normalized.suggested_fields).length;
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
        reason: fieldCount === 0 ? "google_no_useful_fields" : undefined,
        pages_processed: normalized.pages_processed || 1,
        duration_ms: Date.now() - started,
        analyzed_at: new Date().toISOString(),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "google_network_error";
      if (msg.includes("timeout")) {
        return this.fail(msg.startsWith("google_") ? msg : "google_timeout", started);
      }
      if (
        msg.includes("key") ||
        msg.includes("PKCS") ||
        msg.includes("import") ||
        msg.includes("sign")
      ) {
        return this.softSkip("google_private_key_invalid");
      }
      return this.fail("google_network_error", started);
    }
  }

  private softSkip(reason: string): FnrhOcrResult {
    return {
      ok: true,
      provider: this.name,
      model: this.model,
      api_version: this.apiVersion,
      suggested_fields: {},
      confidence: {},
      field_bands: {},
      needs_review_fields: [],
      provenance: "ocr",
      skipped: true,
      reason,
      pages_processed: 0,
    };
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

  private async resolveAccessToken(): Promise<string> {
    if (this.accessTokenProvider) {
      return this.accessTokenProvider();
    }
    const assertion = await createServiceAccountJwt({
      clientEmail: this.clientEmail,
      privateKeyPem: this.privateKeyPem,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error("google_token_http_" + res.status);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new Error("google_token_missing");
    }
    return json.access_token;
  }
}
