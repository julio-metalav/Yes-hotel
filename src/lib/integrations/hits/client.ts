import { getHitsEnv, type HitsEnv } from "./env";
import type {
  HitsAuthResponse,
  HitsReservationDetail,
  HitsReservationListResponse,
  ListReservationsParams,
} from "./types";

interface HitsClientOptions {
  timeoutMs?: number;
  debug?: boolean;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  token?: string;
  body?: unknown;
}

export class HitsApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = "HitsApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function maskToken(token: string | undefined): string {
  if (!token) {
    return "<nao informado>";
  }

  if (token.length <= 8) {
    return "***";
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return "***";
  }

  return `${secret.slice(0, 2)}***${secret.slice(-2)}`;
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function buildAuthHeader(token: string): string {
  // O uso de Bearer e a leitura tecnica mais segura neste momento.
  // Se o teste autenticado real indicar outro formato, este ponto deve ser ajustado.
  return `Bearer ${token}`;
}

function getMissingPostAuthEnvNames(env: HitsEnv): string[] {
  const requiredEntries = [
    ["HITS_TENANT_NAME", env.tenantName],
    ["HITS_PROPERTY_CODE", env.propertyCode],
    ["HITS_PARTNER_USER_ID", env.partnerUserId],
    ["HITS_CLIENT_ID", env.clientId],
  ] as const;

  return requiredEntries
    .filter(([, value]) => !value)
    .map(([envName]) => envName);
}

function applyPostAuthHeaders(headers: Headers, env: HitsEnv, token: string): void {
  const missingEnvNames = getMissingPostAuthEnvNames(env);

  if (missingEnvNames.length > 0) {
    throw new Error(
      `Env(s) obrigatoria(s) ausente(s) para chamadas autenticadas ao HITS: ${missingEnvNames.join(", ")}.`,
    );
  }

  headers.set("Authorization", buildAuthHeader(token));
  headers.set("X-API-TENANT-NAME", env.tenantName!);
  headers.set("X-API-PROPERTY-CODE", env.propertyCode!);
  headers.set("X-API-PARTNER-USERID", env.partnerUserId!);
  headers.set("X-API-LANGUAGE-CODE", env.languageCode);
  headers.set("X-Client-Id", env.clientId!);
}

function extractAccessToken(authResponse: HitsAuthResponse): string {
  const accessToken =
    typeof authResponse.accessToken === "string"
      ? authResponse.accessToken
      : typeof authResponse.token === "string"
        ? authResponse.token
        : undefined;

  if (!accessToken) {
    throw new Error(
      "Resposta de autenticacao nao trouxe accessToken/token em formato conhecido.",
    );
  }

  return accessToken;
}

export class HitsClient {
  private readonly env: HitsEnv;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(env: HitsEnv = getHitsEnv(), options: HitsClientOptions = {}) {
    this.env = env;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.debug = options.debug ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authorizeHits(): Promise<HitsAuthResponse> {
    if (this.debug) {
      console.debug("[hits] authorizeHits()", {
        baseUrl: this.env.baseUrl,
        apiVersion: this.env.apiVersion,
        accessSecret: maskSecret(this.env.accessSecret),
      });
    }

    // O nome do campo abaixo e uma leitura tecnica provisoria baseada no material atual.
    // Confirmar em teste autenticado real se o contrato final do /Authorize difere disso.
    // Nesta primeira leitura, o /Authorize usa apenas versionamento + segredo compartilhado.
    return this.requestJson<HitsAuthResponse>({
      method: "POST",
      path: "/Authorize",
      body: {
        accessSecret: this.env.accessSecret,
      },
    });
  }

  async listReservations(
    params: ListReservationsParams = {},
  ): Promise<HitsReservationListResponse> {
    const authResponse = await this.authorizeHits();
    const token = extractAccessToken(authResponse);
    const searchParams = new URLSearchParams();

    if (params.type !== undefined) {
      searchParams.set("Type", String(params.type));
    }

    if (params.status !== undefined) {
      searchParams.set("Status", String(params.status));
    }

    if (params.initialDate) {
      searchParams.set("InitialDate", params.initialDate);
    }

    if (params.finalDate) {
      searchParams.set("FinalDate", params.finalDate);
    }

    if (params.reservationIntegrationId) {
      searchParams.set(
        "ReservationIntegrationId",
        params.reservationIntegrationId,
      );
    }

    if (params.page !== undefined) {
      searchParams.set("Page", String(params.page));
    }

    if (params.size !== undefined) {
      searchParams.set("Size", String(params.size));
    }

    return this.requestJson<HitsReservationListResponse>({
      method: "GET",
      path: `/Datashare/WebCheckinOut/Reservations?${searchParams.toString()}`,
      token,
    });
  }

  async getReservationById(id: string): Promise<HitsReservationDetail> {
    if (!id.trim()) {
      throw new Error("Parametro 'id' obrigatorio para getReservationById().");
    }

    const authResponse = await this.authorizeHits();
    const token = extractAccessToken(authResponse);

    return this.requestJson<HitsReservationDetail>({
      method: "GET",
      path: `/Datashare/WebCheckinOut/Reservation/${encodeURIComponent(id)}`,
      token,
    });
  }

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    const { signal, cleanup } = buildTimeoutSignal(this.timeoutMs);

    try {
      const headers = new Headers({
        Accept: "application/json",
        "X-API-VERSION": this.env.apiVersion,
      });

      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      if (options.token) {
        // Estes headers estao confirmados para os endpoints autenticados observados no Swagger.
        // O formato exato do Authorization permanece provisoriamente como Bearer ate o teste real.
        applyPostAuthHeaders(headers, this.env, options.token);
      }

      if (this.debug) {
        console.debug("[hits] request", {
          method: options.method,
          url: `${this.env.baseUrl}${options.path}`,
          token: maskToken(options.token),
        });
      }

      const response = await this.fetchImpl(`${this.env.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });

      const responseBody = await parseJsonSafely(response);

      if (!response.ok) {
        throw new HitsApiError(
          `Falha ao chamar HITS ${options.method} ${options.path}`,
          response.status,
          responseBody,
        );
      }

      return responseBody as T;
    } catch (error) {
      if (error instanceof HitsApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Timeout ao chamar HITS ${options.method} ${options.path} em ${this.timeoutMs}ms.`,
        );
      }

      throw error;
    } finally {
      cleanup();
    }
  }
}

export function createHitsClient(options?: HitsClientOptions): HitsClient {
  return new HitsClient(getHitsEnv(), options);
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

export { extractAccessToken, maskToken };
