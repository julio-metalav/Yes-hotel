/**
 * Agregado puro: estado FNRH da reserva a partir das fichas por hóspede.
 */

import {
  evaluateFnrhCompletion,
  type FnrhCompletionPolicyInput,
  type GuestRoleDb,
} from "./fnrh-completion-policy";

export type ReservationFnrhGuestSnapshot = FnrhCompletionPolicyInput;

export type ReservationFnrhPendingGuest = {
  guest_id: string;
  guest_role: GuestRoleDb | null;
  pending_reasons: string[];
};

export type ReservationFnrhStateResult = {
  total_guests: number;
  required_fnrhs: number;
  completed_fnrhs: number;
  pending_fnrhs: number;
  under_review_fnrhs: number;
  unclassified_guests: number;
  all_required_complete: boolean;
  pending_guests: ReservationFnrhPendingGuest[];
  configuration_errors: string[];
};

const FACIAL_PLACA = new Set(["facial", "placa", "has_facial", "has_placa", "missing_facial", "missing_placa"]);

function sanitizeReasons(reasons: string[]): string[] {
  return reasons.filter((r) => !FACIAL_PLACA.has(r) && !r.includes("facial") && !r.includes("placa"));
}

/**
 * Avalia o agregado FNRH da reserva.
 * Facial/placa nunca entram em pending_reasons.
 */
export function evaluateReservationFnrhState(
  guests: ReservationFnrhGuestSnapshot[],
): ReservationFnrhStateResult {
  const configuration_errors: string[] = [];
  const pending_guests: ReservationFnrhPendingGuest[] = [];

  let required = 0;
  let completed = 0;
  let pending = 0;
  let under_review = 0;
  let unclassified = 0;

  const active = guests.filter((g) => !g.is_removed_from_reservation);
  const primaryCount = active.filter((g) => g.guest_role === "primary_adult").length;
  if (primaryCount > 1) {
    configuration_errors.push("multiple_primary_adults");
  }
  if (primaryCount === 0 && active.some((g) => g.guest_role != null && g.guest_role !== "legacy_unclassified")) {
    // Só alerta se já há classificação parcial sem principal.
    if (active.some((g) => g.guest_role === "adult_companion" || g.guest_role === "minor")) {
      configuration_errors.push("missing_primary_adult");
    }
  }

  for (const guest of guests) {
    const result = evaluateFnrhCompletion(guest);

    if (
      guest.guest_role == null ||
      guest.guest_role === "legacy_unclassified" ||
      guest.requires_classification
    ) {
      if (!guest.is_removed_from_reservation) unclassified += 1;
    }

    if (guest.fnrh_status === "under_review" && !guest.is_removed_from_reservation) {
      under_review += 1;
    }

    for (const err of result.validation_errors) {
      if (!configuration_errors.includes(err)) configuration_errors.push(err);
    }

    if (!result.is_required) continue;

    required += 1;
    if (result.is_complete) {
      completed += 1;
    } else {
      pending += 1;
      pending_guests.push({
        guest_id: guest.guest_id,
        guest_role: guest.guest_role,
        pending_reasons: sanitizeReasons(result.pending_reasons),
      });
    }
  }

  const all_required_complete =
    required > 0 &&
    pending === 0 &&
    unclassified === 0 &&
    !configuration_errors.includes("multiple_primary_adults");

  return {
    total_guests: guests.length,
    required_fnrhs: required,
    completed_fnrhs: completed,
    pending_fnrhs: pending,
    under_review_fnrhs: under_review,
    unclassified_guests: unclassified,
    all_required_complete,
    pending_guests,
    configuration_errors,
  };
}
