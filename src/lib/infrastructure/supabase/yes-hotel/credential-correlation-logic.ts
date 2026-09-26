import type { CorrelatedRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import {
  hotelCivilYmdFromUtcMs,
  startOfHotelCivilDayUtcMs,
} from "../../../domain/yes-hotel/hotel-timezone.ts";
import { constantTimeEqual } from "../../../integrations/ttlock/access-ingest/constant-time.ts";
import { classifyLogicalDestination } from "../../../integrations/ttlock/access-ingest/lock-type.ts";

/** Candidato já carregado do banco (sem I/O). */
export type CorrelationCandidate = {
  credential_item_id: string;
  credential_id: string;
  reservation_id: string;
  logical_destination: string;
  lock_id: number;
  remote_keyboard_pwd_id: number | null;
  status_provisionamento: string;
  credential_status: string;
  codigo_credencial: string | null;
  valido_de: string | null;
  valido_ate: string | null;
};

function uncorrelatedUnknown(): CorrelatedRoomAccessResult {
  return { correlated: false, within_reservation_window: false };
}

/** Lock reconhecido como apartamento, mas sem match de credencial/senha. */
function uncorrelatedApartment(): CorrelatedRoomAccessResult {
  return {
    correlated: false,
    within_reservation_window: false,
    lock_type: "apartamento",
  };
}

function ambiguousApartment(): CorrelatedRoomAccessResult {
  return {
    correlated: false,
    ambiguous: true,
    within_reservation_window: false,
    lock_type: "apartamento",
  };
}

export function withinCredentialWindow(
  occurredAt: string,
  validFrom: string | null | undefined,
  validUntil: string | null | undefined,
): boolean {
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return false;
  const from = Date.parse(String(validFrom ?? ""));
  const until = Date.parse(String(validUntil ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(until)) return false;
  return t >= from && t <= until;
}

/**
 * Correlação pura sobre candidatos já filtrados por lockId.
 * Usada pelo adapter Supabase e pelos testes de fixture.
 *
 * Com keyboardPwd presente: exige match em codigo_credencial (fail-closed).
 * Sem keyboardPwd: só aceita se houver exatamente 1 candidato apto ativo.
 */
export function correlateApartmentPasscodeCandidates(input: {
  candidates: CorrelationCandidate[];
  occurred_at: string;
  keyboard_pwd_id?: number;
  ephemeral_keyboard_pwd?: string;
}): CorrelatedRoomAccessResult {
  const inactive = new Set(["revogada", "falhou"]);

  const apartmentRows = input.candidates.filter(
    (row) => classifyLogicalDestination(row.logical_destination) === "apartamento",
  );
  const lockIsApartment = apartmentRows.length > 0;

  let matched = apartmentRows.filter((row) => {
    if (row.status_provisionamento !== "provisionado") return false;
    if (inactive.has(String(row.credential_status ?? "").toLowerCase())) return false;
    if (!row.reservation_id) return false;
    return true;
  });

  if (matched.length === 0) {
    return lockIsApartment ? uncorrelatedApartment() : uncorrelatedUnknown();
  }

  if (input.keyboard_pwd_id != null) {
    const byRemote = matched.filter(
      (r) =>
        r.remote_keyboard_pwd_id != null &&
        Number(r.remote_keyboard_pwd_id) === Number(input.keyboard_pwd_id),
    );
    if (byRemote.length === 1) matched = byRemote;
    else if (byRemote.length > 1) return ambiguousApartment();
    // 0 by remote: mantém matched (ainda pode resolver por senha)
  }

  const pwd = input.ephemeral_keyboard_pwd;
  if (pwd) {
    const pwdMatches = matched.filter((r) => {
      if (!r.codigo_credencial) return false;
      return constantTimeEqual(String(r.codigo_credencial), String(pwd));
    });
    if (pwdMatches.length === 0) return uncorrelatedApartment();
    if (pwdMatches.length > 1) return ambiguousApartment();
    matched = pwdMatches;
  } else if (matched.length > 1) {
    return ambiguousApartment();
  }

  if (matched.length !== 1) {
    return matched.length > 1 ? ambiguousApartment() : uncorrelatedApartment();
  }

  const hit = matched[0]!;
  const windowOk =
    withinCredentialWindow(input.occurred_at, hit.valido_de, hit.valido_ate) ||
    sameArrivalDayBeforeValidity(input.occurred_at, hit.valido_de, hit.valido_ate);
  if (!windowOk) {
    // A senha É desta credencial, mas fora da janela dela.
    // Não reatribuir a outra reserva.
    return {
      ...uncorrelatedApartment(),
      diagnostic: "fora_da_validade_da_credencial",
    };
  }

  return {
    correlated: true,
    reservation_id: hit.reservation_id,
    credential_id: hit.credential_id,
    credential_item_id: hit.credential_item_id,
    logical_destination: hit.logical_destination,
    lock_type: "apartamento",
    within_reservation_window: true,
    keyboard_pwd_id:
      hit.remote_keyboard_pwd_id != null ? Number(hit.remote_keyboard_pwd_id) : undefined,
    original_valid_from: hit.valido_de ?? undefined,
    original_valid_until: hit.valido_ate ?? undefined,
  };
}

/** Reserva já carregada do banco para o fallback de senha fora do fluxo Yes. */
export type LiberatedStayCandidate = {
  reservation_id: string;
  credential_id: string;
  credential_item_id: string;
  logical_destination: string;
  lock_id: number;
  remote_keyboard_pwd_id: number | null;
  status_provisionamento: string;
  credential_status: string;
  valido_de: string | null;
  valido_ate: string | null;
  acesso_liberado: boolean;
  status_reserva: string;
  check_in_previsto: string;
  check_out_previsto: string;
};

/**
 * PIN desta credencial, no dia civil de valido_de, antes das 13h.
 * A fechadura pode abrir de manhã; isso não reatribui outro dia nem outra reserva.
 */
function sameArrivalDayBeforeValidity(
  occurredAt: string,
  validFrom: string | null | undefined,
  validUntil: string | null | undefined,
): boolean {
  const t = Date.parse(occurredAt);
  const from = Date.parse(String(validFrom ?? ""));
  const until = Date.parse(String(validUntil ?? ""));
  if (!Number.isFinite(t) || !Number.isFinite(from) || !Number.isFinite(until)) return false;
  if (t >= from || t > until) return false;
  if (hotelCivilYmdFromUtcMs(t) !== hotelCivilYmdFromUtcMs(from)) return false;
  return t >= startOfHotelCivilDayUtcMs(from);
}

function ymd(value: string): string {
  return String(value ?? "").trim().slice(0, 10);
}

function stayCovers(civilDate: string, checkIn: string, checkOut: string): boolean {
  const inn = ymd(checkIn);
  const out = ymd(checkOut);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inn) || !/^\d{4}-\d{2}-\d{2}$/.test(out)) return false;
  return inn <= civilDate && civilDate <= out;
}

/**
 * Senha que não casa com `codigo_credencial` só vincula se houver
 * exatamente uma reserva ativa, com acesso liberado, cuja estadia cobre
 * o dia civil do evento e cuja credencial do apartamento está provisionada.
 * Qualquer empate permanece sem vínculo.
 */
export function associateUnlockToUniqueLiberatedStay(input: {
  civil_date: string;
  candidates: LiberatedStayCandidate[];
}): CorrelatedRoomAccessResult {
  const civil = ymd(input.civil_date);
  const apartmentRows = input.candidates.filter(
    (row) => classifyLogicalDestination(row.logical_destination) === "apartamento",
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civil) || apartmentRows.length === 0) {
    return uncorrelatedUnknown();
  }

  const inStay = apartmentRows.filter(
    (row) =>
      String(row.status_reserva ?? "").trim().toLowerCase() === "ativa" &&
      stayCovers(civil, row.check_in_previsto, row.check_out_previsto),
  );
  if (inStay.length === 0) {
    return { ...uncorrelatedApartment(), diagnostic: "sem_reserva_associavel" };
  }

  const liberated = inStay.filter((row) => row.acesso_liberado === true);
  const reservationIds = [...new Set(liberated.map((row) => row.reservation_id))];
  if (reservationIds.length === 0) {
    return { ...uncorrelatedApartment(), diagnostic: "acesso_nao_liberado" };
  }
  if (reservationIds.length > 1) {
    return { ...ambiguousApartment(), diagnostic: "reserva_ambigua" };
  }

  const reservationId = reservationIds[0]!;
  const rows = liberated.filter((row) => row.reservation_id === reservationId);
  const credentialIds = [...new Set(rows.map((row) => row.credential_id))];
  if (credentialIds.length !== 1) {
    return { ...ambiguousApartment(), diagnostic: "reserva_ambigua" };
  }

  const inactive = new Set(["revogada", "falhou"]);
  const provisioned = rows.filter(
    (row) =>
      row.status_provisionamento === "provisionado" &&
      !inactive.has(String(row.credential_status ?? "").toLowerCase()),
  );
  if (provisioned.length === 0) {
    return { ...uncorrelatedApartment(), diagnostic: "sem_credencial_provisionada" };
  }

  const hit = provisioned[0]!;
  if (!hit.valido_de || !hit.valido_ate) {
    return { ...uncorrelatedApartment(), diagnostic: "credencial_sem_validade" };
  }

  return {
    correlated: true,
    reservation_id: hit.reservation_id,
    credential_id: hit.credential_id,
    credential_item_id: hit.credential_item_id,
    logical_destination: hit.logical_destination,
    lock_type: "apartamento",
    within_reservation_window: true,
    keyboard_pwd_id:
      hit.remote_keyboard_pwd_id != null ? Number(hit.remote_keyboard_pwd_id) : undefined,
    original_valid_from: hit.valido_de,
    original_valid_until: hit.valido_ate,
  };
}

/** Fallback só quando a senha não pertence a nenhuma credencial conhecida. */
export function shouldApplyLiberatedStayFallback(
  strict: CorrelatedRoomAccessResult,
  hadEphemeralPwd: boolean,
): boolean {
  if (!hadEphemeralPwd) return false;
  if (strict.correlated || strict.ambiguous) return false;
  if (strict.diagnostic === "fora_da_validade_da_credencial") return false;
  return true;
}
