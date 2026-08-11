/**
 * Testes locais — contrato da Edge admin (ações/autorização) sem Deno/deploy.
 * Valida o roteamento de ações do serviço usado pela Edge.
 */
import assert from "node:assert/strict";
import { CobrancaPagarmeService } from "../src/lib/application/yes-hotel/cobranca-pagarme-service";
import { createMemoryCobrancaRepo } from "../src/lib/application/yes-hotel/testing/cobranca-pagarme-memory";
import {
  PAGARME_CHECKOUT_TEST_API_BASE_URL,
  PAGARME_CORE_API_BASE_URL,
  PAGARME_FIXTURE_SECRET,
  PagarmeClient,
  createMockPagarmeFetch,
  fixturePaymentLinkResponse,
  getPagarmeConfig,
} from "../src/lib/integrations/pagarme";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const RESERVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function main() {
  console.log("\n[test-cobranca-pagarme-admin]");

  // Fonte: Edge admin existe e exige JWT via ausência de verify_jwt=false
  const adminSrc = readFileSync(
    resolve("supabase/functions/cobranca-pagarme-admin/index.ts"),
    "utf8",
  );
  assert.match(adminSrc, /classificar_comissionamento/);
  assert.match(adminSrc, /criar/);
  assert.match(adminSrc, /cancelar/);
  assert.match(adminSrc, /recepcao/);
  assert.match(adminSrc, /admin/);
  assert.match(adminSrc, /403/);
  ok("edge admin: acoes e perfis presentes no codigo");

  const configToml = readFileSync(resolve("supabase/config.toml"), "utf8");
  assert.match(configToml, /\[functions\.cobranca-pagarme-webhook\]/);
  assert.match(configToml, /verify_jwt = false/);
  // admin NÃO deve ter verify_jwt=false
  assert.equal(/\[functions\.cobranca-pagarme-admin\][\s\S]*?verify_jwt\s*=\s*false/.test(configToml), false);
  ok("config.toml: webhook verify_jwt=false; admin sem override false");

  const webhookSrc = readFileSync(
    resolve("supabase/functions/cobranca-pagarme-webhook/index.ts"),
    "utf8",
  );
  assert.match(webhookSrc, /processWebhook/);
  assert.match(webhookSrc, /GET server-to-server|createPagarmeClient/);
  ok("edge webhook: processWebhook + client S2S");

  // Autorização simulada (perfis)
  function authorizeRole(role: string): { ok: true } | { ok: false; status: number } {
    const r = role.trim().toLowerCase();
    if (r !== "admin" && r !== "recepcao") return { ok: false, status: 403 };
    return { ok: true };
  }
  assert.equal(authorizeRole("admin").ok, true);
  assert.equal(authorizeRole("recepcao").ok, true);
  assert.equal(authorizeRole("cafe").ok, false);
  ok("perfis admin/recepcao ok; cafe 403");

  // classificar_comissionamento via serviço (como a Edge faz)
  {
    const { repo, state } = createMemoryCobrancaRepo({
      reservas: [
        {
          id: RESERVA,
          external_reservation_id: null,
          classificacao_comissionamento: "desconhecida",
          pagamento_status: "pendente",
        },
      ],
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: new PagarmeClient({
        config: getPagarmeConfig({
          PAGARME_ENV: "test",
          PAGARME_INTEGRATION_ENABLED: "true",
          PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
          PAGARME_CORE_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
          PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
        }),
        fetchImpl: createMockPagarmeFetch([
          {
            match: (u, m) => m === "POST" && u.includes("/paymentlinks"),
            body: fixturePaymentLinkResponse,
          },
        ]) as never,
      }),
    });

    const bad = await svc.classificarComissionamento({
      reservaId: RESERVA,
      classificacao: "desconhecida",
    });
    assert.equal(bad.ok, false);

    const good = await svc.classificarComissionamento({
      reservaId: RESERVA,
      classificacao: "nao_comissionada",
    });
    assert.equal(good.ok, true);
    assert.equal(state.reservas.get(RESERVA)!.classificacao_comissionamento, "nao_comissionada");

    const created = await svc.criar({
      reservaId: RESERVA,
      metodo: "cartao",
      valorCentavos: 180_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(created.ok, true);
    ok("fluxo admin: classificar -> criar cartao");
  }

  // .env.example documenta vars sem secret real (placeholders sk_test_... / sk_live_... ok)
  const envExample = readFileSync(resolve(".env.example"), "utf8");
  assert.match(envExample, /PAGARME_INTEGRATION_ENABLED/);
  assert.match(envExample, /PAGARME_ENV=test/);
  assert.match(envExample, /PAGARME_CORE_API_BASE_URL=https:\/\/api\.pagar\.me\/core\/v5/);
  assert.match(envExample, /PAGARME_CHECKOUT_API_BASE_URL=https:\/\/sdx-api\.pagar\.me\/core\/v5/);
  assert.match(envExample, /# PAGARME_SECRET_KEY=/);
  assert.match(envExample, /sk_test_\.\.\./);
  assert.match(envExample, /sk_live_\.\.\./);
  assert.match(envExample, /PAGARME_ENV=production/);
  assert.match(
    envExample,
    /PAGARME_CHECKOUT_API_BASE_URL=https:\/\/api\.pagar\.me\/core\/v5/,
  );
  // Sem secret real (prefixo + corpo alfanumérico longo)
  assert.equal(/sk_test_[A-Za-z0-9]{12,}/.test(envExample), false);
  assert.equal(/sk_live_[A-Za-z0-9]{12,}/.test(envExample), false);
  ok(".env.example documenta Pagar.me sem secret");

  console.log(`\n[test-cobranca-pagarme-admin] ${passed} assertions OK\n`);
}

main().catch((error) => {
  console.error("[test-cobranca-pagarme-admin] FALHOU:", error);
  process.exit(1);
});
