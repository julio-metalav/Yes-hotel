/**
 * Script para testar reprovisionamento de credencial TTLock (Fase 3).
 * Revoga itens atuais e provisiona itens pendentes (mesmo passcode quando possível).
 * Uso: npm run debug:ttlock-reprovision -- <credencial_id>
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import { reprovisionCredential } from "../src/lib/application/yes-hotel/credential-lifecycle";
import { createSupabaseProvisioningRepository } from "../src/lib/application/yes-hotel/supabase-provisioning-repo";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function main() {
  const credencialId = process.argv[2];
  if (!credencialId) {
    console.log("Uso: npm run debug:ttlock-reprovision -- <credencial_id>");
    process.exit(1);
  }

  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();
  const result = await reprovisionCredential(credencialId, { repository: repo, ttlockClient: ttlock });

  console.log("Resultado reprovisionamento:", JSON.stringify(result, null, 2));
  console.log("Status:", result.status);
  console.log("Revogados:", result.revogados, "| Provisionados:", result.provisionados, "| Falhas:", result.falhas);
  if (result.passcode) console.log("Passcode:", result.passcode);
  if (result.erros.length) console.log("Erros:", result.erros);
  process.exit(result.falhas > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
