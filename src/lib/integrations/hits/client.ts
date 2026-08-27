/**
 * Cliente oficial HITS — preparado e desligado por padrão.
 * Nenhum método chama rede quando HITS_INTEGRATION_ENABLED !== "true".
 */

import {
  getHitsConfig,
  hitsConfigStatus,
  type HitsConfig,
} from "./config.ts";
import { HitsError, assertNoSensitiveLeak } from "./errors.ts";
import {
  createHitsTransport,
  type HitsFetch,
  type HitsTransport,
} from "./transport.ts";
import type {
  HitsAccessSecret,
  HitsAccessToken,
  HitsCheckInRequest,
  HitsCheckInResult,
  HitsGuestListResponse,
  HitsGuestSearchParams,
  HitsGuestsPutDto,
  HitsWebCheckinGuestsPostBody,
  HitsIntegrationStatus,
  HitsProperty,
  HitsReservationDetails,
  HitsReservationListResponse,
  HitsReservationSearchParams,
  HitsSessionToken,
  ListReservationsParams,
  HitsAuthResponse,
  HitsReservationDetail,
} from "./types.ts";
import {
  hitsWebCheckinGuestsPostPath,
  HITS_WEBCHECKIN_GUESTS_PUT_PATH,
} from "./types.ts";

export interface HitsClientOptions {
  config?: HitsConfig;
  transport?: HitsTransport;
  fetchImpl?: HitsFetch;
  /** Se true, permite logs de debug SEM secret/token. */
  debug?: boolean;
}

function buildAuthorizeBody(config: HitsConfig): HitsAccessSecret {
  return {
    secret: config.sharedAccessSecret,
    propertyId: config.propertyId,
    scopes: config.scopes.length > 0 ? config.scopes : ["WebCheckIn"],
  };
}

function parseAccessToken(body: unknown): HitsAccessToken {
  if (!body || typeof body !== "object") {
    throw new HitsError({
      code: "invalid_json",
      message: "AccessToken HITS inválido.",
      httpStatus: 200,
      retryable: false,
    });
  }
  const row = body as Record<string, unknown>;
  const token = typeof row.token === "string" ? row.token : undefined;
  const party = typeof row.party === "string" ? row.party : undefined;
  if (!token || !party) {
    throw new HitsError({
      code: "invalid_json",
      message: "AccessToken HITS sem token/party.",
      httpStatus: 200,
      retryable: false,
    });
  }
  return { token, party };
}

export class HitsClient {
  private readonly config: HitsConfig;
  private readonly transport: HitsTransport;
  private readonly debug: boolean;
  /** Token somente em memória. */
  private session: HitsSessionToken | null = null;

  constructor(options: HitsClientOptions = {}) {
    this.config = options.config ?? getHitsConfig();
    this.transport =
      options.transport ??
      createHitsTransport(options.fetchImpl ?? fetch);
    this.debug = options.debug === true;
  }

  getStatus(): HitsIntegrationStatus {
    const s = hitsConfigStatus(this.config);
    return {
      ...s,
      transport_allowed:
        s.integration_enabled &&
        s.auth_contract === "verified" &&
        s.has_shared_secret &&
        s.has_property_id,
    };
  }

  private assertIntegrationEnabled(action: string): void {
    if (!this.config.integrationEnabled) {
      throw new HitsError({
        code: "integration_disabled",
        message: `Integração HITS desligada; ${action} bloqueado.`,
        httpStatus: null,
        retryable: false,
      });
    }
  }

  private assertAuthContract(): void {
    if (this.config.authContractStatus !== "verified") {
      throw new HitsError({
        code: "auth_contract_unverified",
        message: "Contrato de autenticação HITS unverified; transporte bloqueado.",
        httpStatus: null,
        retryable: false,
      });
    }
  }

  private assertSecretAndProperty(): void {
    if (!this.config.sharedAccessSecret) {
      throw new HitsError({
        code: "missing_secret",
        message: "Shared access secret HITS ausente.",
        httpStatus: null,
        retryable: false,
      });
    }
    if (!this.config.propertyId) {
      throw new HitsError({
        code: "missing_property_id",
        message: "HITS_PROPERTY_ID ausente; operação dependente da propriedade bloqueada.",
        httpStatus: null,
        retryable: false,
      });
    }
  }

  private assertDatashareContext(): void {
    const missing: string[] = [];
    if (!this.config.tenantName) missing.push("HITS_TENANT_NAME");
    if (!this.config.propertyCode) missing.push("HITS_PROPERTY_CODE");
    if (!this.config.clientId) missing.push("HITS_CLIENT_ID");
    // partnerUserId: Swagger allowEmptyValue=true — não obrigatório aqui.
    if (missing.length > 0) {
      throw new HitsError({
        code: "missing_context_headers",
        message: `Headers de contexto HITS ausentes: ${missing.join(", ")}.`,
        httpStatus: null,
        retryable: false,
      });
    }
  }

  private baseHeaders(): Record<string, string> {
    return {
      "X-API-VERSION": this.config.apiVersion,
    };
  }

  private authenticatedHeaders(token: string): Record<string, string> {
    this.assertDatashareContext();
    return {
      ...this.baseHeaders(),
      // securitySchemes.Token = http bearer (Swagger V1)
      Authorization: `Bearer ${token}`,
      "X-API-TENANT-NAME": this.config.tenantName,
      "X-API-PROPERTY-CODE": this.config.propertyCode,
      "X-API-PARTNER-USERID": this.config.partnerUserId || "0",
      "X-API-LANGUAGE-CODE": this.config.languageCode,
      "X-Client-Id": this.config.clientId,
    };
  }

  private debugSafe(event: string, extra: Record<string, unknown> = {}): void {
    if (!this.debug) return;
    const payload = {
      event,
      ...extra,
      ts: new Date().toISOString(),
    };
    assertNoSensitiveLeak(payload, [
      this.config.sharedAccessSecret,
      this.session?.token ?? "",
    ]);
    console.debug("[hits]", JSON.stringify(payload));
  }

  /** Monta o body oficial AccessSecret (sem enviar rede). Útil para testes. */
  buildAuthorizeRequestBody(): HitsAccessSecret {
    this.assertSecretAndProperty();
    return buildAuthorizeBody(this.config);
  }

  async authorize(): Promise<HitsAccessToken> {
    this.assertIntegrationEnabled("authorize");
    this.assertAuthContract();
    this.assertSecretAndProperty();

    const body = buildAuthorizeBody(this.config);
    this.debugSafe("authorize.start", {
      path: "/Authorize",
      propertyIdPresent: Boolean(body.propertyId),
      scopes: body.scopes,
    });

    const res = await this.transport.request({
      method: "POST",
      url: `${this.config.apiBaseUrl}/Authorize`,
      headers: this.baseHeaders(),
      body,
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 1,
    });

    const token = parseAccessToken(res.body);
    this.session = {
      token: token.token,
      party: token.party,
      obtainedAtMs: Date.now(),
    };
    assertNoSensitiveLeak(
      { ok: true, party: token.party },
      [this.config.sharedAccessSecret, token.token],
    );
    this.debugSafe("authorize.success", { party: token.party });
    return token;
  }

  private async ensureSession(): Promise<HitsSessionToken> {
    if (this.session?.token) return this.session;
    await this.authorize();
    if (!this.session) {
      throw new HitsError({
        code: "unauthorized",
        message: "Sessão HITS indisponível após authorize.",
        httpStatus: null,
        retryable: false,
      });
    }
    return this.session;
  }

  async healthCheck(): Promise<{ ok: boolean; httpStatus: number; body: unknown }> {
    this.assertIntegrationEnabled("healthCheck");
    this.assertAuthContract();

    const res = await this.transport.request({
      method: "GET",
      url: `${this.config.apiBaseUrl}/api/HealthCheck`,
      headers: this.baseHeaders(),
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 1,
    });

    return { ok: res.httpStatus >= 200 && res.httpStatus < 300, httpStatus: res.httpStatus, body: res.body };
  }

  async listProperties(params?: { since?: string }): Promise<HitsProperty[]> {
    this.assertIntegrationEnabled("listProperties");
    this.assertAuthContract();
    this.assertSecretAndProperty();
    const session = await this.ensureSession();

    const qs = new URLSearchParams();
    if (params?.since) qs.set("Since", params.since);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";

    const res = await this.transport.request({
      method: "GET",
      url: `${this.config.apiBaseUrl}/Datashare/Properties${suffix}`,
      headers: this.authenticatedHeaders(session.token),
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (Array.isArray(res.body)) return res.body as HitsProperty[];
    if (res.body && typeof res.body === "object") {
      const row = res.body as Record<string, unknown>;
      const list = row.data ?? row.items ?? row.results;
      if (Array.isArray(list)) return list as HitsProperty[];
    }
    return [];
  }

  async listWebCheckinReservations(
    params: HitsReservationSearchParams = {},
  ): Promise<HitsReservationListResponse> {
    this.assertIntegrationEnabled("listWebCheckinReservations");
    this.assertAuthContract();
    this.assertSecretAndProperty();
    const session = await this.ensureSession();

    const qs = new URLSearchParams();
    if (params.type !== undefined) qs.set("Type", String(params.type));
    if (params.status !== undefined) qs.set("Status", String(params.status));
    if (params.initialDate) qs.set("InitialDate", params.initialDate);
    if (params.finalDate) qs.set("FinalDate", params.finalDate);
    if (params.reservationIntegrationId) {
      qs.set("ReservationIntegrationId", params.reservationIntegrationId);
    }
    if (params.page !== undefined) qs.set("Page", String(params.page));
    if (params.size !== undefined) qs.set("Size", String(params.size));

    const res = await this.transport.request({
      method: "GET",
      url: `${this.config.apiBaseUrl}/Datashare/WebCheckinOut/Reservations?${qs.toString()}`,
      headers: this.authenticatedHeaders(session.token),
      timeoutMs: this.config.requestTimeoutMs,
    });

    return res.body as HitsReservationListResponse;
  }

  async getWebCheckinReservation(reservationId: string): Promise<HitsReservationDetails> {
    this.assertIntegrationEnabled("getWebCheckinReservation");
    this.assertAuthContract();
    this.assertSecretAndProperty();

    const id = String(reservationId ?? "").trim();
    if (!id) {
      throw new HitsError({
        code: "missing_reservation_id",
        message: "reservationId obrigatório.",
        httpStatus: null,
        retryable: false,
      });
    }

    const session = await this.ensureSession();
    const res = await this.transport.request({
      method: "GET",
      url: `${this.config.apiBaseUrl}/Datashare/WebCheckinOut/Reservation/${encodeURIComponent(id)}`,
      headers: this.authenticatedHeaders(session.token),
      timeoutMs: this.config.requestTimeoutMs,
    });

    return res.body as HitsReservationDetails;
  }

  async listRevenueManagementGuests(
    params: HitsGuestSearchParams = {},
  ): Promise<HitsGuestListResponse> {
    this.assertIntegrationEnabled("listRevenueManagementGuests");
    this.assertAuthContract();
    this.assertSecretAndProperty();
    const session = await this.ensureSession();

    const qs = new URLSearchParams();
    if (params.entityId) qs.set("EntityId", params.entityId);
    if (params.since) qs.set("Since", params.since);
    if (params.docType !== undefined) qs.set("DocType", String(params.docType));
    if (params.doc) qs.set("Doc", params.doc);
    if (params.email) qs.set("Email", params.email);
    if (params.page !== undefined) qs.set("Page", String(params.page));
    if (params.size !== undefined) qs.set("Size", String(params.size));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";

    const res = await this.transport.request({
      method: "GET",
      url: `${this.config.apiBaseUrl}/Datashare/RevenueManagement/Guests${suffix}`,
      headers: this.authenticatedHeaders(session.token),
      timeoutMs: this.config.requestTimeoutMs,
    });

    return res.body as HitsGuestListResponse;
  }

  /**
   * Inclusão/vínculo de PAX. Sem retry (maxRetries: 0) para não duplicar mutação.
   * reservationId somente no path; o caller não deve incluir idEntity no body.
   */
  async postWebCheckinGuests(
    reservationId: string,
    body: HitsWebCheckinGuestsPostBody,
  ): Promise<unknown> {
    this.assertIntegrationEnabled("postWebCheckinGuests");
    this.assertAuthContract();
    this.assertSecretAndProperty();

    const id = String(reservationId ?? "").trim();
    if (!id) {
      throw new HitsError({
        code: "missing_reservation_id",
        message: "reservationId obrigatório.",
        httpStatus: null,
        retryable: false,
      });
    }

    const session = await this.ensureSession();
    const res = await this.transport.request({
      method: "POST",
      url: `${this.config.apiBaseUrl}${hitsWebCheckinGuestsPostPath(id)}`,
      headers: this.authenticatedHeaders(session.token),
      body,
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 0,
    });

    return res.body;
  }

  /**
   * Atualização cadastral de PAX. Sem retry (maxRetries: 0).
   */
  async putWebCheckinGuests(body: HitsGuestsPutDto): Promise<unknown> {
    this.assertIntegrationEnabled("putWebCheckinGuests");
    this.assertAuthContract();
    this.assertSecretAndProperty();
    const session = await this.ensureSession();

    const res = await this.transport.request({
      method: "PUT",
      url: `${this.config.apiBaseUrl}${HITS_WEBCHECKIN_GUESTS_PUT_PATH}`,
      headers: this.authenticatedHeaders(session.token),
      body,
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 0,
    });

    return res.body;
  }

  /**
   * Check-in preparado. Bloqueado por flag, contrato de body unverified e id ausente.
   * Não executa fetch nesses casos. Persistência/idempotência virão em PR posterior.
   */
  async checkInReservation(
    reservationId: string,
    _payload: HitsCheckInRequest = {},
  ): Promise<HitsCheckInResult> {
    if (!this.config.checkinEnabled) {
      throw new HitsError({
        code: "checkin_disabled",
        message: "HITS check-in desligado (HITS_CHECKIN_ENABLED !== true).",
        httpStatus: null,
        retryable: false,
      });
    }
    this.assertIntegrationEnabled("checkInReservation");
    this.assertAuthContract();

    if (this.config.checkInBodyContractStatus !== "verified") {
      throw new HitsError({
        code: "checkin_body_unverified",
        message:
          "Contrato de request body do CheckIn HITS unverified no Swagger; mutação bloqueada.",
        httpStatus: null,
        retryable: false,
      });
    }

    const id = String(reservationId ?? "").trim();
    if (!id) {
      throw new HitsError({
        code: "missing_reservation_id",
        message: "reservationId obrigatório para check-in.",
        httpStatus: null,
        retryable: false,
      });
    }

    this.assertSecretAndProperty();
    const session = await this.ensureSession();

    // Swagger atual: POST sem requestBody; resposta CheckInDto.
    const res = await this.transport.request({
      method: "POST",
      url: `${this.config.apiBaseUrl}/Datashare/Folios/${encodeURIComponent(id)}/CheckIn`,
      headers: this.authenticatedHeaders(session.token),
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 0,
    });

    return (res.body ?? {}) as HitsCheckInResult;
  }

  /* ---------- Compatibilidade legada ---------- */

  /** @deprecated Use authorize() */
  async authorizeHits(): Promise<HitsAuthResponse> {
    const token = await this.authorize();
    return { ...token, accessToken: token.token };
  }

  /** @deprecated Use listWebCheckinReservations() */
  async listReservations(
    params: ListReservationsParams = {},
  ): Promise<HitsReservationListResponse> {
    return this.listWebCheckinReservations(params);
  }

  /** @deprecated Use getWebCheckinReservation() */
  async getReservationById(id: string): Promise<HitsReservationDetail> {
    return this.getWebCheckinReservation(id);
  }
}

export function createHitsClient(options?: HitsClientOptions): HitsClient {
  return new HitsClient(options);
}

export async function authorizeHits(): Promise<HitsAuthResponse> {
  return createHitsClient().authorizeHits();
}

export async function listReservations(
  params: ListReservationsParams = {},
): Promise<HitsReservationListResponse> {
  return createHitsClient().listReservations(params);
}

export async function getReservationById(
  id: string,
): Promise<HitsReservationDetail> {
  return createHitsClient().getReservationById(id);
}

export function extractAccessToken(authResponse: HitsAuthResponse | HitsAccessToken): string {
  const token =
    typeof (authResponse as HitsAccessToken).token === "string"
      ? (authResponse as HitsAccessToken).token
      : typeof (authResponse as HitsAuthResponse).accessToken === "string"
        ? (authResponse as HitsAuthResponse).accessToken
        : undefined;
  if (!token) {
    throw new HitsError({
      code: "invalid_json",
      message: "Resposta de autenticação sem token.",
      httpStatus: null,
      retryable: false,
    });
  }
  return token;
}

export function maskToken(token: string | undefined): string {
  if (!token) return "<nao informado>";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
