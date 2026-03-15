/**
 * Script para testar revogação de credencial TTLock (Fase 3).
 * Uso: npm run debug:ttlock-revoke -- <credencial_id> [motivo]
 * Motivo padrão: ajuste_manual. Opções: cancelamento, checkout, room_change, ajuste_manual, encerramento_operacional
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import { revokeCredential } from "../src/lib/application/yes-hotel/credential-lifecycle";
import { createSupabaseProvisioningRepository } from "../src/lib/application/yes-hotel/supabase-provisioning-repo";
import type { MotivoRevogacao } from "../src/lib/application/yes-hotel/credential-lifecycle";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

const MOTIVOS: MotivoRevogacao[] = [
  "cancelamento",
  "checkout",
  "room_change",
  "ajuste_manual",
  "encerramento_operacional",
];

async function main() {
  const credencialId = process.argv[2];
  const motivoArg = process.argv[3] ?? "ajuste_manual";
  if (!credencialId) {
    console.log("Uso: npm run debug:ttlock-revoke -- <credencial_id> [motivo]");
    console.log("Motivos:", MOTIVOS.join(", "));
    process.exit(1);
  }
  const motivo = MOTIVOS.includes(motivoArg as MotivoRevogacao)
    ? (motivoArg as MotivoRevogacao)
    : "ajuste_manual";

  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();
  const result = await revokeCredential(credencialId, { repository: repo, ttlockClient: ttlock }, motivo);

  console.log("Resultado revogação:", JSON.stringify(result, null, 2));
  console.log("Status:", result.status);
  console.log("Itens revogados:", result.itensRevogados, "| Falhas:", result.itensFalha);
  if (result.erros.length) console.log("Erros:", result.erros);
  process.exit(result.itensFalha > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
