import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunicationOutboxPort } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { OutboxMessage } from "../../../application/yes-hotel/first-room-access-types.ts";
import { assertSanitizedPayloadSafe } from "../../../integrations/ttlock/access-ingest/sanitize.ts";

/**
 * Outbox sem envio: grava em operacional_comunicacao_envios com status=simulado.
 * proposito=generico (check existente); kind lógico no metadata.
 * Nunca chama DigiSac/Resend.
 */
export class SupabaseCommunicationOutboxPort implements CommunicationOutboxPort {
  constructor(private readonly client: SupabaseClient) {}

  private async enqueue(message: OutboxMessage): Promise<void> {
    assertSanitizedPayloadSafe(message);
    const preview =
      "body" in message
        ? String(message.body).slice(0, 120)
        : String(message.message).slice(0, 120);

    const { error } = await this.client.from("operacional_comunicacao_envios").insert({
      reserva_id: "reservation_id" in message ? message.reservation_id ?? null : null,
      proposito: "generico",
      canal: "whatsapp",
      destinatario_mascara: null,
      corpo_preview: preview,
      status: "simulado",
      provider: "digisac_stub",
      metadata: {
        outbox_kind: message.kind,
        idempotency_key: message.idempotency_key,
        payload: message,
        delivery: "deferred",
        note: "PR3: enfileirado sem envio real",
      },
    });
    if (error) throw new Error(`outbox enqueue: ${error.message}`);
  }

  async enqueueGuestWelcomeMessage(
    message: Extract<OutboxMessage, { kind: "guest_welcome_pending" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }

  async enqueueGuestRestoredMessage(
    message: Extract<OutboxMessage, { kind: "guest_access_restored" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }

  async enqueueGuestSuspendedMessage(
    message: Extract<OutboxMessage, { kind: "guest_access_suspended" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }

  async enqueueGuestTechnicalFailureMessage(
    message: Extract<OutboxMessage, { kind: "guest_technical_failure" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }

  async enqueueInternalAlert(
    message: Extract<OutboxMessage, { kind: "internal_alert" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }

  async enqueueInternalFirstAccessMessage(
    message: Extract<OutboxMessage, { kind: "internal_first_access" }>,
  ): Promise<void> {
    await this.enqueue(message);
  }
}
