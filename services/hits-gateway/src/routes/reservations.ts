import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HitsReadClient } from "../hits-client.ts";
import { gatewayErrorBody, mapHitsFailure } from "../http-errors.ts";
import { parseReservationId, parseReservationListQuery } from "../query.ts";

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

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
): void {
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

    try {
      const data = await hitsClient.listReservations(parsed.value);
      return reply.code(200).send(data);
    } catch (error) {
      const mapped = mapHitsFailure(error, request.id);
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
