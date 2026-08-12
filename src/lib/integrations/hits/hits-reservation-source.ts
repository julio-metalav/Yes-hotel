/**
 * Adapter real HITS → ReservationSourcePort.
 * Usa HitsClient existente. Sem inventar campos.
 * Rede só quando integração ligada e credenciais presentes.
 */

import type {
  ReservationSourceListParams,
  ReservationSourcePage,
  ReservationSourcePort,
  SyncedReservation,
} from "../../domain/yes-hotel/synced-reservation.ts";
import { HitsClient, createHitsClient, type HitsClientOptions } from "./client.ts";
import { getHitsConfig, type HitsConfig } from "./config.ts";
import { HitsError } from "./errors.ts";
import { normalizeHitsDetailToSynced } from "./normalize-hits-detail-to-synced.ts";
import type { HitsReservationListResponse, HitsReservationSummary } from "./types.ts";

export type HitsReservationSourceOptions = {
  client?: HitsClient;
  clientOptions?: HitsClientOptions;
  config?: HitsConfig;
  /** Limite duro de itens por list (smoke controlado). */
  maxReservations?: number;
  /** Só lista — não usar em produção; detalhe traz saldo/hóspedes. */
  skipDetailFetch?: boolean;
  nowIso?: string;
};

function extractListItems(data: HitsReservationListResponse | unknown): HitsReservationSummary[] {
  if (Array.isArray(data)) return data as HitsReservationSummary[];
  if (data && typeof data === "object") {
    const row = data as { data?: unknown; items?: unknown; results?: unknown };
    if (Array.isArray(row.data)) return row.data as HitsReservationSummary[];
    if (Array.isArray(row.items)) return row.items as HitsReservationSummary[];
    if (Array.isArray(row.results)) return row.results as HitsReservationSummary[];
  }
  return [];
}

export function assertHitsRealSourceReady(config?: HitsConfig): {
  ok: true;
  config: HitsConfig;
} | {
  ok: false;
  reason: "integration_disabled" | "missing_credentials" | "missing_context_headers";
  message: string;
} {
  const c = config ?? getHitsConfig();
  if (!c.integrationEnabled) {
    return {
      ok: false,
      reason: "integration_disabled",
      message: "HITS_INTEGRATION_ENABLED != true",
    };
  }
  if (!c.sharedAccessSecret || !c.propertyId) {
    return {
      ok: false,
      reason: "missing_credentials",
      message: "HITS_SHARED_ACCESS_SECRET e/ou HITS_PROPERTY_ID ausentes",
    };
  }
  if (!c.tenantName || !c.propertyCode || !c.clientId) {
    return {
      ok: false,
      reason: "missing_context_headers",
      message: "HITS_TENANT_NAME / HITS_PROPERTY_CODE / HITS_CLIENT_ID ausentes",
    };
  }
  return { ok: true, config: c };
}

export class HitsReservationSource implements ReservationSourcePort {
  private readonly client: HitsClient;
  private readonly config: HitsConfig;
  private readonly maxReservations: number | null;
  private readonly skipDetailFetch: boolean;
  private readonly nowIso: string | null;

  constructor(options: HitsReservationSourceOptions = {}) {
    this.config = options.config ?? options.clientOptions?.config ?? getHitsConfig();
    this.client =
      options.client ??
      createHitsClient(options.clientOptions ?? { config: this.config });
    const max = options.maxReservations;
    this.maxReservations =
      max != null && Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
    this.skipDetailFetch = options.skipDetailFetch === true;
    this.nowIso = options.nowIso ?? null;
  }

  private assertReady(): void {
    const gate = assertHitsRealSourceReady(this.config);
    if (!gate.ok) {
      throw new HitsError({
        code:
          gate.reason === "integration_disabled"
            ? "integration_disabled"
            : gate.reason === "missing_credentials"
              ? "missing_secret"
              : "missing_context_headers",
        message: gate.message,
        httpStatus: null,
        retryable: false,
      });
    }
  }

  async listReservations(
    params: ReservationSourceListParams = {},
  ): Promise<ReservationSourcePage> {
    this.assertReady();

    const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 20));
    const page = params.cursor ? Math.max(0, Number(params.cursor) || 0) : 0;
    const hardCap = this.maxReservations;
    const requestSize =
      hardCap != null ? Math.min(pageSize, Math.max(1, hardCap)) : pageSize;

    const listBody = await this.client.listWebCheckinReservations({
      initialDate: params.dateFrom ?? undefined,
      finalDate: params.dateTo ?? undefined,
      page,
      size: requestSize,
    });
    let summaries = extractListItems(listBody);
    if (hardCap != null) {
      summaries = summaries.slice(0, hardCap);
    }

    const syncedAt = this.nowIso;
    const items: SyncedReservation[] = [];
    for (const summary of summaries) {
      const id = String(summary.idReservation ?? "").trim();
      if (!id) continue;
      if (this.skipDetailFetch) {
        items.push(
          normalizeHitsDetailToSynced(
            {
              idReservation: id,
              contactName: summary.name,
              contact1: summary.mail,
              contact2: summary.phone,
              status: summary.status,
              integrator: summary.integrator,
              reservationChannelId: summary.reservationChannelId,
              rooms: [
                {
                  checkIn: summary.checkIn,
                  checkOut: summary.checkOut,
                  code: null,
                },
              ],
              guests: [],
            },
            syncedAt,
            summary as unknown as Record<string, unknown>,
          ),
        );
        continue;
      }
      const detail = await this.client.getWebCheckinReservation(id);
      items.push(
        normalizeHitsDetailToSynced(
          detail as unknown as Record<string, unknown>,
          syncedAt,
          summary as unknown as Record<string, unknown>,
        ),
      );
    }

    // Com hardCap (smoke), não pagina além do limite.
    const hasMore = hardCap != null ? false : summaries.length >= requestSize;
    return {
      items,
      page,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : null,
    };
  }

  async getReservation(externalReservationId: string): Promise<SyncedReservation | null> {
    this.assertReady();
    const id = String(externalReservationId ?? "").trim();
    if (!id) return null;
    try {
      const detail = await this.client.getWebCheckinReservation(id);
      return normalizeHitsDetailToSynced(
        detail as unknown as Record<string, unknown>,
        this.nowIso,
      );
    } catch (e) {
      if (e instanceof HitsError && (e.code === "not_found" || e.httpStatus === 404)) {
        return null;
      }
      throw e;
    }
  }
}
