import type { FastifyInstance } from "fastify";
import { GATEWAY_VERSION } from "../version.ts";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async (_request, reply) => {
    await reply.code(200).send({
      status: "ok",
      service: "hits-gateway",
      version: GATEWAY_VERSION,
    });
  });
}
