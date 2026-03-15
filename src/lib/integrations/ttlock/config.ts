/**
 * Configuração da integração TTLock Open Platform.
 * Todas as credenciais vêm de variáveis de ambiente; não versionar valores reais.
 *
 * Envs necessárias (preencher em .env ou ambiente):
 *   TTLOCK_CLIENT_ID      - client_id / app_id da aplicação TTLock
 *   TTLOCK_CLIENT_SECRET  - client_secret / app_secret
 *   TTLOCK_USERNAME      - usuário da conta TTLock (APP, não conta desenvolvedor)
 *   TTLOCK_PASSWORD      - senha em texto plano; o cliente fará MD5 para a API
 *   TTLOCK_TOKEN_URL     - (opcional) ex.: https://euapi.ttlock.com/oauth2/token
 *   TTLOCK_API_BASE_URL  - (opcional) ex.: https://euapi.ttlock.com
 *
 * Região: use euapi.ttlock.com para EU, cnapi.ttlock.com para China, etc.
 */

import type { TtlockConfig } from "./types";

const DEFAULT_TOKEN_URL = "https://euapi.ttlock.com/oauth2/token";
const DEFAULT_API_BASE_URL = "https://euapi.ttlock.com";

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * Retorna a configuração TTLock a partir do ambiente.
 * enabled = true só se todas as credenciais obrigatórias estiverem definidas.
 */
export function getTtlockConfig(): TtlockConfig {
  const clientId = getEnv("TTLOCK_CLIENT_ID");
  const clientSecret = getEnv("TTLOCK_CLIENT_SECRET");
  const username = getEnv("TTLOCK_USERNAME");
  const password = getEnv("TTLOCK_PASSWORD");
  const tokenUrl = getEnv("TTLOCK_TOKEN_URL") || DEFAULT_TOKEN_URL;
  const apiBaseUrl = getEnv("TTLOCK_API_BASE_URL") || DEFAULT_API_BASE_URL;

  const hasCredentials = !!(clientId && clientSecret && username && password);
  const enabled = hasCredentials;

  return {
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    username: username ?? "",
    password: password ?? "",
    tokenUrl,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    enabled,
    hasCredentials,
  };
}

/**
 * Verifica se a integração está disponível (credenciais preenchidas).
 * Use antes de chamar o cliente para falhar de forma controlada.
 */
export function isTtlockAvailable(config?: TtlockConfig): boolean {
  const c = config ?? getTtlockConfig();
  return c.enabled && c.hasCredentials;
}

/**
 * Nomes das envs obrigatórias para exibir em mensagens de erro.
 */
export const TTLOCK_REQUIRED_ENV_NAMES = [
  "TTLOCK_CLIENT_ID",
  "TTLOCK_CLIENT_SECRET",
  "TTLOCK_USERNAME",
  "TTLOCK_PASSWORD",
] as const;
