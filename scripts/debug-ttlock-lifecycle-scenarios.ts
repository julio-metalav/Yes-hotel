/**
 * Script para simular cenários de ciclo de vida TTLock (Fase 3).
 * Uso: npm run debug:ttlock-lifecycle -- <cenario> [args...]
 *
 * Cenários:
 *   cancellation <reserva_id>     -> revoga credencial (motivo cancelamento)
 *   checkout <reserva_id>         -> revoga credencial (motivo checkout)
 *   early-checkin <credencial_id> <novo_valido_de_ISO>
 *   late-checkout <credencial_id> <novo_valido_ate_ISO>
 *   room-change <reserva_id> <novo_apartamento>   -> ex: room-change <reserva_id> 12
 *   manual-revoke <credencial_id>
 *   manual-validity <credencial_id> <valido_de_ISO> <valido_ate_ISO>
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import {
  handleCancellation,
  handleCheckout,
  handleEarlyCheckin,
  handleLateCheckout,
  handleRoomChange,
  revokeCredential,
  updateCredentialValidity,
} from "../src/lib/application/yes-hotel/credential-lifecycle";
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
  const cenario = process.argv[2]?.toLowerCase();
  const args = process.argv.slice(3);
  const supabase = getSupabase();
  const repo = createSupabaseProvisioningRepository(supabase);
  const ttlock = getTtlockClient();
  const deps = { repository: repo, ttlockClient: ttlock };

  if (!cenario) {
    console.log("Cenários: cancellation, checkout, early-checkin, late-checkout, room-change, manual-revoke, manual-validity");
    console.log("Ex: npm run debug:ttlock-lifecycle -- cancellation <reserva_id>");
    process.exit(1);
  }

  switch (cenario) {
    case "cancellation": {
      const reservaId = args[0];
      if (!reservaId) {
        console.log("Uso: debug:ttlock-lifecycle -- cancellation <reserva_id>");
        process.exit(1);
      }
      const r = await handleCancellation(reservaId, deps);
      console.log("Cancelamento:", r ? JSON.stringify(r, null, 2) : "Nenhuma credencial encontrada para a reserva.");
      process.exit(r && r.itensFalha > 0 ? 1 : 0);
    }
    case "checkout": {
      const reservaId = args[0];
      if (!reservaId) {
        console.log("Uso: debug:ttlock-lifecycle -- checkout <reserva_id>");
        process.exit(1);
      }
      const r = await handleCheckout(reservaId, deps);
      console.log("Checkout:", r ? JSON.stringify(r, null, 2) : "Nenhuma credencial encontrada para a reserva.");
      process.exit(r && r.itensFalha > 0 ? 1 : 0);
    }
    case "early-checkin": {
      const credencialId = args[0];
      const novoValidoDe = args[1];
      if (!credencialId || !novoValidoDe) {
        console.log("Uso: debug:ttlock-lifecycle -- early-checkin <credencial_id> <novo_valido_de_ISO>");
        process.exit(1);
      }
      const r = await handleEarlyCheckin(credencialId, deps, novoValidoDe);
      console.log("Early check-in:", JSON.stringify(r, null, 2));
      process.exit(r.itensFalha > 0 ? 1 : 0);
    }
    case "late-checkout": {
      const credencialId = args[0];
      const novoValidoAte = args[1];
      if (!credencialId || !novoValidoAte) {
        console.log("Uso: debug:ttlock-lifecycle -- late-checkout <credencial_id> <novo_valido_ate_ISO>");
        process.exit(1);
      }
      const r = await handleLateCheckout(credencialId, deps, novoValidoAte);
      console.log("Late check-out:", JSON.stringify(r, null, 2));
      process.exit(r.itensFalha > 0 ? 1 : 0);
    }
    case "room-change": {
      const reservaId = args[0];
      const novoApt = args[1];
      if (!reservaId || novoApt === undefined) {
        console.log("Uso: debug:ttlock-lifecycle -- room-change <reserva_id> <novo_apartamento>");
        process.exit(1);
      }
      const r = await handleRoomChange(reservaId, deps, String(novoApt));
      console.log("Room change:", JSON.stringify(r, null, 2));
      process.exit(r.falhas > 0 ? 1 : 0);
    }
    case "manual-revoke": {
      const credencialId = args[0];
      if (!credencialId) {
        console.log("Uso: debug:ttlock-lifecycle -- manual-revoke <credencial_id>");
        process.exit(1);
      }
      const r = await revokeCredential(credencialId, deps, "ajuste_manual");
      console.log("Revogação manual:", JSON.stringify(r, null, 2));
      process.exit(r.itensFalha > 0 ? 1 : 0);
    }
    case "manual-validity": {
      const credencialId = args[0];
      const validoDe = args[1];
      const validoAte = args[2];
      if (!credencialId || !validoDe || !validoAte) {
        console.log("Uso: debug:ttlock-lifecycle -- manual-validity <credencial_id> <valido_de_ISO> <valido_ate_ISO>");
        process.exit(1);
      }
      const r = await updateCredentialValidity(credencialId, deps, {
        valido_de: validoDe,
        valido_ate: validoAte,
      });
      console.log("Validade manual:", JSON.stringify(r, null, 2));
      process.exit(r.itensFalha > 0 ? 1 : 0);
    }
    default:
      console.log("Cenário desconhecido:", cenario);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
