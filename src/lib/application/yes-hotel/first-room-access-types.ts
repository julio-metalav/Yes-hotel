/**
 * Tipos de aplicação do fluxo de primeiro acesso / tolerância.
 * Sem senha em texto. Sem I/O.
 */

import type { LockLogicalType } from "../../domain/yes-hotel/first-room-access-policy";
import type { ReservationPendingStateInput } from "../../domain/yes-hotel/reservation-pending-state";

export type AccessEventProcessingStatus =
  | "received"
  | "processing"
  | "processed"
  | "ignored"
  | "failed";

export type AccessMethodPersisted =
  | "passcode"
  | "app"
  | "gateway"
  | "ic_card"
  | "fingerprint"
  | "mechanical_key"
  | "remote"
  | "inside"
  | "invalid_passcode"
  | "other";

export type AccessGraceStatusPersisted =
  | "active"
  | "cancelled"
  | "suspension_pending"
  | "suspended"
  | "partial_failure"
  | "restore_pending"
  | "restored"
  | "error";

export type ItemSuspensionStatus = "pending" | "succeeded" | "failed" | "skipped";
export type ItemRestoreStatus =
  | "not_applicable"
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped";

/** Entrada sanitizada do orquestrador (nunca inclui senha). */
export type ProcessFirstRoomAccessInput = {
  source: string;
  source_event_id: string;
  /** Preferir HMAC na ingestão futura; aqui já vem opaco. */
  idempotency_key: string;
  occurred_at: string;
  lock_id: number;
  keyboard_pwd_id?: number;
  record_type: number;
  success: boolean;
  is_admin_operator?: boolean;
  /** Payload já sem keyboardPwd/tokens/secrets. */
  raw_payload_sanitized?: Record<string, unknown> | null;
};

export type AccessEventRecord = {
  id: string;
  source: string;
  source_event_id: string;
  idempotency_key: string;
  occurred_at: string;
  received_at: string;
  lock_id: number;
  keyboard_pwd_id: number | null;
  record_type: number;
  access_method: AccessMethodPersisted;
  success: boolean;
  reservation_id: string | null;
  credential_id: string | null;
  credential_item_id: string | null;
  logical_destination: string | null;
  processing_status: AccessEventProcessingStatus;
  ignored_reason: string | null;
  raw_payload_sanitized: Record<string, unknown> | null;
  processed_at: string | null;
  created_at: string;
};

export type CorrelatedRoomAccessResult = {
  correlated: boolean;
  reservation_id?: string;
  credential_id?: string;
  credential_item_id?: string;
  logical_destination?: string;
  lock_type?: LockLogicalType;
  within_reservation_window: boolean;
  keyboard_pwd_id?: number;
  original_valid_from?: string;
  original_valid_until?: string;
};

export type ProvisionedCredentialItem = {
  id: string;
  credential_id: string;
  logical_destination: string;
  lock_type: LockLogicalType;
  lock_id: number;
  remote_keyboard_pwd_id: number;
};

export type AccessToleranceRecord = {
  id: string;
  reservation_id: string;
  credential_id: string;
  first_room_access_at: string;
  grace_started_at: string;
  suspension_due_at: string;
  grace_status: AccessGraceStatusPersisted;
  pending_payment_at_start: boolean;
  pending_fnrh_at_start: boolean;
  current_payment_pending: boolean;
  current_fnrh_pending: boolean;
  pending_snapshot: string[];
  original_valid_from: string;
  original_valid_until: string;
  suspended_at: string | null;
  restored_at: string | null;
  welcome_message_event_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AccessToleranceItemRecord = {
  id: string;
  tolerance_id: string;
  credential_item_id: string;
  logical_destination: string;
  lock_id: number;
  remote_keyboard_pwd_id: number;
  original_valid_from: string;
  original_valid_until: string;
  suspended_valid_until: string | null;
  suspension_status: ItemSuspensionStatus;
  restore_status: ItemRestoreStatus;
  suspension_attempts: number;
  restore_attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  suspended_at: string | null;
  restored_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateToleranceInput = {
  reservation_id: string;
  credential_id: string;
  first_room_access_at: string;
  grace_started_at: string;
  suspension_due_at: string;
  pending_payment_at_start: boolean;
  pending_fnrh_at_start: boolean;
  pending_snapshot: string[];
  original_valid_from: string;
  original_valid_until: string;
  welcome_message_event_id: string;
  items: Array<{
    credential_item_id: string;
    logical_destination: string;
    lock_id: number;
    remote_keyboard_pwd_id: number;
  }>;
};

export type OutboxGuestWelcomeMessage = {
  kind: "guest_welcome_pending";
  reservation_id: string;
  credential_id: string;
  tolerance_id: string;
  event_id: string;
  payment_pending: boolean;
  fnrh_pending: boolean;
  body: string;
  idempotency_key: string;
};

export type OutboxGuestRestoredMessage = {
  kind: "guest_access_restored";
  reservation_id: string;
  credential_id: string;
  tolerance_id: string;
  body: string;
  idempotency_key: string;
};

export type OutboxInternalAlert = {
  kind: "internal_alert";
  reservation_id?: string;
  credential_id?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  idempotency_key: string;
};

export type OutboxMessage =
  | OutboxGuestWelcomeMessage
  | OutboxGuestRestoredMessage
  | OutboxInternalAlert;

export type ProcessFirstRoomAccessResult = {
  status:
    | "ignored"
    | "processed_no_pending"
    | "grace_started"
    | "already_started"
    | "failed";
  event_id?: string;
  tolerance_id?: string;
  suspension_due_at?: string;
  pending_reasons?: string[];
  ignored_reason?: string;
  error?: string;
};

export type ReservationPendingPortResult = {
  input: ReservationPendingStateInput;
};
