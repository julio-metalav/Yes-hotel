/**
 * Seleção mock|real do ReservationSourcePort para sync HITS.
 * Sem rede: gates testáveis. Real só com integração + credenciais.
 */

import type { ReservationSourcePort } from "../../domain/yes-hotel/synced-reservation.ts";
import type { ReservationSyncFlags } from "../../application/yes-hotel/reservation-sync-service.ts";
import { HitsMockReservationSource } from "../hits-mock/hits-mock-reservation-source.ts";
import { getHitsConfig, type HitsConfig } from "./config.ts";
import {
  assertHitsRealSourceReady,
  HitsReservationSource,
} from "./hits-reservation-source.ts";

export type ResolveHitsReservationSourceInput = {
  flags: ReservationSyncFlags;
  /** Override de config (testes). Em Edge, omitir = Deno.env via getHitsConfig. */
  hitsConfig?: HitsConfig;
  mockPageSize?: number;
  maxReservations?: number | null;
  nowIso?: string;
};

export type ResolveHitsReservationSourceResult =
  | {
      ok: true;
      kind: "mock" | "real";
      source: ReservationSourcePort;
    }
  | {
      ok: false;
      kind: "real";
      error:
        | "hits_real_blocked"
        | "hits_real_missing_credentials"
        | "hits_real_missing_context";
      message: string;
    };

/**
 * mode=mock → sempre mock.
 * mode=real → exige integração + credenciais; senão fail-safe (não cai em mock silencioso).
 */
export function resolveHitsReservationSource(
  input: ResolveHitsReservationSourceInput,
): ResolveHitsReservationSourceResult {
  const { flags } = input;

  if (flags.mode !== "real") {
    return {
      ok: true,
      kind: "mock",
      source: new HitsMockReservationSource({
        pageSize: input.mockPageSize ?? flags.batchSize,
        scenario: "baseline",
        nowIso: input.nowIso,
      }),
    };
  }

  if (!flags.hitsIntegrationEnabled) {
    return {
      ok: false,
      kind: "real",
      error: "hits_real_blocked",
      message: "HITS_INTEGRATION_ENABLED != true",
    };
  }

  const config = input.hitsConfig ?? getHitsConfig();
  const gate = assertHitsRealSourceReady(config);
  if (!gate.ok) {
    return {
      ok: false,
      kind: "real",
      error:
        gate.reason === "missing_credentials"
          ? "hits_real_missing_credentials"
          : gate.reason === "missing_context_headers"
            ? "hits_real_missing_context"
            : "hits_real_blocked",
      message: gate.message,
    };
  }

  return {
    ok: true,
    kind: "real",
    source: new HitsReservationSource({
      config: gate.config,
      maxReservations: input.maxReservations ?? undefined,
      nowIso: input.nowIso,
    }),
  };
}
