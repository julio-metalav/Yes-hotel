/**
 * Erros sanitizados da integração Pagar.me.
 * Nunca incluir secret, QR completo, payment link completo ou dado de cartão.
 */

import type { PagarmeApiErrorShape, PagarmeHttpErrorCode } from "./types.ts";

const SENSITIVE_KEY_RE =
  /secret|authorization|password|card|cvv|number|qr_code|qrcode|payment_link_url|copia.?cola|pix_qr/i;

export class PagarmeError extends Error {
  readonly code: PagarmeHttpErrorCode;
  readonly httpStatus: number | null;
  readonly ambiguous: boolean;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(shape: PagarmeApiErrorShape) {
    super(sanitizeMessage(shape.message));
    this.name = "PagarmeError";
    this.code = shape.code;
    this.httpStatus = shape.httpStatus;
    this.ambiguous = shape.ambiguous;
    this.retryable = shape.retryable;
    this.details = shape.details ? sanitizeDetails(shape.details) : undefined;
  }

  toJSON(): PagarmeApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      ambiguous: this.ambiguous,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function mapStatusToCode(status: number): PagarmeHttpErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 412) return "precondition_failed";
  if (status === 422) return "bad_request";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  return "unknown";
}

/**
 * Respostas ambíguas: timeout, rede, 408, 409, 429, 5xx.
 * NÃO liberam nova cobrança / NÃO viram failed.
 *
 * 409 Conflict: a Pagar.me pode ter criado o recurso mesmo assim (idempotência
 * remota / corrida). Tratar como definitivo abriria segunda cobrança local.
 */
export function isAmbiguousHttpStatus(status: number): boolean {
  if (status === 408) return true;
  if (status === 409) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

export function isDefinitiveHttpStatus(status: number): boolean {
  if (status >= 200 && status < 300) return false;
  if (isAmbiguousHttpStatus(status)) return false;
  // 4xx (exceto 408/409/429) = definitivo comprovado pelo servidor
  return status >= 400 && status < 500;
}

export function sanitizeMessage(message: string): string {
  let out = message;
  if (/sk_(test|live)_/i.test(out) || /bearer\s+/i.test(out)) {
    return "Erro Pagar.me sanitizado (detalhe sensível omitido).";
  }
  out = out.replace(/sk_(test|live)_[A-Za-z0-9]+/gi, "[REDACTED_SECRET]");
  out = out.replace(/https?:\/\/payment-link\.pagar\.me\/[^\s"']+/gi, "[REDACTED_PAYMENT_LINK]");
  // QR / copia-e-cola longos
  out = out.replace(/\b000201[0-9A-Za-z]{20,}\b/g, "[REDACTED_PIX_QR]");
  return out;
}

export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeMessage(redactLongSensitiveString(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeUnknown(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeUnknown(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function redactLongSensitiveString(value: string): string {
  if (value.length > 80 && (/^000201/.test(value) || /payment-link\.pagar\.me/i.test(value))) {
    return "[REDACTED_LONG]";
  }
  return value;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = sanitizeUnknown(v);
  }
  return out;
}

export function assertNoSensitiveLeak(payload: unknown, secrets: string[]): void {
  const text = JSON.stringify(payload);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && text.includes(secret)) {
      throw new PagarmeError({
        code: "unknown",
        message: "ABORT: vazamento de secret bloqueado.",
        httpStatus: null,
        ambiguous: false,
        retryable: false,
      });
    }
  }
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) return "<nao informado>";
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
