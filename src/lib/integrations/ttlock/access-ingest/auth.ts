import {
  ENV_TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST,
  ENV_TTLOCK_ACCESS_WEBHOOK_SECRET,
  TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER,
  TTLOCK_ACCESS_WEBHOOK_SECRET_QUERY,
} from "./constants";
import { constantTimeEqual } from "./constant-time";

export type WebhookAuthInput = {
  headerSecret?: string | null;
  querySecret?: string | null;
  clientIp?: string | null;
  env?: Record<string, string | undefined>;
};

export type WebhookAuthResult =
  | { ok: true }
  | { ok: false; code: "missing_secret" | "invalid_secret" | "ip_denied"; message: string };

/**
 * Autenticação do callback TTLock.
 *
 * TTLock Lock Records Notify NÃO documenta assinatura HMAC nativa do payload.
 * Estratégia Yes Hotel:
 * 1. Segredo forte em header `x-yes-hotel-ttlock-webhook-secret` (preferido se controlável);
 * 2. Fallback query `?secret=` (se a plataforma só permitir URL fixa — risco de vazamento em logs de proxy);
 * 3. Allowlist de IP apenas complementar — nunca única.
 *
 * Risco: sem HMAC nativo, quem conhecer a URL+secret pode forjar eventos.
 * Mitigar com secret longo, rotação, e (futuro) polling de reconciliação.
 */
export function validateTtlockAccessWebhookAuth(input: WebhookAuthInput): WebhookAuthResult {
  const env = input.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {});
  const expected = env[ENV_TTLOCK_ACCESS_WEBHOOK_SECRET];
  if (!expected || !String(expected).trim()) {
    return {
      ok: false,
      code: "missing_secret",
      message: "TTLOCK_ACCESS_WEBHOOK_SECRET não configurado.",
    };
  }

  const provided = input.headerSecret || input.querySecret;
  if (!provided) {
    return { ok: false, code: "missing_secret", message: "Segredo de webhook ausente." };
  }

  if (!constantTimeEqual(String(provided), String(expected))) {
    return { ok: false, code: "invalid_secret", message: "Segredo de webhook inválido." };
  }

  const allowlistRaw = env[ENV_TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST];
  if (allowlistRaw && String(allowlistRaw).trim()) {
    const allowed = String(allowlistRaw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = (input.clientIp ?? "").trim();
    if (allowed.length > 0 && ip && !allowed.includes(ip)) {
      return { ok: false, code: "ip_denied", message: "IP não permitido." };
    }
  }

  return { ok: true };
}

export function extractWebhookSecretsFromHeaders(
  headers: Headers | Record<string, string | undefined>,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER) ?? headers.get("X-Yes-Hotel-Ttlock-Webhook-Secret");
  }
  const lower = TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v) return v;
  }
  return null;
}

export function extractWebhookSecretFromUrl(url: string | URL): string | null {
  const u = typeof url === "string" ? new URL(url, "http://local") : url;
  return u.searchParams.get(TTLOCK_ACCESS_WEBHOOK_SECRET_QUERY);
}
