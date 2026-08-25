/**
 * Demandas UI/migration/auth — existência, dashboard comum, regressão de login.
 * Sem I/O de rede. Sem aplicar migration.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}
function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

console.log("\n=== Demandas UI + fundação SQL ===\n");

const files = [
  "ui/demandas-mvp.html",
  "ui/demandas-mvp.js",
  "ui/demandas-mvp.css",
  "ui/yes-demandas-photo.js",
  "supabase/functions/demandas-foto-upload/index.ts",
  "supabase/migrations/20260825033658_demandas_manutencao_predial_core_v1.sql",
];
for (const rel of files) {
  assert.equal(existsSync(join(root, rel)), true, `falta ${rel}`);
}
ok("arquivos da tela, edge e migration existem");

const sql = read("supabase/migrations/20260825033658_demandas_manutencao_predial_core_v1.sql");
const html = read("ui/demandas-mvp.html");
const pageSrc = read("ui/demandas-mvp.js");
const photoSrc = read("ui/yes-demandas-photo.js");
const loginJs = read("ui/usuarios-login-mvp.js");
const loginHtml = read("ui/usuarios-login-mvp.html");
const indexHtml = read("ui/index.html");
const authSrc = read("ui/yes-supabase-auth.js");
const edgeSrc = read("supabase/functions/demandas-foto-upload/index.ts");
const usersEdge = read("supabase/functions/internal-users-admin/index.ts");

{
  for (const table of [
    "demandas",
    "demandas_pausas",
    "demandas_historico",
    "demandas_anexos",
    "demandas_geo_checks",
    "demandas_modelos_programados",
    "demandas_ocorrencias_programadas",
    "hotel_geo_config",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(sql, /telefone_whatsapp/);
  assert.match(sql, /'agendada'/);
  assert.match(sql, /'nao_iniciada'/);
  assert.match(sql, /'em_andamento'/);
  assert.match(sql, /'pausada'/);
  assert.match(sql, /'aguardando_validacao'/);
  assert.match(sql, /'em_correcao'/);
  assert.match(sql, /'concluida'/);
  assert.match(sql, /'cancelada'/);
  ok("migration declara tabelas, telefone e oito status");
}

{
  for (const fn of [
    "demandas_criar",
    "demandas_editar",
    "demandas_iniciar",
    "demandas_pausar",
    "demandas_retomar",
    "demandas_enviar_validacao",
    "demandas_aprovar",
    "demandas_rejeitar",
    "demandas_cancelar",
    "demandas_reabrir",
    "demandas_atualizar_geo_config",
    "demandas_registrar_anexo",
    "demandas_haversine_meters",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}`));
  }
  assert.doesNotMatch(sql, /demandas_set_status/);
  assert.match(sql, /demandas_historico é append-only/);
  assert.match(sql, /demandas_delete_proibido/);
  assert.match(sql, /demandas_pausas_aberta_uidx/);
  assert.match(sql, /bucket_id = 'demandas-fotos'/);
  assert.match(sql, /public = excluded\.public/);
  assert.match(sql, /ativo = false/);
  assert.match(sql, /Higienização das sete caixas-d’água da laje/);
  assert.match(sql, /Dedetização e controle de pragas/);
  assert.match(sql, /unique \(modelo_id, data_programada_inicio\)/);
  assert.doesNotMatch(sql, /pg_cron|demandas_gerar_ocorrencia/);
  ok("RPCs atômicas, bucket privado, seed 18 desativados, sem cron");
}

{
  assert.match(html, /capture="environment"/);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /type="file"/);
  assert.match(photoSrc, /1600/);
  assert.match(photoSrc, /0\.8/);
  assert.match(pageSrc, /demandas_criar/);
  assert.match(pageSrc, /demandas_iniciar/);
  assert.match(pageSrc, /createSignedUrl/);
  assert.match(pageSrc, /America\/Campo_Grande/);
  assert.match(edgeSrc, /demandas-fotos/);
  assert.match(edgeSrc, /demandas_registrar_anexo/);
  assert.doesNotMatch(edgeSrc, /getPublicUrl/);
  ok("fotos privadas, compactação e câmera no celular");
}

{
  assert.match(loginHtml, /Minhas demandas/);
  assert.match(loginHtml, /data-nav="demandas"/);
  assert.match(indexHtml, /Minhas demandas/);
  assert.match(loginJs, /function renderDashboard/);
  assert.match(loginJs, /applyDashboardCards/);
  assert.doesNotMatch(loginJs, /window\.location\.href = "\.\/recepcao-mvp\.html"/);
  assert.doesNotMatch(loginJs, /window\.location\.href = "\.\/cafe-da-manha-mvp\.html";/);
  assert.match(loginJs, /cafe-da-manha-mvp\.html\?demo=1/);
  assert.match(authSrc, /function canAccessDemandas/);
  assert.match(loginHtml, /telefoneWhatsapp/);
  assert.match(usersEdge, /telefone_whatsapp/);
  assert.match(loginHtml, /usuarios-login-mvp\.js\?v=8/);
  ok("dashboard comum, telefone e regressão do redirect de login");
}

{
  const checkin = read("ui/checkin-operacional-mvp.html");
  const cafe = read("ui/cafe-da-manha-mvp.html");
  const recepcao = read("ui/recepcao-mvp.html");
  const gestao = read("ui/gestao-saude-hotel.html");
  const wifi = read("ui/apartamentos-wifi-mvp.html");
  const fin = read("ui/financeiro-conciliacao.html");
  for (const src of [checkin, cafe, recepcao, gestao, wifi, fin]) {
    assert.match(src, /demandas-mvp\.html/);
  }
  assert.equal(cafe.includes("financeiro-conciliacao.html"), false);
  assert.equal(cafe.includes("gestao-saude-hotel.html"), false);
  ok("Demandas na sidebar operacional; café sem Gestão/Financeiro");
}

{
  assert.match(sql, /America\/Campo_Grande/);
  assert.match(sql, /row_version/);
  assert.match(sql, /demandas_autoaprovacao_proibida/);
  assert.match(sql, /demandas_geo_nao_configurada/);
  assert.match(sql, /security_invoker = true/);
  ok("concorrência, autoaprovação e geo no backend");
}

console.log(`\nOK test-demandas-manutencao-ui (${cases} casos)\n`);
