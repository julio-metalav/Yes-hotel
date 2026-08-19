/**
 * Fixtures sintéticas HITS — sem dados reais de hóspedes/reservas.
 */

import type {
  HitsAccessSecret,
  HitsAccessToken,
  HitsCheckInResult,
  HitsGuestListResponse,
  HitsProperty,
  HitsReservationDetails,
  HitsReservationSummary,
} from "./types";

export const HITS_FIXTURE_PROPERTY_ID = "00000000-0000-4000-8000-000000000002";
export const HITS_FIXTURE_RESERVATION_ID = "900001";

export const fixtureAuthorizeApproved: HitsAccessToken = {
  token: "synthetic-hits-token-not-real",
  party: "SYNTHETIC-PARTY",
};

export const fixtureAuthorizeRejected = {
  httpStatus: 401,
  body: {
    title: "Unauthorized",
    detail: "Shared access secret rejected (synthetic).",
  },
};

export const fixtureAccessSecret: HitsAccessSecret = {
  secret: "synthetic-shared-secret-not-real",
  propertyId: HITS_FIXTURE_PROPERTY_ID,
  scopes: ["WebCheckIn"],
};

export const fixtureProperties: HitsProperty[] = [
  {
    propertyId: HITS_FIXTURE_PROPERTY_ID,
    propertyCode: 2,
    name: "Yes Hotel (synthetic fixture)",
    tenantName: "synthetic-tenant",
  },
];

export const fixtureYesHotelProperty: HitsProperty = fixtureProperties[0]!;

export const fixtureReservationSummary: HitsReservationSummary = {
  idReservation: Number(HITS_FIXTURE_RESERVATION_ID),
  name: "Hóspede Sintético Homolog",
  mail: "sintetico@example.invalid",
  phone: "+5500000000000",
  checkIn: "2026-08-10T13:00:00",
  checkOut: "2026-08-12T11:00:00",
  status: 1,
  main: true,
};

export const fixtureReservationsList: HitsReservationSummary[] = [
  fixtureReservationSummary,
  {
    idReservation: 900002,
    name: "Segundo Sintético",
    mail: "segundo@example.invalid",
    checkIn: "2026-08-11T13:00:00",
    checkOut: "2026-08-13T11:00:00",
    status: 1,
  },
];

export const fixtureReservationDetails: HitsReservationDetails = {
  idReservation: Number(HITS_FIXTURE_RESERVATION_ID),
  contactName: "Hóspede Sintético Homolog",
  contact1: "+5500000000000",
  contact2: "sintetico@example.invalid",
  dateAdd: "2026-08-01T10:00:00Z",
  dateUp: "2026-08-03T10:00:00Z",
  rooms: [
    {
      idRoom: 2,
      code: "02",
      checkIn: "2026-08-10T13:00:00",
      checkOut: "2026-08-12T11:00:00",
      status: 1,
      pax: 1,
    },
  ],
  guests: [
    {
      idEntity: 1,
      name: "Hóspede Sintético Homolog",
      main: true,
      contactMail: "sintetico@example.invalid",
      contactPhone: "+5500000000000",
    },
  ],
};

export const fixtureGuestsList: HitsGuestListResponse = [
  {
    idEntity: 1,
    name: "Hóspede Sintético Homolog",
    contactMail: "sintetico@example.invalid",
    main: true,
    documentType: "CPF",
    docCpfCnpjPassport: "00000000000",
  },
];

export const fixtureReservationNotFound = {
  httpStatus: 404,
  body: { title: "Not Found", detail: "Reservation not found (synthetic)." },
};

export const fixtureReservationAlreadyCheckedIn: HitsReservationDetails = {
  ...fixtureReservationDetails,
  rooms: [
    {
      ...(fixtureReservationDetails.rooms?.[0] ?? {}),
      status: 3,
      code: "02",
    },
  ],
};

export const fixtureCheckInApproved: HitsCheckInResult = {
  folioId: 70001,
  roomCode: "02",
};

export const fixtureCheckInDuplicate = {
  httpStatus: 409,
  body: {
    title: "Conflict",
    detail: "Reservation already checked in (synthetic).",
  },
};

export const fixtureForbidden = {
  httpStatus: 403,
  body: { title: "Forbidden", detail: "Insufficient permission (synthetic)." },
};

export const fixtureRateLimit = {
  httpStatus: 429,
  headers: { "retry-after": "1" },
  body: { title: "Too Many Requests", detail: "Rate limited (synthetic)." },
};

export const fixtureServerError = {
  httpStatus: 500,
  body: { title: "Server Error", detail: "Synthetic upstream failure." },
};

export const fixtureInvalidJsonRaw = "{not-json";

export const fixtureTimeout = {
  name: "AbortError",
  message: "The operation was aborted",
};

/** Fetch mock roteado por path para testes sem rede. */
export function createHitsFixtureFetch(scenario: string = "happy"): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (scenario === "timeout") {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    if (scenario === "invalid_json") {
      return new Response(fixtureInvalidJsonRaw, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/Authorize") && method === "POST") {
      if (scenario === "authorize_rejected") {
        return jsonResponse(fixtureAuthorizeRejected.httpStatus, fixtureAuthorizeRejected.body);
      }
      return jsonResponse(200, fixtureAuthorizeApproved);
    }

    if (url.includes("/api/HealthCheck")) {
      return jsonResponse(200, { status: "Healthy", synthetic: true });
    }

    if (url.includes("/Datashare/Properties")) {
      if (scenario === "forbidden") return jsonResponse(403, fixtureForbidden.body);
      return jsonResponse(200, fixtureProperties);
    }

    if (url.includes("/Datashare/WebCheckinOut/Reservations") && !url.includes("/Reservation/")) {
      return jsonResponse(200, fixtureReservationsList);
    }

    if (url.includes("/Datashare/WebCheckinOut/Reservation/")) {
      if (scenario === "not_found") {
        return jsonResponse(404, fixtureReservationNotFound.body);
      }
      if (scenario === "already_checked_in") {
        return jsonResponse(200, fixtureReservationAlreadyCheckedIn);
      }
      return jsonResponse(200, fixtureReservationDetails);
    }

    if (url.includes("/Datashare/RevenueManagement/Guests") && method === "GET") {
      return jsonResponse(200, fixtureGuestsList);
    }

    if (url.includes("/CheckIn") && method === "POST") {
      if (scenario === "checkin_duplicate") {
        return jsonResponse(409, fixtureCheckInDuplicate.body);
      }
      if (scenario === "rate_limit") {
        return new Response(JSON.stringify(fixtureRateLimit.body), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": fixtureRateLimit.headers["retry-after"]!,
          },
        });
      }
      if (scenario === "server_error") {
        return jsonResponse(500, fixtureServerError.body);
      }
      return jsonResponse(200, fixtureCheckInApproved);
    }

    return jsonResponse(404, { title: "Not Found", detail: `No fixture for ${method} ${url}` });
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
