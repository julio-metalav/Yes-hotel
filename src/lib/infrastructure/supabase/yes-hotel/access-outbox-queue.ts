/**
 * Fila operacional_acesso_outbox (service_role). Claim com lease via available_at.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccessOutboxQueuePort } from "../../../application/yes-hotel/first-room-access-ports";
import type { AccessOutboxRecord } from "../../../application/yes-hotel/first-room-access-types";
import { assertSanitizedPayloadSafe } from "../../../integrations/ttlock/access-ingest/sanitize";

type OutboxRow = AccessOutboxRecord;

export class SupabaseAccessOutboxQueuePort implements AccessOutboxQueuePort {
  constructor(private readonly client: SupabaseClient) {}

  async listAvailable(nowIso: string, limit = 20): Promise<AccessOutboxRecord[]> {
    // pending/failed elegíveis + processing com lease expirado (available_at <= now)
    const { data: a, error: e1 } = await this.client
      .from("operacional_acesso_outbox")
      .select("*")
      .in("status", ["pending", "failed"])
      .lte("available_at", nowIso)
      .is("processed_at", null)
      .order("available_at", { ascending: true })
      .limit(limit);
    if (e1) throw new Error(`outbox listAvailable: ${e1.message}`);

    const { data: b, error: e2 } = await this.client
      .from("operacional_acesso_outbox")
      .select("*")
      .eq("status", "processing")
      .lte("available_at", nowIso)
      .order("available_at", { ascending: true })
      .limit(limit);
    if (e2) throw new Error(`outbox listAvailable processing: ${e2.message}`);

    const merged = [...(a ?? []), ...(b ?? [])];
    const seen = new Set<string>();
    const out: AccessOutboxRecord[] = [];
    for (const row of merged) {
      const r = row as OutboxRow;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  async tryClaim(id: string, nowIso: string, leaseUntilIso: string): Promise<boolean> {
    // CAS + lease: só reclama se available_at <= now (pending elegível ou processing abandonado).
    const { data, error } = await this.client
      .from("operacional_acesso_outbox")
      .update({ status: "processing", available_at: leaseUntilIso })
      .eq("id", id)
      .in("status", ["pending", "failed", "processing"])
      .lte("available_at", nowIso)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`outbox tryClaim: ${error.message}`);
    return Boolean(data?.id);
  }

  async releaseClaim(id: string, availableAt: string): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_outbox")
      .update({ status: "pending", available_at: availableAt })
      .eq("id", id)
      .eq("status", "processing");
    if (error) throw new Error(`outbox releaseClaim: ${error.message}`);
  }

  async markSent(id: string, processedAt: string): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_outbox")
      .update({ status: "sent", processed_at: processedAt, last_error: null })
      .eq("id", id);
    if (error) throw new Error(`outbox markSent: ${error.message}`);
  }

  async markFailed(
    id: string,
    err: string,
    attempts: number,
    availableAt: string,
    processedAt?: string,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status: "failed",
      last_error: err.slice(0, 200),
      attempts,
      available_at: availableAt,
    };
    if (processedAt) patch.processed_at = processedAt;
    const { error } = await this.client
      .from("operacional_acesso_outbox")
      .update(patch)
      .eq("id", id);
    if (error) throw new Error(`outbox markFailed: ${error.message}`);
  }

  async enqueue(
    record: Omit<AccessOutboxRecord, "id" | "created_at"> & { id?: string },
  ): Promise<string> {
    assertSanitizedPayloadSafe(record.payload);
    const { data, error } = await this.client
      .from("operacional_acesso_outbox")
      .upsert(
        {
          event_type: record.event_type,
          channel: record.channel,
          reservation_id: record.reservation_id,
          credential_id: record.credential_id,
          access_event_id: record.access_event_id,
          tolerance_id: record.tolerance_id,
          recipient_ref: record.recipient_ref,
          template: record.template,
          payload: record.payload,
          idempotency_key: record.idempotency_key,
          status: record.status,
          attempts: record.attempts,
          available_at: record.available_at,
          processed_at: record.processed_at,
          last_error: record.last_error,
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) {
      const { data: existing } = await this.client
        .from("operacional_acesso_outbox")
        .select("id")
        .eq("idempotency_key", record.idempotency_key)
        .maybeSingle();
      if (existing?.id) return existing.id as string;
      throw new Error(`outbox enqueue: ${error.message}`);
    }
    if (data?.id) return data.id as string;
    const { data: existing } = await this.client
      .from("operacional_acesso_outbox")
      .select("id")
      .eq("idempotency_key", record.idempotency_key)
      .maybeSingle();
    if (existing?.id) return existing.id as string;
    throw new Error("outbox enqueue: id ausente");
  }
}
