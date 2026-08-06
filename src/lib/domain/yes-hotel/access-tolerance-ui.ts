/**
 * Policy pura: exceções operacionais de tolerância/suspensão para a tela.
 * Sem I/O. Só problemas — estados regulares retornam null/lista vazia.
 */

import type { AccessGraceStatusPersisted } from "../../application/yes-hotel/first-room-access-types";

export type AccessToleranceUiInput = {
  reservation_id: string;
  apartment_number: string;
  guest_main_name: string;
  /** Número externo da reserva (HITS/PMS). Nunca inventar a partir de UUID. */
  external_reservation_id?: string | null;
  grace_status?: AccessGraceStatusPersisted | null;
  suspension_due_at?: string | null;
  current_payment_pending?: boolean;
  current_fnrh_pending?: boolean;
  /** Pagamento desconhecido / não confirmado pelo sistema. */
  payment_unconfirmed?: boolean;
  last_error?: string | null;
  communication_failed?: boolean;
  now_ms?: number;
};

export type AccessToleranceUiException = {
  code: string;
  label: string;
  severity: "critica" | "moderada";
  /** Minutos restantes da tolerância, se aplicável. */
  minutes_remaining?: number | null;
};

/**
 * Deriva somente problemas/exceções. Sem pendência e status normal → [].
 */
export function deriveAccessToleranceExceptions(
  input: AccessToleranceUiInput,
): AccessToleranceUiException[] {
  const out: AccessToleranceUiException[] = [];
  const status = input.grace_status ?? null;
  const now = input.now_ms ?? Date.now();

  if (input.payment_unconfirmed) {
    out.push({
      code: "pagamento_nao_confirmado",
      label: "Pagamento não confirmado pelo sistema",
      severity: "moderada",
    });
  } else if (input.current_payment_pending) {
    out.push({
      code: "pagamento_pendente",
      label: "Pagamento pendente",
      severity: "moderada",
    });
  }
  if (input.current_fnrh_pending) {
    out.push({
      code: "fnrh_pendente",
      label: "FNRH pendente",
      severity: "moderada",
    });
  }

  if (status === "active" && input.suspension_due_at) {
    const due = new Date(input.suspension_due_at).getTime();
    if (Number.isFinite(due)) {
      const minutes = Math.max(0, Math.ceil((due - now) / 60_000));
      out.push({
        code: "tolerancia_em_andamento",
        label: minutes > 0 ? `Tolerância em andamento (${minutes} min)` : "Tolerância vencendo",
        severity: "moderada",
        minutes_remaining: minutes,
      });
    }
  }

  if (status === "suspension_pending") {
    out.push({
      code: "suspensao_pendente",
      label: "Suspensão pendente",
      severity: "critica",
    });
  }
  if (status === "suspended") {
    out.push({
      code: "senha_suspensa",
      label: "Senha suspensa",
      severity: "critica",
    });
  }
  if (status === "partial_failure") {
    out.push({
      code: "falha_parcial_ttlock",
      label: "Falha parcial ao atualizar acesso",
      severity: "critica",
    });
  }
  if (status === "restore_pending") {
    out.push({
      code: "restauracao_pendente",
      label: "Restauração pendente",
      severity: "critica",
    });
  }
  if (status === "error") {
    out.push({
      code: "erro_operacional",
      label: "Inconsistência operacional de acesso",
      severity: "critica",
    });
  }
  if (input.communication_failed) {
    out.push({
      code: "comunicacao_falha",
      label: "Falha de comunicação",
      severity: "moderada",
    });
  }

  // Estados regulares (cancelled/restored/null sem pendências) → sem extras.
  return out;
}

/** Resumo para strip: null se não houver problema. */
export function summarizeAccessToleranceAlert(
  input: AccessToleranceUiInput,
): string | null {
  const items = deriveAccessToleranceExceptions(input);
  if (items.length === 0) return null;
  const critical = items.find((i) => i.severity === "critica");
  if (critical) return critical.label;
  return items.map((i) => i.label).join(" · ");
}
