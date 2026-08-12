/**
 * Adapter simulado HITS — ReservationSourcePort.
 * Sem rede. Paginação em memória. Não ativa HITS real.
 */

import type {
  ReservationSourceListParams,
  ReservationSourcePage,
  ReservationSourcePort,
  SyncedReservation,
} from "../../domain/yes-hotel/synced-reservation.ts";
import {
  applyHitsMockSyncScenario,
  buildHitsMockSyncCatalog,
  type HitsMockSyncScenario,
} from "./fixtures/sync-catalog.ts";
import { normalizeHitsMockDetailToSynced } from "./normalize-synced-reservation.ts";
import type { HitsMockReservationDetail } from "./types.ts";

export type HitsMockReservationSourceOptions = {
  pageSize?: number;
  scenario?: HitsMockSyncScenario;
  catalog?: HitsMockReservationDetail[];
  nowIso?: string;
};

export class HitsMockReservationSource implements ReservationSourcePort {
  private readonly pageSize: number;
  private catalog: HitsMockReservationDetail[];
  private readonly nowIso: string;

  constructor(options: HitsMockReservationSourceOptions = {}) {
    this.pageSize = Math.max(1, options.pageSize ?? 3);
    this.nowIso = options.nowIso ?? new Date().toISOString();
    const base = options.catalog ?? buildHitsMockSyncCatalog();
    this.catalog = applyHitsMockSyncScenario(base, options.scenario ?? "baseline");
  }

  setScenario(scenario: HitsMockSyncScenario): void {
    const base = buildHitsMockSyncCatalog();
    this.catalog = applyHitsMockSyncScenario(base, scenario);
  }

  replaceCatalog(catalog: HitsMockReservationDetail[]): void {
    this.catalog = catalog.map((c) => ({ ...c }));
  }

  async listReservations(
    params: ReservationSourceListParams = {},
  ): Promise<ReservationSourcePage> {
    const pageSize = Math.max(1, params.pageSize ?? this.pageSize);
    const page = params.cursor ? Math.max(0, Number(params.cursor) || 0) : 0;
    let filtered = this.catalog;
    const from = params.dateFrom ? String(params.dateFrom).trim() : "";
    const to = params.dateTo ? String(params.dateTo).trim() : "";
    if (from || to) {
      filtered = this.catalog.filter((d) => {
        const rooms = Array.isArray(d.rooms) ? d.rooms : [];
        const checkIn = String((rooms[0] as { checkIn?: string } | undefined)?.checkIn ?? "").slice(
          0,
          10,
        );
        if (!checkIn) return false;
        if (from && checkIn < from) return false;
        if (to && checkIn > to) return false;
        return true;
      });
    }
    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    const items = slice.map((d) => normalizeHitsMockDetailToSynced(d, this.nowIso));
    const hasMore = start + pageSize < filtered.length;
    return {
      items,
      page,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : null,
    };
  }

  async getReservation(externalReservationId: string): Promise<SyncedReservation | null> {
    const found = this.catalog.find(
      (r) => String(r.idReservation) === String(externalReservationId),
    );
    if (!found) return null;
    return normalizeHitsMockDetailToSynced(found, this.nowIso);
  }
}
