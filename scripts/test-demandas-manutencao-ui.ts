/**
 * Demandas UI/migration/auth — existência, dashboard comum, regressão de login.
 * Sem I/O de rede. Sem aplicar migration.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const root = resolve(process.cwd());
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
  "ui/demandas-render.js",
  "ui/yes-demandas-photo.js",
  "supabase/functions/demandas-foto-upload/index.ts",
  "supabase/migrations/20260825033658_demandas_manutencao_predial_core_v1.sql",
  "supabase/migrations/20260827181500_demandas_atribuicao_sem_telefone_obrigatorio.sql",
];
for (const rel of files) {
  assert.equal(existsSync(join(root, rel)), true, `falta ${rel}`);
}
ok("arquivos da tela, edge e migration existem");

const sql = read("supabase/migrations/20260825033658_demandas_manutencao_predial_core_v1.sql");
const sqlAtribuicao = read(
  "supabase/migrations/20260827181500_demandas_atribuicao_sem_telefone_obrigatorio.sql",
);
const html = read("ui/demandas-mvp.html");
const pageSrc = read("ui/demandas-mvp.js");
const renderSrc = read("ui/demandas-render.js");
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
    "demandas_autorizar_anexo",
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
  assert.match(html, /id="photo-input-camera"/);
  assert.match(html, /id="photo-input-gallery"/);
  assert.match(html, /capture="environment"/);
  assert.match(html, /Tirar foto/);
  assert.match(html, /Escolher da galeria/);
  assert.match(photoSrc, /1600/);
  assert.match(photoSrc, /0\.8/);
  assert.match(pageSrc, /demandas_criar/);
  assert.match(pageSrc, /demandas_iniciar/);
  assert.match(pageSrc, /demandas_editar/);
  assert.match(pageSrc, /createSignedUrl/);
  assert.match(pageSrc, /America\/Campo_Grande/);
  assert.match(edgeSrc, /demandas-fotos/);
  assert.match(edgeSrc, /demandas_autorizar_anexo/);
  assert.match(edgeSrc, /demandas_registrar_anexo/);
  assert.doesNotMatch(edgeSrc, /getPublicUrl/);
  const galleryBlock = html.slice(html.indexOf("photo-input-gallery"));
  assert.equal(galleryBlock.includes("capture="), false);
  ok("fotos privadas, compactação, câmera e galeria");
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
  assert.match(loginHtml, /Telefone \/ WhatsApp/);
  assert.match(loginHtml, /\+5567999887766/);
  assert.doesNotMatch(loginHtml, /name="telefoneWhatsapp"[^>]*required/);
  assert.match(usersEdge, /telefone_whatsapp/);
  assert.match(loginHtml, /usuarios-login-mvp\.js\?v=10/);
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
  assert.match(sql, /'ok', false/);
  assert.match(sql, /demandas_objeto_inexistente/);
  ok("concorrência, autoaprovação, geo estruturada e objeto de storage");
}

{
  assert.doesNotMatch(sql, /supervisor_telefone/);
  assert.doesNotMatch(sql, /executor_telefone/);
  assert.match(sql, /perfil_usuario text/);
  assert.doesNotMatch(
    sql,
    /create or replace function public\.demandas_listar_usuarios_atribuiveis\(\)[\s\S]*telefone_whatsapp text/,
  );
  assert.match(
    sqlAtribuicao,
    /create or replace function public\.demandas_listar_usuarios_atribuiveis\(\)/,
  );
  assert.doesNotMatch(
    sqlAtribuicao,
    /u\.telefone_whatsapp is not null/,
  );
  assert.doesNotMatch(
    sqlAtribuicao,
    /btrim\(u\.telefone_whatsapp\)/,
  );
  assert.match(
    sqlAtribuicao,
    /lower\(u\.perfil_usuario\) in \('admin', 'recepcao', 'cafe'\)/,
  );
  const listarMatch = sqlAtribuicao.match(
    /create or replace function public\.demandas_listar_usuarios_atribuiveis\(\)([\s\S]*?)\$\$;/,
  );
  assert.ok(listarMatch, "RPC demandas_listar_usuarios_atribuiveis na migration nova");
  assert.match(listarMatch[1], /returns table \(/);
  assert.match(listarMatch[1], /id uuid/);
  assert.match(listarMatch[1], /nome text/);
  assert.match(listarMatch[1], /perfil_usuario text/);
  assert.doesNotMatch(listarMatch[1], /telefone_whatsapp/);
  assert.match(
    sqlAtribuicao,
    /drop trigger if exists usuarios_internos_proteger_telefone_demandas/,
  );
  assert.match(sqlAtribuicao, /demandas_digisac_notificacao_status/);
  assert.match(sqlAtribuicao, /pendente_sem_telefone/);
  assert.doesNotMatch(pageSrc, /p_supervisor_telefone|p_executor_telefone|telefone_whatsapp/);
  ok("telefones ausentes da view e da RPC de atribuíveis; atribuição sem WhatsApp");
}

{
  const listaMatch = sql.match(
    /create or replace view public\.demandas_lista\s+with \(security_invoker = true\) as([\s\S]*?);/,
  );
  assert.ok(listaMatch, "demandas_lista deve existir como security_invoker");
  const listaBody = listaMatch[1];
  assert.doesNotMatch(
    listaBody,
    /join\s+public\.usuarios_internos/i,
    "demandas_lista não pode JOIN direto com usuarios_internos",
  );
  assert.match(listaBody, /public\.demandas_usuario_nome\(d\.criador_id\) as criador_nome/);
  assert.match(listaBody, /public\.demandas_usuario_nome\(d\.supervisor_id\) as supervisor_nome/);
  assert.match(listaBody, /public\.demandas_usuario_nome\(d\.executor_id\) as executor_nome/);
  assert.doesNotMatch(listaBody, /telefone_whatsapp/);

  const helperMatch = sql.match(
    /create or replace function public\.demandas_usuario_nome\(p_usuario_id uuid\)([\s\S]*?)\$\$;/,
  );
  assert.ok(helperMatch, "helper demandas_usuario_nome deve existir");
  const helperBody = helperMatch[1];
  assert.match(helperBody, /security definer/i);
  assert.match(helperBody, /stable/i);
  assert.match(helperBody, /set search_path = pg_catalog, public/);
  assert.match(helperBody, /perform public\.demandas_require_actor\(\)/);
  assert.match(helperBody, /select u\.nome/);
  assert.doesNotMatch(helperBody, /telefone_whatsapp|email_login|perfil_usuario/);
  assert.match(sql, /revoke all on function public\.demandas_usuario_nome\(uuid\) from public, anon/);
  assert.match(sql, /grant execute on function public\.demandas_usuario_nome\(uuid\) to authenticated/);
  assert.doesNotMatch(
    sql,
    /revoke all on function public\.demandas_usuario_nome\(uuid\) from public, anon, authenticated/,
  );
  assert.match(pageSrc, /from\(["']demandas_lista["']\)/);
  assert.match(renderSrc, /criador_nome/);
  assert.match(renderSrc, /supervisor_nome/);
  assert.match(renderSrc, /executor_nome/);
  ok("demandas_lista usa helper de nome sem JOIN em usuarios_internos");
}

{
  assert.match(html, /id="create-submit-btn"/);
  assert.match(pageSrc, /createSubmitBtn\.textContent = "Criar"/);
  assert.match(pageSrc, /createSubmitBtn\.textContent = "Salvar alterações"/);
  ok("botão principal: Criar no modo criação e Salvar alterações no modo edição");
}

{
  assert.doesNotMatch(pageSrc, /\.innerHTML\s*=/);
  assert.doesNotMatch(pageSrc, /innerHTML\s*\+=/);
  assert.doesNotMatch(renderSrc, /\.innerHTML\s*=/);
  assert.doesNotMatch(renderSrc, /innerHTML\s*\+=/);
  ok("Demandas não interpola dados via innerHTML");
}

{
  class FakeNode {
    tagName: string;
    className = "";
    textContent = "";
    type = "";
    value = "";
    children: FakeNode[] = [];
    attrs: Record<string, string> = {};
    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }
    append(...nodes: FakeNode[]) {
      this.children.push(...nodes);
    }
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    }
  }
  const fakeDom = {
    createElement(tag: string) {
      return new FakeNode(tag);
    },
  };
  const sandbox: { globalThis: unknown; window?: unknown; YesHotelDemandasRender?: {
    fillAssigneeSelect: Function;
    buildCard: Function;
    buildDetail: Function;
    collectExecutableSignals: Function;
  } } = { globalThis: null };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  runInContext(renderSrc, createContext(sandbox));
  const api = sandbox.YesHotelDemandasRender;
  assert.ok(api);

  const payloads = [
    "<img src=x onerror=alert(1)>",
    '" onmouseover="alert(1)',
    "<svg onload=alert(1)>",
  ];
  for (const payload of payloads) {
    const usersHost = new FakeNode("select");
    (usersHost as FakeNode & { replaceChildren: Function }).replaceChildren = function () {
      this.children = [];
    };
    api.fillAssigneeSelect(usersHost, [{ id: "u1", nome: payload }], fakeDom);
    const card = api.buildCard(
      {
        titulo: payload,
        tipo: payload,
        prioridade: payload,
        data_programada_inicio: "2026-08-24",
        data_prevista_conclusao: "2026-08-26",
        executor_nome: payload,
        status: "nao_iniciada",
      },
      { overdue: false, statusLabel: payload },
      fakeDom,
    ) as FakeNode;
    const detail = api.buildDetail(
      {
        descricao: payload,
        tipo: "corretiva",
        prioridade: "alta",
        criador_nome: payload,
        supervisor_nome: payload,
        executor_nome: payload,
        data_programada_inicio: "2026-08-24",
        data_prevista_conclusao: "2026-08-26",
        exigir_foto: false,
        sem_local_especifico: false,
        status: "nao_iniciada",
      },
      { overdue: false, statusLabel: "Não iniciada" },
      fakeDom,
    ) as FakeNode;
    const signals = { tags: [] as string[], attrs: [] as string[] };
    api.collectExecutableSignals(usersHost, signals);
    api.collectExecutableSignals(card, signals);
    api.collectExecutableSignals(detail, signals);
    assert.equal(signals.tags.length, 0, `payload criou tag: ${payload}`);
    assert.equal(signals.attrs.length, 0, `payload criou handler: ${payload}`);
    assert.equal(card.children[0].textContent, payload);
    assert.equal(detail.children[0].textContent, payload);
  }
  ok("payloads XSS permanecem texto e não viram elementos/atributos");

  const cardOk = api.buildCard(
    {
      titulo: "Trocar lâmpada do corredor",
      tipo: "corretiva",
      prioridade: "alta",
      data_programada_inicio: "2026-08-24",
      data_prevista_conclusao: "2026-08-29",
      executor_nome: "Breno",
      status: "em_andamento",
    },
    { overdue: true, statusLabel: "Em andamento" },
    fakeDom,
  ) as FakeNode;
  function collectText(node: FakeNode): string[] {
    const texts = node.textContent ? [node.textContent] : [];
    return texts.concat(node.children.flatMap(collectText));
  }
  const cardTexts = collectText(cardOk);
  assert.equal(cardOk.children[0].textContent, "Trocar lâmpada do corredor");
  assert.equal(cardOk.className.includes("is-vencida"), true);
  for (const expected of [
    "Status",
    "Em andamento",
    "Vencida",
    "Prioridade",
    "Alta",
    "Executor",
    "Breno",
    "Prazo",
    "29/08/2026",
    "Tipo",
    "Corretiva",
  ]) {
    assert.equal(cardTexts.includes(expected), true, `card sem ${expected}`);
  }
  ok("card compacto renderiza título, status, prioridade, executor, prazo e vencida");
}

{
  const created = [...sql.matchAll(/create or replace function public\.([a-z0-9_]+)\s*\(/gi)].map(
    (match) => match[1],
  );
  assert.ok(created.length >= 20);
  for (const name of created) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${name}\\(`, "i"),
      `faltou REVOKE em ${name}`,
    );
    const revokeBlock = sql.slice(sql.toLowerCase().indexOf(`revoke all on function public.${name}(`));
    const revokeLine = revokeBlock.split(";")[0].toLowerCase();
    assert.match(revokeLine, /from public/, `REVOKE PUBLIC ausente em ${name}`);
    assert.match(revokeLine, /from public, anon|anon/, `REVOKE anon ausente em ${name}`);
  }
  ok("todas as funções novas têm REVOKE de PUBLIC e anon");
}

{
  const helpers = [
    "demandas_require_actor",
    "demandas_lock",
    "demandas_append_historico",
    "demandas_assert_usuario_atribuivel",
    "demandas_enforce_geo",
    "demandas_assert_foto_envio",
    "demandas_close_open_pause",
    "demandas_haversine_meters",
    "demandas_normalize_telefone_whatsapp",
    "demandas_is_admin",
    "demandas_usuario_tem_demanda_aberta",
    "demandas_historico_append_only",
    "demandas_forbid_delete",
  ];
  for (const name of helpers) {
    const grant = new RegExp(
      `grant execute on function public\\.${name}\\([^;]*\\)\\s+to authenticated`,
      "i",
    );
    assert.doesNotMatch(sql, grant, `helper ${name} não pode ter GRANT authenticated`);
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${name}\\([^;]*\\) from public, anon, authenticated`, "i"),
    );
  }
  ok("helpers sem EXECUTE de authenticated");
}

{
  assert.doesNotMatch(sqlAtribuicao, /demandas_telefone_obrigatorio/);
  assert.match(
    sqlAtribuicao,
    /revoke all on function public\.demandas_digisac_notificacao_status\(uuid\) from public, anon, authenticated/i,
  );
  assert.doesNotMatch(
    sqlAtribuicao,
    /grant execute on function public\.demandas_digisac_notificacao_status/,
  );
  assert.doesNotMatch(
    sqlAtribuicao,
    /grant execute on function public\.demandas_assert_usuario_atribuivel/,
  );
  ok("assert atribuível sem WhatsApp; helper DigiSac sem telefone e sem GRANT authenticated");
}

{
  assert.match(sql, /grant execute on function public\.demandas_criar/);
  assert.match(sql, /grant execute on function public\.demandas_autorizar_anexo/);
  assert.match(sql, /grant execute on function public\.is_yes_hotel_demandas_reader\(\) to authenticated/);
  assert.match(pageSrc, /openEditPanel/);
  assert.match(pageSrc, /Editar/);
  assert.match(pageSrc, /canEdit\(row\)/);
  ok("RPCs públicas com grant mínimo e UI de edição do criador");
}

{
  assert.match(authSrc, /PROFILE_COLUMNS =/);
  assert.doesNotMatch(
    authSrc,
    /PROFILE_COLUMNS =\s*"id, auth_user_id, nome, email_login, perfil_usuario, ativo, telefone_whatsapp/,
  );
  assert.doesNotMatch(authSrc, /telefone_whatsapp, created_at/);
  assert.doesNotMatch(usersEdge, /demanda aberta/);
  assert.doesNotMatch(usersEdge, /userHasOpenDemandaAssignment/);
  assert.match(sqlAtribuicao, /drop trigger if exists usuarios_internos_proteger_telefone_demandas/);
  assert.match(sql, /set search_path = public/);
  assert.match(sql, /demandas_is_admin\(p_user public\.usuarios_internos\)[\s\S]*set search_path = public/);
  ok("login desacoplado do telefone; WhatsApp opcional e search_path");
}

{
  assert.match(edgeSrc, /0xff, 0xd8, 0xff/);
  assert.match(edgeSrc, /demandas_autorizar_anexo/);
  assert.match(edgeSrc, /cleanup/);
  assert.match(edgeSrc, /file\.size/);
  ok("edge inspeciona magic bytes, autoriza antes e faz cleanup verificável");
}

{
  const genPath = join(root, "scripts/generate-yes-supabase-config.mjs");
  const homoUrl = "https://kzprrnbafamuozhyikgb.supabase.co";
  const homoAnon =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6Imt6cHJybmJhZmFtdW96aHlpa2diIn0.e30";
  const prodUrl = "https://minmmecajnmjqlgacfoz.supabase.co";
  function runGen(env: Record<string, string>) {
    return spawnSync(process.execPath, [genPath], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }
  const missing = runGen({
    VERCEL_ENV: "preview",
    YES_HOTEL_SUPABASE_URL: "",
    YES_HOTEL_SUPABASE_ANON_KEY: "",
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}${missing.stdout}`, /YES_HOTEL_SUPABASE_URL/);
  const previewProd = runGen({
    VERCEL_ENV: "preview",
    YES_HOTEL_SUPABASE_URL: prodUrl,
    YES_HOTEL_SUPABASE_ANON_KEY: homoAnon,
  });
  assert.notEqual(previewProd.status, 0);
  assert.match(`${previewProd.stderr}${previewProd.stdout}`, /project_ref de producao/);
  const previewOk = runGen({
    VERCEL_ENV: "preview",
    YES_HOTEL_SUPABASE_URL: homoUrl,
    YES_HOTEL_SUPABASE_ANON_KEY: homoAnon,
  });
  assert.equal(previewOk.status, 0, previewOk.stderr);
  const prodHomo = runGen({
    VERCEL_ENV: "production",
    YES_HOTEL_SUPABASE_URL: homoUrl,
    YES_HOTEL_SUPABASE_ANON_KEY: homoAnon,
  });
  assert.notEqual(prodHomo.status, 0);
  assert.match(`${prodHomo.stderr}${prodHomo.stdout}`, /project_ref de homologacao/);
  const production = runGen({ VERCEL_ENV: "production" });
  assert.equal(production.status, 0, production.stderr);
  const bootstrap = read("ui/api/bootstrap-status.js");
  assert.match(bootstrap, /Preview isolado recusou backend de producao/);
  assert.match(bootstrap, /YES_HOTEL_SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(read("ui/yes-supabase-config.js"), /anonKey: "[^"]*service_role/);
  assert.match(read("ui/yes-supabase-config.js"), /isolateYesHotelSupabase/);
  assert.match(photoSrc, /image\/png/);
  assert.match(photoSrc, /image\/webp/);
  ok("Preview falha fechado e Production permanece no ref de produção");
}

{
  assert.match(html, /id="demandas-page-title"/);
  assert.match(html, /id="nav-minhas"/);
  assert.match(html, /id="nav-todas"/);
  assert.match(html, /data-nav="minhas-demandas"/);
  assert.match(html, /demandas-mvp\.html\?escopo=minhas/);
  assert.match(html, /id="btn-nova"/);
  assert.match(html, />Nova demanda</);
  assert.match(html, /id="kpi-validacao"/);
  assert.match(html, /Aguardando validação/);
  assert.doesNotMatch(html, /id="geo-admin"/);
  assert.doesNotMatch(html, /id="geo-details"/);
  assert.doesNotMatch(html, /id="geo-form"/);
  assert.doesNotMatch(html, /Configuração de localização/);
  assert.doesNotMatch(html, /id="filter-escopo"/);
  assert.doesNotMatch(html, /id="nav-minhas"[^>]*class="active"/);

  const navMinhas = html.match(/<a[^>]*id="nav-minhas"[^>]*>/);
  const navTodas = html.match(/<a[^>]*id="nav-todas"[^>]*>/);
  assert.ok(navMinhas && navTodas, "links de navegação de Demandas");
  assert.match(navMinhas[0], /data-nav="minhas-demandas"/);
  assert.match(navTodas[0], /data-nav="demandas"/);
  assert.doesNotMatch(navMinhas[0], /\bactive\b/);
  assert.match(navTodas[0], /\bactive\b/);
  assert.doesNotMatch(navMinhas[0], /data-nav="demandas"/);
  ok("HTML separa Demandas e Minhas demandas com menu exclusivo");
}

{
  assert.match(pageSrc, /function isMinhasEscopo/);
  assert.match(pageSrc, /get\("escopo"\) === "minhas"/);
  assert.match(pageSrc, /function applyPageChrome/);
  assert.match(pageSrc, /title\.textContent = minhas \? "Minhas demandas" : "Demandas"/);
  assert.match(pageSrc, /navMinhas\?\.classList\.toggle\("active", minhas\)/);
  assert.match(pageSrc, /navTodas\?\.classList\.toggle\("active", !minhas\)/);
  assert.match(pageSrc, /applyPageChrome\(\);/);
  assert.match(pageSrc, /contentPanelElement\?\.classList\.remove\("hidden"\)/);
  const chromeIdx = pageSrc.indexOf("applyPageChrome();");
  const showIdx = pageSrc.indexOf('contentPanelElement?.classList.remove("hidden")');
  assert.equal(chromeIdx > -1 && chromeIdx < showIdx, true, "chrome do menu antes de exibir o painel");
  assert.doesNotMatch(pageSrc, /filter-escopo/);
  assert.doesNotMatch(pageSrc, /function applyQueryEscopo/);
  assert.doesNotMatch(pageSrc, /function loadGeoConfig/);
  assert.doesNotMatch(pageSrc, /#geo-form/);
  assert.doesNotMatch(pageSrc, /demandas_atualizar_geo_config/);
  ok("escopo vem da URL; menu exclusivo; geo fora de Demandas");
}

{
  const css = read("ui/demandas-mvp.css");
  assert.match(css, /\.demandas-card-title/);
  assert.match(css, /\.demandas-badge\.is-status-em_andamento/);
  assert.match(css, /\.demandas-badge\.is-status-aguardando_validacao/);
  assert.doesNotMatch(css, /\.demandas-geo-admin/);
  assert.match(css, /grid-template-columns: 1fr;/);
  const sidebars = [
    "ui/checkin-operacional-mvp.html",
    "ui/cafe-da-manha-mvp.html",
    "ui/gestao-saude-hotel.html",
    "ui/financeiro-conciliacao.html",
    "ui/apartamentos-wifi-mvp.html",
    "ui/recepcao-mvp.html",
    "ui/usuarios-login-mvp.html",
    "ui/index.html",
    "ui/geolocalizacao-hotel-mvp.html",
  ];
  for (const rel of sidebars) {
    const src = read(rel);
    assert.match(src, /data-nav="minhas-demandas"/);
    assert.match(src, /data-nav="demandas"/);
    assert.match(src, /demandas-mvp\.html\?escopo=minhas/);
    assert.doesNotMatch(src, />Geolocalização</);
  }
  ok("CSS compacto e sidebars com data-nav distintos");
}

{
  assert.equal(existsSync(join(root, "ui/geolocalizacao-hotel-mvp.html")), true);
  assert.equal(existsSync(join(root, "ui/geolocalizacao-hotel-mvp.js")), true);
  const geoHtml = read("ui/geolocalizacao-hotel-mvp.html");
  const geoJs = read("ui/geolocalizacao-hotel-mvp.js");
  assert.match(geoHtml, /Geolocalização do hotel/);
  assert.match(geoHtml, /Usado para validar presença em ações com localização obrigatória/);
  assert.match(geoHtml, /name="latitude"/);
  assert.match(geoHtml, /name="longitude"/);
  assert.match(geoHtml, /name="raio"/);
  assert.match(geoHtml, />Salvar coordenadas</);
  assert.match(geoHtml, /href="\.\/usuarios-login-mvp\.html"/);
  assert.doesNotMatch(geoHtml, />Geolocalização</);
  assert.match(geoJs, /hotel_geo_config/);
  assert.match(geoJs, /demandas_atualizar_geo_config/);
  assert.match(geoJs, /user\.role !== "admin"/);
  assert.doesNotMatch(geoJs, /innerHTML/);
  assert.match(loginHtml, /Geolocalização do hotel/);
  assert.match(indexHtml, /Geolocalização do hotel/);
  assert.match(loginHtml, /Coordenadas e raio para validação de presença/);
  assert.match(loginHtml, /href="\.\/geolocalizacao-hotel-mvp\.html"/);
  assert.match(loginHtml, /data-nav="geo"/);
  assert.match(loginJs, /data-nav="geo"/);
  assert.match(loginJs, /toggle\("hidden", !isAdmin\)/);
  const opSidebars = [
    "ui/checkin-operacional-mvp.html",
    "ui/cafe-da-manha-mvp.html",
    "ui/demandas-mvp.html",
    "ui/gestao-saude-hotel.html",
    "ui/financeiro-conciliacao.html",
  ];
  for (const rel of opSidebars) {
    const src = read(rel);
    assert.doesNotMatch(src, /geolocalizacao-hotel-mvp\.html/);
    assert.doesNotMatch(src, /Configuração de localização/);
  }
  ok("geo saiu de Demandas e ficou na área admin");
}

{
  const css = read("ui/demandas-mvp.css");
  assert.match(html, /class="demandas-kpis"/);
  assert.match(html, /id="kpi-total"/);
  assert.match(html, /id="kpi-andamento"/);
  assert.match(html, /id="kpi-validacao"/);
  assert.match(html, /id="kpi-vencidas"/);
  assert.match(html, /class="demandas-filters"/);
  assert.match(html, /id="filter-tipo"/);
  assert.match(html, /id="filter-prioridade"/);
  assert.match(html, /id="filter-status"/);
  assert.match(html, /id="filter-atraso"/);
  assert.match(html, /id="btn-nova"/);
  assert.match(html, /id="demandas-list"/);
  assert.match(html, /id="create-form"/);
  assert.match(html, /id="nav-minhas"/);
  assert.match(html, /id="nav-todas"/);
  assert.match(html, /aria-label="Ações"/);
  assert.match(html, /id="detail-actions"/);
  assert.match(html, />Fotos</);
  assert.match(html, />Histórico</);
  assert.match(html, /id="historico-list"/);
  assert.match(html, /name="sem_local_especifico"/);
  assert.match(css, /\.demandas-view/);
  assert.match(css, /--op-sidebar-w: 196px/);
  assert.match(css, /\.demandas-card-head/);
  assert.match(css, /repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(renderSrc, /Dados principais/);
  assert.match(renderSrc, /demandas-card-head/);
  assert.match(pageSrc, /demandas-action-danger/);
  assert.match(pageSrc, /addAction\(host, "Iniciar"/);
  assert.match(pageSrc, /addAction\(host, "Cancelar"/);
  ok("densidade operacional preserva estrutura de Demandas e Minhas");
}

console.log(`\nOK test-demandas-manutencao-ui (${cases} casos)\n`);
