/**
 * Adapter simulado HITS — ReservationSourcePort.
 * Sem rede. Paginação em memória. Não ativa HITS real.
 */

import type {
  ReservationSourceListParams,
  ReservationSourcePage,
  ReservationSourcePort,
  SyncedReservation,
} from "../../domain/yes-hotel/synced-reservation";
import {
  applyHitsMockSyncScenario,
  buildHitsMockSyncCatalog,
  type HitsMockSyncScenario,
} from "./fixtures/sync-catalog";
import { normalizeHitsMockDetailToSynced } from "./normalize-synced-reservation";
import type { HitsMockReservationDetail } from "./types";

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
    const start = page * pageSize;
    const slice = this.catalog.slice(start, start + pageSize);
    const items = slice.map((d) => normalizeHitsMockDetailToSynced(d, this.nowIso));
    const hasMore = start + pageSize < this.catalog.length;
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
