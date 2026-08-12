import type { SupabaseClient } from "@supabase/supabase-js";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports.ts";
import { SupabaseAccessEventRepository } from "./access-event-repository.ts";
import { SupabaseAccessToleranceRepository } from "./access-tolerance-repository.ts";
import { SupabaseCommunicationOutboxPort } from "./communication-outbox.ts";
import { SupabaseCredentialCorrelationPort } from "./credential-correlation.ts";
import { SupabaseCredentialItemsPort } from "./credential-items.ts";
import { SupabaseAccessOutboxQueuePort } from "./access-outbox-queue.ts";
import {
  SupabaseFirstRoomAccessUnitOfWork,
  SystemClock,
} from "./first-room-access-unit-of-work.ts";
import { SupabaseReservationPendingStatePort } from "./reservation-pending-state.ts";
import { SupabasePresencialDiferidoAuditPort } from "./presencial-diferido-audit.ts";
import { isPagamentoPresencialDiferidoServerEnabled } from "../../../domain/yes-hotel/pagamento-presencial-diferido.ts";

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
        const apartment_number = String(r?.apartamento ?? "—");
        let wifi_ssid: string | null = null;
        let wifi_password: string | null = null;
        const aptNum = apartment_number.trim();
        if (aptNum && aptNum !== "—") {
          const { data: apt } = await client
            .from("apartamentos")
            .select("wifi_ssid, wifi_password")
            .eq("numero", aptNum)
            .maybeSingle();
          wifi_ssid = apt?.wifi_ssid != null ? String(apt.wifi_ssid) : null;
          wifi_password = apt?.wifi_password != null ? String(apt.wifi_password) : null;
        }
        return {
          apartment_number,
          reservation_code: external || "—",
          guest_main_name: String(r?.hospede_principal ?? "hóspede"),
          // Sem campo de vaga dedicado: usa o número do apartamento.
          parking_spot: aptNum && aptNum !== "—" ? aptNum : null,
          wifi_ssid,
          wifi_password,
        };
      },
    },
    presencialDiferidoAudit: new SupabasePresencialDiferidoAuditPort(client),
    presencialDiferidoFeatureEnabled: isPagamentoPresencialDiferidoServerEnabled(env ?? null),
  };
}

export * from "./access-event-repository.ts";
export * from "./access-outbox-queue.ts";
export * from "./access-tolerance-repository.ts";
export * from "./cobranca-pagarme-repository.ts";
export * from "./credential-correlation.ts";
export * from "./credential-correlation-logic.ts";
export * from "./reservation-pending-state.ts";
export * from "./reservation-pending-mapper.ts";
export * from "./credential-items.ts";
export * from "./communication-outbox.ts";
export * from "./first-room-access-unit-of-work.ts";
export * from "./supabase-reservation-sync-repository.ts";
export * from "./fake-reservation-sync-client.ts";
export * from "./presencial-diferido-audit.ts";
