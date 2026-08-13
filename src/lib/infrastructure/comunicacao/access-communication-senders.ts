/**
 * Adapters de comunicação para o dispatcher de acesso.
 * DigiSac e Resend reais — fail-closed sem config.
 * Nunca selecionar mock silenciosamente.
 */

import type { AccessCommunicationSenderPort } from "../../application/yes-hotel/first-room-access-ports.ts";
import {
  createDisabledAccessCommunicationSender,
} from "../../application/yes-hotel/access-outbox-dispatcher.ts";

export type DigisacSenderConfig = {
  apiBaseUrl: string;
  apiToken: string;
  serviceId: string;
  userId: string;
  messagesPath?: string;
  /** DIGISAC_USE_MOCK — default true (fail-closed). */
  useMock: boolean;
};

export type ResendSenderConfig = {
  apiKey: string;
  fromEmail: string;
};

export function readDigisacSenderConfig(
  env: Record<string, string | undefined> = process.env,
): DigisacSenderConfig {
  const useMockRaw = String(env.DIGISAC_USE_MOCK ?? "true").trim().toLowerCase();
  return {
    useMock: useMockRaw !== "false",
    apiBaseUrl: String(env.DIGISAC_API_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    apiToken: String(env.DIGISAC_API_TOKEN ?? "").trim(),
    serviceId: String(env.DIGISAC_SERVICE_ID ?? "").trim(),
    userId: String(env.DIGISAC_USER_ID ?? "").trim(),
    messagesPath: String(env.DIGISAC_MESSAGES_PATH ?? "/api/v1/messages").trim() || "/api/v1/messages",
  };
}

export function digisacConfigComplete(cfg: DigisacSenderConfig): boolean {
  if (cfg.useMock) return false;
  return Boolean(cfg.apiBaseUrl && cfg.apiToken && cfg.serviceId && cfg.userId);
}

export function readResendSenderConfig(
  env: Record<string, string | undefined> = process.env,
): ResendSenderConfig {
  return {
    apiKey: String(env.RESEND_API_KEY ?? "").trim(),
    fromEmail: String(env.RESEND_FROM_EMAIL ?? env.YES_HOTEL_RESEND_FROM ?? "").trim(),
  };
}

export function resendConfigComplete(cfg: ResendSenderConfig): boolean {
  return Boolean(cfg.apiKey && cfg.fromEmail);
}

/** Normaliza telefone BR para dígitos com DDI 55 quando local (10/11). */
export function normalizeAccessPhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return "55" + digits;
  return digits;
}

function extractDigisacMessageId(data: Record<string, unknown>): string | undefined {
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

/**
 * Sender DigiSac real. Sem config completa → disabled (não mock ok).
 * fetchImpl injetável para testes sem rede.
 * ok=true = HTTP 2xx (aceite API); não implica delivery WhatsApp.
 */
export function createDigisacAccessCommunicationSender(
  cfg: DigisacSenderConfig,
  fetchImpl: typeof fetch = fetch,
): AccessCommunicationSenderPort {
  if (!digisacConfigComplete(cfg)) {
    return createDisabledAccessCommunicationSender("digisac_config_incomplete");
  }
  const path = (cfg.messagesPath ?? "/api/v1/messages").startsWith("/")
    ? cfg.messagesPath ?? "/api/v1/messages"
    : `/${cfg.messagesPath}`;
  const url = `${cfg.apiBaseUrl}${path}`;

  return {
    async sendWhatsapp(input) {
      const number = normalizeAccessPhoneDigits(input.recipient_ref);
      if (!number || number.length < 12) {
        return { ok: false, error: "telefone_invalido", retryable: false };
      }
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            text: input.body,
            type: "chat",
            serviceId: cfg.serviceId,
            number,
            userId: cfg.userId,
            origin: "bot",
          }),
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
          const retryable = res.status >= 500 || res.status === 429;
          return {
            ok: false,
            error: `digisac_http_${res.status}`,
            retryable,
            normalized_recipient: number,
          };
        }
        return {
          ok: true,
          provider_message_id: extractDigisacMessageId(parsed),
          normalized_recipient: number,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 120) : "digisac_network";
        return { ok: false, error: msg, retryable: true };
      }
    },
    async sendEmail() {
      return { ok: false, error: "digisac_email_nao_suportado", retryable: false };
    },
  };
}

/**
 * Sender Resend real. Sem API key/from → disabled.
 */
export function createResendAccessCommunicationSender(
  cfg: ResendSenderConfig,
  fetchImpl: typeof fetch = fetch,
): AccessCommunicationSenderPort {
  if (!resendConfigComplete(cfg)) {
    return createDisabledAccessCommunicationSender("resend_config_incomplete");
  }
  return {
    async sendWhatsapp() {
      return { ok: false, error: "resend_whatsapp_nao_suportado", retryable: false };
    },
    async sendEmail(input) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: cfg.fromEmail,
            to: [input.recipient_ref],
            subject: input.subject,
            text: input.body,
          }),
        });
        const rawText = await res.text();
        let parsed: Record<string, unknown> = {};
        if (rawText.length > 0) {
          try {
            parsed = JSON.parse(rawText) as Record<string, unknown>;
          } catch {
            /* ignore */
          }
        }
        if (!res.ok) {
          const retryable = res.status >= 500 || res.status === 429;
          return { ok: false, error: `resend_http_${res.status}`, retryable };
        }
        const id =
          (typeof parsed.id === "string" && parsed.id) ||
          (parsed.data &&
          typeof parsed.data === "object" &&
          !Array.isArray(parsed.data) &&
          typeof (parsed.data as { id?: unknown }).id === "string"
            ? String((parsed.data as { id: string }).id)
            : undefined);
        return {
          ok: true,
          provider_message_id: id,
          normalized_recipient: input.recipient_ref,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 120) : "resend_network";
        return { ok: false, error: msg, retryable: true };
      }
    },
  };
}

/** Compõe WhatsApp DigiSac + e-mail Resend. */
export function composeAccessCommunicationSender(parts: {
  whatsapp: AccessCommunicationSenderPort;
  email: AccessCommunicationSenderPort;
}): AccessCommunicationSenderPort {
  return {
    sendWhatsapp: (input) => parts.whatsapp.sendWhatsapp(input),
    sendEmail: (input) => parts.email.sendEmail(input),
  };
}

/**
 * Composição honesta para Edge/produção.
 * Flags reais + config completa → adapter real; senão disabled (não mock).
 */
export function buildProductionAccessCommunicationSender(
  flags: { digisacRealEnabled: boolean; emailRealEnabled: boolean },
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): AccessCommunicationSenderPort {
  const digiCfg = readDigisacSenderConfig(env);
  const resendCfg = readResendSenderConfig(env);
  const whatsapp =
    flags.digisacRealEnabled && digisacConfigComplete(digiCfg)
      ? createDigisacAccessCommunicationSender(digiCfg, fetchImpl)
      : createDisabledAccessCommunicationSender(
          flags.digisacRealEnabled ? "digisac_config_incomplete" : "digisac_real_disabled",
        );
  const email =
    flags.emailRealEnabled && resendConfigComplete(resendCfg)
      ? createResendAccessCommunicationSender(resendCfg, fetchImpl)
      : createDisabledAccessCommunicationSender(
          flags.emailRealEnabled ? "resend_config_incomplete" : "email_real_disabled",
        );
  return composeAccessCommunicationSender({ whatsapp, email });
}
