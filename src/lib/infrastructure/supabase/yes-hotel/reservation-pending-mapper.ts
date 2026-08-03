import type { PaymentStatusPending, ReservationPendingStateInput } from "../../../domain/yes-hotel/reservation-pending-state";
import type {
  FnrhCompletionStatus,
  GuestRoleForFnrh,
} from "../../../domain/yes-hotel/reservation-pending-state";

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
  // Valores não reconhecidos = pendente (seguro).
  return "desconhecido";
}

export function mapFnrhStatusFromDb(value: string | null | undefined): FnrhCompletionStatus {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    v === "confirmado_hospede" ||
    v === "enviado_oficial" ||
    v === "completed" ||
    v === "confirmado"
  ) {
    return "completed";
  }
  if (v === "pendente_confirmacao" || v === "review") return "review";
  if (v === "rascunho" || v === "draft") return "draft";
  if (v === "not_started" || v === "" || v === "nao_iniciado") return "not_started";
  return "pending";
}

/**
 * Guest enriquecido para mapeamento. Campos role / completed_by_guardian /
 * data_nascimento NÃO existem de forma completa em operacional_hospedes hoje.
 * Sem evidência suficiente → erro de configuração (não inventar).
 */
export type GuestFnrhSourceRow = {
  id: string;
  principal: boolean;
  /** Status FNRH do hóspede (fnrh_hospedes.status ou operacional). */
  fnrh_status: string | null;
  /** Opcional futuro / fixture. */
  role?: GuestRoleForFnrh | null;
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

function resolveRole(row: GuestFnrhSourceRow, at: Date): GuestRoleForFnrh {
  if (row.role === "principal_adulto" || row.role === "acompanhante_adulto" || row.role === "menor") {
    return row.role;
  }
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
      `(hóspede ${row.id} sem role nem data_nascimento). Não iniciar tolerância.`,
  );
}

/**
 * Monta input da policy PR1 a partir de linhas já carregadas.
 * Para menores exige completed_by_guardian explícito — ausente no schema atual.
 */
export function buildReservationPendingInputFromRows(args: {
  pagamento_status: string | null | undefined;
  emergency_access?: boolean;
  manual_access_release?: boolean;
  guests: GuestFnrhSourceRow[];
  now?: Date;
}): ReservationPendingStateInput {
  const now = args.now ?? new Date();
  const guests = args.guests.map((g) => {
    const role = resolveRole(g, now);
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
      fnrh_status: mapFnrhStatusFromDb(g.fnrh_status),
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
