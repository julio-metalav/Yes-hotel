import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HitsReadClient } from "../hits-client.ts";
import {
  describeHitsFailureForDebug,
  gatewayErrorBody,
  isHitsUpstreamDebugEnabled,
  mapHitsFailure,
} from "../http-errors.ts";
import { parseReservationId, parseReservationListQuery } from "../query.ts";
import { ReservationListCache, reservationCacheKey } from "../reservation-cache.ts";
import { HitsApiError } from "../../../../src/lib/integrations/hits/errors.ts";

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

function isRateLimited(error: unknown): boolean {
  return error instanceof HitsApiError && error.status === 429;
}

async function methodNotAllowed(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply
    .code(405)
    .header("Allow", "GET")
    .send(
      gatewayErrorBody(
        request.id,
        "method_not_allowed",
        "Método não permitido. Gateway V1 é somente leitura.",
        false,
      ),
    );
}

export function registerReservationRoutes(
  app: FastifyInstance,
  hitsClient: HitsReadClient | null,
  options: { listCache?: ReservationListCache } = {},
): void {
  // Só a listagem usa cache. Detalhe e escrita nunca passam por aqui.
  const listCache = options.listCache ?? new ReservationListCache();

  for (const method of WRITE_METHODS) {
    app.route({
      method,
      url: "/v1/reservations",
      handler: methodNotAllowed,
    });
    app.route({
      method,
      url: "/v1/reservations/:id",
      handler: methodNotAllowed,
    });
  }

  app.get("/v1/reservations", async (request, reply) => {
    if (!hitsClient) {
      return reply
        .code(503)
        .send(
          gatewayErrorBody(
            request.id,
            "hits_not_configured",
            "Gateway sem credenciais HITS suficientes.",
            false,
          ),
        );
    }

    const parsed = parseReservationListQuery(
      (request.query ?? {}) as Record<string, unknown>,
    );
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, parsed.code, parsed.message, false));
    }

    const cacheKey = reservationCacheKey(parsed.value);
    const cached = listCache.lookup(cacheKey);
    if (cached.state === "fresh") {
      return reply.code(200).header("x-cache", "hit").send(cached.body);
    }

    try {
      const data = await hitsClient.listReservations(parsed.value);
      listCache.set(cacheKey, data);
      return reply.code(200).header("x-cache", "miss").send(data);
    } catch (error) {
      // 429 do HITS ("Too many calls for same reservation page N") com cópia
      // recente em mãos: serve a cópia em vez de esvaziar a tela.
      if (isRateLimited(error) && cached.state === "stale") {
        request.log.warn({
          msg: "hits_list_stale_served",
          request_id: request.id,
          reason: "hits_rate_limited",
          age_ms: cached.ageMs,
        });
        return reply.code(200).header("x-cache", "stale").send(cached.body);
      }

      const mapped = mapHitsFailure(error, request.id);
      if (isHitsUpstreamDebugEnabled()) {
        request.log.error(
          describeHitsFailureForDebug(error, {
            requestId: request.id,
            method: "GET",
            path: "/Datashare/WebCheckinOut/Reservations",
          }),
        );
      }
      request.log.error({
        msg: "hits_list_failed",
        request_id: request.id,
        code: mapped.body.code,
        http_status: mapped.status,
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.get("/v1/reservations/:id", async (request, reply) => {
    if (!hitsClient) {
      return reply
        .code(503)
        .send(
          gatewayErrorBody(
            request.id,
            "hits_not_configured",
            "Gateway sem credenciais HITS suficientes.",
            false,
          ),
        );
    }

    const params = request.params as { id?: string };
    const parsed = parseReservationId(params.id);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, parsed.code, parsed.message, false));
    }

    try {
      const data = await hitsClient.getReservation(parsed.value);
      return reply.code(200).send(data);
    } catch (error) {
      const mapped = mapHitsFailure(error, request.id);
      request.log.error({
        msg: "hits_detail_failed",
        request_id: request.id,
        code: mapped.body.code,
        http_status: mapped.status,
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });
}
