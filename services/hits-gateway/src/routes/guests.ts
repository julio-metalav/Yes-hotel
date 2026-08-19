import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HitsReadClient } from "../hits-client.ts";
import { gatewayErrorBody, mapHitsFailure } from "../http-errors.ts";
import { parseGuestListQuery } from "../query.ts";

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

export function registerGuestRoutes(
  app: FastifyInstance,
  hitsClient: HitsReadClient | null,
): void {
  for (const method of WRITE_METHODS) {
    app.route({ method, url: "/v1/guests", handler: methodNotAllowed });
  }

  app.get("/v1/guests", async (request, reply) => {
    if (!hitsClient?.listGuests) {
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

    const parsed = parseGuestListQuery(
      (request.query ?? {}) as Record<string, unknown>,
    );
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, parsed.code, parsed.message, false));
    }

    try {
      const data = await hitsClient.listGuests(parsed.value);
      return reply.code(200).send(data);
    } catch (error) {
      const mapped = mapHitsFailure(error, request.id);
      request.log.error({
        msg: "hits_guests_failed",
        request_id: request.id,
        code: mapped.body.code,
        http_status: mapped.status,
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });
}
