/**
 * Testes direcionados da entrega "perfis-navegacao-hits-consulta":
 * padronização do menu lateral, autorização de páginas por perfil e o
 * novo perfil hits_consulta (Check-in somente leitura).
 *
 * Escopo estrito: não testa novamente RLS/RPC do café (PR #110), nem
 * sincronização HITS, pré-check-in/FNRH ou o modelo funcional de Demandas.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());

function loadBrowserGlobal(relPath: string, globalName: string) {
  const source = readFileSync(resolve(ROOT, relPath), "utf8");
  const ctx = createContext({ window: {} } as any);
  runInContext(source, ctx);
  const value = (ctx as any).window[globalName];
  assert.ok(value, `${globalName} deveria ter sido anexado a window por ${relPath}`);
  return value;
}

// getNavItemsForRole roda dentro do contexto vm (outro "realm"); normaliza
// para array/objeto nativo do host antes de comparar com assert.deepEqual,
// que trata Array cross-realm como "mesma estrutura mas não referência-igual".
function menuKeysFor(navPolicy: any, role: string): string[] {
  return Array.from(navPolicy.getNavItemsForRole(role)).map((i: any) => String(i.key));
}

function main() {
  const navPolicy = loadBrowserGlobal("ui/yes-nav-policy.js", "YesHotelNavPolicy");
  const authApp = loadBrowserGlobal("ui/yes-supabase-auth.js", "YesHotelAuthApp");

  console.log("\n== 1. Admin recebe o menu operacional; Wi-Fi/Geolocalização/Usuários saíram do sidebar (agora em Configurações) ==");
  {
    const items = menuKeysFor(navPolicy, "admin");
    assert.deepEqual(items, [
      "inicio",
      "operacao",
      "cafe",
      "gestao",
      "financeiro",
      "minhas-demandas",
      "demandas",
    ]);
    assert.ok(!items.includes("wifi") && !items.includes("geo") && !items.includes("usuarios"));
    ok("admin vê os 7 itens operacionais na ordem canônica; wifi/geo/usuarios não aparecem mais no sidebar");
  }

  console.log("\n== 2. Recepção recebe exatamente o mesmo menu lateral do Admin ==");
  {
    const adminItems = menuKeysFor(navPolicy, "admin");
    const recepcaoItems = menuKeysFor(navPolicy, "recepcao");
    assert.deepEqual(recepcaoItems, adminItems);
    ok("menu lateral de admin e recepção é idêntico (usuarios já não aparece em nenhum dos dois)");
  }

  console.log("\n== 3. Recepção continua com acesso ao Início ==");
  {
    assert.equal(navPolicy.isRouteAuthorized("recepcao", "inicio"), true);
    const recepcaoItems = menuKeysFor(navPolicy, "recepcao");
    assert.ok(recepcaoItems.includes("inicio"), "início deve aparecer no menu da recepção");
    ok("recepção autorizada na rota início e o item aparece no menu");
  }

  console.log("\n== 4. Recepção é bloqueada na URL e nas ações de Usuários ==");
  {
    assert.equal(navPolicy.isRouteAuthorized("recepcao", "usuarios"), false);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "usuarios"), false);
    assert.equal(navPolicy.isRouteAuthorized("hits_consulta", "usuarios"), false);
    assert.equal(authApp.canAccessUserManagement({ role: "recepcao" }), false);
    assert.equal(authApp.canAccessUserManagement({ role: "admin" }), true);

    const edgeSrc = readFileSync(
      resolve(ROOT, "supabase/functions/internal-users-admin/index.ts"),
      "utf8",
    );
    assert.match(
      edgeSrc,
      /callerProfile\.role !== "admin"/,
      "backend de administração de usuários continua exigindo role === admin",
    );
    ok("recepção (e café/hits) bloqueados na rota usuarios; backend inalterado e ainda exige admin");
  }

  console.log("\n== 5. Café recebe somente Café da manhã, Minhas demandas e Demandar ==");
  {
    const items = menuKeysFor(navPolicy, "cafe");
    assert.deepEqual(items, ["cafe", "minhas-demandas", "demandar"]);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "inicio"), false);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "checkin"), false);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "gestao"), false);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "financeiro"), false);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "wifi"), false);
    ok("café vê exatamente 3 itens e é bloqueado em início/checkin/gestão/financeiro/wifi");
  }

  console.log("\n== 6. HITS recebe somente Check-in ==");
  {
    const items = menuKeysFor(navPolicy, "hits_consulta");
    assert.deepEqual(items, ["checkin-hits"]);
    assert.equal(navPolicy.getNavItemsForRole("hits_consulta")[0].label, "Check-in");
    ok("hits_consulta vê só 1 item de menu, rotulado Check-in");
  }

  console.log("\n== 7. HITS é bloqueado em todas as demais rotas ==");
  {
    const allRouteKeys = ["inicio", "checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "usuarios"];
    for (const routeKey of allRouteKeys) {
      if (routeKey === "checkin") continue;
      assert.equal(
        navPolicy.isRouteAuthorized("hits_consulta", routeKey),
        false,
        `hits_consulta não deveria acessar ${routeKey}`,
      );
    }
    assert.equal(navPolicy.isRouteAuthorized("hits_consulta", "checkin"), true);
    ok("hits_consulta bloqueado em todas as 7 rotas restantes, autorizado só em checkin");
  }

  console.log("\n== 8. HITS não recebe controles de escrita na tela de Check-in ==");
  {
    const checkinSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    const start = checkinSrc.indexOf("async function initCheckinReadOnlyHits");
    assert.ok(start > -1, "initCheckinReadOnlyHits deve existir");
    const nextFnIdx = checkinSrc.indexOf("\n/* ---------- Bindings / init ---------- */", start);
    assert.ok(nextFnIdx > start, "consegue isolar o corpo de initCheckinReadOnlyHits");
    const body = checkinSrc.slice(start, nextFnIdx);

    const forbiddenTokens = [
      ".update(",
      ".insert(",
      ".delete(",
      "op-refresh-btn",
      "op-hits-sandbox-refresh",
      "liberarAcesso",
      "reenviar",
      "modal-enviar-senha",
    ];
    for (const token of forbiddenTokens) {
      assert.doesNotMatch(
        body,
        new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `initCheckinReadOnlyHits não deve referenciar "${token}"`,
      );
    }
    assert.match(body, /\.rpc\("operacional_hits_checkin_consulta"\)/, "usa a RPC dedicada de leitura");
    ok("initCheckinReadOnlyHits não contém nenhum insert/update/delete nem botão de ação de escrita");
  }

  console.log("\n== 9. O caminho de dados da HITS não retorna campos sensíveis ==");
  {
    const migrationPath = resolve(
      ROOT,
      "supabase/migrations/20260920100000_hits_consulta_perfil_checkin_readonly.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    const declIdx = sql.indexOf("create or replace function public.operacional_hits_checkin_consulta()");
    assert.ok(declIdx > -1, "RPC existe");
    const returnsIdx = sql.indexOf("returns table (", declIdx) + "returns table (".length;
    const returnsEndIdx = sql.indexOf("\n)", returnsIdx);
    const returnsBlock = sql.slice(returnsIdx, returnsEndIdx);

    const forbiddenColumnPatterns = [
      /documento/i,
      /\bcpf\b/i,
      /passaporte/i,
      /\be[-_]?mail\b/i,
      /telefone/i,
      /whatsapp/i,
      /nascimento/i,
      /endereco|endereço/i,
      /\bsenha\b/i,
      /credencial/i,
      /codigo_credencial|codigo_logico/i,
      /valor|amount|financeir/i,
      /pagamento_presencial_diferido_autorizado_por/i,
      /veiculo|placa/i,
      /comissao|comissionamento/i,
      /payload/i,
    ];
    for (const pattern of forbiddenColumnPatterns) {
      assert.doesNotMatch(returnsBlock, pattern, `RPC HITS não retorna coluna proibida (padrão ${pattern})`);
    }

    const returnedColumns = [...returnsBlock.matchAll(/^\s*(\w+)\s+\w+/gm)].map((m) => m[1]);
    assert.deepEqual(returnedColumns, [
      "reservation_id",
      "apartment_code",
      "main_guest_name",
      "check_in_previsto",
      "check_out_previsto",
      "status_reserva",
      "fnrh_status_agregado",
      "acesso_liberado",
      "entrou_no_apto",
    ]);
    ok("RPC devolve exatamente as 9 colunas mínimas, nenhuma delas sensível");
  }

  console.log("\n== 10. O backend rejeita tentativas de escrita da HITS ==");
  {
    const migrationPath = resolve(
      ROOT,
      "supabase/migrations/20260920100000_hits_consulta_perfil_checkin_readonly.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    assert.doesNotMatch(sql, /grant\s+(insert|update|delete)[\s\S]{0,80}hits_consulta/i);
    assert.doesNotMatch(sql, /hits_consulta[\s\S]{0,120}grant\s+(insert|update|delete)/i);
    assert.doesNotMatch(sql, /create policy[\s\S]*?hits_consulta/i, "nenhuma policy nova referencia hits_consulta");
    assert.match(sql, /revoke all on function public\.operacional_hits_checkin_consulta\(\) from public, anon;/);
    assert.match(sql, /grant execute on function public\.operacional_hits_checkin_consulta\(\) to authenticated;/);
    assert.doesNotMatch(sql, /grant\s+execute[\s\S]{0,40}to\s+anon/i);
    ok("migration não concede nenhuma escrita a hits_consulta; EXECUTE da RPC só para authenticated");
  }

  console.log("\n== 11. O menu do mesmo perfil não muda entre páginas (centralização) ==");
  {
    const pagesUsingSharedNav = [
      "ui/checkin-operacional-mvp.js",
      "ui/cafe-da-manha-mvp.js",
      "ui/demandas-mvp.js",
      "ui/gestao-saude-hotel.js",
      "ui/financeiro-conciliacao.js",
      "ui/apartamentos-wifi-mvp.js",
    ];
    for (const rel of pagesUsingSharedNav) {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.match(
        src,
        /YesHotelNavPolicy/,
        `${rel} deve usar o mecanismo compartilhado de menu (YesHotelNavPolicy)`,
      );
    }
    ok("todas as páginas operacionais renderizam o menu a partir da mesma fonte (YesHotelNavPolicy)");
  }

  console.log("\n== 12. Admin, Recepção e Café não sofrem regressões em seus acessos autorizados ==");
  {
    for (const routeKey of ["checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "inicio"]) {
      assert.equal(navPolicy.isRouteAuthorized("admin", routeKey), true, `admin deveria manter ${routeKey}`);
    }
    for (const routeKey of ["checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "inicio"]) {
      assert.equal(navPolicy.isRouteAuthorized("recepcao", routeKey), true, `recepção deveria manter ${routeKey}`);
    }
    assert.equal(navPolicy.isRouteAuthorized("cafe", "cafe"), true);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "demandas"), true);
    assert.equal(authApp.canAccessBreakfast({ role: "cafe" }), true);
    assert.equal(authApp.canAccessBreakfast({ role: "admin" }), true);
    assert.equal(authApp.canAccessBreakfast({ role: "recepcao" }), true);
    assert.equal(authApp.canAccessFinancialRecon({ role: "recepcao" }), true, "recepção passa a acessar conciliação, conforme nova matriz");
    ok("admin/recepção mantêm todas as rotas operacionais previstas; café mantém café e demandas (minhas)");
  }

  console.log("\n== 13. Perfil desconhecido/sem correspondência é sempre negado (default-deny) ==");
  {
    for (const routeKey of ["inicio", "checkin", "cafe", "gestao", "financeiro", "demandas", "wifi", "usuarios"]) {
      assert.equal(navPolicy.isRouteAuthorized("perfil_inexistente", routeKey), false);
      assert.equal(navPolicy.isRouteAuthorized(undefined, routeKey), false);
    }
    assert.deepEqual(Array.from(navPolicy.getNavItemsForRole("perfil_inexistente")), []);
    ok("perfil desconhecido ou ausente não recebe nenhuma rota nem item de menu");
  }

  console.log("\n== 14. acessos_recepcao = acessos_admin - usuarios (regra definitiva, agora ao nível de rota/Configurações) ==");
  {
    // Wi-Fi, Geolocalização e Usuários saíram do sidebar (item de menu) e
    // passaram a viver dentro da tela Configurações; a autorização por rota
    // (isRouteAuthorized/ROUTE_ACCESS) continua sendo a fonte única de
    // verdade de quem pode abrir cada uma delas.
    const ALL_ROUTE_KEYS = [
      "inicio",
      "checkin",
      "cafe",
      "gestao",
      "financeiro",
      "demandas",
      "wifi",
      "geo",
      "usuarios",
    ];

    for (const routeKey of ALL_ROUTE_KEYS) {
      assert.equal(
        navPolicy.isRouteAuthorized("admin", routeKey),
        true,
        `admin deveria acessar ${routeKey}`,
      );
      const expected = routeKey !== "usuarios";
      assert.equal(
        navPolicy.isRouteAuthorized("recepcao", routeKey),
        expected,
        `isRouteAuthorized("recepcao", "${routeKey}") deveria ser ${expected}`,
      );
    }
    assert.equal(navPolicy.isRouteAuthorized("recepcao", "usuarios"), false);
    assert.equal(navPolicy.isRouteAuthorized("admin", "usuarios"), true);
    assert.ok(navPolicy.isRouteAuthorized("admin", "geo"), "admin deve ter geo na matriz");
    assert.ok(navPolicy.isRouteAuthorized("recepcao", "geo"), "recepção deve ter geo — mesma regra: tudo do admin, exceto usuarios");

    ok(
      "recepção tem exatamente os mesmos acessos de rota do admin, com usuarios como única exceção (wifi/geo inclusive, mesmo fora do sidebar)",
    );
  }

  console.log("\n== 15. internal-users-admin aceita hits_consulta sem ampliar permissões ==");
  {
    const edgeSrc = readFileSync(
      resolve(ROOT, "supabase/functions/internal-users-admin/index.ts"),
      "utf8",
    );
    const fnStart = edgeSrc.indexOf("function normalizeRole(");
    assert.ok(fnStart > -1, "normalizeRole existe na Edge Function");
    const fnEnd = edgeSrc.indexOf("\n}", fnStart) + 2;
    // Remove só a assinatura TypeScript para avaliar a função real em JS.
    const fnJs = edgeSrc
      .slice(fnStart, fnEnd)
      .replace(/function normalizeRole\(role: unknown\):[^{]*\{/, "function normalizeRole(role) {");
    const normalizeRole = new Function(`${fnJs}; return normalizeRole;`)() as (r: unknown) => string;

    assert.equal(normalizeRole("hits_consulta"), "hits_consulta");
    assert.equal(normalizeRole(" hits_consulta "), "hits_consulta");
    ok("A. normalizeRole aceita hits_consulta");

    for (const r of ["admin", "recepcao", "cafe"]) assert.equal(normalizeRole(r), r);
    ok("B. admin, recepcao e cafe continuam aceitos");

    for (const r of ["", "superadmin", "HITS_CONSULTA", "hits", "financeiro", null, undefined]) {
      assert.throws(() => normalizeRole(r), /Perfil invalido\. Use admin, recepcao, cafe ou hits_consulta\./);
    }
    ok("C. perfil inválido continua rejeitado, com mensagem dos quatro perfis");

    const bodyOf = (name: string) => {
      const i = edgeSrc.indexOf(`async function ${name}(`);
      assert.ok(i > -1, `${name} existe`);
      return edgeSrc.slice(i, edgeSrc.indexOf("\nasync function ", i + 1));
    };
    for (const name of ["createUser", "updateUser"]) {
      const body = bodyOf(name);
      const iAdmin = body.indexOf("await ensureAdminCaller(request);");
      const iRole = body.indexOf("normalizeRole(payload.role)");
      assert.ok(iAdmin > -1 && iRole > iAdmin, `${name}: exige admin antes de validar o perfil`);
    }
    ok("D/E. create_user e update_user usam a mesma validação, depois de exigir admin");

    assert.match(edgeSrc, /callerProfile\.role !== "admin" \|\| !callerProfile\.active/);
    const mencoes = edgeSrc.match(/hits_consulta/g) || [];
    assert.equal(mencoes.length, 3, "hits_consulta só aparece no tipo, na validação e na mensagem de normalizeRole");
    ok("F. ensureAdminCaller inalterado; hits_consulta não ganha nenhuma permissão administrativa");
  }

  console.log(`\nOK test-perfis-navegacao-hits-consulta (${cases} casos)`);
}

main();
