/**
 * Cliente server-side Pagar.me Core v5 + Checkout.
 * Fetch injetável. Fail-closed. Sem retries automáticos em criação (idempotency local).
 *
 * Roteamento:
 * - CORE (api.pagar.me): orders / charges
 * - CHECKOUT TEST (sdx-api): paymentlinks
 */

import {
  classifyPagarmeSecretKey,
  evaluatePagarmeCheckoutBaseUrl,
  evaluatePagarmeCoreBaseUrl,
  expectedCheckoutBaseUrlForEnv,
  getPagarmeConfig,
  PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL,
  PAGARME_CHECKOUT_TEST_API_BASE_URL,
  PAGARME_CORE_API_BASE_URL,
  parsePagarmeEnvironment,
  resolveEnvSecretCompatibility,
  resolvePagarmeBaseForSurface,
  pagarmeConfigStatus,
  type PagarmeEnvSource,
  type PagarmeProductSurface,
} from "./config.ts";
import {
  PagarmeError,
  assertNoSensitiveLeak,
  isAmbiguousHttpStatus,
  isDefinitiveHttpStatus,
  mapStatusToCode,
  sanitizeUnknown,
} from "./errors.ts";
import {
  buildPaymentLinkRequestBody,
  buildPixOrderRequestBody,
  extractChargeSnapshot,
  extractPaymentLink,
  extractPixFromOrder,
} from "./mapper.ts";
import type {
  CreatePaymentLinkInput,
  CreatePixOrderInput,
  PagarmeChargeSnapshot,
  PagarmeConfig,
  PagarmeFetch,
  PagarmeHttpErrorCode,
  PagarmePaymentLinkExtract,
  PagarmePixExtract,
  PagarmeTransportResponse,
} from "./types.ts";

export interface PagarmeClientOptions {
  config?: PagarmeConfig;
  env?: PagarmeEnvSource;
  fetchImpl?: PagarmeFetch;
  debug?: boolean;
}

function basicAuthHeader(secretKey: string): string {
  const raw = `${secretKey}:`;
  const token =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${token}`;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function safeUrlHint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function blockReasonToErrorCode(reason: string | null): PagarmeHttpErrorCode {
  switch (reason) {
    case "env_missing":
      return "env_missing";
    case "env_secret_mismatch":
      return "env_secret_mismatch";
    case "secret_kind_unknown":
      return "secret_kind_unknown";
    case "live_secret_blocked":
      return "live_secret_blocked";
    case "production_env_unsupported":
      return "production_env_unsupported";
    case "missing_secret":
      return "missing_secret";
    case "legacy_ambiguous_base_url":
      return "legacy_ambiguous_base_url";
    case "missing_core_base_url":
    case "unexpected_core_base_url":
      return "unexpected_core_base_url";
    case "core_base_wrong_surface":
      return "core_base_wrong_surface";
    case "missing_checkout_base_url":
    case "unexpected_checkout_base_url":
      return "unexpected_checkout_base_url";
    case "checkout_base_wrong_surface":
      return "checkout_base_wrong_surface";
    default:
      return "unexpected_base_url";
  }
}

export class PagarmeClient {
  private readonly config: PagarmeConfig;
  private readonly fetchImpl: PagarmeFetch;
  private readonly debug: boolean;

  constructor(options: PagarmeClientOptions = {}) {
    this.config = options.config ?? getPagarmeConfig(options.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.debug = options.debug === true;
  }

  getConfig(): PagarmeConfig {
    return this.config;
  }

  getStatus() {
    return pagarmeConfigStatus(this.config);
  }

  /**
   * Gate fail-closed independente de flags pré-computadas no config.
   * Recomputa a partir de primitivos: env, secretKey, integrationEnabled,
   * coreApiBaseUrl, checkoutApiBaseUrl — mesmo se secretAllowed/envAllowed/
   * transportAllowed forem forjados como true.
   */
  private assertTransport(action: string, surface: PagarmeProductSurface): void {
    if (this.config.integrationEnabled !== true) {
      throw new PagarmeError({
        code: "integration_disabled",
        message: `Integracao Pagar.me desligada; ${action} bloqueado.`,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }

    const secretKey = String(this.config.secretKey ?? "").trim();
    if (!secretKey) {
      throw new PagarmeError({
        code: "missing_secret",
        message: `PAGARME_SECRET_KEY ausente; ${action} bloqueado.`,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }

    const env = parsePagarmeEnvironment(
      this.config.env == null ? "" : String(this.config.env),
    );
    if (!env) {
      throw new PagarmeError({
        code: "env_missing",
        message: `PAGARME_ENV ausente ou invalido; ${action} bloqueado. Use test ou production.`,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }

    const secretKind = classifyPagarmeSecretKey(secretKey);
    const envSecret = resolveEnvSecretCompatibility(env, secretKind);
    if (!envSecret.ok) {
      const code = blockReasonToErrorCode(envSecret.reason);
      const message =
        code === "live_secret_blocked"
          ? `Secret sk_live_ bloqueada em PAGARME_ENV=test; ${action} bloqueado.`
          : code === "env_secret_mismatch"
            ? `Secret incompativel com PAGARME_ENV=${env}; ${action} bloqueado.`
            : `PAGARME_ENV/chave incompativeis; ${action} bloqueado.`;
      throw new PagarmeError({
        code,
        message,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
        details: { secret_key_kind: secretKind },
      });
    }

    const coreEval = evaluatePagarmeCoreBaseUrl(this.config.coreApiBaseUrl, env);
    if (!coreEval.allowed) {
      const reason =
        coreEval.reason === "wrong_surface_for_env"
          ? "core_base_wrong_surface"
          : coreEval.reason === "missing_base_url"
            ? "missing_core_base_url"
            : coreEval.reason === "production_env_unsupported"
              ? "production_env_unsupported"
              : "unexpected_core_base_url";
      throw new PagarmeError({
        code: blockReasonToErrorCode(reason),
        message: `Base Core Pagar.me nao permitida (${safeUrlHint(this.config.coreApiBaseUrl)}). Use ${PAGARME_CORE_API_BASE_URL}.`,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
        details: { surface, block_reason: reason },
      });
    }

    const checkoutEval = evaluatePagarmeCheckoutBaseUrl(
      this.config.checkoutApiBaseUrl,
      env,
    );
    if (!checkoutEval.allowed) {
      const reason =
        checkoutEval.reason === "wrong_surface_for_env"
          ? "checkout_base_wrong_surface"
          : checkoutEval.reason === "missing_base_url"
            ? "missing_checkout_base_url"
            : checkoutEval.reason === "production_env_unsupported"
              ? "production_env_unsupported"
              : "unexpected_checkout_base_url";
      const expected =
        expectedCheckoutBaseUrlForEnv(env) ||
        (env === "production"
          ? PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL
          : PAGARME_CHECKOUT_TEST_API_BASE_URL);
      throw new PagarmeError({
        code: blockReasonToErrorCode(reason),
        message: `Base Checkout Pagar.me nao permitida (${safeUrlHint(this.config.checkoutApiBaseUrl)}). Use ${expected}.`,
        httpStatus: null,
        ambiguous: false,
        retryable: false,
        details: { surface, block_reason: reason },
      });
    }
  }

  private debugSafe(event: string, extra: Record<string, unknown> = {}): void {
    if (!this.debug) return;
    const payload = { event, ...extra, ts: new Date().toISOString() };
    assertNoSensitiveLeak(payload, [this.config.secretKey]);
    console.debug("[pagarme]", JSON.stringify(payload));
  }

  async request(params: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    surface: PagarmeProductSurface;
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<PagarmeTransportResponse> {
    this.assertTransport(`${params.method} ${params.path}`, params.surface);

    const baseUrl = resolvePagarmeBaseForSurface(this.config, params.surface);
    const url = `${baseUrl}${params.path.startsWith("/") ? "" : "/"}${params.path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: basicAuthHeader(this.config.secretKey),
    };
    if (params.idempotencyKey) {
      headers["Idempotency-Key"] = params.idempotencyKey;
    }

    let bodyText: string | undefined;
    if (params.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(params.body);
    }

    this.debugSafe("request.start", {
      method: params.method,
      surface: params.surface,
      url: safeUrlHint(url),
      hasIdempotencyKey: Boolean(params.idempotencyKey),
      env: this.config.env,
      secret_key_kind: this.config.secretKeyKind,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method: params.method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });
      const rawText = await res.text();
      const responseHeaders = headersToRecord(res.headers);
      let body: unknown = null;
      if (rawText.length > 0) {
        try {
          body = JSON.parse(rawText) as unknown;
        } catch {
          body = null;
        }
      }

      const transport: PagarmeTransportResponse = {
        httpStatus: res.status,
        headers: responseHeaders,
        body,
        rawText,
      };

      if (res.status >= 200 && res.status < 300) {
        this.debugSafe("request.success", {
          method: params.method,
          surface: params.surface,
          url: safeUrlHint(url),
          httpStatus: res.status,
        });
        return transport;
      }

      const ambiguous = isAmbiguousHttpStatus(res.status);
      const definitive = isDefinitiveHttpStatus(res.status);
      throw new PagarmeError({
        code: ambiguous ? "ambiguous_response" : definitive ? mapStatusToCode(res.status) : "unknown",
        message: `Pagar.me HTTP ${res.status} em ${safeUrlHint(url)}.`,
        httpStatus: res.status,
        ambiguous,
        retryable: ambiguous,
        details: { body: sanitizeUnknown(body) },
      });
    } catch (error) {
      if (error instanceof PagarmeError) throw error;

      const name = error instanceof Error ? error.name : "";
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort =
        name === "AbortError" ||
        /aborted|timeout/i.test(msg) ||
        (error instanceof DOMException && error.name === "AbortError");

      throw new PagarmeError({
        code: isAbort ? "timeout" : "network",
        message: isAbort
          ? `Timeout Pagar.me em ${safeUrlHint(url)}.`
          : `Falha de rede Pagar.me em ${safeUrlHint(url)}.`,
        httpStatus: null,
        ambiguous: true,
        retryable: true,
        details: { reason: sanitizeUnknown(msg) },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Monta body do Payment Link sem rede (testes). */
  buildPaymentLinkBody(input: CreatePaymentLinkInput): Record<string, unknown> {
    return buildPaymentLinkRequestBody(input);
  }

  /** Monta body do pedido Pix sem rede (testes). */
  buildPixOrderBody(input: CreatePixOrderInput): Record<string, unknown> {
    return buildPixOrderRequestBody(input, this.config.pixExpiresInSeconds);
  }

  async createPixOrder(input: CreatePixOrderInput): Promise<{
    raw: unknown;
    extract: PagarmePixExtract;
  }> {
    const body = this.buildPixOrderBody(input);
    const res = await this.request({
      method: "POST",
      path: "/orders",
      surface: "core",
      body,
      idempotencyKey: input.idempotencyKey,
    });
    const extract = extractPixFromOrder(res.body);
    return { raw: res.body, extract };
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<{
    raw: unknown;
    extract: PagarmePaymentLinkExtract;
  }> {
    const body = this.buildPaymentLinkBody(input);
    const res = await this.request({
      method: "POST",
      path: "/paymentlinks",
      surface: "checkout",
      body,
      idempotencyKey: input.idempotencyKey,
    });
    const extract = extractPaymentLink(res.body);
    return { raw: res.body, extract };
  }

  async getOrder(orderId: string): Promise<{ raw: unknown; extract: PagarmePixExtract }> {
    const id = String(orderId ?? "").trim();
    if (!id) {
      throw new PagarmeError({
        code: "bad_request",
        message: "order_id obrigatorio.",
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }
    const res = await this.request({
      method: "GET",
      path: `/orders/${encodeURIComponent(id)}`,
      surface: "core",
    });
    return { raw: res.body, extract: extractPixFromOrder(res.body) };
  }

  async getCharge(chargeId: string): Promise<{ raw: unknown; snapshot: PagarmeChargeSnapshot }> {
    const id = String(chargeId ?? "").trim();
    if (!id) {
      throw new PagarmeError({
        code: "bad_request",
        message: "charge_id obrigatorio.",
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }
    const res = await this.request({
      method: "GET",
      path: `/charges/${encodeURIComponent(id)}`,
      surface: "core",
    });
    return { raw: res.body, snapshot: extractChargeSnapshot(res.body) };
  }

  async cancelPaymentLink(paymentLinkId: string): Promise<void> {
    const id = String(paymentLinkId ?? "").trim();
    if (!id) {
      throw new PagarmeError({
        code: "bad_request",
        message: "payment_link_id obrigatorio.",
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }
    await this.request({
      method: "PATCH",
      path: `/paymentlinks/${encodeURIComponent(id)}/cancel`,
      surface: "checkout",
    });
  }

  async cancelCharge(chargeId: string): Promise<{ raw: unknown; snapshot: PagarmeChargeSnapshot }> {
    const id = String(chargeId ?? "").trim();
    if (!id) {
      throw new PagarmeError({
        code: "bad_request",
        message: "charge_id obrigatorio.",
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }
    const res = await this.request({
      method: "DELETE",
      path: `/charges/${encodeURIComponent(id)}`,
      surface: "core",
      body: {},
    });
    return { raw: res.body, snapshot: extractChargeSnapshot(res.body) };
  }
}

export function createPagarmeClient(options?: PagarmeClientOptions): PagarmeClient {
  return new PagarmeClient(options);
}
