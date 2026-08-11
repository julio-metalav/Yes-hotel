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
   * ephemeral_keyboard_pwd: só memória; nunca persistir/logar; descartar após uso.
   */
  correlateRoomPasscodeEvent(input: {
    lock_id: number;
    keyboard_pwd_id?: number;
    occurred_at: string;
    record_type: number;
    ephemeral_keyboard_pwd?: string;
  }): Promise<CorrelatedRoomAccessResult>;
}

export interface ReservationPendingStatePort {
  getReservationPendingInput(reservationId: string): Promise<ReservationPendingStateInput>;
}

export interface AccessToleranceRepository {
  findByCredentialId(credentialId: string): Promise<AccessToleranceRecord | null>;
  findById?(toleranceId: string): Promise<AccessToleranceRecord | null>;
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
  /** Candidatas a vencimento: active e suspension_due_at <= now. */
  listDueForSuspension?(nowIso: string, limit?: number): Promise<AccessToleranceRecord[]>;
  /** Candidatas a restauração: suspended | partial_failure. */
  listCandidatesForRestore?(limit?: number): Promise<AccessToleranceRecord[]>;
  /**
   * Pendentes abandonados (suspension_pending|restore_pending) com updated_at <= cutoffIso.
   * Usado como reclaim sem migration (lease implícito via updated_at).
   */
  listStalePending?(cutoffIso: string, limit?: number): Promise<AccessToleranceRecord[]>;
  listItems?(toleranceId: string): Promise<import("./first-room-access-types").AccessToleranceItemRecord[]>;
  /**
   * Claim atômico por compare-and-swap de grace_status (sem migration nova).
   * Retorna false se o status esperado não coincidir (outra execução ganhou).
   */
  tryTransitionStatus?(
    toleranceId: string,
    fromStatus: AccessGraceStatusPersisted | AccessGraceStatusPersisted[],
    toStatus: AccessGraceStatusPersisted,
    updatedAt: string,
    extra?: Partial<AccessToleranceRecord>,
  ): Promise<boolean>;
  /**
   * Reclaim atômico de suspension_pending|restore_pending com lease temporal.
   * Predicado no mesmo UPDATE: grace_status esperado AND updated_at <= cutoffIso.
   * Vencedor atualiza updated_at; concorrente falha.
   */
  tryClaimStaleTolerance?(
    toleranceId: string,
    expectedStatus: "suspension_pending" | "restore_pending",
    cutoffIso: string,
    claimedAtIso: string,
  ): Promise<boolean>;
  updateItemSuspension?(
    itemId: string,
    patch: Partial<import("./first-room-access-types").AccessToleranceItemRecord>,
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
  enqueueGuestSuspendedMessage?(
    message: Extract<OutboxMessage, { kind: "guest_access_suspended" }>,
  ): Promise<void>;
  enqueueGuestTechnicalFailureMessage?(
    message: Extract<OutboxMessage, { kind: "guest_technical_failure" }>,
  ): Promise<void>;
  enqueueInternalAlert(
    message: Extract<OutboxMessage, { kind: "internal_alert" }>,
  ): Promise<void>;
  enqueueInternalFirstAccessMessage?(
    message: Extract<OutboxMessage, { kind: "internal_first_access" }>,
  ): Promise<void>;
}

/** Port de alteração de validade TTLock — nunca newKeyboardPwd. */
export type TtlockValidityChangeRequest = {
  lockId: number;
  keyboardPwdId: number;
  startDateMs: number;
  endDateMs: number;
};

export type TtlockValidityChangeResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean };

export interface TtlockValidityChangePort {
  changeValidityOnly(req: TtlockValidityChangeRequest): Promise<TtlockValidityChangeResult>;
}

/** Fila operacional_acesso_outbox. */
export interface AccessOutboxQueuePort {
  listAvailable(nowIso: string, limit?: number): Promise<import("./first-room-access-types").AccessOutboxRecord[]>;
  tryClaim(id: string, nowIso: string, leaseUntilIso: string): Promise<boolean>;
  releaseClaim?(id: string, availableAt: string): Promise<void>;
  markSent(id: string, processedAt: string): Promise<void>;
  markFailed(
    id: string,
    error: string,
    attempts: number,
    availableAt: string,
    processedAt?: string,
  ): Promise<void>;
  enqueue(record: Omit<import("./first-room-access-types").AccessOutboxRecord, "id" | "created_at"> & { id?: string }): Promise<string>;
}

export interface AccessCommunicationSenderPort {
  sendWhatsapp(input: {
    recipient_ref: string;
    body: string;
    idempotency_key: string;
  }): Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
  sendEmail(input: {
    recipient_ref: string;
    subject: string;
    body: string;
    idempotency_key: string;
  }): Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
}

export interface ClockPort {
  now(): Date;
}

/**
 * Unidade de trabalho: permite rollback lógico se qualquer passo pós-evento falhar.
 * Produção (Supabase): commitFirstRoomAccess → RPC única (migration 0025).
 * In-memory: commit atômico com snapshot.
 */
export interface UnitOfWorkPort {
  /**
   * @deprecated Preferir commitFirstRoomAccess para persistência real.
   * Mantido para compatibilidade de testes legados.
   */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Persistência integral do resultado do domínio (evento + tolerância + itens + outbox).
   * Sem fallback multi-insert. Sem múltiplas chamadas independentes.
   */
  commitFirstRoomAccess(
    command: import("./first-room-access-commit").FirstRoomAccessCommitCommand,
  ): Promise<import("./first-room-access-types").ProcessFirstRoomAccessResult>;
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
  /**
   * Opcional: fila operacional_acesso_outbox para mensagem interna DigiSac
   * e canal e-mail complementar (pós-commit, idempotente).
   */
  accessOutboxQueue?: AccessOutboxQueuePort;
  /** Contexto de exibição para mensagem interna (apto/nome/código). */
  reservationDisplay?: {
    getContext(reservationId: string): Promise<{
      apartment_number: string;
      reservation_code: string;
      guest_main_name: string;
    }>;
  };
  /** Auditoria pagamento presencial diferido (opcional; fail-soft se ausente). */
  presencialDiferidoAudit?: import("./presencial-diferido-audit-port").PresencialDiferidoAuditPort;
  /** Fail-closed: só true quando YES_HOTEL_PAGAMENTO_PRESENCIAL_DIFERIDO_ENABLED=true. */
  presencialDiferidoFeatureEnabled?: boolean;
};
