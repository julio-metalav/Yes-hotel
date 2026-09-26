/**
 * Persistência de checkpoints + seleção de locks candidatos (apartamento).
 * Service role only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PollCheckpoint,
  PollCheckpointStore,
} from "../../../integrations/ttlock/access-ingest/handle-poll.ts";
import {
  broaderPollCandidateLockIds,
  mergePollCandidateLockIds,
  type BroaderPollCandidateInput,
} from "../../../integrations/ttlock/access-ingest/poll-candidates.ts";

export class SupabaseTtlockPollCheckpointStore implements PollCheckpointStore {
  constructor(private readonly client: SupabaseClient) {}

  async listCandidateApartmentLockIds(): Promise<number[]> {
    const { data, error } = await this.client.rpc(
      "yes_hotel_list_ttlock_poll_candidate_locks",
    );
    if (error) throw new Error(`listCandidateApartmentLockIds: ${error.message}`);
    const rpcIds = Array.isArray(data)
      ? data.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const broader = await this.listLiberatedLocksBeforeValidity(Date.now());
    return mergePollCandidateLockIds(rpcIds, broader);
  }

  /**
   * Credencial já provisionada e acesso liberado, com `valido_ate` ainda vigente,
   * sem exigir `valido_de <= now()`. Cobre a abertura antes das 13h.
   */
  private async listLiberatedLocksBeforeValidity(nowMs: number): Promise<number[]> {
    const { data: items, error: itemErr } = await this.client
      .from("operacional_credencial_itens")
      .select("lock_id_ttlock, codigo_logico_destino, credencial_id")
      .eq("tipo_destino", "apartamento")
      .eq("status_provisionamento", "provisionado");
    if (itemErr) throw new Error(`poll candidates itens: ${itemErr.message}`);
    const itemRows = items ?? [];
    const credIds = [...new Set(itemRows.map((row) => String(row.credencial_id ?? "")).filter(Boolean))];
    if (credIds.length === 0) return [];

    const { data: creds, error: credErr } = await this.client
      .from("operacional_credenciais_acesso")
      .select("id, status, valido_de, valido_ate, reserva_id")
      .in("id", credIds)
      .eq("status", "provisionada");
    if (credErr) throw new Error(`poll candidates credenciais: ${credErr.message}`);
    const credById = new Map((creds ?? []).map((row) => [String(row.id), row]));
    const reservaIds = [
      ...new Set((creds ?? []).map((row) => String(row.reserva_id ?? "")).filter(Boolean)),
    ];
    if (reservaIds.length === 0) return [];

    const { data: reservas, error: resErr } = await this.client
      .from("operacional_reservas")
      .select("id, acesso_liberado, entrou_no_apto")
      .in("id", reservaIds);
    if (resErr) throw new Error(`poll candidates reservas: ${resErr.message}`);
    const reservaById = new Map((reservas ?? []).map((row) => [String(row.id), row]));

    const rows: BroaderPollCandidateInput[] = [];
    for (const item of itemRows) {
      const cred = credById.get(String(item.credencial_id ?? ""));
      if (!cred) continue;
      const reserva = reservaById.get(String(cred.reserva_id ?? ""));
      if (!reserva) continue;
      rows.push({
        lock_id_ttlock: String(item.lock_id_ttlock ?? ""),
        codigo_logico_destino: String(item.codigo_logico_destino ?? ""),
        credential_status: String(cred.status ?? ""),
        valido_de: cred.valido_de != null ? String(cred.valido_de) : null,
        valido_ate: cred.valido_ate != null ? String(cred.valido_ate) : null,
        acesso_liberado: reserva.acesso_liberado === true,
        entrou_no_apto: reserva.entrou_no_apto === true,
      });
    }
    return broaderPollCandidateLockIds(rows, nowMs);
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
