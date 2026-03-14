import { authorizeHits, extractAccessToken, maskToken } from "../src/lib/integrations/hits";
import { printJson } from "./_shared";

async function main(): Promise<void> {
  const authResponse = await authorizeHits();
  const accessToken = extractAccessToken(authResponse);

  printJson("Resposta bruta de autenticacao", {
    ...authResponse,
    accessToken: authResponse.accessToken
      ? maskToken(authResponse.accessToken)
      : undefined,
    token: authResponse.token ? maskToken(authResponse.token) : undefined,
  });

  printJson("Resumo", {
    tokenMascara: maskToken(accessToken),
  });
}

main().catch((error) => {
  console.error("[hits-auth] erro:", error);
  process.exit(1);
});
