/**
 * Ports do fluxo de primeiro acesso / tolerância.
 * Sem fetch/Supabase no orquestrador — apenas interfaces.
 */

import type { ReservationPendingStateInput } from "../../domain/yes-hotel/reservation-pending-state";
import type {
  AccessEventRecord,
  AccessGraceStatusPersisted,
  AccessToleranceRecord,
  CorrelatedRoomAccessResult,
  CreateToleranceInput,
  OutboxMessage,
  ProcessFirstRoomAccessInput,
  ProvisionedCredentialItem,
} from "./first-room-access-types";

export interface AccessEventRepository {
  findByIdempotencyKey(key: string): Promise<AccessEventRecord | null>;
  insertRawEvent(
    input: ProcessFirstRoomAccessInput & {
      access_method: AccessEventRecord["access_method"];
      received_at: string;
    },
  ): Promise<AccessEventRecord>;
  markProcessed(eventId: string, processedAt: string): Promise<void>;
  markIgnored(eventId: string, reason: string, processedAt: string): Promise<void>;
  markFailed(eventId: string, error: string, processedAt: string): Promise<void>;
  attachCorrelation(
    eventId: string,
    correlation: {
      reservation_id: string | null;
      credential_id: string | null;
      credential_item_id: string | null;
      logical_destination: string | null;
      keyboard_pwd_id: number | null;
    },
  ): Promise<void>;
}

export interface CredentialCorrelationPort {
  /**
   * Correlaciona lock/evento a item/credencial/reserva.
   * Não deve retornar senha. Material sensível fica só dentro do adapter.
   */
  correlateRoomPasscodeEvent(input: {
    lock_id: number;
    keyboard_pwd_id?: number;
    occurred_at: string;
    record_type: number;
  }): Promise<CorrelatedRoomAccessResult>;
}

export interface ReservationPendingStatePort {
  getReservationPendingInput(reservationId: string): Promise<ReservationPendingStateInput>;
}

export interface AccessToleranceRepository {
  findByCredentialId(credentialId: string): Promise<AccessToleranceRecord | null>;
  createTolerance(input: CreateToleranceInput): Promise<AccessToleranceRecord>;
  updateCurrentPendingState(
    toleranceId: string,
    state: {
      current_payment_pending: boolean;
      current_fnrh_pending: boolean;
      updated_at: string;
    },
  ): Promise<void>;
  markCancelled(toleranceId: string, updatedAt: string): Promise<void>;
  markSuspensionPending(toleranceId: string, updatedAt: string): Promise<void>;
  markSuspended(toleranceId: string, suspendedAt: string): Promise<void>;
  markPartialFailure(toleranceId: string, error: string, updatedAt: string): Promise<void>;
  markRestorePending(toleranceId: string, updatedAt: string): Promise<void>;
  markRestored(toleranceId: string, restoredAt: string): Promise<void>;
  markError(toleranceId: string, error: string, updatedAt: string): Promise<void>;
  /** Atualização de status genérica (testes / futuro executor). */
  setGraceStatus?(
    toleranceId: string,
    status: AccessGraceStatusPersisted,
    updatedAt: string,
  ): Promise<void>;
}

export interface CredentialItemsPort {
  listProvisionedItemsByCredentialId(
    credentialId: string,
  ): Promise<ProvisionedCredentialItem[]>;
}

export interface CommunicationOutboxPort {
  enqueueGuestWelcomeMessage(
    message: Extract<OutboxMessage, { kind: "guest_welcome_pending" }>,
  ): Promise<void>;
  enqueueGuestRestoredMessage(
    message: Extract<OutboxMessage, { kind: "guest_access_restored" }>,
  ): Promise<void>;
  enqueueInternalAlert(
    message: Extract<OutboxMessage, { kind: "internal_alert" }>,
  ): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

/**
 * Unidade de trabalho: permite rollback lógico se qualquer passo pós-evento falhar.
 * Adapters reais usariam transação SQL; in-memory restaura snapshot.
 */
export interface UnitOfWorkPort {
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

export type FirstRoomAccessPorts = {
  events: AccessEventRepository;
  correlation: CredentialCorrelationPort;
  pending: ReservationPendingStatePort;
  tolerances: AccessToleranceRepository;
  items: CredentialItemsPort;
  outbox: CommunicationOutboxPort;
  clock: ClockPort;
  uow: UnitOfWorkPort;
};
