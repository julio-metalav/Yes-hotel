import type { SupabaseClient } from "@supabase/supabase-js";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports";
import { SupabaseAccessEventRepository } from "./access-event-repository";
import { SupabaseAccessToleranceRepository } from "./access-tolerance-repository";
import { SupabaseCommunicationOutboxPort } from "./communication-outbox";
import { SupabaseCredentialCorrelationPort } from "./credential-correlation";
import { SupabaseCredentialItemsPort } from "./credential-items";
import { SupabaseAccessOutboxQueuePort } from "./access-outbox-queue";
import {
  SupabaseFirstRoomAccessUnitOfWork,
  SystemClock,
} from "./first-room-access-unit-of-work";
import { SupabaseReservationPendingStatePort } from "./reservation-pending-state";
import { SupabasePresencialDiferidoAuditPort } from "./presencial-diferido-audit";
import { isPagamentoPresencialDiferidoServerEnabled } from "../../../domain/yes-hotel/pagamento-presencial-diferido";

export function createSupabaseFirstRoomAccessPorts(
  client: SupabaseClient,
  env?: Record<string, string | undefined> | null,
): FirstRoomAccessPorts {
  return {
    events: new SupabaseAccessEventRepository(client),
    correlation: new SupabaseCredentialCorrelationPort(client),
    pending: new SupabaseReservationPendingStatePort(client),
    tolerances: new SupabaseAccessToleranceRepository(client),
    items: new SupabaseCredentialItemsPort(client),
    outbox: new SupabaseCommunicationOutboxPort(client),
    clock: new SystemClock(),
    uow: new SupabaseFirstRoomAccessUnitOfWork(client),
    accessOutboxQueue: new SupabaseAccessOutboxQueuePort(client),
    reservationDisplay: {
      async getContext(reservationId: string) {
        const { data: r } = await client
          .from("operacional_reservas")
          .select("apartamento, hospede_principal, external_reservation_id")
          .eq("id", reservationId)
          .maybeSingle();
        const external = String(r?.external_reservation_id ?? "").trim();
        return {
          apartment_number: String(r?.apartamento ?? "—"),
          reservation_code: external || "—",
          guest_main_name: String(r?.hospede_principal ?? "hóspede"),
        };
      },
    },
    presencialDiferidoAudit: new SupabasePresencialDiferidoAuditPort(client),
    presencialDiferidoFeatureEnabled: isPagamentoPresencialDiferidoServerEnabled(env ?? null),
  };
}

export * from "./access-event-repository";
export * from "./access-outbox-queue";
export * from "./access-tolerance-repository";
export * from "./cobranca-pagarme-repository";
export * from "./credential-correlation";
export * from "./credential-correlation-logic";
export * from "./reservation-pending-state";
export * from "./reservation-pending-mapper";
export * from "./credential-items";
export * from "./communication-outbox";
export * from "./first-room-access-unit-of-work";
export * from "./supabase-reservation-sync-repository";
export * from "./fake-reservation-sync-client";
export * from "./presencial-diferido-audit";
