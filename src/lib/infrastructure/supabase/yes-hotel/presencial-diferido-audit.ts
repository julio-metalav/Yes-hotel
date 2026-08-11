/**
 * Persistência Supabase da auditoria de pagamento presencial diferido.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PresencialDiferidoAuditPort,
  PresencialDiferidoFirstAccessOutcome,
} from "../../../application/yes-hotel/presencial-diferido-audit-port";

export class SupabasePresencialDiferidoAuditPort implements PresencialDiferidoAuditPort {
  constructor(private readonly client: SupabaseClient) {}

  async persistFirstAccessOutcome(input: PresencialDiferidoFirstAccessOutcome): Promise<void> {
    if (!input.autorizado) return;

    const patch: Record<string, unknown> = {
      pagamento_presencial_diferido_primeiro_acesso_em: input.first_access_at,
      pagamento_presencial_diferido_regra: input.regra,
    };
    if (input.efetivado) {
      patch.pagamento_presencial_diferido_efetivado = true;
      patch.pagamento_presencial_diferido_efetivado_em = input.now_iso;
      patch.pagamento_presencial_diferido_deadline_em = input.deadline_iso;
    }

    const { error } = await this.client
      .from("operacional_reservas")
      .update(patch)
      .eq("id", input.reservation_id);
    if (error) throw new Error(`ppd first-access update: ${error.message}`);

    const apt = (input.apartment_number || "").trim() || "—";
    const { error: evErr } = await this.client.from("operacional_reserva_eventos").insert({
      reserva_id: input.reservation_id,
      tipo: input.efetivado
        ? "pagamento_presencial_diferido_efetivado"
        : "pagamento_presencial_diferido_nao_efetivado",
      titulo: input.efetivado
        ? "Pagamento presencial diferido efetivado"
        : "Pagamento presencial diferido não efetivado",
      detalhe: [
        `apto=${apt}`,
        `regra=${input.regra ?? "—"}`,
        `primeiro_acesso=${input.first_access_at}`,
        `efetivado=${input.efetivado ? "sim" : "nao"}`,
        input.deadline_iso ? `deadline=${input.deadline_iso}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    });
    if (evErr) throw new Error(`ppd first-access event: ${evErr.message}`);
  }

  async markBloqueado(input: {
    reservation_id: string;
    at_iso: string;
    motivo: string;
  }): Promise<void> {
    const { error } = await this.client
      .from("operacional_reservas")
      .update({
        pagamento_presencial_diferido_bloqueado_em: input.at_iso,
        pagamento_presencial_diferido_bloqueado_motivo: input.motivo,
      })
      .eq("id", input.reservation_id)
      .eq("pagamento_presencial_diferido_efetivado", true);
    if (error) throw new Error(`ppd bloqueio: ${error.message}`);

    await this.client.from("operacional_reserva_eventos").insert({
      reserva_id: input.reservation_id,
      tipo: "pagamento_presencial_diferido_bloqueado",
      titulo: "Pagamento presencial diferido — acesso suspenso",
      detalhe: input.motivo,
    });
  }

  async markRegularizado(input: { reservation_id: string; at_iso: string }): Promise<void> {
    const { error } = await this.client
      .from("operacional_reservas")
      .update({
        pagamento_presencial_diferido_regularizado_em: input.at_iso,
      })
      .eq("id", input.reservation_id)
      .eq("pagamento_presencial_diferido_autorizado", true)
      .is("pagamento_presencial_diferido_regularizado_em", null);
    if (error) throw new Error(`ppd regularizado: ${error.message}`);

    await this.client.from("operacional_reserva_eventos").insert({
      reserva_id: input.reservation_id,
      tipo: "pagamento_presencial_diferido_regularizado",
      titulo: "Pagamento presencial diferido regularizado",
      detalhe: `regularizado_em=${input.at_iso}`,
    });
  }
}
