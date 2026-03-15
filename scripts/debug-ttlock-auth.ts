/**
 * Script para testar autenticação na TTLock Open Platform.
 * Uso: npm run debug:ttlock-auth
 * Envs: TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD
 */

import "dotenv/config";
import { getTtlockClient, getTtlockConfig } from "../src/lib/integrations/ttlock";

async function main() {
  const config = getTtlockConfig();
  console.log("TTLock config:");
  console.log("  tokenUrl:", config.tokenUrl);
  console.log("  apiBaseUrl:", config.apiBaseUrl);
  console.log("  hasCredentials:", config.hasCredentials);
  console.log("  enabled:", config.enabled);
  if (!config.hasCredentials) {
    console.log("\nFalta configurar envs:", [
      "TTLOCK_CLIENT_ID",
      "TTLOCK_CLIENT_SECRET",
      "TTLOCK_USERNAME",
      "TTLOCK_PASSWORD",
    ].join(", "));
    process.exitCode = 1;
    return;
  }

  const client = getTtlockClient();
  try {
    const token = await client.getAccessToken();
    console.log("\nToken obtido com sucesso.");
    console.log("  (access_token mascarado):", token.slice(0, 8) + "..." + token.slice(-4));
    process.exitCode = 0;
  } catch (e) {
    console.error("\nErro ao obter token:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

main();
