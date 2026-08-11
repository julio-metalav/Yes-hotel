import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnitOfWorkPort } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { FirstRoomAccessCommitCommand } from "../../../application/yes-hotel/first-room-access-commit.ts";
import type { ProcessFirstRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import { assertSanitizedPayloadSafe } from "../../../integrations/ttlock/access-ingest/sanitize.ts";

/**
 * UoW Supabase: uma única RPC `yes_hotel_process_first_room_access` (migration 0025).
 * Sem fallback multi-insert. Sem runInTransaction real no client JS.
 */
export class SupabaseFirstRoomAccessUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly client: SupabaseClient) {}

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // Client JS não garante transação multi-tabela. Usar commitFirstRoomAccess.
    return fn();
  }

  async commitFirstRoomAccess(
    command: FirstRoomAccessCommitCommand,
  ): Promise<ProcessFirstRoomAccessResult> {
    assertSanitizedPayloadSafe(command.event.raw_payload_sanitized ?? {});
    if (command.outbox) {
      assertSanitizedPayloadSafe(command.outbox);
      assertSanitizedPayloadSafe(command.outbox.payload);
    }

    const { data, error } = await this.client.rpc("yes_hotel_process_first_room_access", {
      p_decision: command.decision,
      p_source: command.event.source,
      p_source_event_id: command.event.source_event_id,
      p_idempotency_key: command.event.idempotency_key,
      p_occurred_at: command.event.occurred_at,
      p_received_at: command.event.received_at,
      p_lock_id: command.event.lock_id,
      p_keyboard_pwd_id: command.event.keyboard_pwd_id ?? null,
      p_record_type: command.event.record_type,
      p_access_method: command.event.access_method,
      p_success: command.event.success,
      p_reservation_id: command.correlation?.reservation_id ?? null,
      p_credential_id: command.correlation?.credential_id ?? null,
      p_credential_item_id: command.correlation?.credential_item_id ?? null,
      p_logical_destination: command.correlation?.logical_destination ?? null,
      p_raw_payload_sanitized: command.event.raw_payload_sanitized ?? null,
      p_ignored_reason: command.ignored_reason ?? null,
      p_first_room_access_at: command.grace?.first_room_access_at ?? null,
      p_grace_started_at: command.grace?.grace_started_at ?? null,
      p_suspension_due_at: command.grace?.suspension_due_at ?? null,
      p_pending_payment: command.grace?.pending_payment ?? null,
      p_pending_fnrh: command.grace?.pending_fnrh ?? null,
      p_pending_snapshot: command.grace?.pending_snapshot ?? null,
      p_original_valid_from: command.grace?.original_valid_from ?? null,
      p_original_valid_until: command.grace?.original_valid_until ?? null,
      p_items: command.items
        ? command.items.map((i) => ({
            credential_item_id: i.credential_item_id,
            logical_destination: i.logical_destination,
            lock_id: i.lock_id,
            remote_keyboard_pwd_id: i.remote_keyboard_pwd_id,
            original_valid_from: i.original_valid_from,
            original_valid_until: i.original_valid_until,
            lock_class: i.lock_class,
          }))
        : null,
      p_outbox_event: command.outbox
        ? {
            event_type: command.outbox.event_type,
            channel: command.outbox.channel,
            recipient_ref: command.outbox.recipient_ref ?? null,
            template: command.outbox.template ?? null,
            payload: command.outbox.payload,
            idempotency_key: command.outbox.idempotency_key,
            available_at: command.outbox.available_at ?? null,
          }
        : null,
    });

    if (error) {
      const msg = error.message ?? String(error);
      if (
        /yes_hotel_process_first_room_access/i.test(msg) ||
        /could not find the function/i.test(msg) ||
        /schema cache/i.test(msg) ||
        /does not exist/i.test(msg)
      ) {
        throw new Error(
          `RPC yes_hotel_process_first_room_access indisponível (migration 0025 não aplicada): ${msg}. ` +
            "Sem fallback multi-insert.",
        );
      }
      throw new Error(`commitFirstRoomAccess RPC: ${msg}`);
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row !== "object") {
      throw new Error("RPC não retornou resultado.");
    }

    const status = String(row.status ?? "");
    const pending =
      Array.isArray(row.pending_reasons)
        ? (row.pending_reasons as string[])
        : typeof row.pending_reasons === "string"
          ? (JSON.parse(row.pending_reasons) as string[])
          : undefined;

    return {
      status: status as ProcessFirstRoomAccessResult["status"],
      event_id: row.event_id ? String(row.event_id) : undefined,
      tolerance_id: row.tolerance_id ? String(row.tolerance_id) : undefined,
      suspension_due_at: row.suspension_due_at ? String(row.suspension_due_at) : undefined,
      pending_reasons: pending,
      ignored_reason: row.ignored_reason ? String(row.ignored_reason) : undefined,
      error: row.error ? String(row.error) : undefined,
      first_access_at: row.first_access_at ? String(row.first_access_at) : undefined,
    };
  }
}

export class SystemClock {
  now(): Date {
    return new Date();
  }
}

/** @deprecated Prefer SupabaseFirstRoomAccessUnitOfWork */
export class SupabasePassthroughUnitOfWork implements UnitOfWorkPort {
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async commitFirstRoomAccess(): Promise<ProcessFirstRoomAccessResult> {
    throw new Error(
      "SupabasePassthroughUnitOfWork não persiste. Use SupabaseFirstRoomAccessUnitOfWork (RPC 0025).",
    );
  }
}
