/**
 * Provider DigiSac: stub quando DIGISAC_USE_MOCK=true ou credenciais incompletas;
 * POST real para /api/v1/messages (contato por number + serviceId), doc oficial DigiSac.
 */
import type { ComunicacaoProvider } from "./types.ts";

export type DigisacSendResult = {
  ok: boolean;
  provider_message_id?: string;
  error?: string;
  provider_used: Extract<ComunicacaoProvider, "digisac_stub" | "digisac">;
};

/**
 * Normalização mínima: apenas dígitos; DDI 55 para números BR típicos (10/11 dígitos locais).
 * Não altera números que já tenham 12+ dígitos (ex.: já com DDI).
 */
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
  userId: string;
  /** Path relativo à base (default /api/v1/messages) */
  messagesPath: string;
};

export function readDigisacEnv(): DigisacEnvConfig {
  const useMockRaw = (Deno.env.get("DIGISAC_USE_MOCK") ?? "true").trim().toLowerCase();
  const useMock = useMockRaw !== "false";
  const pathRaw = (Deno.env.get("DIGISAC_MESSAGES_PATH") ?? "/api/v1/messages").trim();
  return {
    useMock,
    apiBaseUrl: (Deno.env.get("DIGISAC_API_BASE_URL") ?? "").trim().replace(/\/+$/, ""),
    apiToken: (Deno.env.get("DIGISAC_API_TOKEN") ?? "").trim(),
    serviceId: (Deno.env.get("DIGISAC_SERVICE_ID") ?? "").trim(),
    userId: (Deno.env.get("DIGISAC_USER_ID") ?? "").trim(),
    messagesPath: pathRaw || "/api/v1/messages",
  };
}

/** Modo simulado: flag explícita, ou falta de URL/token/serviceId/userId para o fluxo por number. */
export function shouldUseDigisacMock(cfg: DigisacEnvConfig): boolean {
  if (cfg.useMock) return true;
  if (!cfg.apiBaseUrl || !cfg.apiToken) return true;
  if (!cfg.serviceId || !cfg.userId) return true;
  return false;
}

function extractProviderMessageId(data: Record<string, unknown>): string | undefined {
  const direct =
    (typeof data.id === "string" && data.id) ||
    (typeof data.messageId === "string" && data.messageId) ||
    (typeof data.uuid === "string" && data.uuid);
  if (direct) return direct;
  const nested = data.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const o = nested as Record<string, unknown>;
    if (typeof o.id === "string") return o.id;
    if (typeof o.messageId === "string") return o.messageId;
  }
  const msg = data.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const o = msg as Record<string, unknown>;
    if (typeof o.id === "string") return o.id;
  }
  return undefined;
}

function summarizeDigisacError(status: number, bodyText: string, parsed: Record<string, unknown>): string {
  const fromJson =
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.error === "string" && parsed.error) ||
    (parsed.error &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      typeof (parsed.error as { message?: unknown }).message === "string" &&
      String((parsed.error as { message: string }).message));
  if (fromJson) return `DigiSac HTTP ${status}: ${fromJson}`;
  const trimmed = bodyText.trim();
  if (trimmed) return `DigiSac HTTP ${status}: ${trimmed.slice(0, 400)}`;
  return `DigiSac HTTP ${status} (sem corpo útil)`;
}

export async function sendDigisacMessage(
  cfg: DigisacEnvConfig,
  params: { telefoneRaw: string; text: string },
): Promise<DigisacSendResult> {
  const number = normalizePhoneDigits(params.telefoneRaw);
  if (!number) {
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

  const body = {
    text: params.text,
    type: "chat",
    serviceId: cfg.serviceId,
    number,
    userId: cfg.userId,
    origin: "bot",
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

    const rawText = await res.text();
    let parsed: Record<string, unknown> = {};
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        /* corpo não-JSON */
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        error: summarizeDigisacError(res.status, rawText, parsed),
        provider_used: "digisac",
      };
    }

    const provider_message_id = extractProviderMessageId(parsed);
    return { ok: true, provider_message_id, provider_used: "digisac" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      provider_used: "digisac",
    };
  }
}
