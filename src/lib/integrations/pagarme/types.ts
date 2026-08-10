/**
 * Tipos da integração Pagar.me Core API v5 (server-side).
 * Nenhum tipo carrega dado de cartão do pagador.
 */

export type PagarmeMetodo = "pix" | "cartao";

/** Status normalizado Yes Hotel (espelha check da migration). */
export type CobrancaStatusNormalizado =
  | "created"
  | "pending"
  | "processing"
  | "paid"
  | "expired"
  | "canceled"
  | "failed"
  | "refunded"
  | "chargeback";

export type ClassificacaoComissionamento =
  | "nao_comissionada"
  | "comissionada"
  | "desconhecida";

export type RevisaoMotivo =
  | "charge_underpaid"
  | "charge_overpaid"
  | "charge_partial_canceled";

export type PagarmeEnvironment = "test" | "production";

export type PagarmeSecretKeyKind = "test" | "live" | "unknown" | "missing";

export type PagarmeHttpErrorCode =
  | "integration_disabled"
  | "missing_secret"
  | "env_missing"
  | "env_secret_mismatch"
  | "secret_kind_unknown"
  | "live_secret_blocked"
  | "production_env_unsupported"
  | "unexpected_base_url"
  | "unexpected_core_base_url"
  | "unexpected_checkout_base_url"
  | "core_base_wrong_surface"
  | "checkout_base_wrong_surface"
  | "legacy_ambiguous_base_url"
  | "production_base_blocked"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "invalid_json"
  | "ambiguous_response"
  | "definitive_error"
  | "unknown";

export interface PagarmeApiErrorShape {
  code: PagarmeHttpErrorCode;
  message: string;
  httpStatus: number | null;
  /** true = não marcar failed / não liberar nova cobrança */
  ambiguous: boolean;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface PagarmeConfig {
  env: PagarmeEnvironment | null;
  /** Base Core: orders / charges. */
  coreApiBaseUrl: string;
  /** Base Checkout: paymentlinks. */
  checkoutApiBaseUrl: string;
  /**
   * Compat: espelha coreApiBaseUrl (orders/charges).
   * Não usar para paymentlinks.
   */
  apiBaseUrl: string;
  secretKey: string;
  secretKeyKind: PagarmeSecretKeyKind;
  integrationEnabled: boolean;
  requestTimeoutMs: number;
  pixExpiresInSeconds: number;
  envAllowed: boolean;
  secretAllowed: boolean;
  coreBaseUrlAllowed: boolean;
  checkoutBaseUrlAllowed: boolean;
  /** true se Core e Checkout estão permitidos para o env. */
  baseUrlAllowed: boolean;
  transportAllowed: boolean;
  blockReason: string | null;
}

export interface PagarmeIntegrationStatus {
  integration_enabled: boolean;
  has_secret: boolean;
  env: PagarmeEnvironment | null;
  secret_key_kind: Exclude<PagarmeSecretKeyKind, "missing"> | null;
  core_base_url: string;
  checkout_base_url: string;
  /** Compat: core base. */
  base_url: string;
  base_url_allowed: boolean;
  transport_allowed: boolean;
  block_reason: string | null;
}

export interface PagarmeInstallmentOption {
  number: number;
  /** Valor TOTAL da cobrança em centavos (sem juros). */
  total: number;
}

export interface PagarmePixCustomer {
  name: string;
  email: string;
  document: string;
  document_type?: "CPF" | "CNPJ";
  phone_country_code?: string;
  phone_area_code?: string;
  phone_number?: string;
}

export interface CreatePixOrderInput {
  /** UUID da cobrança local — usado em code/metadata. */
  cobrancaId: string;
  valorCentavos: number;
  customer: PagarmePixCustomer;
  idempotencyKey: string;
  description?: string;
}

export interface CreatePaymentLinkInput {
  /** UUID da cobrança local → order_code. */
  cobrancaId: string;
  valorCentavos: number;
  idempotencyKey: string;
  name?: string;
  itemName?: string;
  itemDescription?: string;
}

export interface PagarmePixExtract {
  orderId: string | null;
  chargeId: string | null;
  transactionId: string | null;
  qrCode: string | null;
  qrCodeUrl: string | null;
  expiresAt: string | null;
  statusRaw: string | null;
  statusNormalized: CobrancaStatusNormalizado;
  amountCentavos: number | null;
  currency: string | null;
}

export interface PagarmePaymentLinkExtract {
  paymentLinkId: string | null;
  paymentLinkUrl: string | null;
  orderCode: string | null;
  statusRaw: string | null;
  statusNormalized: CobrancaStatusNormalizado;
  expiresAt: string | null;
}

export interface PagarmeChargeSnapshot {
  chargeId: string;
  orderId: string | null;
  statusRaw: string;
  statusNormalized: CobrancaStatusNormalizado;
  amountCentavos: number | null;
  paidAmountCentavos: number | null;
  currency: string | null;
  paidAt: string | null;
  transactionId: string | null;
  orderCode: string | null;
  paymentMethod: string | null;
  paymentLinkId: string | null;
}

export type PagarmeFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface PagarmeTransportResponse {
  httpStatus: number;
  headers: Record<string, string>;
  body: unknown;
  rawText: string;
}
