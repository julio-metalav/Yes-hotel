import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReservationPendingStatePort } from "../../../application/yes-hotel/first-room-access-ports";
import type { ReservationPendingStateInput } from "../../../domain/yes-hotel/reservation-pending-state";
import {
  buildReservationPendingInputFromRows,
  FirstRoomAccessConfigurationError,
  type GuestFnrhSourceRow,
} from "./reservation-pending-mapper";

/**
 * Carrega pendências reais do banco.
 * FNRH: operacional_hospedes não tem papel/menor/guardião → erro de configuração
 * (não inventa; não inicia tolerância).
 */
export class SupabaseReservationPendingStatePort implements ReservationPendingStatePort {
  constructor(private readonly client: SupabaseClient) {}

  async getReservationPendingInput(reservationId: string): Promise<ReservationPendingStateInput> {
    const { data: reserva, error: resErr } = await this.client
      .from("operacional_reservas")
      .select("id, pagamento_status")
      .eq("id", reservationId)
      .maybeSingle();
    if (resErr) throw new Error(`reserva: ${resErr.message}`);
    if (!reserva) throw new Error(`Reserva não encontrada: ${reservationId}`);

    const { data: hospedes, error: hopErr } = await this.client
      .from("operacional_hospedes")
      .select("id, principal, status_operacional, modo_coleta_fnrh")
      .eq("reserva_id", reservationId);
    if (hopErr) throw new Error(`hospedes: ${hopErr.message}`);

    // Tenta enriquecer com fnrh_hospedes (status + data_nascimento) via hospede_id.
    const { data: fnrhRows } = await this.client
      .from("fnrh_hospedes")
      .select("id, hospede_id, status, data_nascimento")
      .eq("reserva_id", reservationId);

    const fnrhByHop = new Map<string, { status: string | null; data_nascimento: string | null }>();
    for (const f of fnrhRows ?? []) {
      const hopId = (f as { hospede_id?: string | null }).hospede_id;
      if (hopId) {
        fnrhByHop.set(hopId, {
          status: (f as { status?: string | null }).status ?? null,
          data_nascimento: (f as { data_nascimento?: string | null }).data_nascimento ?? null,
        });
      }
    }

    const guests: GuestFnrhSourceRow[] = (hospedes ?? []).map((h) => {
      const enrich = fnrhByHop.get(h.id as string);
      return {
        id: h.id as string,
        principal: Boolean(h.principal),
        fnrh_status: enrich?.status ?? (h.status_operacional as string | null) ?? null,
        data_nascimento: enrich?.data_nascimento ?? null,
        // completed_by_guardian NÃO existe no schema — mapper falha para menores.
        completed_by_guardian: null,
        role: null,
      };
    });

    try {
      return buildReservationPendingInputFromRows({
        pagamento_status: (reserva as { pagamento_status?: string }).pagamento_status,
        guests,
      });
    } catch (e) {
      if (e instanceof FirstRoomAccessConfigurationError) throw e;
      throw e;
    }
  }
}
