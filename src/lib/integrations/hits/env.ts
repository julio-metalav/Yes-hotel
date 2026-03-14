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

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }

  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getHitsEnv(): HitsEnv {
  const baseUrl = getRequiredEnv("HITS_BASE_URL").replace(/\/+$/, "");

  return {
    baseUrl,
    apiVersion: getRequiredEnv("HITS_API_VERSION"),
    accessSecret: getRequiredEnv("HITS_ACCESS_SECRET"),
    tenantName: getOptionalEnv("HITS_TENANT_NAME"),
    propertyCode: getOptionalEnv("HITS_PROPERTY_CODE"),
    partnerUserId: getOptionalEnv("HITS_PARTNER_USER_ID"),
    clientId: getOptionalEnv("HITS_CLIENT_ID"),
    languageCode: process.env.HITS_LANGUAGE_CODE?.trim() || "pt-BR",
  };
}
