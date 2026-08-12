/**
 * Erros sanitizados da integração HITS.
 * Nunca incluir shared secret, token ou Authorization em message/details.
 */

import type { HitsApiErrorShape, HitsHttpErrorCode } from "./types.ts";

const SENSITIVE_SUBSTRINGS = [
  "bearer ",
  "authorization",
  "accesssecret",
  "shared_access",
  "sharedaccess",
] as const;

export class HitsError extends Error {
  readonly code: HitsHttpErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(shape: HitsApiErrorShape) {
    super(sanitizeMessage(shape.message));
    this.name = "HitsError";
    this.code = shape.code;
    this.httpStatus = shape.httpStatus;
    this.retryable = shape.retryable;
    this.details = shape.details ? sanitizeDetails(shape.details) : undefined;
  }

  toJSON(): HitsApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Compatível com código legado que captura HitsApiError. */
export class HitsApiError extends HitsError {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(message: string, status: number, responseBody: unknown) {
    super({
      code: mapStatusToCode(status),
      message,
      httpStatus: status,
      retryable: isRetryableStatus(status),
      details: { responseBody: sanitizeUnknown(responseBody) },
    });
    this.name = "HitsApiError";
    this.status = status;
    this.responseBody = sanitizeUnknown(responseBody);
  }
}

export function mapStatusToCode(status: number): HitsHttpErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  return "unknown";
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function sanitizeMessage(message: string): string {
  let out = message;
  for (const needle of SENSITIVE_SUBSTRINGS) {
    if (out.toLowerCase().includes(needle)) {
      out = "Erro HITS sanitizado (detalhe sensível omitido).";
      break;
    }
  }
  // Remove possíveis JWT / tokens longos hex/base64
  out = out.replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "[REDACTED_TOKEN]");
  out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]");
  return out;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (/secret|token|password|authorization|authorization/i.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = sanitizeUnknown(v);
  }
  return out;
}

export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeMessage(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeUnknown(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|authorization/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeUnknown(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function assertNoSensitiveLeak(payload: unknown, secrets: string[]): void {
  const text = JSON.stringify(payload);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && text.includes(secret)) {
      throw new HitsError({
        code: "unknown",
        message: "ABORT: vazamento de secret/token bloqueado.",
        httpStatus: null,
        retryable: false,
      });
    }
  }
}
