/**
 * Configuração server-side Pagar.me — fail-closed.
 *
 * TEST:
 * - PAGARME_ENV=test
 * - secret somente sk_test_
 * - Core: https://api.pagar.me/core/v5
 * - Checkout: https://sdx-api.pagar.me/core/v5
 *
 * PRODUCTION:
 * - PAGARME_ENV=production
 * - secret somente sk_ (formato oficial atual da conta LIVE)
 * - Core: https://api.pagar.me/core/v5
 * - Checkout: https://api.pagar.me/core/v5
 *
 * sk_live_ NÃO é suportado (formato não usado pela conta LIVE Yes Hotel).
 * Nunca cruzar test↔production. Sem fallback. Sem inferir env pela chave.
 */

import type {
  PagarmeConfig,
  PagarmeEnvironment,
  PagarmeIntegrationStatus,
  PagarmeSecretKeyKind,
} from "./types.ts";

/** Core API — orders / charges (test e production). */
export const PAGARME_CORE_API_BASE_URL = "https://api.pagar.me/core/v5";

/** Checkout / Payment Links em ambiente TEST. */
export const PAGARME_CHECKOUT_TEST_API_BASE_URL = "https://sdx-api.pagar.me/core/v5";

/**
 * Checkout / Payment Links em ambiente PRODUCTION.
 * Mesma host do Core, mas surface semanticamente distinta.
 */
export const PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL = "https://api.pagar.me/core/v5";

/**
 * @deprecated Preferir PAGARME_CHECKOUT_TEST_API_BASE_URL.
 * Mantido como alias do Checkout TEST (sdx).
 */
export const PAGARME_HOMOLOG_API_BASE_URL = PAGARME_CHECKOUT_TEST_API_BASE_URL;

/**
 * @deprecated Preferir PAGARME_CORE_API_BASE_URL.
 * Mantido como alias do Core (api.pagar.me).
 */
export const PAGARME_PRODUCTION_API_BASE_URL = PAGARME_CORE_API_BASE_URL;

export const PAGARME_DEFAULT_TIMEOUT_MS = 20_000;
export const PAGARME_DEFAULT_PIX_EXPIRES_IN_SECONDS = 86_400;

export type PagarmeEnvSource = Record<string, string | undefined>;

export type PagarmeBaseUrlReason =
  | "ok"
  | "missing_base_url"
  | "unexpected_base_url"
  | "wrong_surface_for_env"
  | "production_env_unsupported";

export type PagarmeProductSurface = "core" | "checkout";

function readEnv(env: PagarmeEnvSource, name: string): string {
  return String(env[name] ?? "").trim();
}

function parseBoolExactTrue(raw: string): boolean {
  return raw === "true";
}

function parseTimeoutMs(raw: string): number {
  if (!raw) return PAGARME_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000 || n > 120_000) return PAGARME_DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

function parsePixExpires(raw: string): number {
  if (!raw) return PAGARME_DEFAULT_PIX_EXPIRES_IN_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60 || n > 60 * 60 * 24 * 30) {
    return PAGARME_DEFAULT_PIX_EXPIRES_IN_SECONDS;
  }
  return Math.floor(n);
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/**
 * Classifica o prefixo da secret sem expor o valor.
 * ORDEM CRÍTICA:
 * 1) sk_test_ => test
 * 2) sk_live_ => unknown (formato não suportado nesta integração)
 * 3) sk_ => live/production (formato oficial LIVE atual)
 * 4) demais => unknown
 *
 * Ambiente NÃO é inferido pelo prefixo: PAGARME_ENV é obrigatório e separado.
 */
export function classifyPagarmeSecretKey(secretKey: string): PagarmeSecretKeyKind {
  const key = String(secretKey ?? "").trim();
  if (!key) return "missing";
  // sk_test_ ANTES de sk_ — senão cairia no ramo production.
  if (key.startsWith("sk_test_")) return "test";
  // sk_live_ explicitamente não suportado (conta LIVE Yes Hotel usa sk_).
  if (key.startsWith("sk_live_")) return "unknown";
  if (key.startsWith("sk_")) return "live";
  return "unknown";
}

export function parsePagarmeEnvironment(raw: string): PagarmeEnvironment | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "test") return "test";
  if (v === "production") return "production";
  return null;
}

export function expectedCheckoutBaseUrlForEnv(
  pagarmeEnv: PagarmeEnvironment | null,
): string | null {
  if (pagarmeEnv === "test") return PAGARME_CHECKOUT_TEST_API_BASE_URL;
  if (pagarmeEnv === "production") return PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL;
  return null;
}

/**
 * Avalia base URL do Core (orders/charges).
 * TEST e PRODUCTION: somente https://api.pagar.me/core/v5
 * sdx-api nunca é Core.
 */
export function evaluatePagarmeCoreBaseUrl(
  rawBaseUrl: string,
  pagarmeEnv: PagarmeEnvironment | null,
): { url: string; allowed: boolean; reason: PagarmeBaseUrlReason } {
  const trimmed = String(rawBaseUrl ?? "").trim();
  if (!trimmed) {
    return { url: "", allowed: false, reason: "missing_base_url" };
  }
  const url = normalizeBaseUrl(trimmed);
  if (!pagarmeEnv) {
    return { url, allowed: false, reason: "unexpected_base_url" };
  }
  if (pagarmeEnv !== "test" && pagarmeEnv !== "production") {
    return { url, allowed: false, reason: "production_env_unsupported" };
  }
  if (url === PAGARME_CHECKOUT_TEST_API_BASE_URL) {
    return { url, allowed: false, reason: "wrong_surface_for_env" };
  }
  if (url !== PAGARME_CORE_API_BASE_URL) {
    return { url, allowed: false, reason: "unexpected_base_url" };
  }
  return { url, allowed: true, reason: "ok" };
}

/**
 * Avalia base URL do Checkout (paymentlinks).
 * TEST: somente sdx-api
 * PRODUCTION: somente api.pagar.me (mesmo host do Core; surface distinta)
 */
export function evaluatePagarmeCheckoutBaseUrl(
  rawBaseUrl: string,
  pagarmeEnv: PagarmeEnvironment | null,
): { url: string; allowed: boolean; reason: PagarmeBaseUrlReason } {
  const trimmed = String(rawBaseUrl ?? "").trim();
  if (!trimmed) {
    return { url: "", allowed: false, reason: "missing_base_url" };
  }
  const url = normalizeBaseUrl(trimmed);
  if (!pagarmeEnv) {
    return { url, allowed: false, reason: "unexpected_base_url" };
  }
  if (pagarmeEnv === "test") {
    if (url === PAGARME_CORE_API_BASE_URL) {
      return { url, allowed: false, reason: "wrong_surface_for_env" };
    }
    if (url !== PAGARME_CHECKOUT_TEST_API_BASE_URL) {
      return { url, allowed: false, reason: "unexpected_base_url" };
    }
    return { url, allowed: true, reason: "ok" };
  }
  if (pagarmeEnv === "production") {
    if (url === PAGARME_CHECKOUT_TEST_API_BASE_URL) {
      return { url, allowed: false, reason: "wrong_surface_for_env" };
    }
    if (url !== PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL) {
      return { url, allowed: false, reason: "unexpected_base_url" };
    }
    return { url, allowed: true, reason: "ok" };
  }
  return { url, allowed: false, reason: "production_env_unsupported" };
}

/**
 * @deprecated Preferir evaluatePagarmeCoreBaseUrl / evaluatePagarmeCheckoutBaseUrl.
 * Mantido: interpreta como Checkout TEST (sdx). api.pagar.me ≠ checkout test.
 */
export function evaluatePagarmeBaseUrl(rawBaseUrl: string): {
  url: string;
  allowed: boolean;
  reason: "ok" | "production_base_blocked" | "unexpected_base_url" | "missing_base_url";
} {
  const trimmed = String(rawBaseUrl ?? "").trim();
  if (!trimmed) {
    return { url: "", allowed: false, reason: "missing_base_url" };
  }
  const url = normalizeBaseUrl(trimmed);
  if (url === PAGARME_CORE_API_BASE_URL) {
    return { url, allowed: false, reason: "production_base_blocked" };
  }
  if (url !== PAGARME_CHECKOUT_TEST_API_BASE_URL) {
    return { url, allowed: false, reason: "unexpected_base_url" };
  }
  return { url, allowed: true, reason: "ok" };
}

/**
 * Compatibilidade env × kind da secret (fail-closed).
 * Usar também no client.assertTransport — não confiar em flags pré-computadas.
 */
export function resolveEnvSecretCompatibility(
  pagarmeEnv: PagarmeEnvironment | null,
  secretKind: PagarmeSecretKeyKind,
): { ok: boolean; reason: string | null } {
  if (!pagarmeEnv) {
    return { ok: false, reason: "env_missing" };
  }
  if (secretKind === "missing") {
    return { ok: false, reason: "missing_secret" };
  }
  if (secretKind === "unknown") {
    return { ok: false, reason: "secret_kind_unknown" };
  }

  if (pagarmeEnv === "test") {
    if (secretKind === "live") {
      return { ok: false, reason: "live_secret_blocked" };
    }
    if (secretKind === "test") {
      return { ok: true, reason: null };
    }
    return { ok: false, reason: "secret_kind_unknown" };
  }

  if (pagarmeEnv === "production") {
    if (secretKind === "test") {
      return { ok: false, reason: "env_secret_mismatch" };
    }
    if (secretKind === "live") {
      return { ok: true, reason: null };
    }
    return { ok: false, reason: "secret_kind_unknown" };
  }

  return { ok: false, reason: "env_missing" };
}

/**
 * Lê configuração do ambiente.
 * Sem ENV válido / secret pareada / bases allowlisted / ENABLED=true: transportAllowed=false.
 */
export function getPagarmeConfig(
  env: PagarmeEnvSource = typeof process !== "undefined" ? process.env : {},
): PagarmeConfig {
  const integrationEnabled = parseBoolExactTrue(readEnv(env, "PAGARME_INTEGRATION_ENABLED"));
  const secretKey = readEnv(env, "PAGARME_SECRET_KEY");
  const secretKeyKind = classifyPagarmeSecretKey(secretKey);
  const pagarmeEnv = parsePagarmeEnvironment(readEnv(env, "PAGARME_ENV"));

  const legacySingleBase = readEnv(env, "PAGARME_API_BASE_URL");
  const rawCore =
    readEnv(env, "PAGARME_CORE_API_BASE_URL") ||
    ((pagarmeEnv === "test" || pagarmeEnv === "production") && !legacySingleBase
      ? PAGARME_CORE_API_BASE_URL
      : "");
  const rawCheckout =
    readEnv(env, "PAGARME_CHECKOUT_API_BASE_URL") ||
    (pagarmeEnv === "test" && !legacySingleBase
      ? PAGARME_CHECKOUT_TEST_API_BASE_URL
      : pagarmeEnv === "production" && !legacySingleBase
        ? PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL
        : "");

  // Legacy PAGARME_API_BASE_URL sozinho é ambíguo (Core×Checkout) → bloquear.
  const legacyAmbiguous =
    Boolean(legacySingleBase) &&
    !readEnv(env, "PAGARME_CORE_API_BASE_URL") &&
    !readEnv(env, "PAGARME_CHECKOUT_API_BASE_URL");

  const coreEval = evaluatePagarmeCoreBaseUrl(rawCore, pagarmeEnv);
  const checkoutEval = evaluatePagarmeCheckoutBaseUrl(rawCheckout, pagarmeEnv);
  const envSecret = resolveEnvSecretCompatibility(pagarmeEnv, secretKeyKind);

  let blockReason: string | null = null;
  if (!pagarmeEnv) blockReason = "env_missing";
  else if (legacyAmbiguous) blockReason = "legacy_ambiguous_base_url";
  else if (!envSecret.ok) blockReason = envSecret.reason;
  else if (!coreEval.allowed) {
    blockReason =
      coreEval.reason === "wrong_surface_for_env"
        ? "core_base_wrong_surface"
        : coreEval.reason === "missing_base_url"
          ? "missing_core_base_url"
          : coreEval.reason === "production_env_unsupported"
            ? "production_env_unsupported"
            : "unexpected_core_base_url";
  } else if (!checkoutEval.allowed) {
    blockReason =
      checkoutEval.reason === "wrong_surface_for_env"
        ? "checkout_base_wrong_surface"
        : checkoutEval.reason === "missing_base_url"
          ? "missing_checkout_base_url"
          : checkoutEval.reason === "production_env_unsupported"
            ? "production_env_unsupported"
            : "unexpected_checkout_base_url";
  }

  const envAllowed = pagarmeEnv === "test" || pagarmeEnv === "production";
  const secretAllowed = envSecret.ok === true;
  const coreBaseUrlAllowed = coreEval.allowed && !legacyAmbiguous && envAllowed;
  const checkoutBaseUrlAllowed =
    checkoutEval.allowed && !legacyAmbiguous && envAllowed;
  const baseUrlAllowed = coreBaseUrlAllowed && checkoutBaseUrlAllowed;
  const hasSecret = Boolean(secretKey);
  const transportAllowed =
    integrationEnabled &&
    hasSecret &&
    envAllowed &&
    secretAllowed &&
    baseUrlAllowed &&
    blockReason === null;

  const defaultCheckout =
    pagarmeEnv === "production"
      ? PAGARME_CHECKOUT_PRODUCTION_API_BASE_URL
      : PAGARME_CHECKOUT_TEST_API_BASE_URL;

  return {
    env: pagarmeEnv,
    coreApiBaseUrl: coreEval.url || PAGARME_CORE_API_BASE_URL,
    checkoutApiBaseUrl: checkoutEval.url || defaultCheckout,
    /** Compat: aponta para Core (orders/charges). */
    apiBaseUrl: coreEval.url || PAGARME_CORE_API_BASE_URL,
    secretKey,
    secretKeyKind,
    integrationEnabled,
    requestTimeoutMs: parseTimeoutMs(readEnv(env, "PAGARME_REQUEST_TIMEOUT_MS")),
    pixExpiresInSeconds: parsePixExpires(readEnv(env, "PAGARME_PIX_EXPIRES_IN_SECONDS")),
    envAllowed,
    secretAllowed,
    coreBaseUrlAllowed,
    checkoutBaseUrlAllowed,
    baseUrlAllowed,
    transportAllowed,
    blockReason,
  };
}

export function pagarmeConfigStatus(config?: PagarmeConfig): PagarmeIntegrationStatus {
  const c = config ?? getPagarmeConfig();
  return {
    integration_enabled: c.integrationEnabled,
    has_secret: Boolean(c.secretKey),
    env: c.env,
    secret_key_kind: c.secretKeyKind === "missing" ? null : c.secretKeyKind,
    core_base_url: c.coreApiBaseUrl,
    checkout_base_url: c.checkoutApiBaseUrl,
    base_url: c.apiBaseUrl,
    base_url_allowed: c.baseUrlAllowed,
    transport_allowed: c.transportAllowed,
    block_reason: c.blockReason,
  };
}

export function isPagarmeTransportAllowed(config?: PagarmeConfig): boolean {
  return (config ?? getPagarmeConfig()).transportAllowed === true;
}

export function resolvePagarmeBaseForSurface(
  config: PagarmeConfig,
  surface: PagarmeProductSurface,
): string {
  return surface === "core" ? config.coreApiBaseUrl : config.checkoutApiBaseUrl;
}
