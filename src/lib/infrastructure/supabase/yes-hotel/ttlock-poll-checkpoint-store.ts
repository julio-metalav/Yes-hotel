/**
 * Persistência de checkpoints + seleção de locks candidatos (apartamento).
 * Service role only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PollCheckpoint,
  PollCheckpointStore,
} from "../../../integrations/ttlock/access-ingest/handle-poll.ts";

export class SupabaseTtlockPollCheckpointStore implements PollCheckpointStore {
  constructor(private readonly client: SupabaseClient) {}

  async listCandidateApartmentLockIds(): Promise<number[]> {
    const { data, error } = await this.client.rpc(
      "yes_hotel_list_ttlock_poll_candidate_locks",
    );
    if (error) throw new Error(`listCandidateApartmentLockIds: ${error.message}`);
    if (!Array.isArray(data)) return [];
    return data
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  async getCheckpoint(lockId: number): Promise<PollCheckpoint | null> {
    const { data, error } = await this.client
      .from("operacional_ttlock_poll_checkpoints")
      .select("lock_id, last_lock_date_ms, last_record_id")
      .eq("lock_id", lockId)
      .maybeSingle();
    if (error) throw new Error(`getCheckpoint: ${error.message}`);
    if (!data) return null;
    return {
      lock_id: Number(data.lock_id),
      last_lock_date_ms: Number(data.last_lock_date_ms),
      last_record_id: data.last_record_id != null ? String(data.last_record_id) : null,
    };
  }

  async upsertCheckpoint(input: {
    lock_id: number;
    last_lock_date_ms: number;
    last_record_id?: string | null;
    last_error?: string | null;
  }): Promise<void> {
    const { error } = await this.client.from("operacional_ttlock_poll_checkpoints").upsert(
      {
        lock_id: input.lock_id,
        last_lock_date_ms: input.last_lock_date_ms,
        last_record_id: input.last_record_id ?? null,
        last_polled_at: new Date().toISOString(),
        last_error: input.last_error ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "lock_id" },
    );
    if (error) throw new Error(`upsertCheckpoint: ${error.message}`);
  }
}
