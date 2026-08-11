/**
 * Auditoria / persistência de pagamento presencial diferido (sem I/O no domínio).
 */

export type PresencialDiferidoFirstAccessOutcome = {
  reservation_id: string;
  autorizado: boolean;
  efetivado: boolean;
  regra: "util_19h" | "fim_semana_feriado_15h" | null;
  first_access_at: string;
  deadline_iso: string | null;
  now_iso: string;
  apartment_number?: string | null;
};

export interface PresencialDiferidoAuditPort {
  persistFirstAccessOutcome(input: PresencialDiferidoFirstAccessOutcome): Promise<void>;
  markBloqueado(input: {
    reservation_id: string;
    at_iso: string;
    motivo: string;
  }): Promise<void>;
  markRegularizado(input: { reservation_id: string; at_iso: string }): Promise<void>;
}
