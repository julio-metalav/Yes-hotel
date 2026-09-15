/**
 * Leitura de reservas do HITS pelo gateway — somente GET.
 *
 * Existe porque o adapter real (`hits-reservation-source.ts`) fala direto com
 * api.hitspms.net e exige o shared secret no runtime. Aqui o único caminho de
 * rede é o gateway, e o Bearer do gateway é montado somente no backend.
 *
 * Reusa o transporte e o normalizador HITS já existentes — sem paginação,
 * persistência ou escrita.
 */

import { HitsError } from "./errors.ts";
import { normalizeHitsDetailToSynced } from "./normalize-hits-detail-to-synced.ts";
import {
  createHitsTransport,
  type HitsFetch,
  type HitsTransport,
} from "./transport.ts";
import type {
  HitsReservationDetails,
  HitsReservationListResponse,
  HitsReservationSummary,
} from "./types.ts";
import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";

export const HITS_GATEWAY_DEFAULT_TIMEOUT_MS = 12_000;
export const HITS_GATEWAY_DEFAULT_PAGE_SIZE = 20;
export const HITS_GATEWAY_MAX_PAGE_SIZE = 100;

/** Host de produção — proibido nesta etapa. */
export const HITS_GATEWAY_FORBIDDEN_HOSTS = ["167.172.2.24"] as const;

/** Leitura tolera um retry de 429/5xx; nenhuma mutação existe aqui. */
const READ_MAX_RETRIES = 1;

export interface HitsGatewayReadConfig {
  /** Base absoluta sem barra final. */
  baseUrl: string;
  /** Bearer do gateway. Nunca logar; nunca enviar ao navegador. */
  token: string;
  requestTimeoutMs: number;
  enabled: boolean;
}

export type HitsGatewayEnv = Record<string, string | undefined>;

function read(env: HitsGatewayEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

function parseTimeoutMs(raw: string): number {
  if (!raw) return HITS_GATEWAY_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000 || n > 120_000) {
    return HITS_GATEWAY_DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(n);
}

export function getHitsGatewayReadConfig(env: HitsGatewayEnv): HitsGatewayReadConfig {
  return {
    baseUrl: read(env, "HITS_GATEWAY_URL").replace(/\/+$/, ""),
    token: read(env, "HITS_GATEWAY_TOKEN"),
    requestTimeoutMs: parseTimeoutMs(read(env, "HITS_GATEWAY_TIMEOUT_MS")),
    enabled: read(env, "HITS_GATEWAY_READ_ENABLED") === "true",
  };
}

export type HitsGatewayReadReadiness =
  | { ok: true; config: HitsGatewayReadConfig }
  | {
      ok: false;
      reason:
        | "gateway_read_disabled"
        | "gateway_missing_url"
        | "gateway_missing_token"
        | "gateway_invalid_url"
        | "gateway_forbidden_host";
      message: string;
    };

/** Gate sem rede — testável. O host de produção é recusado de propósito. */
export function assertHitsGatewayReadReady(
  config: HitsGatewayReadConfig,
): HitsGatewayReadReadiness {
  if (!config.enabled) {
    return {
      ok: false,
      reason: "gateway_read_disabled",
      message: "HITS_GATEWAY_READ_ENABLED != true",
    };
  }
  if (!config.baseUrl) {
    return { ok: false, reason: "gateway_missing_url", message: "HITS_GATEWAY_URL ausente" };
  }
  if (!config.token) {
    return {
      ok: false,
      reason: "gateway_missing_token",
      message: "HITS_GATEWAY_TOKEN ausente",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    return {
      ok: false,
      reason: "gateway_invalid_url",
      message: "HITS_GATEWAY_URL não é URL absoluta",
    };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      reason: "gateway_invalid_url",
      message: "HITS_GATEWAY_URL deve usar http(s)",
    };
  }
  if ((HITS_GATEWAY_FORBIDDEN_HOSTS as readonly string[]).includes(parsed.hostname)) {
    return {
      ok: false,
      reason: "gateway_forbidden_host",
      message: "Host de produção proibido nesta etapa",
    };
  }

  return { ok: true, config };
}

/** Status sem segredo — seguro para log e para body de resposta. */
export function hitsGatewayReadStatus(config: HitsGatewayReadConfig): {
  enabled: boolean;
  has_url: boolean;
  has_token: boolean;
  request_timeout_ms: number;
} {
  return {
    enabled: config.enabled,
    has_url: Boolean(config.baseUrl),
    has_token: Boolean(config.token),
    request_timeout_ms: config.requestTimeoutMs,
  };
}

/** Linha exibida na tela. Sem contato, documento ou payload bruto. */
export type HitsSandboxReservationRow = {
  external_reservation_id: string;
  apartamento: string;
  hospede_principal: string;
  check_in: string;
  check_out: string;
  status_reserva: "ativa" | "cancelada";
  total_hospedes: number;
};

export function toHitsSandboxRow(
  reservation: SyncedReservation,
): HitsSandboxReservationRow {
  return {
    external_reservation_id: reservation.externalReservationId,
    apartamento: reservation.apartmentCode || "",
    hospede_principal: reservation.mainGuestName || "",
    check_in: reservation.checkIn || "",
    check_out: reservation.checkOut || "",
    status_reserva: reservation.reservationStatus,
    total_hospedes: Math.max(1, Number(reservation.totalGuests) || 1),
  };
}

export function extractGatewayListItems(
  data: HitsReservationListResponse | unknown,
): HitsReservationSummary[] {
  if (Array.isArray(data)) return data as HitsReservationSummary[];
  if (data && typeof data === "object") {
    const row = data as { data?: unknown; items?: unknown; results?: unknown };
    if (Array.isArray(row.data)) return row.data as HitsReservationSummary[];
    if (Array.isArray(row.items)) return row.items as HitsReservationSummary[];
    if (Array.isArray(row.results)) return row.results as HitsReservationSummary[];
  }
  return [];
}

export type FetchHitsSandboxReservationsInput = {
  config: HitsGatewayReadConfig;
  fetchImpl?: HitsFetch;
  transport?: HitsTransport;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  size?: number;
  /** Ids explícitos: pula a listagem e busca só esses detalhes. */
  reservationIds?: string[];
};

export type FetchHitsSandboxReservationsResult = {
  rows: HitsSandboxReservationRow[];
  page: number;
  size: number;
  /** Detalhes que falharam individualmente — sem PII, só id e código. */
  failed: Array<{ external_reservation_id: string; code: string }>;
};

function clampPage(page: number | undefined): number {
  if (page == null || !Number.isFinite(page) || page < 0) return 0;
  return Math.floor(page);
}

function clampSize(size: number | undefined): number {
  if (size == null || !Number.isFinite(size) || size < 1) {
    return HITS_GATEWAY_DEFAULT_PAGE_SIZE;
  }
  return Math.min(HITS_GATEWAY_MAX_PAGE_SIZE, Math.floor(size));
}

function gatewayHeaders(config: HitsGatewayReadConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
  };
}

/**
 * GET /v1/reservations (ou ids explícitos) + GET /v1/reservations/:id por item.
 * O detalhe é necessário: a lista não traz apartamento nem hóspedes.
 */
export async function fetchHitsSandboxReservations(
  input: FetchHitsSandboxReservationsInput,
): Promise<FetchHitsSandboxReservationsResult> {
  const gate = assertHitsGatewayReadReady(input.config);
  if (!gate.ok) {
    throw new HitsError({
      code:
        gate.reason === "gateway_read_disabled" ? "integration_disabled" : "missing_secret",
      message: gate.message,
      httpStatus: null,
      retryable: false,
    });
  }

  const config = gate.config;
  const transport = input.transport ?? createHitsTransport(input.fetchImpl ?? fetch);
  const page = clampPage(input.page);
  const size = clampSize(input.size);
  const headers = gatewayHeaders(config);

  let ids: string[];
  if (input.reservationIds && input.reservationIds.length > 0) {
    ids = [
      ...new Set(input.reservationIds.map((id) => String(id).trim()).filter(Boolean)),
    ].slice(0, size);
  } else {
    const qs = new URLSearchParams();
    if (input.dateFrom) qs.set("InitialDate", input.dateFrom);
    if (input.dateTo) qs.set("FinalDate", input.dateTo);
    qs.set("Page", String(page));
    qs.set("Size", String(size));

    const listRes = await transport.request({
      method: "GET",
      url: `${config.baseUrl}/v1/reservations?${qs.toString()}`,
      headers,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: READ_MAX_RETRIES,
    });

    ids = [
      ...new Set(
        extractGatewayListItems(listRes.body)
          .map((s) => String(s?.idReservation ?? "").trim())
          .filter(Boolean),
      ),
    ].slice(0, size);
  }

  const rows: HitsSandboxReservationRow[] = [];
  const failed: FetchHitsSandboxReservationsResult["failed"] = [];

  for (const id of ids) {
    try {
      const detailRes = await transport.request({
        method: "GET",
        url: `${config.baseUrl}/v1/reservations/${encodeURIComponent(id)}`,
        headers,
        timeoutMs: config.requestTimeoutMs,
        maxRetries: READ_MAX_RETRIES,
      });
      const synced = normalizeHitsDetailToSynced(
        (detailRes.body ?? {}) as HitsReservationDetails as Record<string, unknown>,
        null,
      );
      rows.push(toHitsSandboxRow(synced));
    } catch (e) {
      failed.push({
        external_reservation_id: id,
        code: e instanceof HitsError ? e.code : "detail_failed",
      });
    }
  }

  rows.sort((a, b) => {
    if (a.check_in !== b.check_in) return a.check_in < b.check_in ? -1 : 1;
    if (a.apartamento !== b.apartamento) return a.apartamento < b.apartamento ? -1 : 1;
    return a.external_reservation_id < b.external_reservation_id ? -1 : 1;
  });

  return { rows, page, size, failed };
}
