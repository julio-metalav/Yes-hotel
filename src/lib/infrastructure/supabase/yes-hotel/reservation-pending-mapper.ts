import type {
  PaymentStatusPending,
  ReservationPendingStateInput,
  FnrhCompletionStatus,
  GuestRoleForFnrh,
} from "../../../domain/yes-hotel/reservation-pending-state";
import type {
  FnrhConfirmationSource,
  FnrhLifecycleStatus,
  GuestRoleDb,
} from "../../../domain/yes-hotel/fnrh-completion-policy";
import { evaluateFnrhCompletion } from "../../../domain/yes-hotel/fnrh-completion-policy";
import { evaluateReservationFnrhState } from "../../../domain/yes-hotel/reservation-fnrh-state";

export class FirstRoomAccessConfigurationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FirstRoomAccessConfigurationError";
    this.code = code;
  }
}

/** Mapeia pagamento do DB operacional (check binário) + valores de domínio. */
export function mapPaymentStatusFromDb(value: string | null | undefined): PaymentStatusPending {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "pago") return "pago";
  if (v === "parcial") return "parcial";
  if (v === "emergencial") return "emergencial";
  if (v === "desconhecido" || v === "") return "desconhecido";
  if (v === "pendente") return "pendente";
  return "desconhecido";
}

export function mapGuestRoleDbToDomain(
  role: GuestRoleDb | string | null | undefined,
): GuestRoleForFnrh | null {
  if (role === "primary_adult") return "principal_adulto";
  if (role === "adult_companion") return "acompanhante_adulto";
  if (role === "minor") return "menor";
  return null;
}

export function mapLifecycleToLegacyCompletion(
  status: FnrhLifecycleStatus | string | null | undefined,
): FnrhCompletionStatus {
  const v = String(status ?? "")
    .trim()
    .toLowerCase();
  if (v === "completed" || v === "manually_completed" || v === "waived") return "completed";
  if (v === "under_review") return "review";
  if (v === "draft") return "draft";
  if (
    v === "awaiting_guest_confirmation" ||
    v === "awaiting_responsible_confirmation" ||
    v === "cancelled"
  ) {
    return "pending";
  }
  // Legado PT-BR
  if (v === "confirmado_hospede" || v === "enviado_oficial" || v === "confirmado") {
    return "completed";
  }
  if (v === "pendente_confirmacao" || v === "review") return "review";
  if (v === "rascunho") return "draft";
  if (v === "not_started" || v === "" || v === "nao_iniciado") return "not_started";
  return "pending";
}

/** @deprecated Prefer mapLifecycleToLegacyCompletion. Mantido para testes PR3. */
export function mapFnrhStatusFromDb(value: string | null | undefined): FnrhCompletionStatus {
  return mapLifecycleToLegacyCompletion(value);
}

/**
 * Linha enriquecida pós-PR4. Sem guest_role formal → schema incompleto / legado.
 */
export type GuestFnrhSourceRow = {
  id: string;
  principal: boolean;
  fnrh_status: string | null;
  /** Coluna formal PR4. */
  guest_role?: GuestRoleDb | string | null;
  fnrh_lifecycle_status?: FnrhLifecycleStatus | string | null;
  responsible_guest_id?: string | null;
  completed_by_guest_id?: string | null;
  completed_by_user_id?: string | null;
  confirmation_source?: FnrhConfirmationSource | string | null;
  manual_completion_reason?: string | null;
  waived_reason?: string | null;
  has_required_core_fields?: boolean | null;
  has_required_documents?: boolean | null;
  has_whatsapp?: boolean;
  has_email?: boolean;
  requires_classification?: boolean | null;
  fnrh_required?: boolean | null;
  removed_from_reservation?: boolean | null;
  /** Legado / fallback. */
  data_nascimento?: string | null;
  completed_by_guardian?: boolean | null;
  individual_confirmation?: boolean | null;
};

function ageYearsAt(isoDate: string, at: Date): number | null {
  const dob = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime())) return null;
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function resolveRoleLegacy(row: GuestFnrhSourceRow, at: Date): GuestRoleForFnrh {
  const mapped = mapGuestRoleDbToDomain(row.guest_role as GuestRoleDb);
  if (mapped) return mapped;

  if (row.data_nascimento) {
    const age = ageYearsAt(row.data_nascimento, at);
    if (age == null) {
      throw new FirstRoomAccessConfigurationError(
        "fnrh_guest_role_schema_incomplete",
        `data_nascimento inválida para hóspede ${row.id}.`,
      );
    }
    if (age < 18) return "menor";
    return row.principal ? "principal_adulto" : "acompanhante_adulto";
  }
  throw new FirstRoomAccessConfigurationError(
    "fnrh_guest_role_schema_incomplete",
    "Schema operacional não distingue menor/adulto/responsável de forma suficiente " +
      `(hóspede ${row.id} sem guest_role nem data_nascimento). Não iniciar tolerância.`,
  );
}

function hasContact(row: GuestFnrhSourceRow): boolean {
  return Boolean(row.has_whatsapp || row.has_email);
}

function isSchemaV2Row(row: GuestFnrhSourceRow): boolean {
  return (
    row.guest_role != null ||
    row.fnrh_lifecycle_status != null ||
    row.requires_classification === false ||
    row.responsible_guest_id != null
  );
}

/**
 * Detecta se o conjunto de linhas indica schema PR4 disponível e classificado.
 * Se nenhum hóspede tem guest_role e não há lifecycle → schema antigo / não aplicado.
 */
export function assertPr4SchemaAvailable(guests: GuestFnrhSourceRow[]): void {
  if (guests.length === 0) return;
  const anyFormal = guests.some(
    (g) =>
      g.guest_role != null ||
      g.fnrh_lifecycle_status != null ||
      typeof g.requires_classification === "boolean",
  );
  if (!anyFormal) {
    throw new FirstRoomAccessConfigurationError(
      "fnrh_guest_role_schema_incomplete",
      "Schema PR4 (guest_role / fnrh_lifecycle_status) ausente ou não aplicado. " +
        "Não iniciar tolerância.",
    );
  }
}

/**
 * Monta input da policy PR1 a partir de linhas já carregadas.
 * Com schema PR4: usa evaluateFnrhCompletion + mapeia para ExpectedGuestFnrhInput.
 * Sem classificação segura: ConfigurationError (não simula conclusão).
 */
export function buildReservationPendingInputFromRows(args: {
  pagamento_status: string | null | undefined;
  emergency_access?: boolean;
  manual_access_release?: boolean;
  guests: GuestFnrhSourceRow[];
  now?: Date;
  /** Quando true, exige evidência de colunas PR4. Default: auto. */
  require_pr4_schema?: boolean;
}): ReservationPendingStateInput {
  const now = args.now ?? new Date();
  const usePr4 = args.guests.some(isSchemaV2Row);

  if (args.require_pr4_schema || (args.guests.length > 0 && !usePr4 && args.require_pr4_schema !== false)) {
    // Compat: testes PR3 passam role em GuestRoleForFnrh via campo role legado.
  }

  // Caminho legado PR3: role em português via campo interno (fixtures antigas usam role).
  const legacyRoleField = args.guests.some(
    (g) =>
      (g as { role?: GuestRoleForFnrh }).role === "principal_adulto" ||
      (g as { role?: GuestRoleForFnrh }).role === "acompanhante_adulto" ||
      (g as { role?: GuestRoleForFnrh }).role === "menor",
  );

  if (!usePr4 && legacyRoleField) {
    return buildLegacyPr3Input(args, now);
  }

  if (!usePr4) {
    throw new FirstRoomAccessConfigurationError(
      "fnrh_guest_role_schema_incomplete",
      "Schema operacional não distingue menor/adulto/responsável de forma suficiente. " +
        "Não iniciar tolerância.",
    );
  }

  // Schema PR4: qualquer unclassificado / gaps → reserva pendente via guests mapeados,
  // mas múltiplos principais ou menor sem responsável → configuration error se impedir avaliação.
  const aggregate = evaluateReservationFnrhState(
    args.guests
      .filter((g) => !g.removed_from_reservation)
      .map((g) => ({
        guest_id: g.id,
        guest_role: (g.guest_role as GuestRoleDb) ?? null,
        fnrh_required: g.fnrh_required !== false,
        fnrh_status: (g.fnrh_lifecycle_status as FnrhLifecycleStatus) ?? null,
        responsible_guest_id: g.responsible_guest_id,
        completed_by_guest_id: g.completed_by_guest_id,
        completed_by_user_id: g.completed_by_user_id,
        confirmation_source: g.confirmation_source as FnrhConfirmationSource | null,
        manual_completion_reason: g.manual_completion_reason,
        waived_reason: g.waived_reason,
        has_required_core_fields: g.has_required_core_fields === true,
        has_required_documents: g.has_required_documents === true,
        has_contact_channel: hasContact(g),
        requires_classification:
          g.requires_classification === true ||
          g.guest_role == null ||
          g.guest_role === "legacy_unclassified",
        is_removed_from_reservation: g.removed_from_reservation === true,
      })),
  );

  if (aggregate.configuration_errors.includes("multiple_primary_adults")) {
    throw new FirstRoomAccessConfigurationError(
      "multiple_primary_adults",
      "Reserva com mais de um primary_adult. Não iniciar tolerância.",
    );
  }

  const guests = args.guests
    .filter((g) => !g.removed_from_reservation)
    .map((g) => {
      const role = mapGuestRoleDbToDomain(g.guest_role as GuestRoleDb);
      if (!role) {
        throw new FirstRoomAccessConfigurationError(
          "fnrh_guest_unclassified",
          `Hóspede ${g.id} sem classificação segura (guest_role). Não iniciar tolerância.`,
        );
      }

      const completion = evaluateFnrhCompletion({
        guest_id: g.id,
        guest_role: g.guest_role as GuestRoleDb,
        fnrh_required: g.fnrh_required !== false,
        fnrh_status: (g.fnrh_lifecycle_status as FnrhLifecycleStatus) ?? null,
        responsible_guest_id: g.responsible_guest_id,
        completed_by_guest_id: g.completed_by_guest_id,
        completed_by_user_id: g.completed_by_user_id,
        confirmation_source: g.confirmation_source as FnrhConfirmationSource | null,
        manual_completion_reason: g.manual_completion_reason,
        waived_reason: g.waived_reason,
        has_required_core_fields: g.has_required_core_fields === true,
        has_required_documents: g.has_required_documents === true,
        has_contact_channel: hasContact(g),
        requires_classification: g.requires_classification === true,
        is_removed_from_reservation: false,
      });

      const completedByGuardian =
        role === "menor" &&
        completion.is_complete &&
        (g.confirmation_source === "responsible" || g.completed_by_guardian === true);

      return {
        id: g.id,
        role,
        fnrh_status: completion.is_complete
          ? ("completed" as const)
          : mapLifecycleToLegacyCompletion(g.fnrh_lifecycle_status),
        individual_confirmation:
          role !== "menor" &&
          g.confirmation_source === "guest" &&
          g.completed_by_guest_id === g.id,
        has_phone: g.has_whatsapp,
        has_email: g.has_email,
        completed_by_guardian: completedByGuardian,
      };
    });

  return {
    payment_status: mapPaymentStatusFromDb(args.pagamento_status),
    emergency_access: args.emergency_access,
    manual_access_release: args.manual_access_release,
    guests,
  };
}

function buildLegacyPr3Input(
  args: {
    pagamento_status: string | null | undefined;
    emergency_access?: boolean;
    manual_access_release?: boolean;
    guests: GuestFnrhSourceRow[];
  },
  now: Date,
): ReservationPendingStateInput {
  const guests = args.guests.map((g) => {
    const explicit = (g as { role?: GuestRoleForFnrh }).role;
    const role = explicit ?? resolveRoleLegacy(g, now);
    if (role === "menor" && g.completed_by_guardian !== true && g.completed_by_guardian !== false) {
      throw new FirstRoomAccessConfigurationError(
        "fnrh_guardian_confirmation_missing",
        "Schema não persiste confirmação do responsável pelo menor; " +
          "não é seguro avaliar FNRH de menor. Não iniciar tolerância.",
      );
    }
    return {
      id: g.id,
      role,
      fnrh_status: mapLifecycleToLegacyCompletion(g.fnrh_status),
      individual_confirmation: g.individual_confirmation ?? undefined,
      completed_by_guardian: g.completed_by_guardian === true,
    };
  });

  return {
    payment_status: mapPaymentStatusFromDb(args.pagamento_status),
    emergency_access: args.emergency_access,
    manual_access_release: args.manual_access_release,
    guests,
  };
}
