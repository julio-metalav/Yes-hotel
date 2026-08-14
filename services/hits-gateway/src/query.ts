/**
 * Query allowlist da listagem — nomes e enums do HitsClient / Swagger V1.
 * Qualquer outro parâmetro é ignorado (nunca vira path/URL no HITS).
 */

import type { HitsReservationSearchParams } from "../../../src/lib/integrations/hits/types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGRATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SIZE = 100;

export type QueryParseOk<T> = { ok: true; value: T };
export type QueryParseErr = { ok: false; code: "bad_request"; message: string };
export type QueryParseResult<T> = QueryParseOk<T> | QueryParseErr;

function asSingle(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return String(value[0] ?? "").trim() || undefined;
  }
  const s = String(value).trim();
  return s || undefined;
}

function pick(
  query: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const v = asSingle(query[name]);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function parseReservationListQuery(
  query: Record<string, unknown>,
): QueryParseResult<HitsReservationSearchParams> {
  const params: HitsReservationSearchParams = {};

  const typeRaw = pick(query, ["Type"]);
  if (typeRaw !== undefined) {
    if (!/^[012]$/.test(typeRaw)) {
      return { ok: false, code: "bad_request", message: "Type inválido (0|1|2)." };
    }
    params.type = Number(typeRaw) as 0 | 1 | 2;
  }

  const statusRaw = pick(query, ["Status"]);
  if (statusRaw !== undefined) {
    if (!/^[1234]$/.test(statusRaw)) {
      return { ok: false, code: "bad_request", message: "Status inválido (1|2|3|4)." };
    }
    params.status = Number(statusRaw) as 1 | 2 | 3 | 4;
  }

  const initialDate = pick(query, ["InitialDate"]);
  if (initialDate !== undefined) {
    if (!DATE_RE.test(initialDate)) {
      return { ok: false, code: "bad_request", message: "InitialDate inválida." };
    }
    params.initialDate = initialDate;
  }

  const finalDate = pick(query, ["FinalDate"]);
  if (finalDate !== undefined) {
    if (!DATE_RE.test(finalDate)) {
      return { ok: false, code: "bad_request", message: "FinalDate inválida." };
    }
    params.finalDate = finalDate;
  }

  const integrationId = pick(query, ["ReservationIntegrationId"]);
  if (integrationId !== undefined) {
    if (!INTEGRATION_ID_RE.test(integrationId)) {
      return { ok: false, code: "bad_request", message: "ReservationIntegrationId inválido." };
    }
    params.reservationIntegrationId = integrationId;
  }

  const pageRaw = pick(query, ["Page"]);
  if (pageRaw !== undefined) {
    if (!/^\d+$/.test(pageRaw)) {
      return { ok: false, code: "bad_request", message: "Page inválido." };
    }
    params.page = Number(pageRaw);
  }

  const sizeRaw = pick(query, ["Size"]);
  if (sizeRaw !== undefined) {
    if (!/^\d+$/.test(sizeRaw)) {
      return { ok: false, code: "bad_request", message: "Size inválido." };
    }
    const size = Number(sizeRaw);
    if (size < 1) {
      return { ok: false, code: "bad_request", message: "Size inválido." };
    }
    params.size = Math.min(size, MAX_SIZE);
  }

  return { ok: true, value: params };
}

export function parseReservationId(raw: string | undefined): QueryParseResult<string> {
  const id = String(raw ?? "").trim();
  if (!id) {
    return { ok: false, code: "bad_request", message: "id de reserva obrigatório." };
  }
  if (!RESERVATION_ID_RE.test(id)) {
    return { ok: false, code: "bad_request", message: "id de reserva inválido." };
  }
  return { ok: true, value: id };
}
