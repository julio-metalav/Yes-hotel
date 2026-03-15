/**
 * Script para executar provisionamento TTLock (passcode temporário) em credenciais.
 * Uso:
 *   npm run debug:ttlock-provision              -> processa todas as credenciais pendentes
 *   npm run debug:ttlock-provision -- <id>     -> processa apenas a credencial com o id informado
 *
 * Envs: TTLOCK_* para API; SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para banco.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import {
  processarCredencialDeAcesso,
  processarProvisionamentosPendentes,
} from "../src/lib/application/yes-hotel/provisioning-executor";
import { createSupabaseProvisioningRepository } from "../src/lib/application/yes-hotel/supabase-provisioning-repo";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Defina SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY para usar o script.",
    );
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function main() {
  const credencialIdArg = process.argv.slice(2)[0];

  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();

  if (!ttlock.isAvailable()) {
    console.log("TTLock: credenciais nao configuradas. Itens serao marcados com erro controlado.");
    console.log("Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD para provisionar de verdade.");
  }

  const deps = { repository: repo, ttlockClient: ttlock };

  if (credencialIdArg) {
    console.log("Processando credencial:", credencialIdArg);
    const result = await processarCredencialDeAcesso(credencialIdArg, deps);
    console.log("Resultado:", JSON.stringify(result, null, 2));
    console.log("Status final:", result.status);
    if (result.passcode) console.log("Passcode (guardado na credencial):", result.passcode);
    if (result.erros.length) console.log("Erros:", result.erros);
    process.exitCode = result.falhas > 0 && result.provisionados === 0 ? 1 : 0;
    return;
  }

  console.log("Processando todas as credenciais pendentes...");
  const results = await processarProvisionamentosPendentes(deps);
  console.log("Credenciais processadas:", results.length);
  for (const r of results) {
    console.log(`  ${r.credencialId}: ${r.status} (${r.provisionados}/${r.totalItens} itens)`);
    if (r.erros.length) console.log("    Erros:", r.erros);
  }
  const totalFalhas = results.reduce((s, r) => s + r.falhas, 0);
  const totalOk = results.reduce((s, r) => s + r.provisionados, 0);
  console.log("Resumo: total itens ok =", totalOk, ", total itens falha =", totalFalhas);
  process.exitCode = totalFalhas > 0 && totalOk === 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
