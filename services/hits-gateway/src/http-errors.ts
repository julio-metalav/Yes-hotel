/**
 * Mapeia erros do HitsClient existente para HTTP sanitizado (sem stack, sem secret).
 */

import {
  HitsApiError,
  HitsError,
  sanitizeMessage,
} from "../../../src/lib/integrations/hits/errors.ts";

export type GatewayErrorBody = {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  request_id: string;
};

export function gatewayErrorBody(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
): GatewayErrorBody {
  return {
    ok: false,
    code,
    message: sanitizeMessage(message),
    retryable,
    request_id: requestId,
  };
}

export function mapHitsFailure(
  error: unknown,
  requestId: string,
): { status: number; body: GatewayErrorBody } {
  if (error instanceof HitsApiError) {
    const status = error.status;
    if (status === 404) {
      return {
        status: 404,
        body: gatewayErrorBody(requestId, "hits_not_found", "Reserva não encontrada no HITS.", false),
      };
    }
    if (status === 429) {
      return {
        status: 429,
        body: gatewayErrorBody(requestId, "hits_rate_limited", "HITS limitou a taxa de pedidos.", true),
      };
    }
    if (status === 401) {
      return {
        status: 502,
        body: gatewayErrorBody(requestId, "hits_unauthorized", "HITS recusou autenticação.", false),
      };
    }
    if (status === 403) {
      return {
        status: 502,
        body: gatewayErrorBody(requestId, "hits_forbidden", "HITS recusou a operação.", false),
      };
    }
    if (status >= 500) {
      return {
        status: 502,
        body: gatewayErrorBody(requestId, "hits_server_error", "Erro no HITS.", true),
      };
    }
    return {
      status: 502,
      body: gatewayErrorBody(requestId, "hits_bad_request", "HITS recusou o pedido.", false),
    };
  }

  if (error instanceof HitsError) {
    if (error.code === "timeout") {
      return {
        status: 504,
        body: gatewayErrorBody(requestId, "gateway_timeout", "Timeout ao consultar o HITS.", true),
      };
    }
    if (
      error.code === "missing_secret" ||
      error.code === "missing_property_id" ||
      error.code === "missing_context_headers" ||
      error.code === "integration_disabled"
    ) {
      return {
        status: 503,
        body: gatewayErrorBody(
          requestId,
          "hits_not_configured",
          "Gateway sem credenciais HITS suficientes.",
          false,
        ),
      };
    }
    if (error.code === "missing_reservation_id") {
      return {
        status: 400,
        body: gatewayErrorBody(requestId, "bad_request", "id de reserva obrigatório.", false),
      };
    }
    if (error.retryable) {
      return {
        status: 502,
        body: gatewayErrorBody(requestId, "hits_server_error", "Falha transitória ao consultar o HITS.", true),
      };
    }
    return {
      status: 502,
      body: gatewayErrorBody(requestId, "hits_error", "Falha ao consultar o HITS.", false),
    };
  }

  return {
    status: 500,
    body: gatewayErrorBody(requestId, "internal_error", "Erro interno do gateway.", false),
  };
}

export function containsSensitiveLeak(payload: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(payload);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && text.includes(secret)) return true;
  }
  return false;
}
