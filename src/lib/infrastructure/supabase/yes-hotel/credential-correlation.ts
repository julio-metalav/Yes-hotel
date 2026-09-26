import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialCorrelationPort } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { CorrelatedRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import { hotelCivilYmdFromUtcMs } from "../../../domain/yes-hotel/hotel-timezone.ts";
import {
  associateUnlockToUniqueLiberatedStay,
  correlateApartmentPasscodeCandidates,
  shouldApplyLiberatedStayFallback,
  type CorrelationCandidate,
  type LiberatedStayCandidate,
} from "./credential-correlation-logic.ts";

type ItemJoinRow = {
  id: string;
  credencial_id: string;
  codigo_logico_destino: string;
  lock_id_ttlock: string;
  remote_keyboard_pwd_id: number | null;
  status_provisionamento: string;
  credencial: {
    id: string;
    reserva_id: string;
    status: string;
    /** PIN técnico provisionado — obrigatório para match com keyboardPwd da TTLock. */
    codigo_credencial?: string | null;
    valido_de: string | null;
    valido_ate: string | null;
  } | null;
};

/**
 * Correlação segura via Supabase + lógica pura (sem senha no retorno).
 */
export class SupabaseCredentialCorrelationPort implements CredentialCorrelationPort {
  constructor(private readonly client: SupabaseClient) {}

  async correlateRoomPasscodeEvent(input: {
    lock_id: number;
    keyboard_pwd_id?: number;
    occurred_at: string;
    record_type: number;
    ephemeral_keyboard_pwd?: string;
  }): Promise<CorrelatedRoomAccessResult> {
    let pwd = input.ephemeral_keyboard_pwd;
    try {
      const lockKey = String(input.lock_id);
      const { data, error } = await this.client
        .from("operacional_credencial_itens")
        .select(
          `
          id,
          credencial_id,
          codigo_logico_destino,
          lock_id_ttlock,
          remote_keyboard_pwd_id,
          status_provisionamento,
          credencial:operacional_credenciais_acesso!inner (
            id,
            reserva_id,
            status,
            codigo_credencial,
            valido_de,
            valido_ate
          )
        `,
        )
        .eq("lock_id_ttlock", lockKey)
        .eq("status_provisionamento", "provisionado");

      if (error) throw new Error(`correlate query: ${error.message}`);
      const rows = (data ?? []) as unknown as ItemJoinRow[];

      const candidates: CorrelationCandidate[] = rows
        .filter((row) => row.credencial)
        .map((row) => ({
          credential_item_id: row.id,
          credential_id: row.credencial!.id,
          reservation_id: row.credencial!.reserva_id,
          logical_destination: row.codigo_logico_destino,
          lock_id: Number(row.lock_id_ttlock),
          remote_keyboard_pwd_id: row.remote_keyboard_pwd_id,
          status_provisionamento: row.status_provisionamento,
          credential_status: row.credencial!.status,
          codigo_credencial: row.credencial!.codigo_credencial ?? null,
          valido_de: row.credencial!.valido_de,
          valido_ate: row.credencial!.valido_ate,
        }));

      const strict = correlateApartmentPasscodeCandidates({
        candidates,
        occurred_at: input.occurred_at,
        keyboard_pwd_id: input.keyboard_pwd_id,
        ephemeral_keyboard_pwd: pwd,
      });
      if (!shouldApplyLiberatedStayFallback(strict, Boolean(pwd))) {
        return strict;
      }
      const occurredMs = Date.parse(input.occurred_at);
      if (!Number.isFinite(occurredMs)) return strict;
      const stay = await this.loadLiberatedStayCandidates(input.lock_id);
      return associateUnlockToUniqueLiberatedStay({
        civil_date: hotelCivilYmdFromUtcMs(occurredMs),
        candidates: stay,
      });
    } finally {
      pwd = undefined;
    }
  }

  /**
   * Candidatos do lock para senha criada fora do fluxo Yes.
   * Não lê `codigo_credencial`.
   */
  private async loadLiberatedStayCandidates(lockId: number): Promise<LiberatedStayCandidate[]> {
    const lockKey = String(lockId);
    const { data: items, error: itemErr } = await this.client
      .from("operacional_credencial_itens")
      .select(
        "id, credencial_id, codigo_logico_destino, lock_id_ttlock, remote_keyboard_pwd_id, status_provisionamento",
      )
      .eq("lock_id_ttlock", lockKey);
    if (itemErr) throw new Error(`stay items: ${itemErr.message}`);
    const itemRows = items ?? [];
    const credIds = [...new Set(itemRows.map((row) => String(row.credencial_id ?? "")).filter(Boolean))];
    if (credIds.length === 0) return [];

    const { data: creds, error: credErr } = await this.client
      .from("operacional_credenciais_acesso")
      .select("id, reserva_id, status, valido_de, valido_ate")
      .in("id", credIds);
    if (credErr) throw new Error(`stay credenciais: ${credErr.message}`);
    const credById = new Map((creds ?? []).map((row) => [String(row.id), row]));
    const reservaIds = [
      ...new Set(
        (creds ?? []).map((row) => String(row.reserva_id ?? "")).filter(Boolean),
      ),
    ];
    if (reservaIds.length === 0) return [];

    const { data: reservas, error: resErr } = await this.client
      .from("operacional_reservas")
      .select("id, status_reserva, acesso_liberado, check_in_previsto, check_out_previsto")
      .in("id", reservaIds);
    if (resErr) throw new Error(`stay reservas: ${resErr.message}`);
    const reservaById = new Map((reservas ?? []).map((row) => [String(row.id), row]));

    const out: LiberatedStayCandidate[] = [];
    for (const item of itemRows) {
      const cred = credById.get(String(item.credencial_id ?? ""));
      if (!cred) continue;
      const reserva = reservaById.get(String(cred.reserva_id ?? ""));
      if (!reserva) continue;
      out.push({
        reservation_id: String(cred.reserva_id),
        credential_id: String(cred.id),
        credential_item_id: String(item.id),
        logical_destination: String(item.codigo_logico_destino ?? ""),
        lock_id: Number(item.lock_id_ttlock),
        remote_keyboard_pwd_id:
          item.remote_keyboard_pwd_id != null ? Number(item.remote_keyboard_pwd_id) : null,
        status_provisionamento: String(item.status_provisionamento ?? ""),
        credential_status: String(cred.status ?? ""),
        valido_de: cred.valido_de != null ? String(cred.valido_de) : null,
        valido_ate: cred.valido_ate != null ? String(cred.valido_ate) : null,
        acesso_liberado: reserva.acesso_liberado === true,
        status_reserva: String(reserva.status_reserva ?? ""),
        check_in_previsto: String(reserva.check_in_previsto ?? ""),
        check_out_previsto: String(reserva.check_out_previsto ?? ""),
      });
    }
    return out;
  }
}
