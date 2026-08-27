/**
 * Wrapper de leitura sobre o HitsClient existente.
 * Não expõe check-in nem proxy de path arbitrário.
 */

import { HitsClient, type HitsClientOptions } from "../../../src/lib/integrations/hits/client.ts";
import type { HitsConfig } from "../../../src/lib/integrations/hits/config.ts";
import type {
  HitsGuestSearchParams,
  HitsGuestsPutDto,
  HitsReservationSearchParams,
  HitsWebCheckinGuestsPostBody,
} from "../../../src/lib/integrations/hits/types.ts";

export type HitsReadClient = {
  listReservations(params: HitsReservationSearchParams): Promise<unknown>;
  getReservation(id: string): Promise<unknown>;
  listGuests?(params: HitsGuestSearchParams): Promise<unknown>;
  postReservationGuests?(
    reservationId: string,
    body: HitsWebCheckinGuestsPostBody,
  ): Promise<unknown>;
  putGuest?(body: HitsGuestsPutDto): Promise<unknown>;
};

export function createHitsReadClient(
  hitsConfig: HitsConfig,
  options: Pick<HitsClientOptions, "fetchImpl" | "debug"> = {},
): HitsReadClient {
  const client = new HitsClient({
    config: {
      ...hitsConfig,
      integrationEnabled: true,
      checkinEnabled: false,
      checkInBodyContractStatus: "unverified",
    },
    fetchImpl: options.fetchImpl,
    debug: options.debug === true,
  });

  return {
    listReservations: (params) => client.listWebCheckinReservations(params),
    getReservation: (id) => client.getWebCheckinReservation(id),
    listGuests: (params) => client.listRevenueManagementGuests(params),
    postReservationGuests: (reservationId, body) =>
      client.postWebCheckinGuests(reservationId, body),
    putGuest: (body) => client.putWebCheckinGuests(body),
  };
}
