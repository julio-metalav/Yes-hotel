/**
 * Normaliza detail HITS mock → SyncedReservation.
 * Delega ao normalizer compartilhado (hits/normalize-hits-detail-to-synced).
 */

import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import { normalizeHitsDetailToSynced } from "../hits/normalize-hits-detail-to-synced.ts";
import type { HitsMockReservationDetail } from "./types.ts";

export function normalizeHitsMockDetailToSynced(
  detail: HitsMockReservationDetail,
  syncedAt: string | null = null,
): SyncedReservation {
  return normalizeHitsDetailToSynced(
    detail as unknown as Record<string, unknown>,
    syncedAt,
  );
}
