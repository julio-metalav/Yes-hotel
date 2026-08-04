export {
  getHitsConfig,
  getHitsEnv,
  hitsConfigStatus,
  isHitsCheckInEnabled,
  isHitsIntegrationEnabled,
  HITS_DEFAULT_API_BASE_URL,
  HITS_DEFAULT_TIMEOUT_MS,
  HITS_KNOWN_SCOPES,
  type HitsConfig,
  type HitsEnv,
} from "./config";

export {
  HitsClient,
  createHitsClient,
  authorizeHits,
  listReservations,
  getReservationById,
  extractAccessToken,
  maskToken,
  type HitsClientOptions,
} from "./client";

export {
  HitsError,
  HitsApiError,
  mapStatusToCode,
  sanitizeMessage,
  sanitizeUnknown,
  assertNoSensitiveLeak,
} from "./errors";

export {
  createHitsTransport,
  mapHttpError,
  type HitsTransport,
  type HitsTransportRequest,
  type HitsTransportResponse,
  type HitsFetch,
} from "./transport";

export {
  evaluateHitsCheckInEligibility,
  type HitsCheckInEligibilityInput,
  type HitsCheckInEligibilityResult,
} from "./checkin-policy";

export * from "./types";
export * from "./fixtures";
export * from "./mapper";
export * from "./preview";
