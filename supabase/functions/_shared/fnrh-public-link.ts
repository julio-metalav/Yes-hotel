/**
 * Origem pública da página FNRH (frontend), distinta de SUPABASE_URL (API).
 * Nunca use *.supabase.co como base de HTML público.
 */

export const FNRH_PUBLIC_PAGE_PATH = "/fnrh-preenchimento.html";
export const FNRH_PUBLIC_DEFAULT_BASE_URL = "https://yes-hotel.vercel.app";

export function isForbiddenFnrhPublicHost(hostname: string): boolean {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return true;
  return h === "supabase.co" || h.endsWith(".supabase.co");
}

/**
 * Normaliza base pública https sem path/query e sem barra final.
 * Rejeita http, hosts Supabase e URLs inválidas.
 */
export function normalizeFnrhPublicBaseUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (isForbiddenFnrhPublicHost(parsed.hostname)) return null;

  return parsed.origin;
}

/**
 * Prioridade: override válido → env válido → default de produção.
 * Nunca faz fallback para SUPABASE_URL.
 */
export function resolveFnrhPublicBaseUrl(options?: {
  override?: string | null;
  envValue?: string | null;
}): string {
  const fromOverride = normalizeFnrhPublicBaseUrl(options?.override);
  if (fromOverride) return fromOverride;

  const fromEnv = normalizeFnrhPublicBaseUrl(options?.envValue);
  if (fromEnv) return fromEnv;

  return FNRH_PUBLIC_DEFAULT_BASE_URL;
}

export function buildFnrhPreenchimentoUrl(
  guestId: string,
  token: string,
  options?: {
    baseUrl?: string | null;
    envValue?: string | null;
    version?: string | number;
  },
): string {
  const base = resolveFnrhPublicBaseUrl({
    override: options?.baseUrl,
    envValue: options?.envValue,
  });
  const url = new URL(FNRH_PUBLIC_PAGE_PATH, `${base}/`);
  url.searchParams.set("v", String(options?.version ?? 2));
  url.searchParams.set("guest_id", String(guestId ?? ""));
  url.searchParams.set("token", String(token ?? ""));
  return url.toString();
}

/** Mascara o token na query para logs/preview (não registra token completo). */
export function maskFnrhLinkForLog(link: string): string {
  try {
    const u = new URL(link);
    if (u.searchParams.has("token")) {
      const t = u.searchParams.get("token") || "";
      u.searchParams.set("token", t.length <= 4 ? "***" : `${t.slice(0, 2)}***`);
    }
    return u.toString();
  } catch {
    return String(link).replace(/([?&]token=)[^&\s]*/gi, "$1***");
  }
}

/** Mascara tokens FNRH em textos de preview/log (e-mail/WhatsApp). */
export function maskFnrhTokensInText(text: string): string {
  return String(text).replace(/https?:\/\/[^\s<>"']+/g, (match) => {
    if (/[?&]token=/i.test(match)) return maskFnrhLinkForLog(match);
    return match;
  });
}
