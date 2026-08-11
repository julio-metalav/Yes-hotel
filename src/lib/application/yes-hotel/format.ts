import type { ReservationOperationalPlan } from "./types.ts";

function formatWindow(plan: ReservationOperationalPlan): string {
  if (!plan.window) {
    return "n/a";
  }

  return `${plan.window.validFrom.toISOString()} -> ${plan.window.validTo.toISOString()} (${plan.window.source})`;
}

function formatActions(plan: ReservationOperationalPlan): string {
  if (plan.actions.length === 0) {
    return "nenhuma";
  }

  return plan.actions
    .map((action) => `${action.action}:${action.target.targetCode}`)
    .join(", ");
}

function formatNotes(plan: ReservationOperationalPlan): string {
  if (plan.notes.length === 0) {
    return "nenhuma";
  }

  return plan.notes.join(" | ");
}

export function formatOperationalPlanForConsole(
  plan: ReservationOperationalPlan,
): string {
  return [
    `evento: ${plan.eventType}`,
    `reserva: ${plan.summary.reservationId}`,
    `hospede: ${plan.summary.guestMainName}`,
    `apartamento: ${plan.summary.apartmentCode}`,
    `bloco: ${plan.summary.blockCode}`,
    `status: ${plan.summary.status}`,
    `validade: ${formatWindow(plan)}`,
    `acoes: ${formatActions(plan)}`,
    `notas: ${formatNotes(plan)}`,
  ].join("\n");
}
