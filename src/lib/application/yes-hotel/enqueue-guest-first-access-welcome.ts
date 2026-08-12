/**
 * Enfileira boas-vindas pós-primeiro-acesso (hóspede) — WA + e-mail.
 * Idempotente por reserva. Sem cobrança no body.
 */

import {
  buildGuestFirstAccessWelcomeMessage,
  guestFirstAccessWelcomeIdempotencyKey,
  GUEST_FIRST_ACCESS_WELCOME_EVENT,
  resolveParkingSpot,
} from "../../domain/yes-hotel/guest-access-messages.ts";
import type { AccessOutboxQueuePort } from "./first-room-access-ports.ts";

export type EnqueueGuestFirstAccessWelcomeInput = {
  queue: AccessOutboxQueuePort;
  reservation_id: string;
  credential_id: string | null;
  access_event_id?: string | null;
  tolerance_id?: string | null;
  guest_main_name: string;
  apartment_number: string;
  parking_spot?: string | null;
  wifi_ssid?: string | null;
  wifi_password?: string | null;
  nowIso: string;
};

export async function enqueueGuestFirstAccessWelcomeMessages(
  input: EnqueueGuestFirstAccessWelcomeInput,
): Promise<void> {
  const parking = resolveParkingSpot({
    parking_spot: input.parking_spot,
    apartment_number: input.apartment_number,
  });
  const msg = buildGuestFirstAccessWelcomeMessage({
    guest_first_name: input.guest_main_name,
    apartment_number: input.apartment_number,
    parking_spot: parking,
    wifi_ssid: input.wifi_ssid,
    wifi_password: input.wifi_password,
  });

  const base = {
    event_type: GUEST_FIRST_ACCESS_WELCOME_EVENT,
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: input.access_event_id ?? null,
    tolerance_id: input.tolerance_id ?? null,
    recipient_ref: null,
    template: GUEST_FIRST_ACCESS_WELCOME_EVENT,
    status: "pending" as const,
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  };

  await input.queue.enqueue({
    ...base,
    channel: "whatsapp",
    payload: { body: msg.body },
    idempotency_key: guestFirstAccessWelcomeIdempotencyKey(
      input.reservation_id,
      "whatsapp",
    ),
  });
  await input.queue.enqueue({
    ...base,
    channel: "email",
    payload: { body: msg.body, subject: msg.subject, body_html: msg.body_html },
    idempotency_key: guestFirstAccessWelcomeIdempotencyKey(
      input.reservation_id,
      "email",
    ),
  });
}

/** available_at da pendência ≈ 1 minuto após o welcome. */
export function pendingMessageAvailableAt(nowIso: string, delayMs = 60_000): string {
  return new Date(Date.parse(nowIso) + delayMs).toISOString();
}
