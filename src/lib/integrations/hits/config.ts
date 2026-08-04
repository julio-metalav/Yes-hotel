/**
 * Configuração server-side da integração oficial HITS.
 * Flags desligadas por padrão. Sem NEXT_PUBLIC_*. Sem validação por rede.
 */

export const HITS_DEFAULT_API_BASE_URL = "https://api.hitspms.net";
export const HITS_DEFAULT_API_VERSION = "1";
export const HITS_DEFAULT_TIMEOUT_MS = 12_000;
export const HITS_DEFAULT_LANGUAGE_CODE = "pt-BR";

/** Escopos possíveis no schema AccessSecret (Swagger V1). */
export const HITS_KNOWN_SCOPES = [
  "InternetMgr",
  "ChannelMgr",
  "PtOfSale",
  "WebCheckIn",
] as const;

export type HitsKnownScope = (typeof HITS_KNOWN_SCOPES)[number];

export type HitsAuthContractStatus = "verified" | "unverified";
export type HitsCheckInBodyContractStatus = "verified" | "unverified";

export interface HitsConfig {
  apiBaseUrl: string;
  /** Shared access secret — somente server-side. Pode estar vazio com integração desligada. */
  sharedAccessSecret: string;
  /** UUID da propriedade (AccessSecret.propertyId). Não inventar. */
  propertyId: string;
  integrationEnabled: boolean;
  checkinEnabled: boolean;
  requestTimeoutMs: number;
  /** Header X-API-VERSION (default Swagger = "1"). */
  apiVersion: string;
  /**
   * Headers de contexto observados no Swagger para Datashare.
   * Obrigatórios nas rotas autenticadas; valores oficiais ainda dependem da HITS.
   */
  tenantName: string;
  propertyCode: string;
  partnerUserId: string;
  clientId: string;
  languageCode: string;
  /** Escopos solicitados no /Authorize. Default: WebCheckIn. */
  scopes: string[];
  /**
   * Contrato POST /Authorize + AccessSecret + AccessToken + Bearer:
   * confirmado no swagger/v1/swagger.json.
   */
  authContractStatus: HitsAuthContractStatus;
  /**
   * POST /Datashare/Folios/{reservationId}/CheckIn não declara requestBody no Swagger;
   * CheckInDto aparece só como resposta 200. Corpo de request permanece unverified.
   */
  checkInBodyContractStatus: HitsCheckInBodyContractStatus;
}

function readEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function parseBoolExactTrue(raw: string): boolean {
  return raw === "true";
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

/**
 * Lê configuração do ambiente.
 * Não exige secret/propertyId quando a integração está desligada.
 */
export function getHitsConfig(env: NodeJS.ProcessEnv = process.env): HitsConfig {
  const prev = process.env;
  // Permite injeção em testes sem mutar global quando o caller passa um objeto próprio.
  const read = (name: string): string => {
    if (env === prev) return readEnv(name);
    return String(env[name] ?? "").trim();
  };

  const apiBaseUrl = (read("HITS_API_BASE_URL") || HITS_DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const integrationEnabled = parseBoolExactTrue(read("HITS_INTEGRATION_ENABLED"));
  const checkinEnabled = parseBoolExactTrue(read("HITS_CHECKIN_ENABLED"));

  return {
    apiBaseUrl,
    sharedAccessSecret: read("HITS_SHARED_ACCESS_SECRET"),
    propertyId: read("HITS_PROPERTY_ID"),
    integrationEnabled,
    checkinEnabled: integrationEnabled && checkinEnabled,
    requestTimeoutMs: parseTimeoutMs(read("HITS_REQUEST_TIMEOUT_MS")),
    apiVersion: read("HITS_API_VERSION") || HITS_DEFAULT_API_VERSION,
    tenantName: read("HITS_TENANT_NAME"),
    propertyCode: read("HITS_PROPERTY_CODE"),
    partnerUserId: read("HITS_PARTNER_USER_ID"),
    clientId: read("HITS_CLIENT_ID"),
    languageCode: read("HITS_LANGUAGE_CODE") || HITS_DEFAULT_LANGUAGE_CODE,
    scopes: parseScopes(read("HITS_AUTHORIZE_SCOPES")),
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
  };
}

export function isHitsIntegrationEnabled(config?: HitsConfig): boolean {
  return (config ?? getHitsConfig()).integrationEnabled === true;
}

export function isHitsCheckInEnabled(config?: HitsConfig): boolean {
  const c = config ?? getHitsConfig();
  return c.integrationEnabled === true && c.checkinEnabled === true;
}

export function hitsConfigStatus(config?: HitsConfig): {
  integration_enabled: boolean;
  checkin_enabled: boolean;
  has_shared_secret: boolean;
  has_property_id: boolean;
  auth_contract: HitsAuthContractStatus;
  checkin_body_contract: HitsCheckInBodyContractStatus;
} {
  const c = config ?? getHitsConfig();
  return {
    integration_enabled: c.integrationEnabled,
    checkin_enabled: c.checkinEnabled,
    has_shared_secret: Boolean(c.sharedAccessSecret),
    has_property_id: Boolean(c.propertyId),
    auth_contract: c.authContractStatus,
    checkin_body_contract: c.checkInBodyContractStatus,
  };
}

/** @deprecated Prefer getHitsConfig(). Mantido para scripts legados de leitura. */
export interface HitsEnv {
  baseUrl: string;
  apiVersion: string;
  accessSecret: string;
  tenantName?: string;
  propertyCode?: string;
  partnerUserId?: string;
  clientId?: string;
  languageCode: string;
}

/** @deprecated Prefer getHitsConfig(). */
export function getHitsEnv(): HitsEnv {
  const c = getHitsConfig();
  return {
    baseUrl: c.apiBaseUrl,
    apiVersion: c.apiVersion,
    accessSecret: c.sharedAccessSecret,
    tenantName: c.tenantName || undefined,
    propertyCode: c.propertyCode || undefined,
    partnerUserId: c.partnerUserId || undefined,
    clientId: c.clientId || undefined,
    languageCode: c.languageCode,
  };
}
