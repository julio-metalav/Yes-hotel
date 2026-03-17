/**
 * Limpeza em massa de senhas TTLock já vencidas (valido_ate passou há ≥ 2h).
 * Remove na TTLock e atualiza o item no banco; não toca em futuras nem em já revogados.
 *
 * PREMISSA TIMEZONE:
 * - operacional_credenciais_acesso.valido_ate é timestamptz (migration 0006).
 * - No PostgreSQL, timestamptz é armazenado em UTC; now() retorna em UTC no servidor.
 * - O script usa cutoff em UTC: now - 2 horas (Date em JS), comparado com valido_ate
 *   via .lt('valido_ate', cutoff.toISOString()). Assim a comparação é consistente (UTC).
 *
 * Uso:
 *   npx tsx scripts/cleanup-ttlock-expired.ts --dry-run
 *   npx tsx scripts/cleanup-ttlock-expired.ts --dry-run --limit 5
 *   npx tsx scripts/cleanup-ttlock-expired.ts --dry-run --credencial-id <uuid>
 *   npx tsx scripts/cleanup-ttlock-expired.ts --execute --limit 10
 *   npx tsx scripts/cleanup-ttlock-expired.ts --execute
 *
 * Flags:
 *   --dry-run       Apenas lista elegíveis; não chama TTLock nem atualiza banco (padrão se omitir --execute).
 *   --execute       Executa delete na TTLock e atualiza itens no banco. Obrigatório para sair do dry-run.
 *   --limit N       Limita a N itens processados (opcional; útil para teste ou rate limit).
 *   --credencial-id <id>  Restringe elegíveis a uma única credencial (opcional; útil para teste).
 *
 * Envs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TTLOCK_* (só necessários em --execute).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock";
import { createSupabaseProvisioningRepository } from "../src/lib/application/yes-hotel/supabase-provisioning-repo";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY_RUN_DEFAULT = true;
const CUTOFF_HOURS = 2;

interface Elegivel {
  id: string;
  credencial_id: string;
  codigo_logico_destino: string;
  remote_keyboard_pwd_id: number;
  status_provisionamento: string;
  lock_id_ttlock: string;
  valido_ate_credencial: string;
  revogado_em: string | null;
  ultimo_erro: string | null;
}

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

function parseArgs(): {
  dryRun: boolean;
  limit: number | null;
  credencialId: string | null;
} {
  const args = process.argv.slice(2);
  let dryRun = DRY_RUN_DEFAULT;
  let limit: number | null = null;
  let credencialId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") dryRun = false;
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--limit" && args[i + 1] != null) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isNaN(n) || n < 1) {
        console.error("--limit deve ser um número positivo.");
        process.exit(1);
      }
      limit = n;
      i++;
    } else if (args[i] === "--credencial-id" && args[i + 1] != null) {
      credencialId = args[i + 1].trim();
      i++;
    }
  }

  return { dryRun, limit, credencialId };
}

/**
 * Busca itens elegíveis: credencial com valido_ate em timestamptz < cutoff (UTC),
 * item com remote_keyboard_pwd_id preenchido e status provisionado ou pendente_limpeza.
 */
async function getElegiveis(
  supabase: ReturnType<typeof createClient>,
  cutoffIso: string,
  credencialIdFilter: string | null,
): Promise<Elegivel[]> {
  // Credenciais cuja validade terminou antes do cutoff (valido_ate em timestamptz = UTC no armazenamento).
  let credenciaisQuery = supabase
    .from("operacional_credenciais_acesso")
    .select("id, valido_ate")
    .lt("valido_ate", cutoffIso);

  if (credencialIdFilter) {
    credenciaisQuery = credenciaisQuery.eq("id", credencialIdFilter);
  }

  const { data: credenciais, error: errCred } = await credenciaisQuery.order("valido_ate", { ascending: true });
  if (errCred) throw new Error(`Credenciais: ${errCred.message}`);
  if (!credenciais?.length) return [];

  const credencialIds = credenciais.map((c: { id: string }) => c.id);
  const validoAteByCred = new Map(credenciais.map((c: { id: string; valido_ate: string }) => [c.id, c.valido_ate]));

  const { data: itens, error: errItens } = await supabase
    .from("operacional_credencial_itens")
    .select("id, credencial_id, codigo_logico_destino, remote_keyboard_pwd_id, status_provisionamento, lock_id_ttlock, revogado_em, ultimo_erro")
    .in("credencial_id", credencialIds)
    .not("remote_keyboard_pwd_id", "is", null)
    .in("status_provisionamento", ["provisionado", "pendente_limpeza"]);

  if (errItens) throw new Error(`Itens: ${errItens.message}`);
  if (!itens?.length) return [];

  const elegiveis: Elegivel[] = (itens as Array<Record<string, unknown>>).map((i) => ({
    id: i.id as string,
    credencial_id: i.credencial_id as string,
    codigo_logico_destino: i.codigo_logico_destino as string,
    remote_keyboard_pwd_id: i.remote_keyboard_pwd_id as number,
    status_provisionamento: i.status_provisionamento as string,
    lock_id_ttlock: i.lock_id_ttlock as string,
    valido_ate_credencial: validoAteByCred.get(i.credencial_id as string) ?? "",
    revogado_em: (i.revogado_em as string | null) ?? null,
    ultimo_erro: (i.ultimo_erro as string | null) ?? null,
  }));

  // Ordenar por valido_ate da credencial (mais antigos primeiro).
  elegiveis.sort((a, b) => {
    const ta = a.valido_ate_credencial;
    const tb = b.valido_ate_credencial;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.credencial_id.localeCompare(b.credencial_id) || a.codigo_logico_destino.localeCompare(b.codigo_logico_destino);
  });

  return elegiveis;
}

function printResumo(opts: {
  totalElegiveis: number;
  totalProcessados: number;
  totalSucesso: number;
  totalFalha: number;
  totalIgnorados: number;
  duracaoMs: number;
  dryRun: boolean;
}) {
  const {
    totalElegiveis,
    totalProcessados,
    totalSucesso,
    totalFalha,
    totalIgnorados,
    duracaoMs,
    dryRun,
  } = opts;
  console.log("\n--- Resumo final ---");
  console.log("Total elegíveis encontrados:", totalElegiveis);
  console.log("Total processados:", totalProcessados);
  console.log("Total sucesso:", totalSucesso);
  console.log("Total falha:", totalFalha);
  console.log("Total ignorados:", totalIgnorados);
  console.log("Duração total:", `${(duracaoMs / 1000).toFixed(2)}s`);
  if (dryRun) console.log("Modo: dry-run (nenhuma alteração feita).");
}

async function main() {
  const start = Date.now();
  const { dryRun, limit, credencialId } = parseArgs();

  // Cutoff: now - 2 horas em UTC (premissa: valido_ate é timestamptz, comparação consistente).
  const cutoff = new Date(Date.now() - CUTOFF_HOURS * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  console.log("Premissa timezone: valido_ate é timestamptz (UTC); cutoff = now() - 2h em UTC.");
  console.log("Cutoff usado:", cutoffIso);
  if (credencialId) console.log("Filtro credencial-id:", credencialId);
  if (limit != null) console.log("Limit:", limit);

  const supabase = getSupabase();
  const elegiveis = await getElegiveis(supabase, cutoffIso, credencialId);
  const totalElegiveis = elegiveis.length;

  const toProcess = limit != null ? elegiveis.slice(0, limit) : elegiveis;
  const totalProcessados = toProcess.length;
  const totalIgnorados = totalElegiveis - totalProcessados;

  if (dryRun) {
    console.log("\nItens elegíveis para limpeza (dry-run):");
    if (toProcess.length === 0) {
      console.log("(nenhum)");
    } else {
      for (const r of toProcess) {
        console.log(
          [
            r.id,
            r.credencial_id,
            r.codigo_logico_destino,
            r.remote_keyboard_pwd_id,
            r.status_provisionamento,
            r.valido_ate_credencial,
            r.revogado_em ?? "-",
            r.ultimo_erro ?? "-",
          ].join("\t"),
        );
      }
    }
    printResumo({
      totalElegiveis,
      totalProcessados: 0,
      totalSucesso: 0,
      totalFalha: 0,
      totalIgnorados,
      duracaoMs: Date.now() - start,
      dryRun: true,
    });
    process.exit(0);
    return;
  }

  // --execute
  const ttlock = getTtlockClient();
  if (!ttlock.isAvailable()) {
    console.error("TTLock não configurado. Defina TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.");
    process.exit(1);
  }
  const repo = createSupabaseProvisioningRepository(supabase);
  const now = new Date().toISOString();

  let totalSucesso = 0;
  let totalFalha = 0;

  for (const item of toProcess) {
    try {
      await ttlock.deleteKeyboardPassword({
        lockId: item.lock_id_ttlock,
        keyboardPwdId: item.remote_keyboard_pwd_id,
      });
      await repo.updateItem(item.id, {
        status_provisionamento: "revogado",
        revogado_em: now,
        ultimo_erro: null,
      });
      totalSucesso++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await repo.updateItem(item.id, {
        status_provisionamento: "pendente_limpeza",
        ultimo_erro: msg,
      });
      totalFalha++;
      console.error(`Falha item ${item.id} (${item.codigo_logico_destino}):`, msg);
    }
  }

  printResumo({
    totalElegiveis,
    totalProcessados,
    totalSucesso,
    totalFalha,
    totalIgnorados,
    duracaoMs: Date.now() - start,
    dryRun: false,
  });
  process.exit(totalFalha > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
