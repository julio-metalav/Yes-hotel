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

/**
 * Mapper de escrita PAX. 400/409 específicos desta operação;
 * demais status reutilizam mapHitsFailure (GETs permanecem inalterados).
 */
export function mapHitsGuestWriteFailure(
  error: unknown,
  requestId: string,
): { status: number; body: GatewayErrorBody } {
  if (error instanceof HitsApiError) {
    if (error.status === 400) {
      return {
        status: 422,
        body: gatewayErrorBody(
          requestId,
          "hits_validation_failed",
          "HITS recusou a validação do pedido.",
          false,
        ),
      };
    }
    if (error.status === 409) {
      return {
        status: 409,
        body: gatewayErrorBody(requestId, "hits_conflict", "Conflito no HITS.", false),
      };
    }
  }
  return mapHitsFailure(error, requestId);
}

export function containsSensitiveLeak(payload: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(payload);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && text.includes(secret)) return true;
  }
  return false;
}

type ClientInputMap = {
  status: number;
  code: string;
  message: string;
};

const CLIENT_INPUT_BY_CODE: Record<string, ClientInputMap> = {
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: "bad_request",
    message: "Pedido inválido.",
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: "bad_request",
    message: "Pedido inválido.",
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: "bad_request",
    message: "Pedido inválido.",
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: "unsupported_media_type",
    message: "Content-Type não suportado.",
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: "payload_too_large",
    message: "Pedido excede o tamanho permitido.",
  },
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Erros de entrada (JSON/body/content-type/tamanho) → HTTP sanitizado.
 * Não usa message/stack do Fastify. Retorna null se não for erro de parser.
 */
export function mapClientInputFailure(
  error: unknown,
  requestId: string,
): { status: number; body: GatewayErrorBody } | null {
  const code = errorCode(error);
  const mapped = code ? CLIENT_INPUT_BY_CODE[code] : undefined;
  if (mapped) {
    return {
      status: mapped.status,
      body: gatewayErrorBody(requestId, mapped.code, mapped.message, false),
    };
  }

  const status = errorStatus(error);
  if (status === 415) {
    return {
      status: 415,
      body: gatewayErrorBody(
        requestId,
        "unsupported_media_type",
        "Content-Type não suportado.",
        false,
      ),
    };
  }
  if (status === 413) {
    return {
      status: 413,
      body: gatewayErrorBody(
        requestId,
        "payload_too_large",
        "Pedido excede o tamanho permitido.",
        false,
      ),
    };
  }
  if (status === 400) {
    return {
      status: 400,
      body: gatewayErrorBody(requestId, "bad_request", "Pedido inválido.", false),
    };
  }
  return null;
}
