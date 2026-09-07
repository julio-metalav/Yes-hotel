/**
 * Reprocessa credenciais com pendência de sincronização (sync_status pending/partial/failed).
 * Uso:
 *   npm run debug:ttlock-retry-pending              -> lista e processa todas com pendência
 *   npm run debug:ttlock-retry-pending -- <credencial_id>  -> reprocessa apenas a credencial informada
 *
 * Envs: TTLOCK_* e SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import { retryCredentialSync } from "../src/lib/application/yes-hotel/credential-lifecycle";
import { createSupabaseProvisioningRepository } from "../src/lib/application/yes-hotel/supabase-provisioning-repo";
import { formatRetryResult } from "./_ttlock-log";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function main() {
  const credencialIdArg = process.argv[2];
  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();
  const deps = { repository: repo, ttlockClient: ttlock };

  if (credencialIdArg) {
    console.log("Reprocessando credencial:", credencialIdArg);
    const r = await retryCredentialSync(credencialIdArg, deps);
    console.log(formatRetryResult(r));
    console.log(r.syncStatusAfter === "ok" ? "Sucesso total." : "Ainda ha pendencia ou falha.");
    process.exit(r.itensFalha > 0 ? 1 : 0);
    return;
  }

  const pendentes = await repo.getCredenciaisComPendenciaSync();
  console.log("Credenciais com pendencia de sync:", pendentes.length);
  if (pendentes.length === 0) {
    console.log("Nenhuma credencial pendente.");
    process.exit(0);
    return;
  }

  let totalOk = 0;
  let totalFalha = 0;
  for (const c of pendentes) {
    console.log("\n---", c.id, "| reserva", c.reserva_id, "| sync_status", c.sync_status);
    const r = await retryCredentialSync(c.id, deps);
    console.log(formatRetryResult(r));
    totalOk += r.itensOk;
    totalFalha += r.itensFalha;
  }
  console.log("\nResumo: itens ok =", totalOk, "| itens falha =", totalFalha);
  process.exit(totalFalha > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
