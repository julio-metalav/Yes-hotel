import type { SupabaseClient } from "@supabase/supabase-js";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports";
import { SupabaseAccessEventRepository } from "./access-event-repository";
import { SupabaseAccessToleranceRepository } from "./access-tolerance-repository";
import { SupabaseCommunicationOutboxPort } from "./communication-outbox";
import { SupabaseCredentialCorrelationPort } from "./credential-correlation";
import { SupabaseCredentialItemsPort } from "./credential-items";
import {
  SupabaseFirstRoomAccessUnitOfWork,
  SystemClock,
} from "./first-room-access-unit-of-work";
import { SupabaseReservationPendingStatePort } from "./reservation-pending-state";

export function createSupabaseFirstRoomAccessPorts(
  client: SupabaseClient,
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
  };
}

export * from "./access-event-repository";
export * from "./access-tolerance-repository";
export * from "./credential-correlation";
export * from "./credential-correlation-logic";
export * from "./reservation-pending-state";
export * from "./reservation-pending-mapper";
export * from "./credential-items";
export * from "./communication-outbox";
export * from "./first-room-access-unit-of-work";
