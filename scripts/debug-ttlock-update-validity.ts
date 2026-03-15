/**
 * Script para testar alteração de validade de credencial TTLock (Fase 3).
 * Uso: npm run debug:ttlock-update-validity -- <credencial_id> <valido_de_ISO> <valido_ate_ISO>
 * Exemplo: npm run debug:ttlock-update-validity -- <uuid> 2025-03-20T13:00:00Z 2025-03-22T11:00:00Z
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import { updateCredentialValidity } from "../src/lib/application/yes-hotel/credential-lifecycle";
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
  const validoDe = process.argv[3];
  const validoAte = process.argv[4];
  if (!credencialId || !validoDe || !validoAte) {
    console.log("Uso: npm run debug:ttlock-update-validity -- <credencial_id> <valido_de_ISO> <valido_ate_ISO>");
    process.exit(1);
  }

  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();
  const result = await updateCredentialValidity(
    credencialId,
    { repository: repo, ttlockClient: ttlock },
    { valido_de: validoDe, valido_ate: validoAte },
  );

  console.log("Resultado atualização validade:", JSON.stringify(result, null, 2));
  console.log("Itens atualizados no TTLock:", result.itensAtualizados, "| Falhas:", result.itensFalha);
  if (result.erros.length) console.log("Erros:", result.erros);
  process.exit(result.itensFalha > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
