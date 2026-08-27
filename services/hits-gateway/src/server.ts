/**
 * Processo HTTP do Gateway HITS.
 * Escuta somente 127.0.0.1. Nginx é o único ponto público.
 */

import { createHitsReadClient } from "./hits-client.ts";
import {
  GATEWAY_BIND_HOST,
  assertGatewayTokenOrThrow,
  loadGatewayConfig,
} from "./config.ts";
import { buildApp } from "./app.ts";

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  assertGatewayTokenOrThrow(config.gatewayToken);

  const hitsClient = config.hitsReady ? createHitsReadClient(config.hits) : null;

  const app = await buildApp({
    gatewayToken: config.gatewayToken,
    hitsClient,
    secretsToRedact: [
      config.gatewayToken,
      config.hits.sharedAccessSecret,
    ],
    guestWriteEnabled: config.guestWriteEnabled,
    nodeEnv: config.nodeEnv,
    enableRateLimit: true,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ msg: "shutdown", signal });
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await app.listen({ host: GATEWAY_BIND_HOST, port: config.port });
  app.log.info({
    msg: "hits_gateway_listening",
    host: GATEWAY_BIND_HOST,
    port: config.port,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "falha ao iniciar";
  console.error("[hits-gateway] start failed:", message);
  process.exit(1);
});
