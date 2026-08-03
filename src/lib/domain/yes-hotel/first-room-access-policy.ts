/**
 * Policy pura: reconhecimento do primeiro uso de senha na porta do apartamento.
 * Sem I/O — sem TTLock, DigiSac, Supabase ou senha em texto.
 */

/** Tipos TTLock recordType relevantes (doc Open Platform lockRecord/list). */
export const TTLOCK_RECORD_TYPE = {
  APP_UNLOCK: 1,
  GATEWAY_UNLOCK: 3,
  PASSCODE_UNLOCK: 4,
  IC_CARD_UNLOCK: 7,
  MECHANICAL_KEY: 10,
  GATEWAY_UNLOCK_ALT: 12,
  OPEN_FROM_INSIDE: 32,
  REMOTE_CONTROL: 37,
  INVALID_PASSCODE: 48,
} as const;

export type LockLogicalType = "apartamento" | "portao_externo" | "portao_interno";

/**
 * Evento de abertura já normalizado pelo adaptador de ingestão.
 * Nunca inclui senha/passcode em texto.
 */
export type NormalizedRoomAccessEvent = {
  source_event_id: string;
  occurred_at: string;
  lock_id: number;
  keyboard_pwd_id?: number;
  record_type: number;
  success: boolean;
  logical_destination?: string;
  lock_type?: LockLogicalType;
  reservation_id?: string;
  credential_id?: string;
  credential_item_id?: string;
  within_reservation_window: boolean;
  correlated: boolean;
  /** Abertura por operador/admin no app (ainda que record_type varie). */
  is_admin_operator?: boolean;
};

export type FirstRoomAccessIgnoredReason =
  | "not_passcode"
  | "unsuccessful"
  | "not_apartment"
  | "uncorrelated"
  | "outside_window"
  | "duplicate"
  | "already_started"
  | "accepted";

export type FirstRoomAccessDecision = {
  accepted: boolean;
  should_register_first_access: boolean;
  /** Sempre false aqui — a decisão de iniciar tolerância é de decideAccessGrace. */
  should_start_grace: boolean;
  ignored_reason?: FirstRoomAccessIgnoredReason;
  decision: FirstRoomAccessIgnoredReason;
};

export type FirstRoomAccessContext = {
  /** Já existe registro de primeiro acesso para esta credencial/reserva. */
  first_access_already_registered: boolean;
  /** Este source_event_id já foi processado. */
  event_already_processed?: boolean;
  /** Tolerância já foi iniciada alguma vez. */
  grace_already_started?: boolean;
};

function isPasscodeUnlock(recordType: number): boolean {
  return recordType === TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK;
}

function isApartmentLock(event: NormalizedRoomAccessEvent): boolean {
  if (event.lock_type === "apartamento") return true;
  if (event.lock_type === "portao_externo" || event.lock_type === "portao_interno") {
    return false;
  }
  const dest = String(event.logical_destination ?? "").trim().toUpperCase();
  if (dest.startsWith("APT-") || dest.startsWith("APTO-")) return true;
  if (dest.includes("GATE") || dest.includes("PORTAO") || dest.includes("PORTÃO")) {
    return false;
  }
  return false;
}

/**
 * Avalia se o evento é o primeiro uso válido de senha na porta do apartamento.
 */
export function evaluateFirstRoomAccessEvent(
  event: NormalizedRoomAccessEvent,
  context: FirstRoomAccessContext,
): FirstRoomAccessDecision {
  const reject = (reason: FirstRoomAccessIgnoredReason): FirstRoomAccessDecision => ({
    accepted: false,
    should_register_first_access: false,
    should_start_grace: false,
    ignored_reason: reason,
    decision: reason,
  });

  if (context.event_already_processed) {
    return reject("duplicate");
  }

  if (!event.success) {
    return reject("unsuccessful");
  }

  if (event.is_admin_operator) {
    return reject("not_passcode");
  }

  if (!isPasscodeUnlock(event.record_type)) {
    return reject("not_passcode");
  }

  if (!isApartmentLock(event)) {
    return reject("not_apartment");
  }

  if (!event.correlated) {
    return reject("uncorrelated");
  }

  if (!event.within_reservation_window) {
    return reject("outside_window");
  }

  if (context.first_access_already_registered || context.grace_already_started) {
    return {
      accepted: false,
      should_register_first_access: false,
      should_start_grace: false,
      ignored_reason: context.grace_already_started ? "already_started" : "duplicate",
      decision: context.grace_already_started ? "already_started" : "duplicate",
    };
  }

  return {
    accepted: true,
    should_register_first_access: true,
    should_start_grace: false,
    decision: "accepted",
  };
}

export type AccessGraceDecisionInput = {
  event_accepted: boolean;
  first_access_already_registered: boolean;
  grace_already_started: boolean;
  payment_pending: boolean;
  fnrh_pending: boolean;
  pending_reasons: string[];
  /** ISO UTC do evento de primeiro acesso. */
  occurred_at: string;
};

export type AccessGraceDecision = {
  start_grace: boolean;
  grace_started_at?: string;
  suspension_due_at?: string;
  pending_snapshot: string[];
  /** Primeiro acesso deve ser registrado mesmo sem iniciar tolerância. */
  register_first_access: boolean;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Decide se inicia tolerância de 1h após um primeiro acesso aceito.
 * Idempotente: se já iniciou, não reinicia.
 */
export function decideAccessGrace(input: AccessGraceDecisionInput): AccessGraceDecision {
  if (!input.event_accepted) {
    return {
      start_grace: false,
      pending_snapshot: [],
      register_first_access: false,
    };
  }

  if (input.grace_already_started) {
    return {
      start_grace: false,
      pending_snapshot: [],
      register_first_access: false,
    };
  }

  const register_first_access = !input.first_access_already_registered;
  const hasPending = input.payment_pending || input.fnrh_pending;

  if (!hasPending) {
    return {
      start_grace: false,
      pending_snapshot: [],
      register_first_access,
    };
  }

  const started = new Date(input.occurred_at);
  if (Number.isNaN(started.getTime())) {
    throw new Error(`occurred_at inválido: ${input.occurred_at}`);
  }

  const due = new Date(started.getTime() + ONE_HOUR_MS);
  const snapshot = [...input.pending_reasons];

  return {
    start_grace: true,
    grace_started_at: started.toISOString(),
    suspension_due_at: due.toISOString(),
    pending_snapshot: snapshot,
    register_first_access,
  };
}
