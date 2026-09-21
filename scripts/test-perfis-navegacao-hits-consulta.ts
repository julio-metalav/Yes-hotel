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

  console.log("\n== 8. HITS usa a mesma tela operacional, sem comandos de escrita ==");
  {
    const checkinSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    const checkinHtml = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");
    const fnBody = (name: string) => {
      const i = checkinSrc.search(new RegExp(`(async )?function ${name}\\(`));
      assert.ok(i > -1, `${name} existe`);
      return checkinSrc.slice(i, checkinSrc.indexOf("\n}", i) + 2);
    };

    // Não existe mais uma segunda interface para o perfil.
    assert.doesNotMatch(checkinHtml, /hits-readonly/);
    assert.doesNotMatch(checkinSrc, /initCheckinReadOnlyHits|hits-readonly/);
    assert.match(checkinHtml, /id="op-main-content"/);
    const init = fnBody("initCheckinOperacional");
    assert.match(init, /modoConsultaHits = auth\.isHitsConsultaRole\(currentUser\);/);
    assert.doesNotMatch(init, /isHitsConsultaRole\(currentUser\)\)\s*\{\s*return/);
    ok("hits_consulta fica em #op-main-content: não há mais segunda tela nem desvio no init");

    // Dados: só a RPC dedicada, sem escrita e sem SELECT direto em tabela.
    const load = fnBody("loadReservasConsultaHits");
    assert.match(load, /\.rpc\("operacional_hits_checkin_consulta"\)/);
    for (const token of [".from(", ".update(", ".insert(", ".delete(", ".upsert(", "functions.invoke"]) {
      assert.ok(!load.includes(token), `loadReservasConsultaHits não usa ${token}`);
    }
    // Banco só pela RPC; a leitura HITS é a mesma da Recepção, sem reconciliação (que grava).
    assert.match(
      fnBody("loadReservasOperacionaisFromProvider"),
      /if \(modoConsultaHits\) return loadReservasConsultaHits\(\)\.then\(filtrarReservasOperacionaisAtivas\);/,
    );
    assert.match(fnBody("ensureArrivalsDataset"), /if \(modoConsultaHits\) \{\s*\/\/[^\n]*\n\s*arrivalsDatasetCache = consultaHitsTodas\.map/);
    const leituraHits = fnBody("loadReservasSomenteLeituraHits");
    assert.match(leituraHits, /if \(!modoConsultaHits && !\(options && options\.reuseOnly === true\)\) \{\s*await reconciliarCanceladasHits/);
    assert.match(leituraHits, /modoConsultaHits \? novas\.map\(paraConsultaSomenteNoHits\) : novas/);
    ok("banco só pela RPC operacional_hits_checkin_consulta(); leitura HITS igual à Recepção, sem reconciliação");

    // Nenhum comando de escrita para reservas de consulta.
    for (const fn of [
      "renderDetail",
      "canShowPresencialDiferidoBtn",
      "listaProximaAcaoOperacional",
      "derivarExcecaoOperacionalReserva",
      "linhaFluxoResumo",
      "isPagamentoPendenteOperacional",
    ]) {
      assert.match(fnBody(fn), /isReservaConsultaHits\(reserva\)/, `${fn} respeita o modo consulta`);
    }
    assert.match(
      fnBody("listaProximaAcaoOperacional"),
      /isReservaConsultaHits\(reserva\)\) \{\s*return \{ texto: proximaEtapaConsultaHits\(reserva\), destaque: false, cta: null \};/,
    );
    const lista = fnBody("renderOperacionalLista");
    assert.equal(
      (lista.match(/isReservaConsultaHits\(reserva\)\s*\?\s*derivarStatusConsultaHits\(reserva\)/g) || []).length,
      2,
      "tabela e cartão usam o status de consulta (sem pagamento)",
    );
    // A. Ver existe para o perfil; B. nada além dele (sem ⋯, PPD, cobrança, CTA).
    const celConsulta = lista.match(/consulta\s*\?\s*`([\s\S]*?)`\s*:\s*`/);
    assert.ok(celConsulta, "célula de ações da consulta isolável");
    assert.match(celConsulta![1], /class="op-btn-table op-btn-ver" data-id="\$\{rid\}">Ver<\/button>/);
    assert.equal((celConsulta![1].match(/<button/g) || []).length, 1, "tabela: só o botão Ver");
    const cardConsulta = lista.match(/mConsulta\s*\?\s*`([\s\S]*?)`\s*:\s*`/);
    assert.ok(cardConsulta, "ações do cartão de consulta isoláveis");
    assert.match(cardConsulta![1], /op-btn-ver-inline/);
    assert.equal((cardConsulta![1].match(/<button/g) || []).length, 1, "cartão: só o botão Ver");
    for (const proibido of ["op-btn-more", "data-ppd", "ppdBtn", "data-payment-badge", "op-next-action-btn", "data-cta-kind"]) {
      assert.ok(!celConsulta![1].includes(proibido) && !cardConsulta![1].includes(proibido), `sem ${proibido} na consulta`);
    }
    ok("A/B. hits_consulta tem só o botão Ver (tabela e cartão); sem ⋯, PPD, cobrança ou CTA");

    // C. Ver abre o MESMO drawer (openDetail → syncDetailPanelChrome → renderDetail).
    const abrir = fnBody("openDetail");
    assert.doesNotMatch(abrir, /isReservaConsultaHits/, "sem caminho paralelo de abertura");
    const render = fnBody("renderDetail");
    assert.match(
      render,
      /if \(isReservaConsultaHits\(reserva\)\) \{\s*detailBodyElement\.innerHTML = buildSituacaoConsultaHitsHtml\(reserva\);\s*return;\s*\}/,
      "consulta sai antes de montar ações e de bindDetailListeners",
    );
    assert.ok(
      render.indexOf("buildSituacaoConsultaHitsHtml") < render.indexOf("bindDetailListeners"),
      "nenhum listener do detalhe operacional é ligado para consulta",
    );
    ok("C/I. Ver abre o mesmo drawer do admin; consulta não liga listeners nem carrega fechaduras");

    // D/E. Mesmo bloco "Situação atual" do admin, só com dados da RPC e sem controles.
    const det = fnBody("buildSituacaoConsultaHitsHtml");
    for (const cls of ["reservation-detail-section reservation-detail-top-hero", "detail-situacao-kicker", "detail-situacao-grid", "detail-situacao-acesso", "detail-proxima-acao", "detail-acao-kicker", "detail-acao-hint"]) {
      assert.ok(det.includes(cls), `reaproveita a marcação do admin (${cls})`);
    }
    for (const tag of ["<button", "<form", "<input", "<select", "<textarea", "<a ", "href=", "data-cta", "data-recomendacao", "onclick", "Pagamento"]) {
      assert.ok(!det.includes(tag), `drawer de consulta sem ${tag}`);
    }
    const campos = [...det.matchAll(/reserva\.(\w+)/g)].map((m) => m[1]);
    const permitidos = new Set(["acessoLiberado", "entrouNoApto"]);
    for (const c of campos) assert.ok(permitidos.has(c), `drawer só usa campos da RPC (achou reserva.${c})`);
    ok("D/E. drawer de consulta reaproveita o bloco do admin, sem pagamento e sem nenhum controle");

    // F. Linha e cartão inteiros não abrem o detalhe; só o botão Ver.
    assert.match(lista, /if \(!id \|\| isReservaConsultaHits\(getReservaById\(id\)\)\) return;/, "linha não abre detalhe");
    assert.match(
      lista,
      /isReservaConsultaHits\(getReservaById\(card\.getAttribute\("data-id"\)\)\)\) \{\s*card\.querySelector\("\.op-btn-ver-inline"\)\?\.addEventListener\("click"[\s\S]{0,160}openDetail\(id\);[\s\S]{0,40}return;/,
      "cartão de consulta: só o botão Ver abre",
    );
    const prep = fnBody("prepararTelaConsultaHits");
    assert.match(prep, /#op-hits-sandbox-toggle"\)\?\.remove\(\)/, "diagnóstico técnico removido do DOM");
    ok("F. linha e cartão não abrem detalhe por outros caminhos; diagnóstico continua removido");

    // G. Admin/recepção: renderDetail completo inalterado no caminho normal.
    assert.match(fnBody("openDetail"), /detailReservaId = reservaId;\s*syncDetailPanelChrome\(reserva\);\s*renderDetail\(reserva\);/);
    assert.match(lista, /<button type="button" class="op-btn-icon op-btn-more" data-id="\$\{rid\}" title="Detalhes" aria-label="Abrir detalhes">⋯<\/button>/);
    ok("G. admin/recepção mantêm Ver + ⋯ e o detalhe operacional completo");
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

    // Projeção de homologação (20260921120000): mesma população, só campos operacionais.
    const sql2 = readFileSync(
      resolve(ROOT, "supabase/migrations/20260921120000_hits_consulta_projecao_homologacao.sql"),
      "utf8",
    );
    const r2i = sql2.indexOf("returns table (", sql2.indexOf("create function public.operacional_hits_checkin_consulta()")) + "returns table (".length;
    const returns2 = sql2.slice(r2i, sql2.indexOf("\n)", r2i));
    for (const pattern of forbiddenColumnPatterns) {
      assert.doesNotMatch(returns2, pattern, `projeção não retorna coluna proibida (${pattern})`);
    }
    assert.deepEqual([...returns2.matchAll(/^\s*(\w+)\s+\w+/gm)].map((m) => m[1]), [
      "reservation_id",
      "external_reservation_id",
      "apartment_code",
      "main_guest_name",
      "main_guest_display_name",
      "check_in_previsto",
      "check_out_previsto",
      "status_reserva",
      "fnrh_status_agregado",
      "fnrh_hospedes_total",
      "fnrh_hospedes_confirmados",
      "total_hospedes",
      "acesso_liberado",
      "acesso_efetivo",
      "entrou_no_apto",
      "manter_na_lista_operacional",
    ]);
    const corpo2Inteiro = sql2.slice(sql2.indexOf("as $$"), sql2.lastIndexOf("$$;"));
    // Estado interno (pagamento/saldo/cobrança/comissionamento) só dentro do bloco
    // [permanencia], que produz um único booleano e não é projetado ao perfil.
    const iniPerm = corpo2Inteiro.indexOf("-- [permanencia:inicio]");
    const fimPerm = corpo2Inteiro.indexOf("-- [permanencia:fim]");
    assert.ok(iniPerm > 0 && fimPerm > iniPerm, "bloco [permanencia] delimitado");
    const blocoPerm = corpo2Inteiro.slice(iniPerm, fimPerm);
    const corpo2 = corpo2Inteiro.slice(0, iniPerm) + corpo2Inteiro.slice(fimPerm);
    assert.deepEqual([...blocoPerm.matchAll(/\)\s+as\s+(\w+)/g)].map((m) => m[1]), ["pendencia_interna", "quitado_centavos"], "bloco [permanencia] só produz o booleano (e o subtotal interno)");
    assert.ok(!/perm\.(?!pendencia_interna)\w+/.test(corpo2), "fora do bloco só se usa perm.pendencia_interna");
    assert.match(corpo2, /coalesce\(perm\.pendencia_interna, true\)[\s\S]*\) as manter_na_lista_operacional/, "pendência interna só entra na decisão neutra");
    assert.ok(!/q\.quitado_centavos/.test(corpo2), "subtotal interno não sai do bloco");
    assert.match(corpo2, /if not public\.is_yes_hotel_hits_consulta_reader\(\) then/);
    assert.match(sql2, /security definer\s*\nset search_path = ''/);
    for (const col of ["pagamento", "balance", "amount", "email", "whatsapp", "telefone", "documento", "placa", "comiss", "senha", "payload"]) {
      assert.ok(!new RegExp(col, "i").test(corpo2), `corpo da RPC não lê ${col}`);
    }
    assert.doesNotMatch(sql2, /\b(insert|update|delete)\b\s+(into|public\.|from)/i, "RPC sem escrita");
    assert.doesNotMatch(sql2, /grant\s+(select|insert|update|delete)/i, "nenhum GRANT em tabela");
    assert.doesNotMatch(sql2, /create policy|alter policy|enable row level/i, "RLS intocada");
    assert.match(sql2, /revoke all on function public\.operacional_hits_checkin_consulta\(\) from public, anon;/);
    assert.match(sql2, /grant execute on function public\.operacional_hits_checkin_consulta\(\) to authenticated;/);
    ok("projeção de homologação: 16 colunas operacionais (decisão de permanência só booleana), sem financeiro/contato/documento, sem escrita, RLS e grants inalterados");
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

  console.log("\n== 16. Login pela raiz (ui/index.html) redireciona hits_consulta para o Check-in ==");
  {
    const indexHtml = readFileSync(resolve(ROOT, "ui/index.html"), "utf8");
    const loginHtml = readFileSync(resolve(ROOT, "ui/usuarios-login-mvp.html"), "utf8");

    for (const [nome, html] of [["index.html", indexHtml], ["usuarios-login-mvp.html", loginHtml]] as const) {
      const iPolicy = html.indexOf('src="./yes-nav-policy.js');
      const iLogin = html.indexOf('src="./usuarios-login-mvp.js');
      assert.ok(iPolicy > -1, `${nome} carrega yes-nav-policy.js`);
      assert.ok(iLogin > -1 && iPolicy < iLogin, `${nome}: yes-nav-policy.js antes de usuarios-login-mvp.js`);
    }
    ok("A. index.html carrega yes-nav-policy.js antes de usuarios-login-mvp.js");

    assert.match(indexHtml, /<option value="hits_consulta">HITS \(consulta\)<\/option>/);
    ok("B. index.html oferece o perfil hits_consulta");

    // Mesma lógica real de redirectUserByRole, com a política carregada.
    const loginJs = readFileSync(resolve(ROOT, "ui/usuarios-login-mvp.js"), "utf8");
    const pick = (name: string) => {
      const i = loginJs.indexOf(`function ${name}(`);
      assert.ok(i > -1, `${name} existe em usuarios-login-mvp.js`);
      return loginJs.slice(i, loginJs.indexOf("\n}", i) + 2);
    };
    const src = `${pick("isCafeDemoReturnRequested")}\n${pick("redirectUserByRole")}\nthis.redirectUserByRole = redirectUserByRole;`;
    const redirectCom = (policy: unknown, role: string) => {
      const window = { location: { search: "", href: "" }, YesHotelNavPolicy: policy };
      const ctx = createContext({
        window,
        URLSearchParams,
        auth: { canAccessBreakfast: () => false },
      } as any);
      runInContext(src, ctx);
      const redirected = (ctx as any).redirectUserByRole({ role });
      return { redirected, href: window.location.href };
    };

    const hits = redirectCom(navPolicy, "hits_consulta");
    assert.equal(hits.redirected, true);
    assert.equal(hits.href, "./checkin-operacional-mvp.html");
    ok("C. hits_consulta, com a política carregada, vai direto para ./checkin-operacional-mvp.html");

    for (const role of ["admin", "recepcao"]) {
      const r = redirectCom(navPolicy, role);
      assert.equal(r.redirected, false, `${role} permanece na Home`);
      assert.equal(r.href, "");
    }
    ok("D. admin e recepção continuam na Home");

    const cafe = redirectCom(navPolicy, "cafe");
    assert.equal(cafe.redirected, true);
    assert.equal(cafe.href, navPolicy.getHomeHrefForRole("cafe"));
    ok("E. café segue a política atual (primeiro item do seu menu)");

    // O defeito original: sem a política carregada, hits_consulta ficava na Home.
    assert.equal(redirectCom(undefined, "hits_consulta").redirected, false);

    const criticos = [
      'src="./yes-nav-policy.js',
      '<option value="hits_consulta">HITS (consulta)</option>',
      'placeholder="+5567999887766"',
    ];
    for (const trecho of criticos) {
      assert.equal(indexHtml.includes(trecho), loginHtml.includes(trecho), `divergência em: ${trecho}`);
      assert.ok(indexHtml.includes(trecho), `index.html sem: ${trecho}`);
    }
    const scripts = (html: string) => Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g), (m) => m[1]);
    assert.deepEqual(scripts(indexHtml), scripts(loginHtml), "mesmos scripts, na mesma ordem");
    ok("F. index.html e usuarios-login-mvp.html alinhados nos elementos críticos (scripts, perfil e telefone)");
  }

  console.log(`\nOK test-perfis-navegacao-hits-consulta (${cases} casos)`);
}

main();
