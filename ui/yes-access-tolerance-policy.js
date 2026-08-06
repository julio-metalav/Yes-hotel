/**
 * Policy pura (browser): exceções de tolerância/suspensão.
 * Espelha src/lib/domain/yes-hotel/access-tolerance-ui.ts — só problemas.
 */
(function (global) {
  "use strict";

  function deriveAccessToleranceExceptions(input) {
    var out = [];
    var status = input.grace_status || null;
    var now = input.now_ms != null ? input.now_ms : Date.now();

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
      var due = new Date(input.suspension_due_at).getTime();
      if (Number.isFinite(due)) {
        var minutes = Math.max(0, Math.ceil((due - now) / 60000));
        out.push({
          code: "tolerancia_em_andamento",
          label:
            minutes > 0
              ? "Tolerância em andamento (" + minutes + " min)"
              : "Tolerância vencendo",
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
    return out;
  }

  function summarizeAccessToleranceAlert(input) {
    var items = deriveAccessToleranceExceptions(input);
    if (!items.length) return null;
    var critical = items.find(function (i) {
      return i.severity === "critica";
    });
    if (critical) return critical.label;
    return items
      .map(function (i) {
        return i.label;
      })
      .join(" · ");
  }

  global.YesHotelAccessTolerancePolicy = {
    deriveAccessToleranceExceptions: deriveAccessToleranceExceptions,
    summarizeAccessToleranceAlert: summarizeAccessToleranceAlert,
  };
})(typeof window !== "undefined" ? window : globalThis);
