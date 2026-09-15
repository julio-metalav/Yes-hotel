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

/**
 * A listagem HITS não aceita busca sem critério: `Type` é o que dá sentido ao
 * intervalo de datas (0 = data de check-in, 1 = inclusão, 2 = atualização —
 * docs/YES_HOTEL_CONTRATO_TECNICO_HITS_V1.md §6.1). Sem Type e sem janela, o
 * HITS responde 400 e o gateway devolve hits_bad_request.
 *
 * Type=0 é o que a tela de chegadas quer: reservas por data de entrada.
 */
export const HITS_LIST_TYPE_CHECKIN_DATE = 0;
/** Valores aceitos pelo contrato HITS (docs/YES_HOTEL_CONTRATO_TECNICO_HITS_V1.md §6.1). */
export const HITS_LIST_TYPES = [0, 1, 2] as const;
export const HITS_LIST_STATUSES = [1, 2, 3, 4] as const;
/**
 * `Status` é obrigatório: omitido, o HITS faz bind para 0 (fora do enum) e
 * responde 400 `The field Status is invalid.`
 * 1=Confirmed, 2=Canceled, 3=Processed, 4=Blocked
 * (docs/YES_HOTEL_CONTRATO_TECNICO_HITS_V1.md §6.1).
 */
export const HITS_LIST_STATUS_CONFIRMED = 1;
/** Janela default quando o chamador não informa datas. */
export const HITS_LIST_DEFAULT_WINDOW_DAYS = 30;
/** Paginação do HITS é 1-based (docs/YES_HOTEL_PLANO_TESTE_AUTENTICADO_HITS_V1.md §5.3). */
export const HITS_LIST_FIRST_PAGE = 1;
/** Limites defensivos: a listagem nunca vira laço infinito nem varredura do universo. */
export const HITS_LIST_MAX_PAGES = 10;
/**
 * Teto de reservas por leitura. Cada reserva custa um GET de detalhe, e o
 * gateway limita a 60 req/min — este teto é o que mantém o fan-out abaixo disso.
 */
export const HITS_LIST_MAX_RESERVATIONS = 50;

/**
 * Hosts de produção conhecidos. Continuam recusados enquanto o ambiente for
 * sandbox — falar com produção a partir do sandbox é erro grave, não conveniência.
 * Em `HITS_ENVIRONMENT=production` com a trava liberada, deixam de ser bloqueados.
 */
export const HITS_GATEWAY_FORBIDDEN_HOSTS = ["167.172.2.24"] as const;

export type HitsEnvironment = "sandbox" | "production";

export const HITS_ENVIRONMENT_DEFAULT: HitsEnvironment = "sandbox";

/** Leitura tolera um retry de 429/5xx; nenhuma mutação existe aqui. */
const READ_MAX_RETRIES = 1;

export interface HitsGatewayReadConfig {
  /** Base absoluta sem barra final. */
  baseUrl: string;
  /** Bearer do gateway. Nunca logar; nunca enviar ao navegador. */
  token: string;
  requestTimeoutMs: number;
  enabled: boolean;
  /** Ambiente HITS alvo. Default sandbox — produção exige opt-in explícito. */
  environment: HitsEnvironment;
  /** Trava de produção: só `true` exato libera `environment=production`. */
  productionEnabled: boolean;
  /** Filtro Type da listagem. Default 0 (data de check-in). */
  reservationType: (typeof HITS_LIST_TYPES)[number];
  /** Filtro Status da listagem. Default 1 (Confirmed). */
  reservationStatus: (typeof HITS_LIST_STATUSES)[number];
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

/** Só o literal "production" muda o ambiente; qualquer outra coisa é sandbox. */
function parseEnvironment(raw: string): HitsEnvironment {
  return raw.trim().toLowerCase() === "production" ? "production" : HITS_ENVIRONMENT_DEFAULT;
}

function parseEnumOr<T extends number>(
  raw: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!raw) return fallback;
  const n = Number(raw);
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback;
}

export function getHitsGatewayReadConfig(env: HitsGatewayEnv): HitsGatewayReadConfig {
  return {
    baseUrl: read(env, "HITS_GATEWAY_URL").replace(/\/+$/, ""),
    token: read(env, "HITS_GATEWAY_TOKEN"),
    requestTimeoutMs: parseTimeoutMs(read(env, "HITS_GATEWAY_TIMEOUT_MS")),
    enabled: read(env, "HITS_GATEWAY_READ_ENABLED") === "true",
    environment: parseEnvironment(read(env, "HITS_ENVIRONMENT")),
    productionEnabled: read(env, "HITS_PRODUCTION_ENABLED") === "true",
    reservationType: parseEnumOr(
      read(env, "HITS_RESERVATION_TYPE"),
      HITS_LIST_TYPES,
      HITS_LIST_TYPE_CHECKIN_DATE,
    ),
    reservationStatus: parseEnumOr(
      read(env, "HITS_RESERVATION_STATUS"),
      HITS_LIST_STATUSES,
      HITS_LIST_STATUS_CONFIRMED,
    ),
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
        | "gateway_forbidden_host"
        | "hits_production_not_enabled";
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
  // Trava de produção: apontar o ambiente para production não basta, é preciso
  // liberar explicitamente. Sem isso, nenhuma chamada sai.
  if (config.environment === "production" && !config.productionEnabled) {
    return {
      ok: false,
      reason: "hits_production_not_enabled",
      message: "HITS_ENVIRONMENT=production exige HITS_PRODUCTION_ENABLED=true",
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
  // Em sandbox, host de produção continua recusado. Em produção liberada, não.
  if (
    config.environment !== "production" &&
    (HITS_GATEWAY_FORBIDDEN_HOSTS as readonly string[]).includes(parsed.hostname)
  ) {
    return {
      ok: false,
      reason: "gateway_forbidden_host",
      message: "Host de produção recusado em ambiente sandbox",
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
  environment: HitsEnvironment;
  production_enabled: boolean;
  reservation_type: number;
  reservation_status: number;
} {
  return {
    enabled: config.enabled,
    has_url: Boolean(config.baseUrl),
    has_token: Boolean(config.token),
    request_timeout_ms: config.requestTimeoutMs,
    environment: config.environment,
    production_enabled: config.productionEnabled,
    reservation_type: config.reservationType,
    reservation_status: config.reservationStatus,
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
  /** Status HITS (1=Confirmed, 2=Canceled, 3=Processed, 4=Blocked). Default 1. */
  status?: 1 | 2 | 3 | 4;
  /** Relógio injetável — só afeta a janela default de datas. */
  nowIso?: string;
};

export type FetchHitsSandboxReservationsResult = {
  rows: HitsSandboxReservationRow[];
  /** Primeira página consultada. */
  page: number;
  size: number;
  /** Quantas páginas de listagem foram efetivamente buscadas. */
  pages_fetched: number;
  /** Por que a paginação parou — diagnóstico, sem PII. */
  stopped_reason:
    | "last_page"
    | "empty_page"
    | "max_pages"
    | "max_reservations"
    | "explicit_ids";
  /** Detalhes que falharam individualmente — sem PII, só id e código. */
  failed: Array<{ external_reservation_id: string; code: string }>;
};

function clampPage(page: number | undefined): number {
  if (page == null || !Number.isFinite(page) || page < HITS_LIST_FIRST_PAGE) {
    return HITS_LIST_FIRST_PAGE;
  }
  return Math.floor(page);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Janela default: a partir de hoje, `HITS_LIST_DEFAULT_WINDOW_DAYS` à frente.
 * Só é usada quando o chamador não informou nenhuma das duas datas.
 */
export function defaultListWindow(nowIso?: string): { from: string; to: string } {
  const today = (nowIso ? new Date(nowIso) : new Date()).toISOString().slice(0, 10);
  return { from: today, to: addDaysYmd(today, HITS_LIST_DEFAULT_WINDOW_DAYS) };
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

  const ids: string[] = [];
  const seenIds = new Set<string>();
  let pagesFetched = 0;
  let stoppedReason: FetchHitsSandboxReservationsResult["stopped_reason"] = "last_page";

  if (input.reservationIds && input.reservationIds.length > 0) {
    stoppedReason = "explicit_ids";
    for (const raw of input.reservationIds) {
      const id = String(raw).trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
      if (ids.length >= size) break;
    }
  } else {
    // Type + janela são obrigatórios na prática: sem eles o HITS devolve 400.
    const window = defaultListWindow(input.nowIso);
    const initialDate = input.dateFrom || window.from;
    const finalDate = input.dateTo || window.to;

    // Sequencial de propósito: o gateway limita a 60 req/min e cada reserva
    // ainda custa um GET de detalhe. Paralelizar aqui produz 429.
    for (let offset = 0; offset < HITS_LIST_MAX_PAGES; offset += 1) {
      const currentPage = page + offset;
      const qs = new URLSearchParams();
      // Filtros vêm da config (env), com os defaults atuais preservados.
      // O override por chamada continua tendo precedência.
      qs.set("Type", String(config.reservationType));
      qs.set("Status", String(input.status ?? config.reservationStatus));
      qs.set("InitialDate", initialDate);
      qs.set("FinalDate", finalDate);
      qs.set("Page", String(currentPage));
      qs.set("Size", String(size));

      const listRes = await transport.request({
        method: "GET",
        url: `${config.baseUrl}/v1/reservations?${qs.toString()}`,
        headers,
        timeoutMs: config.requestTimeoutMs,
        maxRetries: READ_MAX_RETRIES,
      });
      pagesFetched += 1;

      const items = extractGatewayListItems(listRes.body);
      let hitCap = false;
      for (const summary of items) {
        const id = String(summary?.idReservation ?? "").trim();
        // Dedupe entre páginas: o HITS pode repetir item se algo mudar durante a varredura.
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        ids.push(id);
        if (ids.length >= HITS_LIST_MAX_RESERVATIONS) {
          hitCap = true;
          break;
        }
      }

      if (hitCap) {
        stoppedReason = "max_reservations";
        break;
      }
      if (items.length === 0) {
        stoppedReason = "empty_page";
        break;
      }
      // Página incompleta = última página.
      if (items.length < size) {
        stoppedReason = "last_page";
        break;
      }
      if (offset === HITS_LIST_MAX_PAGES - 1) {
        stoppedReason = "max_pages";
      }
    }
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

  return { rows, page, size, pages_fetched: pagesFetched, stopped_reason: stoppedReason, failed };
}
