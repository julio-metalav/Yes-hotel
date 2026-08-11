import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialCorrelationPort } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { CorrelatedRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import {
  correlateApartmentPasscodeCandidates,
  type CorrelationCandidate,
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

      return correlateApartmentPasscodeCandidates({
        candidates,
        occurred_at: input.occurred_at,
        keyboard_pwd_id: input.keyboard_pwd_id,
        ephemeral_keyboard_pwd: pwd,
      });
    } finally {
      pwd = undefined;
    }
  }
}
