/**
 * Provider DigiSac: mock/stub por padrão; HTTP real quando DIGISAC_USE_MOCK=false
 * e base URL + token configurados. Corpo do POST é genérico até fechar doc oficial.
 */
import type { ComunicacaoProvider } from "./types.ts";

export type DigisacSendResult = {
  ok: boolean;
  provider_message_id?: string;
  error?: string;
  provider_used: Extract<ComunicacaoProvider, "digisac_stub" | "digisac">;
};

export function normalizePhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return "55" + digits;
  return digits;
}

export function maskPhoneForLog(phoneDigits: string): string {
  const d = phoneDigits.replace(/\D/g, "");
  if (d.length <= 4) return "****";
  return `***${d.slice(-4)}`;
}

export type DigisacEnvConfig = {
  useMock: boolean;
  apiBaseUrl: string;
  apiToken: string;
  serviceId: string;
  /** Path relativo à base (ex. /api/v1/messages) — ajustar com doc DigiSac */
  messagesPath: string;
};

export function readDigisacEnv(): DigisacEnvConfig {
  const useMockRaw = (Deno.env.get("DIGISAC_USE_MOCK") ?? "true").trim().toLowerCase();
  const useMock = useMockRaw !== "false";
  return {
    useMock,
    apiBaseUrl: (Deno.env.get("DIGISAC_API_BASE_URL") ?? "").trim().replace(/\/+$/, ""),
    apiToken: (Deno.env.get("DIGISAC_API_TOKEN") ?? "").trim(),
    serviceId: (Deno.env.get("DIGISAC_SERVICE_ID") ?? "").trim(),
    messagesPath: (Deno.env.get("DIGISAC_MESSAGES_PATH") ?? "/api/messages").trim() || "/api/messages",
  };
}

export function shouldUseDigisacMock(cfg: DigisacEnvConfig): boolean {
  if (cfg.useMock) return true;
  if (!cfg.apiBaseUrl || !cfg.apiToken) return true;
  return false;
}

export async function sendDigisacMessage(
  cfg: DigisacEnvConfig,
  params: { telefoneRaw: string; text: string },
): Promise<DigisacSendResult> {
  const phone = normalizePhoneDigits(params.telefoneRaw);
  if (!phone) {
    return { ok: false, error: "Telefone inválido (sem dígitos).", provider_used: "digisac_stub" };
  }
  if (params.text.includes("__digisac_fail__")) {
    return { ok: false, error: "Simulação de falha DigiSac (__digisac_fail__).", provider_used: "digisac_stub" };
  }
  if (shouldUseDigisacMock(cfg)) {
    return {
      ok: true,
      provider_message_id: `digisac-mock-${Date.now()}`,
      provider_used: "digisac_stub",
    };
  }
  const path = cfg.messagesPath.startsWith("/") ? cfg.messagesPath : `/${cfg.messagesPath}`;
  const url = `${cfg.apiBaseUrl}${path}`;
  const body: Record<string, unknown> = {
    serviceId: cfg.serviceId || undefined,
    service: cfg.serviceId || undefined,
    to: phone,
    phone,
    text: params.text,
    message: params.text,
    body: params.text,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof data?.message === "string"
        ? data.message
        : typeof data?.error === "string"
        ? data.error
        : `HTTP ${res.status}`;
      return { ok: false, error: `DigiSac: ${msg}`, provider_used: "digisac" };
    }
    const id = typeof data?.id === "string"
      ? data.id
      : typeof data?.messageId === "string"
      ? data.messageId
      : typeof data?.data === "object" && data.data && typeof (data.data as Record<string, unknown>)?.id === "string"
      ? String((data.data as Record<string, unknown>).id)
      : undefined;
    return { ok: true, provider_message_id: id, provider_used: "digisac" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      provider_used: "digisac",
    };
  }
}
