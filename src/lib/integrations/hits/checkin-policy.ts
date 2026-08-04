/**
 * Policy pura: elegibilidade de check-in factual no HITS.
 * Sem I/O. Pagamento/FNRH pendentes NÃO bloqueiam o check-in factual.
 * Suspensão posterior de acesso NÃO desfaz check-in (fora do escopo desta função).
 */

import type { HitsAccessMethod } from "./types";

export interface HitsCheckInEligibilityInput {
  integration_enabled: boolean;
  checkin_enabled: boolean;
  hits_reservation_id?: string;
  first_room_access_confirmed: boolean;
  access_method: HitsAccessMethod;
  already_checked_in: boolean;
  reservation_cancelled: boolean;
  reservation_closed: boolean;
  payment_pending: boolean;
  fnrh_pending: boolean;
}

export interface HitsCheckInEligibilityResult {
  allowed: boolean;
  reasons: string[];
}

export function evaluateHitsCheckInEligibility(
  input: HitsCheckInEligibilityInput,
): HitsCheckInEligibilityResult {
  const reasons: string[] = [];

  if (!input.integration_enabled) {
    reasons.push("integration_disabled");
  }
  if (!input.checkin_enabled) {
    reasons.push("checkin_disabled");
  }

  const hitsId = String(input.hits_reservation_id ?? "").trim();
  if (!hitsId) {
    reasons.push("missing_hits_reservation_id");
  }

  if (!input.first_room_access_confirmed) {
    reasons.push("first_room_access_not_confirmed");
  }

  if (input.access_method !== "room_passcode") {
    if (input.access_method === "gate_passcode") {
      reasons.push("gate_passcode_not_allowed");
    } else {
      reasons.push(`access_method_not_allowed:${input.access_method}`);
    }
  }

  if (input.already_checked_in) {
    reasons.push("already_checked_in");
  }
  if (input.reservation_cancelled) {
    reasons.push("reservation_cancelled");
  }
  if (input.reservation_closed) {
    reasons.push("reservation_closed");
  }

  // payment_pending e fnrh_pending: intencionalmente NÃO bloqueiam.

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
