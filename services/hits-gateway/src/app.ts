import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { isValidGatewayBearer } from "./auth.ts";
import { TRUSTED_PROXY_ADDRESSES } from "./config.ts";
import { containsSensitiveLeak, gatewayErrorBody } from "./http-errors.ts";
import type { HitsReadClient } from "./hits-client.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerReservationRoutes } from "./routes/reservations.ts";

export type BuildAppOptions = {
  gatewayToken: string;
  hitsClient: HitsReadClient | null;
  secretsToRedact?: string[];
  logger?: boolean | { level: string };
  enableRateLimit?: boolean;
  rateLimitMax?: number;
  nodeEnv?: string;
  /**
   * Fastify só escuta 127.0.0.1; o hop confiável é o Nginx local.
   * Default: 127.0.0.1 e ::1. Não usar `true` (confiar em qualquer X-Forwarded-For).
   */
  trustProxy?: boolean | string | string[] | number;
};

const BODY_LIMIT_BYTES = 32 * 1024;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const secretsToRedact = (options.secretsToRedact ?? [])
    .concat([options.gatewayToken])
    .filter((s) => s.length >= 4);

  const trustProxy = options.trustProxy ?? [...TRUSTED_PROXY_ADDRESSES];

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level:
              typeof options.logger === "object"
                ? options.logger.level
                : "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.headers.Authorization",
                "err.stack",
              ],
              remove: true,
            },
          },
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 20_000,
    connectionTimeout: 20_000,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string") {
        const trimmed = incoming.trim();
        if (trimmed && trimmed.length <= 128 && /^[A-Za-z0-9._-]+$/.test(trimmed)) {
          return trimmed;
        }
      }
      return randomUUID();
    },
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  });

  if (options.enableRateLimit !== false) {
    await app.register(rateLimit, {
      max: options.rateLimitMax ?? 60,
      timeWindow: "1 minute",
      allowList: (req) => {
        const url = req.url.split("?")[0] ?? "";
        return url === "/health";
      },
    });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    if (containsSensitiveLeak(payload, secretsToRedact)) {
      request.log.error({ msg: "sensitive_leak_blocked", request_id: request.id });
      reply.code(500);
      return JSON.stringify(
        gatewayErrorBody(request.id, "internal_error", "Erro interno do gateway.", false),
      );
    }
    return payload;
  });

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path === "/health") return;
    if (!path.startsWith("/v1/")) return;
    if (request.method !== "GET" && request.method !== "HEAD") return;

    if (!isValidGatewayBearer(request.headers.authorization, options.gatewayToken)) {
      return reply
        .code(401)
        .send(gatewayErrorBody(request.id, "unauthorized", "Não autorizado.", false));
    }
  });

  registerHealthRoute(app);
  registerReservationRoutes(app, options.hitsClient);

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(gatewayErrorBody(request.id, "not_found", "Rota não encontrada.", false));
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    request.log.error({
      msg: "unhandled_error",
      request_id: request.id,
      code: (error as { code?: string }).code ?? "internal_error",
      http_status: statusCode,
    });
    if (reply.sent) return;
    if (statusCode === 429) {
      return reply
        .code(429)
        .send(
          gatewayErrorBody(request.id, "rate_limited", "Muitos pedidos. Tente novamente em instantes.", true),
        );
    }
    reply
      .code(500)
      .send(gatewayErrorBody(request.id, "internal_error", "Erro interno do gateway.", false));
  });

  return app;
}
