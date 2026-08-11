import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccessEventRepository } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type {
  AccessEventRecord,
  ProcessFirstRoomAccessInput,
} from "../../../application/yes-hotel/first-room-access-types.ts";
import { assertSanitizedPayloadSafe } from "../../../integrations/ttlock/access-ingest/sanitize.ts";

type EventRow = {
  id: string;
  source: string;
  source_event_id: string;
  idempotency_key: string;
  occurred_at: string;
  received_at: string;
  lock_id: number;
  keyboard_pwd_id: number | null;
  record_type: number;
  access_method: AccessEventRecord["access_method"];
  success: boolean;
  reservation_id: string | null;
  credential_id: string | null;
  credential_item_id: string | null;
  logical_destination: string | null;
  processing_status: AccessEventRecord["processing_status"];
  ignored_reason: string | null;
  raw_payload_sanitized: Record<string, unknown> | null;
  processed_at: string | null;
  created_at: string;
};

function mapRow(row: EventRow): AccessEventRecord {
  return { ...row, lock_id: Number(row.lock_id) };
}

export class SupabaseAccessEventRepository implements AccessEventRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByIdempotencyKey(key: string): Promise<AccessEventRecord | null> {
    const { data, error } = await this.client
      .from("operacional_acesso_eventos")
      .select("*")
      .eq("idempotency_key", key)
      .maybeSingle();
    if (error) throw new Error(`findByIdempotencyKey: ${error.message}`);
    return data ? mapRow(data as EventRow) : null;
  }

  async findFirstProcessedApartmentByCredentialId(
    credentialId: string,
  ): Promise<AccessEventRecord | null> {
    const { data, error } = await this.client
      .from("operacional_acesso_eventos")
      .select("*")
      .eq("credential_id", credentialId)
      .eq("processing_status", "processed")
      .or("logical_destination.ilike.APT-%,logical_destination.ilike.APTO-%")
      .order("occurred_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`findFirstProcessedApartmentByCredentialId: ${error.message}`);
    }
    return data ? mapRow(data as EventRow) : null;
  }

  async hasProcessedApartmentFirstAccess(credentialId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("operacional_acesso_eventos")
      .select("id, logical_destination")
      .eq("credential_id", credentialId)
      .eq("processing_status", "processed")
      .limit(50);
    if (error) throw new Error(`hasProcessedApartmentFirstAccess: ${error.message}`);
    const rows = (data ?? []) as Array<{ logical_destination: string | null }>;
    return rows.some((r) => {
      const d = (r.logical_destination ?? "").toUpperCase();
      return d.startsWith("APT-") || d.startsWith("APTO-");
    });
  }

  async insertRawEvent(
    input: ProcessFirstRoomAccessInput & {
      access_method: AccessEventRecord["access_method"];
      received_at: string;
    },
  ): Promise<AccessEventRecord> {
    if (input.raw_payload_sanitized) {
      assertSanitizedPayloadSafe(input.raw_payload_sanitized);
    }
    const payload = {
      source: input.source,
      source_event_id: input.source_event_id,
      idempotency_key: input.idempotency_key,
      occurred_at: input.occurred_at,
      received_at: input.received_at,
      lock_id: input.lock_id,
      keyboard_pwd_id: input.keyboard_pwd_id ?? null,
      record_type: input.record_type,
      access_method: input.access_method,
      success: input.success,
      processing_status: "received",
      raw_payload_sanitized: input.raw_payload_sanitized ?? null,
    };
    assertSanitizedPayloadSafe(payload);
    const { data, error } = await this.client
      .from("operacional_acesso_eventos")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw new Error(`insertRawEvent: ${error.message}`);
    return mapRow(data as EventRow);
  }

  async markProcessed(eventId: string, processedAt: string): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_eventos")
      .update({
        processing_status: "processed",
        processed_at: processedAt,
        ignored_reason: null,
      })
      .eq("id", eventId);
    if (error) throw new Error(`markProcessed: ${error.message}`);
  }

  async markIgnored(eventId: string, reason: string, processedAt: string): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_eventos")
      .update({
        processing_status: "ignored",
        ignored_reason: reason,
        processed_at: processedAt,
      })
      .eq("id", eventId);
    if (error) throw new Error(`markIgnored: ${error.message}`);
  }

  async markFailed(eventId: string, errorMsg: string, processedAt: string): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_eventos")
      .update({
        processing_status: "failed",
        ignored_reason: errorMsg,
        processed_at: processedAt,
      })
      .eq("id", eventId);
    if (error) throw new Error(`markFailed: ${error.message}`);
  }

  async attachCorrelation(
    eventId: string,
    correlation: {
      reservation_id: string | null;
      credential_id: string | null;
      credential_item_id: string | null;
      logical_destination: string | null;
      keyboard_pwd_id: number | null;
    },
  ): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_eventos")
      .update({
        reservation_id: correlation.reservation_id,
        credential_id: correlation.credential_id,
        credential_item_id: correlation.credential_item_id,
        logical_destination: correlation.logical_destination,
        keyboard_pwd_id: correlation.keyboard_pwd_id,
      })
      .eq("id", eventId);
    if (error) throw new Error(`attachCorrelation: ${error.message}`);
  }
}
