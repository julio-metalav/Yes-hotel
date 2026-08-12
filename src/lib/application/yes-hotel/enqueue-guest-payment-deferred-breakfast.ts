/**
 * Enfileira orientação PPD → café da manhã (hóspede) — WA + e-mail.
 * Exactly-once por reserva via idempotency_key. available_at ≈ +1 min.
 */

import {
  buildGuestPaymentDeferredBreakfastMessage,
  guestPaymentDeferredBreakfastIdempotencyKey,
  GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
} from "../../domain/yes-hotel/guest-payment-deferred-breakfast.ts";
import type { AccessOutboxQueuePort } from "./first-room-access-ports.ts";

export type EnqueueGuestPaymentDeferredBreakfastInput = {
  queue: AccessOutboxQueuePort;
  reservation_id: string;
  credential_id: string | null;
  access_event_id?: string | null;
  tolerance_id?: string | null;
  deadlineIso: string;
  nowIso: string;
  /** Default: +60s (após welcome). */
  available_at?: string;
};

export async function enqueueGuestPaymentDeferredBreakfastMessages(
  input: EnqueueGuestPaymentDeferredBreakfastInput,
): Promise<void> {
  const msg = buildGuestPaymentDeferredBreakfastMessage({
    deadlineIso: input.deadlineIso,
    nowIso: input.nowIso,
  });
  const availableAt = input.available_at ?? input.nowIso;

  const base = {
    event_type: GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: input.access_event_id ?? null,
    tolerance_id: input.tolerance_id ?? null,
    recipient_ref: null,
    template: GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
    status: "pending" as const,
    attempts: 0,
    available_at: availableAt,
    processed_at: null,
    last_error: null,
  };

  await input.queue.enqueue({
    ...base,
    channel: "whatsapp",
    payload: { body: msg.body },
    idempotency_key: guestPaymentDeferredBreakfastIdempotencyKey(
      input.reservation_id,
      "whatsapp",
    ),
  });
  await input.queue.enqueue({
    ...base,
    channel: "email",
    payload: {
      body: msg.body,
      subject: msg.subject,
      body_html: msg.body_html,
    },
    idempotency_key: guestPaymentDeferredBreakfastIdempotencyKey(
      input.reservation_id,
      "email",
    ),
  });
}
