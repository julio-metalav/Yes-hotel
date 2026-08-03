/**
 * Policy pura: conclusão de FNRH por papel (adulto principal, acompanhante, menor).
 * Sem I/O. Facial/placa nunca bloqueiam. Contato próprio do menor nunca bloqueia.
 */

export type GuestRoleDb =
  | "primary_adult"
  | "adult_companion"
  | "minor"
  | "legacy_unclassified";

export type FnrhLifecycleStatus =
  | "draft"
  | "awaiting_guest_confirmation"
  | "awaiting_responsible_confirmation"
  | "under_review"
  | "completed"
  | "manually_completed"
  | "waived"
  | "cancelled";

export type FnrhConfirmationSource =
  | "guest"
  | "responsible"
  | "reception"
  | "migration";

export type FnrhCompletionPolicyInput = {
  guest_id: string;
  guest_role: GuestRoleDb | null;
  fnrh_required: boolean;
  fnrh_status: FnrhLifecycleStatus | null;
  responsible_guest_id?: string | null;
  completed_by_guest_id?: string | null;
  completed_by_user_id?: string | null;
  confirmation_source?: FnrhConfirmationSource | null;
  manual_completion_reason?: string | null;
  waived_reason?: string | null;
  has_required_core_fields: boolean;
  has_required_documents: boolean;
  has_contact_channel: boolean;
  /** Facial/placa informativos — nunca geram pendência. */
  has_facial?: boolean;
  has_placa?: boolean;
  is_removed_from_reservation?: boolean;
  requires_classification?: boolean;
};

export type FnrhCompletionPolicyResult = {
  is_required: boolean;
  is_complete: boolean;
  is_pending: boolean;
  pending_reasons: string[];
  validation_errors: string[];
};

const PENDING_STATUSES = new Set<FnrhLifecycleStatus>([
  "draft",
  "awaiting_guest_confirmation",
  "awaiting_responsible_confirmation",
  "under_review",
]);

const COMPLETE_STATUSES = new Set<FnrhLifecycleStatus>([
  "completed",
  "manually_completed",
  "waived",
]);

function hasText(value: string | null | undefined): boolean {
  return Boolean(value && String(value).trim());
}

/**
 * Avalia se a ficha de um hóspede está completa/pendente segundo o papel.
 */
export function evaluateFnrhCompletion(
  input: FnrhCompletionPolicyInput,
): FnrhCompletionPolicyResult {
  const pending_reasons: string[] = [];
  const validation_errors: string[] = [];

  if (input.is_removed_from_reservation) {
    return {
      is_required: false,
      is_complete: false,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  if (
    input.guest_role == null ||
    input.guest_role === "legacy_unclassified" ||
    input.requires_classification
  ) {
    validation_errors.push("guest_unclassified");
    return {
      is_required: true,
      is_complete: false,
      is_pending: true,
      pending_reasons: ["guest_unclassified"],
      validation_errors,
    };
  }

  if (!input.fnrh_required) {
    return {
      is_required: false,
      is_complete: false,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  const status = input.fnrh_status;

  if (status == null) {
    pending_reasons.push("fnrh_status_missing");
    return {
      is_required: true,
      is_complete: false,
      is_pending: true,
      pending_reasons,
      validation_errors,
    };
  }

  if (status === "cancelled") {
    return {
      is_required: false,
      is_complete: false,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  if (status === "waived") {
    if (!hasText(input.waived_reason) || !input.completed_by_user_id) {
      validation_errors.push("waived_without_audit");
      return {
        is_required: true,
        is_complete: false,
        is_pending: true,
        pending_reasons: ["waived_without_audit"],
        validation_errors,
      };
    }
    return {
      is_required: true,
      is_complete: true,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  if (status === "manually_completed") {
    if (!hasText(input.manual_completion_reason) || !input.completed_by_user_id) {
      validation_errors.push("manual_completion_without_audit");
      return {
        is_required: true,
        is_complete: false,
        is_pending: true,
        pending_reasons: ["manual_completion_without_audit"],
        validation_errors,
      };
    }
    return {
      is_required: true,
      is_complete: true,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  // Papel-específico
  if (input.guest_role === "minor") {
    if (!input.responsible_guest_id) {
      validation_errors.push("minor_without_responsible");
      pending_reasons.push("minor_without_responsible");
    }
    if (!input.has_required_core_fields) {
      pending_reasons.push("missing_core_fields");
    }
    if (!input.has_required_documents) {
      pending_reasons.push("missing_required_documents");
    }
    // Contato próprio / facial / placa / confirmação individual do menor: NUNCA pendência.
  } else if (input.guest_role === "adult_companion") {
    if (!input.has_contact_channel) {
      pending_reasons.push("missing_contact_channel");
      validation_errors.push("adult_companion_requires_contact");
    }
    if (!input.has_required_core_fields) {
      pending_reasons.push("missing_core_fields");
    }
    if (!input.has_required_documents) {
      pending_reasons.push("missing_required_documents");
    }
  } else if (input.guest_role === "primary_adult") {
    if (!input.has_required_core_fields) {
      pending_reasons.push("missing_core_fields");
    }
    if (!input.has_required_documents) {
      pending_reasons.push("missing_required_documents");
    }
  }

  if (PENDING_STATUSES.has(status)) {
    if (status === "draft") pending_reasons.push("draft");
    if (status === "awaiting_guest_confirmation") {
      pending_reasons.push("awaiting_guest_confirmation");
    }
    if (status === "awaiting_responsible_confirmation") {
      pending_reasons.push("awaiting_responsible_confirmation");
    }
    if (status === "under_review") pending_reasons.push("under_review");

    return {
      is_required: true,
      is_complete: false,
      is_pending: true,
      pending_reasons: [...new Set(pending_reasons)],
      validation_errors: [...new Set(validation_errors)],
    };
  }

  if (status === "completed") {
    // Preenchimento pelo principal NÃO basta para acompanhante: exige confirmation_source=guest
    // e completed_by_guest_id = próprio (ou migration com ator explícito).
    if (input.guest_role === "adult_companion" || input.guest_role === "primary_adult") {
      if (input.confirmation_source === "responsible") {
        // Responsável confirmando ficha de adulto = inválido
        validation_errors.push("adult_confirmed_by_responsible");
        pending_reasons.push("awaiting_guest_confirmation");
      } else if (
        input.confirmation_source !== "guest" &&
        input.confirmation_source !== "migration" &&
        input.confirmation_source !== "reception"
      ) {
        pending_reasons.push("awaiting_guest_confirmation");
      } else if (
        input.confirmation_source === "guest" &&
        input.completed_by_guest_id !== input.guest_id
      ) {
        validation_errors.push("adult_confirmation_actor_mismatch");
        pending_reasons.push("awaiting_guest_confirmation");
      }
      // confirmation_source=reception sem manual_completion → inválido para "completed"
      if (input.confirmation_source === "reception") {
        validation_errors.push("reception_must_use_manually_completed");
        pending_reasons.push("manual_completion_without_audit");
      }
    }

    if (input.guest_role === "minor") {
      if (input.confirmation_source !== "responsible" && input.confirmation_source !== "migration") {
        pending_reasons.push("awaiting_responsible_confirmation");
      }
      if (
        input.confirmation_source === "responsible" &&
        (!input.completed_by_guest_id ||
          (input.responsible_guest_id &&
            input.completed_by_guest_id !== input.responsible_guest_id))
      ) {
        validation_errors.push("minor_confirmed_by_non_responsible");
        pending_reasons.push("awaiting_responsible_confirmation");
      }
      if (input.confirmation_source === "guest") {
        validation_errors.push("minor_cannot_self_confirm");
        pending_reasons.push("awaiting_responsible_confirmation");
      }
    }

    const stillPending = pending_reasons.length > 0 || validation_errors.length > 0;
    if (stillPending) {
      return {
        is_required: true,
        is_complete: false,
        is_pending: true,
        pending_reasons: [...new Set(pending_reasons)],
        validation_errors: [...new Set(validation_errors)],
      };
    }

    if (!input.has_required_core_fields) {
      pending_reasons.push("missing_core_fields");
    }
    if (!input.has_required_documents) {
      pending_reasons.push("missing_required_documents");
    }
    if (pending_reasons.length > 0) {
      return {
        is_required: true,
        is_complete: false,
        is_pending: true,
        pending_reasons: [...new Set(pending_reasons)],
        validation_errors: [...new Set(validation_errors)],
      };
    }

    return {
      is_required: true,
      is_complete: true,
      is_pending: false,
      pending_reasons: [],
      validation_errors: [],
    };
  }

  // Status desconhecido
  validation_errors.push("unknown_fnrh_status");
  return {
    is_required: true,
    is_complete: false,
    is_pending: true,
    pending_reasons: ["unknown_fnrh_status"],
    validation_errors,
  };
}

export function isFnrhLifecyclePending(status: FnrhLifecycleStatus | null | undefined): boolean {
  if (!status) return true;
  return PENDING_STATUSES.has(status);
}

export function isFnrhLifecycleComplete(status: FnrhLifecycleStatus | null | undefined): boolean {
  if (!status) return false;
  return COMPLETE_STATUSES.has(status);
}
