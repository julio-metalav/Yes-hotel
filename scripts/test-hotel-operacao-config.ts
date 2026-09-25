/**
 * Dados do hotel: horário de check-out e telefone da recepção.
 *
 * Antes desta mudança os dois valores eram constantes no código
 * (`CHECKOUT_HORARIO = "11h"`, `TELEFONE_RECEPCAO`). Trocar o telefone da
 * recepção exigia deploy de Edge.
 *
 * O que estes testes protegem:
 *
 * 1. O valor virou configuração do hotel, com uma fonte só (hotel_operacao_config).
 * 2. As duas telas continuam separadas: Mensagens edita TEXTO, Dados do hotel
 *    edita VALOR. Nenhuma das duas RPCs aceita o campo da outra.
 * 3. A janela de validade da credencial (check-out 11:00 civil) NÃO virou
 *    configuração: continua sendo regra de fechadura, no código.
 *
 * Sem rede e sem banco: SQL, fontes e um cliente Supabase falso.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSupabaseFirstRoomAccessPorts } from "../src/lib/infrastructure/supabase/yes-hotel/index.ts";
import { renderizarTemplate } from "../src/lib/domain/yes-hotel/mensagens-template.ts";
import { CATALOGO_MENSAGENS } from "../src/lib/domain/yes-hotel/mensagens-catalogo.ts";

const ROOT = process.cwd();
const ler = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function ok(label: string) {
  console.log("  OK  " + label);
}

// Descoberta pelo sufixo: o timestamp muda se a migration for reordenada.
const SUFIXO = "_hotel_operacao_config.sql";
const MIGRATION = (() => {
  const dir = "supabase/migrations";
  const achados = readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(SUFIXO));
  assert.equal(achados.length, 1, "deve existir exatamente uma migration de dados do hotel");
  return `${dir}/${achados[0]}`;
})();

const sql = ler(MIGRATION);
const codigo = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const infra = ler("src/lib/infrastructure/supabase/yes-hotel/index.ts");
const telaJs = ler("ui/dados-do-hotel.js");
const telaHtml = ler("ui/dados-do-hotel.html");
const navPolicy = ler("ui/yes-nav-policy.js");
const indexHtml = ler("ui/index.html");
const loginHtml = ler("ui/usuarios-login-mvp.html");
const mensagensJs = ler("ui/mensagens-automaticas.js");
const mensagensPolicy = ler("ui/yes-mensagens-policy.js");
const mensagensSql = ler("supabase/migrations/20261003090000_mensagens_automaticas_templates.sql");

console.log("\n== Uma linha só: configuração do hotel, não por reserva ==");
{
  assert.match(codigo, /create table if not exists public\.hotel_operacao_config/);
  // Mesmo padrão de hotel_geo_config: PK boolean com check, então só existe
  // uma linha. Duas linhas seriam duas verdades sobre o mesmo hotel.
  assert.match(codigo, /id boolean primary key default true check \(id\)/);
  assert.match(codigo, /checkout_horario text not null/);
  assert.match(codigo, /telefone_recepcao text not null/);
  // O valor vai literal para o texto do hóspede: não pode ser frase livre.
  assert.match(codigo, /hotel_operacao_config_checkout_check/);
  assert.match(codigo, /hotel_operacao_config_telefone_check/);
  ok("tabela singleton com os dois valores validados");
}

console.log("\n== Escrita só pela RPC, e só por quem opera ==");
{
  assert.match(codigo, /alter table public\.hotel_operacao_config enable row level security/);
  assert.match(codigo, /for select to authenticated\s*\n\s*using \(public\.is_yes_hotel_ops_reader\(\)\)/);
  assert.match(codigo, /hotel_operacao_config_write_deny/);
  assert.match(codigo, /using \(false\) with check \(false\)/);
  assert.match(codigo, /revoke insert, update, delete on public\.hotel_operacao_config from authenticated, anon/);
  assert.match(codigo, /lower\(v_user\.perfil_usuario\) not in \('admin', 'recepcao'\)/);
  assert.match(codigo, /hotel_operacao_config_forbidden_role/);
  // Histórico append-only: quem mudou o que chega ao hóspede fica registrado.
  assert.match(codigo, /hotel_operacao_config_historico e append-only/);
  ok("RLS fecha escrita direta; RPC exige admin ou recepção e audita");
}

console.log("\n== Seed preserva o que o hóspede recebe hoje ==");
{
  assert.match(codigo, /values \(true, '11h', '\(67\) 99668-8886'\)/);
  // Reaplicar a migration não pode desfazer ajuste da recepção.
  assert.match(codigo, /on conflict \(id\) do nothing/);
  assert.match(codigo, /raise exception 'hotel_operacao_config sem linha singleton/);
  ok("valores atuais entram como padrão e não são sobrescritos depois");
}

console.log("\n== Escopo: não toca regra nenhuma ==");
{
  for (const proibido of [
    /operacional_reservas/,
    /acessos_senhas/,
    /credenciais/,
    /fnrh/i,
    /ttlock/i,
    /toleranc/i,
    /pagamento/i,
    /cron\.schedule/,
    /pg_net/,
    /operacional_mensagens_templates/,
  ]) {
    assert.doesNotMatch(codigo, proibido, "migration saiu do escopo: " + proibido);
  }
  ok("só a tabela nova, seu histórico e sua RPC");
}

console.log("\n== Texto e valor são configurações independentes ==");
{
  // A RPC de dados do hotel não tem por onde receber texto de mensagem...
  assert.match(codigo, /hotel_operacao_config_salvar\(\s*\n\s*p_checkout_horario text,\s*\n\s*p_telefone_recepcao text\s*\n\)/);
  const salvarHotel = codigo.slice(
    codigo.indexOf("function public.hotel_operacao_config_salvar("),
    codigo.indexOf("comment on function public.hotel_operacao_config_salvar"),
  );
  for (const proibido of ["p_corpo", "p_chave", "corpo text", "mensagem"]) {
    assert.equal(
      salvarHotel.includes(proibido),
      false,
      "a RPC de dados do hotel aceita " + proibido,
    );
  }
  // ...e a RPC de mensagens não tem por onde receber horário ou telefone.
  const salvarMensagem = mensagensSql.slice(
    mensagensSql.indexOf("function public.operacional_mensagens_salvar("),
  );
  for (const proibido of ["p_checkout", "p_telefone", "checkout_horario text", "telefone_recepcao text"]) {
    assert.equal(
      salvarMensagem.includes(proibido),
      false,
      "a RPC de mensagens aceita " + proibido,
    );
  }
  // O template só cita o parâmetro; o valor nunca está escrito nele.
  for (const m of CATALOGO_MENSAGENS) {
    assert.equal(m.corpo_padrao.includes("11h"), false, "valor literal no texto de " + m.chave);
    assert.equal(m.corpo_padrao.includes("99668"), false, "telefone literal no texto de " + m.chave);
  }
  ok("editar texto não muda horário nem telefone, e vice-versa");
}

console.log("\n== O código não guarda mais os valores ==");
{
  assert.equal(infra.includes('"11h"'), false, "horário de check-out ainda hardcoded no código");
  assert.equal(infra.includes("99668"), false, "telefone da recepção ainda hardcoded no código");
  assert.doesNotMatch(infra, /CHECKOUT_HORARIO|TELEFONE_RECEPCAO/);
  // Ele lê a fonte canônica.
  assert.match(infra, /\.from\("hotel_operacao_config"\)/);
  assert.match(infra, /checkout_horario: operacao\.checkout_horario/);
  assert.match(infra, /telefone_recepcao: operacao\.telefone_recepcao/);
  // Prévia da tela de mensagens também deixou de repetir o valor.
  assert.equal(mensagensPolicy.includes("99668"), false, "telefone real no espelho da prévia");
  assert.match(mensagensPolicy, /checkout_horario: null/);
  assert.match(mensagensJs, /\.from\("hotel_operacao_config"\)/);
  ok("uma fonte só: a tabela");
}

console.log("\n== Validade da credencial continua sendo regra, não configuração ==");
{
  const tz = ler("src/lib/domain/yes-hotel/hotel-timezone.ts");
  assert.match(tz, /DEFAULT_CHECK_OUT_HOUR = 11/);
  // A janela da fechadura não pode passar a depender desta tabela: mudar o
  // texto exibido ao hóspede nunca pode encurtar ou esticar uma senha.
  assert.equal(tz.includes("hotel_operacao_config"), false);
  assert.equal(
    ler("src/lib/domain/yes-hotel/access-engine.ts").includes("hotel_operacao_config"),
    false,
  );
  ok("horário exibido e validade da senha seguem desacoplados");
}

console.log("\n== Entrada em Configurações, com a mesma matriz de perfis ==");
{
  const secao = indexHtml.slice(
    indexHtml.indexOf('id="view-configuracoes"'),
    indexHtml.indexOf('id="view-usuarios"'),
  );
  assert.match(secao, /href="\.\/dados-do-hotel\.html"/, "card fora de Configurações");
  assert.match(secao, /data-nav="hotel"/);
  assert.match(secao, /Dados do hotel/);
  // Rota own, com a regra de sempre: recepção tem tudo do admin menos usuarios.
  assert.match(navPolicy, /admin: \[[^\]]*"hotel"[^\]]*\]/);
  assert.match(navPolicy, /recepcao: \[[^\]]*"hotel"[^\]]*\]/);
  assert.doesNotMatch(navPolicy, /cafe: \[[^\]]*"hotel"/);
  assert.doesNotMatch(navPolicy, /hits_consulta: \[[^\]]*"hotel"/);
  // A tela protege a própria rota, não confia no menu.
  assert.match(telaJs, /isRouteAuthorized\(user\.role, "hotel"\)/);
  assert.match(telaJs, /rpc\("hotel_operacao_config_salvar"/);
  // Ela edita valor, nunca texto de mensagem.
  for (const proibido of ["p_corpo", "operacional_mensagens_salvar", "textarea"]) {
    assert.equal(telaJs.includes(proibido), false, "a tela de dados do hotel expõe " + proibido);
  }
  // E diz ao usuário onde cada coisa se edita.
  assert.match(telaHtml, /\{\{checkout_horario\}\}/);
  assert.match(telaHtml, /editar uma mensagem n(ã|a)o altera/i);
  assert.match(ler("ui/mensagens-automaticas.html"), /dados-do-hotel\.html/);
  ok("card, rota, guard e aviso cruzado entre as duas telas");
}

console.log("\n== As duas paginas de entrada mostram os mesmos cards ==");
{
  // index.html e usuarios-login-mvp.html sao paginas de entrada duplicadas e a
  // servida em producao e a segunda. O PR #140 adicionou os cards so na
  // primeira: em PROD, Configuracoes continuou com os tres cards antigos.
  // Divergir aqui nao quebra teste nenhum -- quebra a tela do usuario.
  const bloco = (html: string) => {
    const ini = html.indexOf('id="view-configuracoes"');
    assert.ok(ini > 0, "secao de Configuracoes ausente");
    return html.slice(ini, html.indexOf("</nav>", ini));
  };
  assert.equal(
    bloco(loginHtml),
    bloco(indexHtml),
    "Configuracoes divergiu entre index.html e usuarios-login-mvp.html",
  );
  for (const html of [indexHtml, loginHtml]) {
    assert.match(html, /data-nav="hotel"/);
    assert.match(html, /data-nav="mensagens"/);
    assert.match(html, /href="\.\/dados-do-hotel\.html"/);
    assert.match(html, /href="\.\/mensagens-automaticas\.html"/);
  }
  ok("Configuracoes identica nas duas paginas de entrada");
}

async function testeContexto() {
  console.log("\n== Contexto de envio lê a tabela ==");
  type Resposta = { data: Record<string, unknown> | null; error?: unknown };
  function fakeClient(tabelas: Record<string, Resposta>) {
    const chamadas: string[] = [];
    const client = {
      from(tabela: string) {
        chamadas.push(tabela);
        const resposta: Resposta = tabelas[tabela] ?? { data: null };
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => resposta,
        };
        return builder;
      },
    };
    return { chamadas, client };
  }

  const reserva = {
    data: {
      apartamento: "22",
      hospede_principal: "Maria Souza",
      external_reservation_id: "3281",
      check_in_previsto: "2026-08-11",
      check_out_previsto: "2026-08-13",
    },
  };

  {
    const fake = fakeClient({
      operacional_reservas: reserva,
      apartamentos: { data: { wifi_ssid: "YES-22", wifi_password: "hotel2026" } },
      hotel_operacao_config: {
        data: { checkout_horario: "12h", telefone_recepcao: "(67) 1111-2222" },
      },
    });
    const ports = createSupabaseFirstRoomAccessPorts(fake.client as never, {});
    const ctx = await ports.reservationDisplay!.getContext("res-1");
    assert.equal(ctx.checkout_horario, "12h");
    assert.equal(ctx.telefone_recepcao, "(67) 1111-2222");

    // Segunda montagem no mesmo ciclo não relê a configuração.
    await ports.reservationDisplay!.getContext("res-1");
    const leituras = fake.chamadas.filter((t) => t === "hotel_operacao_config").length;
    assert.equal(leituras, 1, "configuração relida no mesmo ciclo");
    ok("valor vem da tabela e é lido uma vez por invocação");
  }

  {
    // Tabela ainda não aplicada, ou leitura com erro: o envio não pode cair.
    const fake = fakeClient({
      operacional_reservas: reserva,
      apartamentos: { data: { wifi_ssid: "YES-22", wifi_password: "hotel2026" } },
      hotel_operacao_config: { data: null, error: { message: "relation does not exist" } },
    });
    const ports = createSupabaseFirstRoomAccessPorts(fake.client as never, {});
    const ctx = await ports.reservationDisplay!.getContext("res-1");
    assert.equal(ctx.checkout_horario, null);
    assert.equal(ctx.telefone_recepcao, null);
    // O resto do contexto continua completo: Wi-Fi inclusive.
    assert.equal(ctx.wifi_ssid, "YES-22");
    assert.equal(ctx.apartment_number, "22");

    // E o texto sai sem linha órfã nem sobra de pontuação.
    const boasVindas = CATALOGO_MENSAGENS.find((m) => m.chave === "boas_vindas_primeiro_acesso")!;
    const r = renderizarTemplate(boasVindas.corpo_padrao, {
      hospede_nome: ctx.guest_main_name,
      apartamento: ctx.apartment_number,
      wifi_rede: ctx.wifi_ssid,
      wifi_senha: ctx.wifi_password,
      checkout_horario: ctx.checkout_horario,
      telefone_recepcao: ctx.telefone_recepcao,
      data_entrada: ctx.data_entrada,
      data_saida: ctx.data_saida,
    });
    assert.doesNotMatch(r.texto, /Check-out/);
    assert.doesNotMatch(r.texto, /fale conosco/);
    assert.doesNotMatch(r.texto, /\n\n\n/, "sobrou linha em branco dupla");
    assert.match(r.texto, /Maria Souza/);
    assert.match(r.texto, /YES-22/);
    ok("sem configuração, a mensagem sai completa menos as linhas afetadas");
  }
}

testeContexto()
  .then(() => {
    console.log("\nDados do hotel: todos os testes passaram.\n");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
