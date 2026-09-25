/**
 * Tela Configuracoes -> Mensagens automaticas.
 *
 * Dois riscos que estes testes cobrem:
 *
 * 1. A previa mostrar algo diferente do que o hospede recebe. O espelho do
 *    navegador roda de verdade aqui e e comparado com o motor do dominio.
 * 2. A tela ganhar poder sobre a REGRA. Ela edita texto; gatilho, canal e
 *    horario nao podem aparecer em lugar nenhum dela.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import { CATALOGO_MENSAGENS } from "../src/lib/domain/yes-hotel/mensagens-catalogo.ts";
import {
  PARAMETROS_SUPORTADOS,
  renderizarTemplate,
  validarTemplate,
} from "../src/lib/domain/yes-hotel/mensagens-template.ts";

function ok(label: string) {
  console.log("  OK  " + label);
}

const ROOT = process.cwd();
const ler = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const html = ler("ui/mensagens-automaticas.html");
const js = ler("ui/mensagens-automaticas.js");
const policySrc = ler("ui/yes-mensagens-policy.js");
const index = ler("ui/index.html");

// Executa o espelho do navegador de verdade.
const ctx = createContext({ globalThis: {} as never });
(ctx as never as { globalThis: unknown }).globalThis = ctx;
runInContext(policySrc, ctx);
const P = (ctx as never as { YesMensagensPolicy: Record<string, Function> })
  .YesMensagensPolicy;

const EXEMPLO = P.EXEMPLO as Record<string, string>;

console.log("\n== Espelho do navegador bate com o dominio ==");
{
  assert.equal(
    JSON.stringify(P.PARAMETROS_SUPORTADOS),
    JSON.stringify([...PARAMETROS_SUPORTADOS]),
    "lista de parametros divergiu entre navegador e dominio",
  );

  // Cada corpo padrao renderiza igual nos dois motores.
  for (const m of CATALOGO_MENSAGENS) {
    const dominio = renderizarTemplate(m.corpo_padrao, EXEMPLO);
    const navegador = P.renderizarTemplate(m.corpo_padrao, EXEMPLO) as {
      texto: string; html: string;
      parametros_ausentes: string[]; parametros_desconhecidos: string[];
    };
    assert.equal(navegador.texto, dominio.texto, "texto divergiu em " + m.chave);
    assert.equal(navegador.html, dominio.html, "html divergiu em " + m.chave);
  }

  // E o caso critico: sem Wi-Fi, os dois removem o bloco inteiro.
  const semWifi = { ...EXEMPLO, wifi_rede: "", wifi_senha: "" };
  const d = renderizarTemplate(CATALOGO_MENSAGENS[0]!.corpo_padrao, semWifi);
  const n = P.renderizarTemplate(CATALOGO_MENSAGENS[0]!.corpo_padrao, semWifi) as { texto: string };
  assert.equal(n.texto, d.texto);
  assert.doesNotMatch(n.texto, /Wi-Fi:|Rede:|Senha:/);
  ok("previa renderiza exatamente o que o hospede recebe");
}

console.log("\n== Validacao tambem espelhada ==");
{
  const casos = [
    CATALOGO_MENSAGENS[0]!.corpo_padrao,
    "",
    "   ",
    "Olá {{nao_existe}}",
    "Olá {{hospede_nome}",
    "Texto sem parâmetro.",
    "x".repeat(4001),
  ];
  for (const c of casos) {
    const d = validarTemplate(c);
    const n = P.validarTemplate(c) as { valido: boolean; erros: string[]; avisos: string[] };
    assert.equal(n.valido, d.valido, "validade divergiu: " + c.slice(0, 20));
    assert.equal(n.erros.length > 0, d.erros.length > 0);
    assert.equal(n.avisos.length > 0, d.avisos.length > 0);
  }
  ok("validacao do navegador concorda com a do dominio");
}

console.log("\n== Cada mensagem tem editor proprio ==");
{
  // As oito chaves do dominio aparecem na tela, e nenhuma a mais.
  const doDominio = CATALOGO_MENSAGENS.map((m) => m.chave).sort();
  const daTela = [...js.matchAll(/chave: "([a-z0-9_]+)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual(daTela, doDominio, "catalogo da tela divergiu do dominio");

  // Um textarea, um salvar e um status POR mensagem, via data-atributo.
  assert.match(js, /area\.setAttribute\("data-texto", def\.chave\)/);
  assert.match(js, /salvarBtn\.setAttribute\("data-salvar", def\.chave\)/);
  assert.match(js, /status\.setAttribute\("data-status", def\.chave\)/);
  // O salvar manda UMA chave por vez.
  assert.match(js, /p_chave: chave,\s*\n\s*p_corpo: area\.value/);
  // Nada de salvar tudo de uma vez.
  assert.doesNotMatch(js, /salvarTodos|salvar_todas|forEach\([^)]*salvar\(/);
  ok("oito editores independentes, um salvar por mensagem");
}

console.log("\n== A tela nao edita regra ==");
{
  // Nenhum campo de gatilho, canal, horario ou destinatario.
  for (const proibido of [
    "p_canal", "p_gatilho", "p_horario", "p_destinatario",
    "channel:", "cron", "trigger", "agendar", "disparar",
  ]) {
    assert.equal(js.includes(proibido), false, "a tela expoe " + proibido);
  }
  // O "quando" e texto, nunca um campo editavel.
  assert.match(js, /"Quando é enviada: " \+ def\.quando/);
  assert.doesNotMatch(js, /data-quando|input[^\n]*quando/i);
  // O aviso esta visivel na pagina.
  assert.match(html, /altera <strong>somente o texto<\/strong>/);
  assert.match(html, /não pode ser mudado aqui/);
  ok("gatilho e leitura; nao ha campo que o altere");
}

console.log("\n== Mensagens ainda nao integradas avisam ==");
{
  // So a de boas-vindas esta ligada; as outras precisam dizer isso ao usuario.
  const ativas = CATALOGO_MENSAGENS.filter((m) => m.status === "ativa");
  assert.deepEqual(ativas.map((m) => m.chave), ["boas_vindas_primeiro_acesso"]);
  assert.match(js, /def\.status !== "ativa"/);
  assert.match(js, /ainda não controla o envio real/);
  assert.match(js, /def\.status === "ativa" \? "Em uso" : "Preparada"/);
  ok("as sete preparadas avisam que nao controlam o disparo");
}

console.log("\n== Elementos exigidos na tela ==");
{
  assert.match(js, /"Texto da mensagem"/);
  assert.match(js, /"Parâmetros disponíveis"/);
  assert.match(js, /"Prévia com dados de exemplo"/);
  assert.match(js, /"Salvar"/);
  assert.match(js, /"Restaurar padrão"/);
  assert.match(js, /el\("textarea", "msg-texto"\)/);
  // Clicar no parametro insere no texto.
  assert.match(js, /area\.value\.slice\(0, pos\) \+ token \+ area\.value\.slice\(pos\)/);
  // Previa usa dados ficticios, nunca de hospede real.
  assert.match(policySrc, /Dados fictícios da prévia/);
  assert.match(policySrc, /Maria Souza/);
  ok("nome, gatilho, texto, parametros, previa, salvar e restaurar presentes");
}

console.log("\n== Entrada por Configuracoes ==");
{
  assert.match(index, /href="\.\/mensagens-automaticas\.html"/);
  assert.match(index, /Mensagens automáticas/);
  // Dentro da secao de Configuracoes, nao na raiz.
  const secao = index.slice(
    index.indexOf('id="view-configuracoes"'),
    index.indexOf('id="view-usuarios"'),
  );
  assert.match(secao, /mensagens-automaticas\.html/, "card fora de Configuracoes");
  // A pagina carrega o espelho antes da tela.
  const iPolicy = html.indexOf("yes-mensagens-policy.js");
  const iTela = html.indexOf("mensagens-automaticas.js");
  assert.ok(iPolicy > 0 && iPolicy < iTela, "ordem de scripts errada");
  ok("card em Configuracoes e scripts na ordem certa");
}

console.log("\n== HTML escapa o que vem do hospede ==");
{
  const r = P.renderizarTemplate("Olá, {{hospede_nome}}!", {
    hospede_nome: '<img src=x onerror="alert(1)">',
  }) as { html: string };
  assert.doesNotMatch(r.html, /<img/);
  assert.match(r.html, /&lt;img/);
  ok("previa e e-mail escapam conteudo");
}

console.log("\nTela de mensagens automaticas: todos os testes passaram.\n");
