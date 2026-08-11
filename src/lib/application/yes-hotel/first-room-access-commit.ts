/**
 * Comando de persistência atômica do primeiro acesso (domínio → RPC/UoW).
 * Sem senha. Sem I/O neste arquivo.
 */

import type {
  AccessMethodPersisted,
  ProcessFirstRoomAccessResult,
} from "./first-room-access-types.ts";

export type FirstRoomAccessCommitDecision =
  | "ignored"
  | "processed_no_pending"
  | "grace_started"
  | "already_started";

export type FirstRoomAccessEventWrite = {
  source: string;
  source_event_id: string;
  idempotency_key: string;
  occurred_at: string;
  received_at: string;
  lock_id: number;
  keyboard_pwd_id?: number | null;
  record_type: number;
  access_method: AccessMethodPersisted;
  success: boolean;
  raw_payload_sanitized?: Record<string, unknown> | null;
};

export type FirstRoomAccessCorrelationWrite = {
  reservation_id: string | null;
  credential_id: string | null;
  credential_item_id: string | null;
  logical_destination: string | null;
  keyboard_pwd_id: number | null;
};

export type FirstRoomAccessItemWrite = {
  credential_item_id: string;
  logical_destination: string;
  lock_id: number;
  remote_keyboard_pwd_id: number;
  original_valid_from: string;
  original_valid_until: string;
  /** Destino lógico classificado: apartamento | portao_externo | portao_interno */
  lock_class: "apartamento" | "portao_externo" | "portao_interno";
};

export type FirstRoomAccessOutboxWrite = {
  event_type: string;
  channel: "whatsapp" | "email";
  reservation_id: string;
  credential_id?: string;
  recipient_ref?: string | null;
  template?: string | null;
  /** Payload sanitizado — sem senha/token/documento. */
  payload: Record<string, unknown>;
  idempotency_key: string;
  available_at?: string;
};

export type FirstRoomAccessCommitCommand = {
  decision: FirstRoomAccessCommitDecision;
  event: FirstRoomAccessEventWrite;
  correlation?: FirstRoomAccessCorrelationWrite;
  ignored_reason?: string;
  /** Já conhecido em already_started (opcional). */
  existing_tolerance_id?: string;
  existing_suspension_due_at?: string;
  existing_pending_snapshot?: string[];
  grace?: {
    first_room_access_at: string;
    grace_started_at: string;
    suspension_due_at: string;
    pending_payment: boolean;
    pending_fnrh: boolean;
    pending_snapshot: string[];
    original_valid_from: string;
    original_valid_until: string;
  };
  items?: FirstRoomAccessItemWrite[];
  outbox?: FirstRoomAccessOutboxWrite | null;
};

export type FirstRoomAccessCommitResult = ProcessFirstRoomAccessResult;
