/**
 * Dispatcher da fila operacional_acesso_outbox.
 * Nunca marca sent sem confirmação do sender real.
 * Flags desligadas: skip sem claim (itens permanecem pending).
 * Mock: somente por injeção explícita nos testes.
 */

import {
  getAccessToleranceFlags,
  type AccessToleranceFlags,
} from "../../domain/yes-hotel/access-tolerance-flags";
import { assertMessageHasNoTechnicalJargon } from "../../domain/yes-hotel/access-grace-messages";
import type { AccessOutboxRecord } from "./first-room-access-types";
import type {
  AccessCommunicationSenderPort,
  AccessOutboxQueuePort,
  ClockPort,
} from "./first-room-access-ports";

const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 60_000;
const CLAIM_LEASE_MS = 5 * 60_000;

export type AccessOutboxDispatcherPorts = {
  queue: AccessOutboxQueuePort;
  sender: AccessCommunicationSenderPort;
  clock: ClockPort;
  resolveRecipients: (reservationId: string) => Promise<{
    phone_digits: string | null;
    email: string | null;
  }>;
};

export type DispatchOutboxResult = {
  id: string;
  status: "sent" | "failed" | "skipped" | "already_done" | "disabled";
  channel: string;
  error?: string;
};

function maskPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 4) return "***";
  return `${d.slice(0, 2)}***${d.slice(-2)}`;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export async function dispatchAccessOutboxBatch(
  ports: AccessOutboxDispatcherPorts,
  options: { flags?: AccessToleranceFlags; limit?: number } = {},
): Promise<DispatchOutboxResult[]> {
  const flags = options.flags ?? getAccessToleranceFlags();
  if (!flags.outboxDispatchEnabled) {
    return [];
  }

  const now = ports.clock.now();
  const nowIso = now.toISOString();
  const rows = await ports.queue.listAvailable(nowIso, options.limit ?? 20);
  const results: DispatchOutboxResult[] = [];

  for (const row of rows) {
    try {
      results.push(await dispatchOne(ports, row, flags, nowIso));
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : "error";
      results.push({
        id: row.id,
        status: "failed",
        channel: row.channel,
        error: msg,
      });
    }
  }
  return results;
}

async function dispatchOne(
  ports: AccessOutboxDispatcherPorts,
  row: AccessOutboxRecord,
  flags: AccessToleranceFlags,
  nowIso: string,
): Promise<DispatchOutboxResult> {
  if (row.status === "sent") {
    return { id: row.id, status: "already_done", channel: row.channel };
  }

  const isInternal =
    row.event_type.startsWith("internal_") || row.template === "internal_first_access";

  // Antes do claim: canais reais desligados → não marca sent; deixa pending.
  if (row.channel === "whatsapp" && !flags.digisacRealEnabled) {
    return { id: row.id, status: "disabled", channel: "whatsapp", error: "digisac_real_disabled" };
  }
  if (row.channel === "email" && !flags.emailRealEnabled) {
    if (isInternal) {
      return { id: row.id, status: "skipped", channel: "email", error: "email_nao_aplicavel_interno" };
    }
    return { id: row.id, status: "disabled", channel: "email", error: "email_real_disabled" };
  }

  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const claimed = await ports.queue.tryClaim(row.id, nowIso, leaseUntil);
  if (!claimed) {
    return { id: row.id, status: "skipped", channel: row.channel, error: "claim_failed" };
  }

  const body = String((row.payload as { body?: string }).body ?? "");
  try {
    assertMessageHasNoTechnicalJargon(body);
  } catch (e) {
    await ports.queue.markFailed(
      row.id,
      e instanceof Error ? e.message : "jargon",
      row.attempts + 1,
      nowIso,
      nowIso,
    );
    return { id: row.id, status: "failed", channel: row.channel, error: "jargon" };
  }

  const recipients = await ports.resolveRecipients(row.reservation_id);
  const attempts = row.attempts + 1;

  if (row.channel === "whatsapp") {
    const phone = isInternal
      ? flags.digisacInternalNumber.replace(/\D/g, "") || null
      : recipients.phone_digits;
    if (!phone) {
      const err = isInternal ? "numero_interno_ausente" : "telefone_ausente";
      // Terminal — sem retry infinito.
      await ports.queue.markFailed(row.id, err, attempts, nowIso, nowIso);
      return { id: row.id, status: "failed", channel: "whatsapp", error: err };
    }
    void maskPhone(phone);
    const send = await ports.sender.sendWhatsapp({
      recipient_ref: phone,
      body,
      idempotency_key: row.idempotency_key,
    });
    if (!send.ok) {
      const retryable = send.retryable !== false;
      const availableAt = retryable
        ? new Date(Date.now() + RETRY_BACKOFF_MS * Math.min(attempts, 5)).toISOString()
        : nowIso;
      const terminal = !retryable || attempts >= MAX_ATTEMPTS;
      await ports.queue.markFailed(
        row.id,
        send.error ?? "whatsapp_failed",
        attempts,
        availableAt,
        terminal ? nowIso : undefined,
      );
      return { id: row.id, status: "failed", channel: "whatsapp", error: send.error };
    }
    await ports.queue.markSent(row.id, nowIso);
    return { id: row.id, status: "sent", channel: "whatsapp" };
  }

  // email
  if (isInternal) {
    await ports.queue.markFailed(row.id, "email_nao_aplicavel_interno", attempts, nowIso, nowIso);
    return { id: row.id, status: "skipped", channel: "email", error: "email_nao_aplicavel_interno" };
  }
  const email = recipients.email;
  if (!email) {
    // Ausência de e-mail: skip terminal, não é erro do fluxo.
    await ports.queue.markFailed(row.id, "email_ausente", attempts, nowIso, nowIso);
    return { id: row.id, status: "skipped", channel: "email", error: "email_ausente" };
  }
  void maskEmail(email);
  const subject = String((row.payload as { subject?: string }).subject ?? "Yes Hotel");
  const send = await ports.sender.sendEmail({
    recipient_ref: email,
    subject,
    body,
    idempotency_key: row.idempotency_key,
  });
  if (!send.ok) {
    const retryable = send.retryable !== false;
    const availableAt = retryable
      ? new Date(Date.now() + RETRY_BACKOFF_MS * Math.min(attempts, 5)).toISOString()
      : nowIso;
    const terminal = !retryable || attempts >= MAX_ATTEMPTS;
    await ports.queue.markFailed(
      row.id,
      send.error ?? "email_failed",
      attempts,
      availableAt,
      terminal ? nowIso : undefined,
    );
    return { id: row.id, status: "failed", channel: "email", error: send.error };
  }
  await ports.queue.markSent(row.id, nowIso);
  return { id: row.id, status: "sent", channel: "email" };
}

/** Sender mock — somente testes (injeção explícita). Nunca selecionar silenciosamente. */
export function createMockAccessCommunicationSender(options?: {
  failWhatsapp?: boolean;
  failEmail?: boolean;
}): AccessCommunicationSenderPort {
  return {
    async sendWhatsapp() {
      if (options?.failWhatsapp) {
        return { ok: false, error: "mock_whatsapp_fail", retryable: true };
      }
      return { ok: true };
    },
    async sendEmail() {
      if (options?.failEmail) {
        return { ok: false, error: "mock_email_fail", retryable: true };
      }
      return { ok: true };
    },
  };
}

/** Sender desabilitado — não envia e não mente sucesso. */
export function createDisabledAccessCommunicationSender(
  reason = "sender_disabled",
): AccessCommunicationSenderPort {
  return {
    async sendWhatsapp() {
      return { ok: false, error: reason, retryable: false };
    },
    async sendEmail() {
      return { ok: false, error: reason, retryable: false };
    },
  };
}

/** TTLock mock — somente testes. */
export function createMockTtlockValidityChangePort(options?: {
  failLockIds?: number[];
  failAlways?: boolean;
}): import("./first-room-access-ports").TtlockValidityChangePort {
  const failSet = new Set(options?.failLockIds ?? []);
  return {
    async changeValidityOnly(req) {
      if (options?.failAlways || failSet.has(req.lockId)) {
        return { ok: false, error: "mock_ttlock_fail", retryable: true };
      }
      if (req.endDateMs <= 0 || req.startDateMs <= 0) {
        return { ok: false, error: "invalid_dates", retryable: false };
      }
      return { ok: true };
    },
  };
}
