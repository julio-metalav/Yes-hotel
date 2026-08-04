/**
 * Transporte HTTP injetável para HITS — testável sem rede.
 */

import {
  HitsError,
  HitsApiError,
  isRetryableStatus,
  sanitizeUnknown,
} from "./errors";

export interface HitsTransportRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Máximo de retries adicionais (0 = só 1 tentativa). Default 2. */
  maxRetries?: number;
}

export interface HitsTransportResponse {
  httpStatus: number;
  headers: Record<string, string>;
  body: unknown;
  rawText: string;
}

export type HitsFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface HitsTransport {
  request(req: HitsTransportRequest): Promise<HitsTransportResponse>;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const raw = headers["retry-after"];
  if (!raw) return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt >= 0) return Math.min(asInt * 1000, 30_000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, 30_000);
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function safeUrlHint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function shouldRetryError(error: unknown): boolean {
  if (error instanceof HitsApiError) return isRetryableStatus(error.status);
  if (error instanceof HitsError) return error.retryable && error.code === "timeout";
  return false;
}

export function createHitsTransport(fetchImpl: HitsFetch = fetch): HitsTransport {
  return {
    async request(req: HitsTransportRequest): Promise<HitsTransportResponse> {
      const maxRetries = Math.max(0, Math.min(req.maxRetries ?? 2, 3));
      let attempt = 0;
      let lastError: unknown;

      while (attempt <= maxRetries) {
        attempt += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), req.timeoutMs);

        try {
          const headers: Record<string, string> = {
            Accept: "application/json",
            ...(req.headers ?? {}),
          };
          let bodyText: string | undefined;
          if (req.body !== undefined) {
            headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
            bodyText = JSON.stringify(req.body);
          }

          const res = await fetchImpl(req.url, {
            method: req.method,
            headers,
            body: bodyText,
            signal: controller.signal,
          });

          const rawText = await res.text();
          const responseHeaders = headersToRecord(res.headers);
          let body: unknown = null;

          if (rawText.length > 0) {
            try {
              body = JSON.parse(rawText) as unknown;
            } catch {
              throw new HitsError({
                code: "invalid_json",
                message: "Resposta HITS com JSON inválido.",
                httpStatus: res.status,
                retryable: false,
                details: { pathHint: safeUrlHint(req.url) },
              });
            }
          }

          if (!res.ok) {
            const err = new HitsApiError(
              `HITS HTTP ${res.status} em ${req.method} ${safeUrlHint(req.url)}`,
              res.status,
              sanitizeUnknown(body),
            );
            // Sem retry em 400, 401, 403, 409.
            if (isRetryableStatus(res.status) && attempt <= maxRetries) {
              const retryAfter = parseRetryAfterMs(responseHeaders);
              const backoff = retryAfter ?? Math.min(250 * 2 ** (attempt - 1), 2_000);
              await sleep(backoff);
              lastError = err;
              continue;
            }
            throw err;
          }

          return {
            httpStatus: res.status,
            headers: responseHeaders,
            body,
            rawText,
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            const timeoutErr = new HitsError({
              code: "timeout",
              message: `Timeout HITS após ${req.timeoutMs}ms.`,
              httpStatus: null,
              retryable: true,
              details: { pathHint: safeUrlHint(req.url) },
            });
            if (attempt <= maxRetries) {
              await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
              lastError = timeoutErr;
              continue;
            }
            throw timeoutErr;
          }

          if (shouldRetryError(error) && attempt <= maxRetries) {
            lastError = error;
            await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
            continue;
          }

          throw error;
        } finally {
          clearTimeout(timer);
        }
      }

      if (lastError instanceof Error) throw lastError;
      throw new HitsError({
        code: "unknown",
        message: "Falha HITS após retries.",
        httpStatus: null,
        retryable: false,
      });
    },
  };
}

export function mapHttpError(
  status: number,
  message?: string,
  body?: unknown,
): HitsError {
  return new HitsApiError(message ?? `HITS HTTP ${status}`, status, body ?? null);
}
