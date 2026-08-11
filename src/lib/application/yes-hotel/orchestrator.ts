import {
  buildCancellationPlan,
  buildProvisionPlan,
  buildRoomChangePlan,
  generateOperationalCredentialPreview,
  resolveBlockCode,
} from "../../domain/yes-hotel.ts";
import type { ReservationAdjustment } from "../../domain/yes-hotel.ts";
import type {
  ReservationOperationalContext,
  ReservationOperationalPlan,
  ReservationOperationalSummary,
} from "./types.ts";

function buildSummary(
  context: ReservationOperationalContext,
): ReservationOperationalSummary {
  const reservation = context.currentReservation;

  return {
    reservationId: reservation.reservationId,
    guestMainName: reservation.guestMainName,
    apartmentCode: reservation.apartmentCode,
    blockCode: resolveBlockCode(reservation.apartmentCode),
    status: reservation.status,
    eventType: context.eventType,
  };
}

function buildCredentialPreview(
  context: ReservationOperationalContext,
): ReservationOperationalPlan["credentialPreview"] {
  if (context.eventType === "reservation_canceled") {
    return undefined;
  }

  return generateOperationalCredentialPreview(
    context.currentReservation.reservationId,
    context.currentReservation.apartmentCode,
  );
}

function buildAdjustmentNotes(adjustment?: ReservationAdjustment): string[] {
  if (!adjustment) {
    return [];
  }

  const notes: string[] = [];

  if (adjustment.earlyCheckInAt) {
    notes.push(
      `Ajuste manual aplicado: early check-in em ${String(adjustment.earlyCheckInAt)}.`,
    );
  }

  if (adjustment.lateCheckOutAt) {
    notes.push(
      `Ajuste manual aplicado: late check-out em ${String(adjustment.lateCheckOutAt)}.`,
    );
  }

  return notes;
}

export function buildReservationOperationalPlan(
  context: ReservationOperationalContext,
): ReservationOperationalPlan {
  const summary = buildSummary(context);
  const credentialPreview = buildCredentialPreview(context);
  const adjustmentNotes = buildAdjustmentNotes(context.adjustment);

  switch (context.eventType) {
    case "reservation_created": {
      const plan = buildProvisionPlan(
        context.currentReservation,
        context.adjustment,
      );

      return {
        eventType: context.eventType,
        reservationId: plan.reservationId,
        summary,
        window: plan.window,
        credentialPreview,
        targets: plan.targets,
        actions: plan.actions,
        notes: [
          "Reserva criada; gerar plano inicial de provisionamento.",
          "Credencial principal prevista para apartamento e portoes do bloco.",
          ...adjustmentNotes,
        ],
      };
    }

    case "reservation_updated": {
      const plan = buildProvisionPlan(
        context.currentReservation,
        context.adjustment,
      );

      return {
        eventType: context.eventType,
        reservationId: plan.reservationId,
        summary,
        window: plan.window,
        credentialPreview,
        targets: plan.targets,
        actions: plan.actions,
        notes: [
          "Reserva atualizada; comportamento atual faz reavaliacao conservadora da reserva corrente.",
          "Nao ha deteccao estrutural fina nesta camada; eventuais diferencas devem ser classificadas antes como room_changed ou manual_adjustment.",
          ...adjustmentNotes,
        ],
      };
    }

    case "reservation_canceled": {
      const plan = buildCancellationPlan(
        context.currentReservation,
        context.adjustment,
      );

      return {
        eventType: context.eventType,
        reservationId: plan.reservationId,
        summary,
        window: plan.window,
        targets: plan.targets,
        actions: plan.actions,
        notes: [
          "Reserva cancelada; revogar acessos operacionais da credencial principal.",
          "Preview de credencial omitido por se tratar de fluxo de revogacao.",
          ...adjustmentNotes,
        ],
      };
    }

    case "room_changed": {
      if (!context.previousReservation) {
        throw new Error(
          "Evento room_changed exige previousReservation no contexto operacional.",
        );
      }

      const plan = buildRoomChangePlan(
        context.previousReservation,
        context.currentReservation,
        context.adjustment,
      );

      return {
        eventType: context.eventType,
        reservationId: plan.reservationId,
        summary,
        window: plan.window,
        credentialPreview,
        targets: [...plan.previousTargets, ...plan.nextTargets],
        actions: plan.actions,
        notes: [
          `Troca de apartamento detectada: ${plan.previousApartmentCode} -> ${plan.nextApartmentCode}.`,
          plan.blockChanged
            ? "Houve troca de bloco; portoes antigos devem ser revogados e os novos provisionados."
            : "Nao houve troca de bloco; a revisao dos targets ainda e refletida pelo novo conjunto de acessos.",
          ...adjustmentNotes,
        ],
      };
    }

    case "manual_adjustment": {
      const plan = buildProvisionPlan(
        context.currentReservation,
        context.adjustment,
      );

      return {
        eventType: context.eventType,
        reservationId: plan.reservationId,
        summary,
        window: plan.window,
        credentialPreview,
        targets: plan.targets,
        actions: plan.actions,
        notes: [
          "Ajuste manual aplicado; janela da credencial recalculada para a reserva atual.",
          "Targets operacionais mantidos conforme apartamento e bloco correntes.",
          ...adjustmentNotes,
        ],
      };
    }
  }
}
