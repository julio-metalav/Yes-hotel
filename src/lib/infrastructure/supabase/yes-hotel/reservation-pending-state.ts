import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReservationPendingStatePort } from "../../../application/yes-hotel/first-room-access-ports";
import type { ReservationPendingStateInput } from "../../../domain/yes-hotel/reservation-pending-state";
import {
  buildReservationPendingInputFromRows,
  FirstRoomAccessConfigurationError,
  type GuestFnrhSourceRow,
} from "./reservation-pending-mapper";

function isMissingColumnError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("guest_role") ||
    m.includes("fnrh_lifecycle_status") ||
    m.includes("does not exist") ||
    m.includes("could not find") ||
    (m.includes("column") && m.includes("schema cache"))
  );
}

/**
 * Carrega pendências reais do banco.
 * Com migration 0024 aplicada: mapeia papéis/status formal.
 * Sem colunas PR4: ConfigurationError (não simula conclusão).
 */
export class SupabaseReservationPendingStatePort implements ReservationPendingStatePort {
  constructor(private readonly client: SupabaseClient) {}

  async getReservationPendingInput(reservationId: string): Promise<ReservationPendingStateInput> {
    let reserva: {
      pagamento_status?: string;
      pagamento_presencial_diferido_autorizado?: boolean;
      pagamento_presencial_diferido_efetivado?: boolean;
    } | null = null;
    {
      const first = await this.client
        .from("operacional_reservas")
        .select(
          "id, pagamento_status, pagamento_presencial_diferido_autorizado, pagamento_presencial_diferido_efetivado",
        )
        .eq("id", reservationId)
        .maybeSingle();
      if (first.error && isMissingColumnError(first.error.message)) {
        const legacy = await this.client
          .from("operacional_reservas")
          .select("id, pagamento_status")
          .eq("id", reservationId)
          .maybeSingle();
        if (legacy.error) throw new Error(`reserva: ${legacy.error.message}`);
        reserva = legacy.data as typeof reserva;
      } else if (first.error) {
        throw new Error(`reserva: ${first.error.message}`);
      } else {
        reserva = first.data as typeof reserva;
      }
    }
    if (!reserva) throw new Error(`Reserva não encontrada: ${reservationId}`);

    const { data: hospedes, error: hopErr } = await this.client
      .from("operacional_hospedes")
      .select(
        "id, principal, status_operacional, modo_coleta_fnrh, email, whatsapp, guest_role, is_minor, responsible_guest_id, requires_classification, fnrh_required, removed_from_reservation, data_nascimento",
      )
      .eq("reserva_id", reservationId);

    if (hopErr) {
      if (isMissingColumnError(hopErr.message)) {
        throw new FirstRoomAccessConfigurationError(
          "fnrh_guest_role_schema_incomplete",
          "Colunas PR4 (guest_role etc.) ausentes — migration 0024 não aplicada. " +
            "Não iniciar tolerância.",
        );
      }
      throw new Error(`hospedes: ${hopErr.message}`);
    }

    const { data: fnrhRows, error: fnrhErr } = await this.client
      .from("fnrh_hospedes")
      .select(
        "id, hospede_id, status, fnrh_lifecycle_status, data_nascimento, completed_by_guest_id, completed_by_user_id, confirmation_source, manual_completion_reason, waived_reason, has_required_core_fields, has_required_documents",
      )
      .eq("reserva_id", reservationId);

    if (fnrhErr) {
      if (isMissingColumnError(fnrhErr.message)) {
        // Fallback: tenta só colunas legadas → força ConfigurationError no mapper.
        return this.loadLegacyAndFail(reservationId, reserva, hospedes ?? []);
      }
      throw new Error(`fnrh: ${fnrhErr.message}`);
    }

    const fnrhByHop = new Map<
      string,
      {
        status: string | null;
        lifecycle: string | null;
        data_nascimento: string | null;
        completed_by_guest_id: string | null;
        completed_by_user_id: string | null;
        confirmation_source: string | null;
        manual_completion_reason: string | null;
        waived_reason: string | null;
        has_required_core_fields: boolean | null;
        has_required_documents: boolean | null;
      }
    >();

    for (const f of fnrhRows ?? []) {
      const hopId = (f as { hospede_id?: string | null }).hospede_id;
      if (!hopId) continue;
      fnrhByHop.set(hopId, {
        status: (f as { status?: string | null }).status ?? null,
        lifecycle: (f as { fnrh_lifecycle_status?: string | null }).fnrh_lifecycle_status ?? null,
        data_nascimento: (f as { data_nascimento?: string | null }).data_nascimento ?? null,
        completed_by_guest_id: (f as { completed_by_guest_id?: string | null }).completed_by_guest_id ?? null,
        completed_by_user_id: (f as { completed_by_user_id?: string | null }).completed_by_user_id ?? null,
        confirmation_source: (f as { confirmation_source?: string | null }).confirmation_source ?? null,
        manual_completion_reason:
          (f as { manual_completion_reason?: string | null }).manual_completion_reason ?? null,
        waived_reason: (f as { waived_reason?: string | null }).waived_reason ?? null,
        has_required_core_fields:
          (f as { has_required_core_fields?: boolean | null }).has_required_core_fields ?? null,
        has_required_documents:
          (f as { has_required_documents?: boolean | null }).has_required_documents ?? null,
      });
    }

    const guests: GuestFnrhSourceRow[] = (hospedes ?? []).map((h) => {
      const enrich = fnrhByHop.get(h.id as string);
      const email = String((h as { email?: string }).email ?? "").trim();
      const whatsapp = String((h as { whatsapp?: string }).whatsapp ?? "").trim();
      return {
        id: h.id as string,
        principal: Boolean(h.principal),
        guest_role: (h as { guest_role?: string | null }).guest_role ?? null,
        responsible_guest_id: (h as { responsible_guest_id?: string | null }).responsible_guest_id ?? null,
        requires_classification: (h as { requires_classification?: boolean }).requires_classification,
        fnrh_required: (h as { fnrh_required?: boolean }).fnrh_required,
        removed_from_reservation: (h as { removed_from_reservation?: boolean }).removed_from_reservation,
        data_nascimento:
          enrich?.data_nascimento ??
          (h as { data_nascimento?: string | null }).data_nascimento ??
          null,
        fnrh_status: enrich?.status ?? null,
        fnrh_lifecycle_status: enrich?.lifecycle ?? null,
        completed_by_guest_id: enrich?.completed_by_guest_id ?? null,
        completed_by_user_id: enrich?.completed_by_user_id ?? null,
        confirmation_source: enrich?.confirmation_source ?? null,
        manual_completion_reason: enrich?.manual_completion_reason ?? null,
        waived_reason: enrich?.waived_reason ?? null,
        has_required_core_fields: enrich?.has_required_core_fields ?? null,
        has_required_documents: enrich?.has_required_documents ?? null,
        has_email: email.length > 0,
        has_whatsapp: whatsapp.length > 0,
      };
    });

    return {
      ...buildReservationPendingInputFromRows({
        pagamento_status: (reserva as { pagamento_status?: string }).pagamento_status,
        guests,
      }),
      pagamento_presencial_diferido_autorizado: Boolean(
        (reserva as { pagamento_presencial_diferido_autorizado?: boolean })
          .pagamento_presencial_diferido_autorizado,
      ),
      pagamento_presencial_diferido_efetivado: Boolean(
        (reserva as { pagamento_presencial_diferido_efetivado?: boolean })
          .pagamento_presencial_diferido_efetivado,
      ),
    };
  }

  private async loadLegacyAndFail(
    reservationId: string,
    reserva: { pagamento_status?: string },
    hospedes: Array<Record<string, unknown>>,
  ): Promise<ReservationPendingStateInput> {
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

    const guests: GuestFnrhSourceRow[] = hospedes.map((h) => {
      const enrich = fnrhByHop.get(h.id as string);
      return {
        id: h.id as string,
        principal: Boolean(h.principal),
        fnrh_status: enrich?.status ?? null,
        data_nascimento: enrich?.data_nascimento ?? null,
        completed_by_guardian: null,
        guest_role: null,
      };
    });

    // Sempre ConfigurationError no schema antigo.
    return buildReservationPendingInputFromRows({
      pagamento_status: reserva.pagamento_status,
      guests,
    });
  }
}
