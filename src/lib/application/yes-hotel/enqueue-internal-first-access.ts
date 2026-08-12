/**
 * Enfileira mensagem interna DigiSac de primeiro acesso (pós-commit).
 * Idempotente por idempotency_key. Sem senha/IDs técnicos no body.
 */

import { buildInternalFirstAccessMessage } from "../../domain/yes-hotel/access-grace-messages.ts";
import type { AccessOutboxQueuePort } from "./first-room-access-ports.ts";

export type EnqueueInternalFirstAccessInput = {
  queue: AccessOutboxQueuePort;
  reservation_id: string;
  credential_id: string | null;
  tolerance_id: string | null;
  apartment_number: string;
  reservation_code: string;
  guest_main_name: string;
  payment_pending: boolean;
  fnrh_pending: boolean;
  grace_started: boolean;
  presencial_diferido_efetivado?: boolean;
  /** Já resolvido; "confirmar no HITS" se sem fonte confiável. */
  charge_valor_label?: string | null;
  nowIso: string;
};

export async function enqueueInternalFirstAccessMessage(
  input: EnqueueInternalFirstAccessInput,
): Promise<string> {
  const msg = buildInternalFirstAccessMessage({
    apartment_number: input.apartment_number,
    reservation_code: input.reservation_code,
    guest_main_name: input.guest_main_name,
    payment_pending: input.payment_pending,
    fnrh_pending: input.fnrh_pending,
    grace_started: input.grace_started,
    presencial_diferido_efetivado: input.presencial_diferido_efetivado === true,
    charge_valor_label: input.charge_valor_label ?? null,
  });
  return input.queue.enqueue({
    event_type: "internal_first_access",
    channel: "whatsapp",
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: null,
    tolerance_id: input.tolerance_id,
    recipient_ref: null,
    template: "internal_first_access",
    payload: { body: msg.body },
    idempotency_key: `internal_first_access:${input.reservation_id}:${input.tolerance_id ?? "none"}`,
    status: "pending",
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  });
}
