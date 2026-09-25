/**
 * Regressão estática do snapshot HITS: migration, Edge, módulo de sync e UI.
 * Sem rede / sem banco: só lê os arquivos do repo e confere contratos de
 * segurança (RLS, grants, allowlist de campos, nenhuma escrita no HITS,
 * UI sem leitura ao vivo) e compatibilidade do scheduler.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const MIGRATIONS_DIR = "supabase/migrations";
const EDGE = "supabase/functions/hits-reservations-preview/index.ts";
const SYNC = "src/lib/integrations/hits/hits-snapshot-sync.ts";
const PREVIEW = "ui/yes-hits-sandbox-preview.js";
const PAINEL = "ui/checkin-operacional-mvp.js";

let cases = 0;
function ok(label: string) {
  cases += 1;
  console.log(`  ok ${label}`);
}

function readRepo(rel: string): string {
  return readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function findMigration(suffix: string): string {
  const files = readdirSync(join(root, MIGRATIONS_DIR)).filter((f) => f.endsWith(suffix));
  assert.equal(files.length, 1, `esperava 1 migration ${suffix}, achei ${files.length}`);
  return join(MIGRATIONS_DIR, files[0]!);
}

/** Corpo de uma função plpgsql (entre o `as $$` e o `$$;` seguinte). */
function functionBody(sql: string, name: string): string {
  const head = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(head > -1, `função ${name} não encontrada`);
  const start = sql.indexOf("as $$", head);
  const end = sql.indexOf("$$;", start);
  assert.ok(start > head && end > start, `corpo de ${name} não delimitado`);
  return sql.slice(start, end);
}

function main() {
  const sql = readRepo(findMigration("_hits_reservas_snapshot.sql"));
  const lower = sql.toLowerCase();

  console.log("\n== Tabela: só o que a tela exibe ==");
  {
    const tabela = sql.slice(
      sql.indexOf("create table if not exists public.hits_reservas_snapshot"),
      sql.indexOf("comment on table public.hits_reservas_snapshot"),
    );
    for (const col of [
      "external_reservation_id text primary key",
      "apartamento text",
      "hospede_principal text",
      "check_in date",
      "check_out date",
      "status_reserva text",
      "ciclo_hits text",
      "total_hospedes integer",
      "source text",
      "batch_id uuid",
      "first_seen_at timestamptz",
      "last_seen_at timestamptz",
    ]) {
      assert.ok(tabela.includes(col), `coluna esperada ausente: ${col}`);
    }
    ok("colunas mínimas da área HITS presentes");

    const proibidas =
      /telefone|phone|email|e-mail|contact|documento|document|cpf|passaport|valor|balance|amount|payment|pagamento|cobranca|cart[aã]o|raw|payload|json/i;
    assert.doesNotMatch(tabela, proibidas, "coluna sensível na projeção");
    ok("nenhuma coluna de contato, documento, financeiro ou payload bruto");

    assert.match(tabela, /source text not null default 'hits'\s*\n?\s*check \(source = 'hits'\)/);
    ok("source fixo em hits");
  }

  console.log("\n== RLS e grants ==");
  {
    for (const t of ["hits_reservas_snapshot", "hits_snapshot_sync_state"]) {
      assert.ok(
        lower.includes(`alter table public.${t} enable row level security;`),
        `RLS não habilitado em ${t}`,
      );
      assert.ok(
        lower.includes(`revoke all on table public.${t} from public, anon;`),
        `anon não revogado em ${t}`,
      );
      assert.ok(lower.includes(`grant select on table public.${t} to authenticated;`));
      assert.ok(
        !new RegExp(`grant\\s+(all|insert|update|delete)[^;]*on table public\\.${t}`, "i").test(sql),
        `grant de escrita indevido em ${t}`,
      );
      const policy = sql.slice(sql.indexOf(`create policy ${t}_select_perfis`));
      const head = policy.slice(0, policy.indexOf(";") + 1);
      assert.match(head, /for select/);
      assert.match(head, /to authenticated/);
      assert.match(head, /public\.is_yes_hotel_ops_reader\(\)/);
      assert.match(head, /public\.is_yes_hotel_hits_consulta_reader\(\)/);
    }
    ok("RLS ligado, anon sem nada, SELECT só authenticated com gate por perfil (ops + hits_consulta)");

    assert.doesNotMatch(sql, /for (insert|update|delete|all)\b/i, "policy de escrita não deve existir");
    ok("nenhuma policy de INSERT/UPDATE/DELETE: escrita só por service_role via RPC");
  }

  console.log("\n== RPCs: service_role apenas, search_path seguro ==");
  {
    const fns: Array<[string, string]> = [
      ["hits_snapshot_sync_start", "hits_snapshot_sync_start(uuid)"],
      ["hits_snapshot_sync_apply", "hits_snapshot_sync_apply(uuid, jsonb, text[], text, text)"],
      ["hits_snapshot_sync_fail", "hits_snapshot_sync_fail(uuid, text)"],
    ];
    for (const [name, sig] of fns) {
      const head = sql.slice(
        sql.indexOf(`create or replace function public.${name}(`),
        sql.indexOf("as $$", sql.indexOf(`create or replace function public.${name}(`)),
      );
      assert.match(head, /security definer/, `${name} sem security definer`);
      assert.match(head, /set search_path = ''/, `${name} sem search_path vazio`);
      assert.ok(
        lower.includes(`revoke all on function public.${sig} from public, anon, authenticated;`) ||
          lower.includes(`revoke all on function public.${sig}\n  from public, anon, authenticated;`),
        `${name}: revoke incompleto`,
      );
      assert.ok(
        lower.includes(`grant execute on function public.${sig} to service_role;`) ||
          lower.includes(`grant execute on function public.${sig}\n  to service_role;`),
        `${name}: grant a service_role ausente`,
      );
      assert.ok(
        !new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s*to (authenticated|anon|public)`, "i").test(sql),
        `${name}: grant indevido a authenticated/anon`,
      );
    }
    ok("3 RPCs security definer, search_path vazio, EXECUTE só service_role");

    const fail = functionBody(sql, "hits_snapshot_sync_fail");
    assert.doesNotMatch(fail, /delete from|insert into|truncate|hits_reservas_snapshot/i);
    assert.match(fail, /last_status = 'error'/);
    ok("fail só registra o erro: nunca toca em hits_reservas_snapshot");

    const start = functionBody(sql, "hits_snapshot_sync_start");
    assert.doesNotMatch(start, /delete from|insert into|truncate|hits_reservas_snapshot/i);
    ok("start só marca o ciclo: nunca toca em hits_reservas_snapshot");

    const apply = functionBody(sql, "hits_snapshot_sync_apply");
    assert.match(apply, /on conflict \(external_reservation_id\) do update/);
    assert.match(apply, /where s\.batch_id <> p_batch_id/);
    assert.match(apply, /not \(s\.external_reservation_id = any \(v_failed_ids\)\)/);
    assert.doesNotMatch(apply, /truncate/i);
    assert.match(apply, /p_status not in \('ok', 'partial'\)/);
    ok("apply: upsert por lote + remoção só do que não veio e não falhou; sem truncate");

    const upsertCols = apply.slice(apply.indexOf("insert into public.hits_reservas_snapshot"), apply.indexOf("select\n", apply.indexOf("insert into public.hits_reservas_snapshot")));
    assert.doesNotMatch(upsertCols, /phone|email|contact|document|cpf|balance|amount|raw/i);
    ok("apply grava apenas as colunas da projeção (allowlist no SQL)");
  }

  console.log("\n== Edge: mesma leitura, grava só na forma do scheduler ==");
  {
    const edge = readRepo(EDGE);
    assert.match(edge, /hits-snapshot-sync\.ts/);
    assert.match(edge, /shouldPersistSnapshot\(/);
    assert.match(edge, /runHitsSnapshotSync\(/);
    assert.match(edge, /HITS_SNAPSHOT_WRITE_ENV/);
    assert.match(edge, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(edge, /if \(req\.method !== "GET"\)/, "continua GET-only");
    // Única leitura direta permitida: o cursor da incremental (select em
    // hits_snapshot_sync_state). Escrita continua só por RPC.
    // Leituras diretas permitidas: cursor da incremental e existência local
    // (materialização automática). Escrita continua só por RPC/helper.
    const froms = edge.match(/\.from\("([^"]+)"\)/g) ?? [];
    assert.deepEqual(
      [...new Set(froms)].sort(),
      ['.from("hits_snapshot_sync_state")', '.from("operacional_reservas")'],
      "Edge só lê estado do snapshot e existência em operacional_reservas",
    );
    assert.doesNotMatch(edge, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/, "Edge não escreve em tabela direto: só RPC");
    // A Edge só CONSULTA existência em operacional_reservas (materialização
    // automática); a escrita fica no helper hits-materializar.ts.
    assert.doesNotMatch(edge, /operacional_hospedes/);
    assert.doesNotMatch(edge, /\.from\("operacional_reservas"\)\s*\.(insert|update|delete|upsert)\(/);
    assert.match(edge, /fetchHitsSandboxReservations\(/);
    ok("Edge importa o módulo, decide por forma da chamada e grava só por RPC");

    // Sem a trava, o corpo de resposta continua com os mesmos campos (rollback simples).
    for (const campo of ["read_only: true", "rows: result.rows", "failed: result.failed", "stopped_reason"]) {
      assert.ok(edge.includes(campo), `campo de resposta ${campo} sumiu`);
    }
    ok("contrato de resposta preservado (rows/failed/stopped_reason)");
  }

  console.log("\n== Módulo de sync: nenhuma escrita no HITS ==");
  {
    const sync = readRepo(SYNC);
    assert.doesNotMatch(sync, /fetch\(|createHitsTransport|\/v1\/|hitspms|guests|check-?in\b/i);
    assert.doesNotMatch(sync, /import .* from "\.\/transport|hits-client/);
    assert.match(sync, /HITS_SNAPSHOT_AD_HOC_PARAMS = \["ids", "date_from", "date_to", "page", "size"\]/);
    ok("módulo não tem rede: só decide, mapeia e chama RPC injetada");
  }

  console.log("\n== UI: lê o snapshot, nunca a Edge ==");
  {
    // Só código: o cabeçalho do módulo explica que a Edge é do scheduler, não da tela.
    const js = readRepo(PREVIEW)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(js, /hits-reservations-preview|functions\/v1|getEdgeFunctionFetchHeaders/);
    assert.doesNotMatch(js, /\bfetch\(/, "sem fetch: só supabase-js");
    assert.match(js, /from\(SNAPSHOT_TABLE\)/);
    assert.match(js, /SNAPSHOT_TABLE = "hits_reservas_snapshot"/);
    assert.match(js, /SYNC_STATE_TABLE = "hits_snapshot_sync_state"/);
    assert.doesNotMatch(js, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/, "UI somente leitura");
    // Colunas pedidas ao banco (não o objeto neutro da grade, que tem `pagamento: "desconhecido"`).
    const colunas = (js.match(/SNAPSHOT_COLUMNS =\s*"([^"]+)"/) ?? [])[1] ?? "";
    const colunasEstado = (js.match(/SYNC_STATE_COLUMNS =\s*"([^"]+)"/) ?? [])[1] ?? "";
    assert.ok(colunas.length > 0 && colunasEstado.length > 0, "colunas explícitas");
    assert.doesNotMatch(colunas + colunasEstado, /\*|telefone|phone|email|documento|cpf|balance|pagamento/i, "UI não pede colunas sensíveis");
    ok("preview: dois SELECTs locais, sem Edge, sem escrita, sem colunas sensíveis");

    for (const msg of [
      "dados ainda não sincronizados",
      "falhou — exibindo dados de",
      "dados desatualizados",
    ]) {
      assert.ok(js.includes(msg), `mensagem de saúde ausente: ${msg}`);
    }
    ok("indicador de saúde: sem snapshot / falhou com dados antigos / desatualizado");

    const painel = readRepo(PAINEL);
    assert.match(painel, /const HITS_RECONCILIAR_CANCELADAS_AO_VIVO = false;/);
    assert.match(
      painel,
      /HITS_RECONCILIAR_CANCELADAS_AO_VIVO &&[\s\S]{0,120}await reconciliarCanceladasHits/,
    );
    const carga = painel.slice(painel.indexOf("async function carregarUniversoHits"));
    const cargaBody = carga.slice(0, carga.indexOf("\n}\n"));
    assert.doesNotMatch(cargaBody, /dateFrom|resolveHitsReadWindow/, "sem janela: o snapshot é do scheduler");
    ok("painel: reconciliação ao vivo desligada; carga sem janela/Edge");
  }

  console.log("\n== Scheduler: intacto e compatível ==");
  {
    const cron = readRepo(findMigration("hits_reservations_preview_scheduler_cron.sql"));
    const urls = cron.match(/url := '[^']+'/g) ?? [];
    assert.equal(urls.length, 5);
    for (const u of urls) {
      assert.match(u, /\/functions\/v1\/hits-reservations-preview'$/, "sem query string: forma do scheduler");
    }
    const cronCode = cron.replace(/^\s*--.*$/gm, "");
    assert.doesNotMatch(cronCode, /net\.http_post/);
    ok("5 jobs continuam GET sem parâmetros → é a forma que alimenta o snapshot");
  }

  console.log(`\nOK test-hits-snapshot-migration (${cases} casos)`);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
