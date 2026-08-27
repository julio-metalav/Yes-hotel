/**
 * Configuração do Gateway HITS.
 *
 * Nomes HITS: somente os confirmados em src/lib/integrations/hits/config.ts.
 * Sem default para HITS_API_BASE_URL (não hardcoded de produção neste serviço).
 */

import {
  HITS_DEFAULT_API_VERSION,
  HITS_DEFAULT_LANGUAGE_CODE,
  HITS_DEFAULT_TIMEOUT_MS,
  type HitsConfig,
} from "../../../src/lib/integrations/hits/config.ts";
import { isHitsGuestWriteEnabled } from "./guest-write.ts";

export const GATEWAY_BIND_HOST = "127.0.0.1";
export const GATEWAY_DEFAULT_PORT = 3001;
/** Mínimo operacional: 32 caracteres. Recomendado: `openssl rand -hex 32` (64 hex). */
export const GATEWAY_TOKEN_MIN_LENGTH = 32;
export const TRUSTED_PROXY_ADDRESSES = ["127.0.0.1", "::1"] as const;

export type GatewayConfig = {
  nodeEnv: string;
  port: number;
  gatewayToken: string;
  hits: HitsConfig;
  hitsReady: boolean;
  hitsReadyReason: string | null;
  /** Escrita PAX só com HITS pronto + tenant sandbox `develop` + flag exact `true`. */
  guestWriteEnabled: boolean;
};

function read(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value == null) return "";
  return String(value);
}

function parsePort(raw: string): number {
  if (!raw) return GATEWAY_DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return GATEWAY_DEFAULT_PORT;
  return n;
}

function parseTimeoutMs(raw: string): number {
  if (!raw) return HITS_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000 || n > 120_000) return HITS_DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

function parseScopes(raw: string): string[] {
  if (!raw) return ["WebCheckIn"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHitsApiBaseUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/\/+$/, ""));
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  } catch {
    return null;
  }
}

export function assessHitsReady(hits: HitsConfig): { ok: boolean; reason: string | null } {
  if (!hits.apiBaseUrl) {
    return { ok: false, reason: "HITS_API_BASE_URL ausente ou inválida (exige https, sem default)" };
  }
  if (!hits.sharedAccessSecret) {
    return { ok: false, reason: "HITS_SHARED_ACCESS_SECRET ausente" };
  }
  if (!hits.propertyId) {
    return { ok: false, reason: "HITS_PROPERTY_ID ausente" };
  }
  if (!hits.tenantName || !hits.propertyCode || !hits.clientId) {
    return {
      ok: false,
      reason: "HITS_TENANT_NAME / HITS_PROPERTY_CODE / HITS_CLIENT_ID ausentes",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Monta HitsConfig para o HitsClient existente.
 * integrationEnabled=true só quando o gateway está pronto para falar com o HITS.
 * checkinEnabled permanece sempre false neste serviço.
 */
export function buildHitsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HitsConfig {
  const apiBaseUrl = parseHitsApiBaseUrl(read(env, "HITS_API_BASE_URL")) ?? "";
  const timeoutRaw = read(env, "HITS_REQUEST_TIMEOUT_MS");

  return {
    apiBaseUrl,
    sharedAccessSecret: read(env, "HITS_SHARED_ACCESS_SECRET"),
    propertyId: read(env, "HITS_PROPERTY_ID"),
    integrationEnabled: false,
    checkinEnabled: false,
    requestTimeoutMs: parseTimeoutMs(timeoutRaw),
    apiVersion: read(env, "HITS_API_VERSION") || HITS_DEFAULT_API_VERSION,
    tenantName: read(env, "HITS_TENANT_NAME"),
    propertyCode: read(env, "HITS_PROPERTY_CODE"),
    partnerUserId: read(env, "HITS_PARTNER_USER_ID"),
    clientId: read(env, "HITS_CLIENT_ID"),
    languageCode: read(env, "HITS_LANGUAGE_CODE") || HITS_DEFAULT_LANGUAGE_CODE,
    scopes: parseScopes(read(env, "HITS_AUTHORIZE_SCOPES")),
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const gatewayToken = read(env, "GATEWAY_TOKEN");
  const hitsBase = buildHitsConfigFromEnv(env);
  const readiness = assessHitsReady(hitsBase);
  const hits: HitsConfig = {
    ...hitsBase,
    integrationEnabled: readiness.ok,
    checkinEnabled: false,
  };

  return {
    nodeEnv: read(env, "NODE_ENV") || "production",
    port: parsePort(read(env, "PORT")),
    gatewayToken,
    hits,
    hitsReady: readiness.ok,
    hitsReadyReason: readiness.reason,
    guestWriteEnabled: isHitsGuestWriteEnabled({
      hitsReady: readiness.ok,
      tenantName: hits.tenantName,
      guestWriteFlag: readRaw(env, "HITS_GUEST_WRITE_ENABLED"),
    }),
  };
}

export function assertGatewayTokenOrThrow(token: string): void {
  if (!token || token.length < GATEWAY_TOKEN_MIN_LENGTH) {
    throw new Error(
      `GATEWAY_TOKEN ausente ou curto demais (mínimo ${GATEWAY_TOKEN_MIN_LENGTH} caracteres). Processo recusado.`,
    );
  }
}
