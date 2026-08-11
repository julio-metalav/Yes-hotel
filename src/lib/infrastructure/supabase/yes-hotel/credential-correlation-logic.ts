import type { CorrelatedRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
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

function uncorrelated(): CorrelatedRoomAccessResult {
  return { correlated: false, within_reservation_window: false };
}

function ambiguous(): CorrelatedRoomAccessResult {
  return { correlated: false, ambiguous: true, within_reservation_window: false };
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
 */
export function correlateApartmentPasscodeCandidates(input: {
  candidates: CorrelationCandidate[];
  occurred_at: string;
  keyboard_pwd_id?: number;
  ephemeral_keyboard_pwd?: string;
}): CorrelatedRoomAccessResult {
  const inactive = new Set(["revogada", "falhou"]);

  let matched = input.candidates.filter((row) => {
    if (row.status_provisionamento !== "provisionado") return false;
    if (inactive.has(String(row.credential_status ?? "").toLowerCase())) return false;
    if (!row.reservation_id) return false;
    return classifyLogicalDestination(row.logical_destination) === "apartamento";
  });

  if (matched.length === 0) return uncorrelated();

  if (input.keyboard_pwd_id != null) {
    const byRemote = matched.filter(
      (r) => r.remote_keyboard_pwd_id != null && Number(r.remote_keyboard_pwd_id) === Number(input.keyboard_pwd_id),
    );
    if (byRemote.length === 1) matched = byRemote;
    else if (byRemote.length > 1) return ambiguous();
  }

  const pwd = input.ephemeral_keyboard_pwd;
  if (pwd) {
    const pwdMatches = matched.filter((r) => {
      if (!r.codigo_credencial) return false;
      return constantTimeEqual(String(r.codigo_credencial), String(pwd));
    });
    if (pwdMatches.length === 0) return uncorrelated();
    if (pwdMatches.length > 1) return ambiguous();
    matched = pwdMatches;
  } else if (matched.length > 1) {
    return ambiguous();
  }

  if (matched.length !== 1) {
    return matched.length > 1 ? ambiguous() : uncorrelated();
  }

  const hit = matched[0]!;
  const windowOk = withinCredentialWindow(input.occurred_at, hit.valido_de, hit.valido_ate);

  return {
    correlated: true,
    reservation_id: hit.reservation_id,
    credential_id: hit.credential_id,
    credential_item_id: hit.credential_item_id,
    logical_destination: hit.logical_destination,
    lock_type: "apartamento",
    within_reservation_window: windowOk,
    keyboard_pwd_id:
      hit.remote_keyboard_pwd_id != null ? Number(hit.remote_keyboard_pwd_id) : undefined,
    original_valid_from: hit.valido_de ?? undefined,
    original_valid_until: hit.valido_ate ?? undefined,
  };
}
