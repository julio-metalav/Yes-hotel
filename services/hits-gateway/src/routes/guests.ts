import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HitsReadClient } from "../hits-client.ts";
import { gatewayErrorBody, mapHitsFailure, mapHitsGuestWriteFailure } from "../http-errors.ts";
import { parseGuestsPostBody, parseGuestsPutBody } from "../guest-write.ts";
import { parseGuestListQuery, parseReservationId } from "../query.ts";

const BLOCKED_GUEST_METHODS = ["POST", "PATCH", "DELETE"] as const;

async function methodNotAllowed(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply
    .code(405)
    .header("Allow", "GET, PUT")
    .send(
      gatewayErrorBody(
        request.id,
        "method_not_allowed",
        "Método não permitido.",
        false,
      ),
    );
}

function writeDisabledBody(requestId: string) {
  return gatewayErrorBody(
    requestId,
    "guest_write_disabled",
    "Escrita de hóspede desabilitada.",
    false,
  );
}

export function registerGuestRoutes(
  app: FastifyInstance,
  hitsClient: HitsReadClient | null,
  options: { guestWriteEnabled: boolean } = { guestWriteEnabled: false },
): void {
  for (const method of BLOCKED_GUEST_METHODS) {
    app.route({ method, url: "/v1/guests", handler: methodNotAllowed });
  }

  app.post("/v1/reservations/:id/guests", async (request, reply) => {
    if (!options.guestWriteEnabled) {
      return reply.code(403).send(writeDisabledBody(request.id));
    }
    if (!hitsClient?.postReservationGuests) {
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
    const reservationId = parseReservationId(params.id);
    if (!reservationId.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, reservationId.code, reservationId.message, false));
    }

    const parsed = parseGuestsPostBody(request.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, parsed.code, parsed.message, false));
    }

    try {
      await hitsClient.postReservationGuests(reservationId.value, parsed.value);
      return reply.code(200).send({ ok: true, request_id: request.id });
    } catch (error) {
      const mapped = mapHitsGuestWriteFailure(error, request.id);
      request.log.error({
        msg: "hits_guest_post_failed",
        request_id: request.id,
        operation: "guest_post",
        code: mapped.body.code,
        http_status: mapped.status,
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.put("/v1/guests", async (request, reply) => {
    if (!options.guestWriteEnabled) {
      return reply.code(403).send(writeDisabledBody(request.id));
    }
    if (!hitsClient?.putGuest) {
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

    const parsed = parseGuestsPutBody(request.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(gatewayErrorBody(request.id, parsed.code, parsed.message, false));
    }

    try {
      await hitsClient.putGuest(parsed.value);
      return reply.code(200).send({ ok: true, request_id: request.id });
    } catch (error) {
      const mapped = mapHitsGuestWriteFailure(error, request.id);
      request.log.error({
        msg: "hits_guest_put_failed",
        request_id: request.id,
        operation: "guest_put",
        code: mapped.body.code,
        http_status: mapped.status,
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });

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
