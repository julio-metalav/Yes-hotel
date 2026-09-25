/**
 * Motor de mensagens automaticas com texto editavel.
 *
 * O ponto que estes testes protegem: parametro ausente NAO pode virar buraco
 * no texto que chega ao hospede. Substituir por vazio produziria
 *
 *     Wi-Fi:
 *     Rede:
 *     Senha:
 *
 * que e pior do que nao mandar o bloco.
 */
import assert from "node:assert/strict";

import {
  CATALOGO_MENSAGENS,
  CHAVES_MENSAGENS,
  buscarDefinicaoMensagem,
  validarCatalogo,
} from "../src/lib/domain/yes-hotel/mensagens-catalogo.ts";
import {
  PARAMETROS_SUPORTADOS,
  TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO,
  renderizarTemplate,
  validarTemplate,
} from "../src/lib/domain/yes-hotel/mensagens-template.ts";

function ok(label: string) {
  console.log("  OK  " + label);
}

const COMPLETO = {
  hospede_nome: "Breno Santoriano",
  apartamento: "34",
  wifi_rede: "YES-34",
  wifi_senha: "segredo34",
  checkout_horario: "11h",
  telefone_recepcao: "(67) 99999-0000",
  data_entrada: "11/08/2026",
  data_saida: "12/08/2026",
};

console.log("\n== Substituicao com todos os parametros ==");
{
  const r = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, COMPLETO);
  assert.match(r.texto, /Olá, Breno Santoriano!/);
  assert.match(r.texto, /Apartamento: 34/);
  assert.match(r.texto, /Rede: YES-34/);
  assert.match(r.texto, /Senha: segredo34/);
  assert.match(r.texto, /Check-out: 11h/);
  assert.match(r.texto, /\(67\) 99999-0000/);
  // Nenhuma chave sobra no texto que vai ao hospede.
  assert.doesNotMatch(r.texto, /\{\{/, "sobrou chave no texto final");
  assert.deepEqual(r.parametros_ausentes, []);
  assert.deepEqual(r.parametros_desconhecidos, []);
  ok("todos os parametros substituidos, sem chave residual");
}

console.log("\n== Sem Wi-Fi: o bloco inteiro sai, sem linha orfa ==");
{
  const semWifi = { ...COMPLETO, wifi_rede: "", wifi_senha: "" };
  const r = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, semWifi);

  // O que NAO pode aparecer de jeito nenhum:
  assert.doesNotMatch(r.texto, /Wi-Fi:/, "cabecalho Wi-Fi ficou orfao");
  assert.doesNotMatch(r.texto, /Rede:/, "sobrou 'Rede:' sem valor");
  assert.doesNotMatch(r.texto, /Senha:/, "sobrou 'Senha:' sem valor");
  assert.doesNotMatch(r.texto, /\{\{/);

  // O resto da mensagem continua inteiro.
  assert.match(r.texto, /Olá, Breno Santoriano!/);
  assert.match(r.texto, /Apartamento: 34/);
  assert.match(r.texto, /Check-out: 11h/);
  assert.match(r.texto, /\(67\) 99999-0000/);
  assert.deepEqual(r.parametros_ausentes, ["wifi_rede", "wifi_senha"]);
  ok("bloco de Wi-Fi removido por inteiro; resto intacto");
}

console.log("\n== Só a senha ausente: o bloco tambem nao fica pela metade ==");
{
  const r = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, {
    ...COMPLETO,
    wifi_senha: "",
  });
  assert.doesNotMatch(r.texto, /Senha:/, "sobrou 'Senha:' sem valor");
  // A rede sozinha nao serve ao hospede, mas a linha dela tem valor proprio:
  // o que importa e nao existir rotulo sem dado.
  assert.doesNotMatch(r.texto, /Senha:\s*$/m);
  assert.deepEqual(r.parametros_ausentes, ["wifi_senha"]);
  ok("parametro isolado ausente nao deixa rotulo solto");
}

console.log("\n== Espacamento nao degenera ==");
{
  const r = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, {
    ...COMPLETO,
    wifi_rede: "",
    wifi_senha: "",
  });
  assert.doesNotMatch(r.texto, /\n{3,}/, "sobrou bloco de linhas em branco");
  assert.doesNotMatch(r.texto, /^\n/, "comeca com linha em branco");
  assert.doesNotMatch(r.texto, /\n$/, "termina com linha em branco");
  assert.doesNotMatch(r.texto, /[ \t]+\n/, "sobrou espaco no fim de linha");
  ok("sem linha em branco sobrando nas pontas nem no meio");
}

console.log("\n== HTML sai do MESMO texto ==");
{
  const r = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, COMPLETO);
  assert.match(r.html, /<p>/);
  assert.match(r.html, /Breno Santoriano/);
  assert.match(r.html, /YES-34/);
  // Quebra simples vira <br/>, bloco em branco vira paragrafo novo.
  assert.match(r.html, /Rede: YES-34<br\/>Senha: segredo34/);
  assert.doesNotMatch(r.html, /\{\{/);

  // Sem Wi-Fi, o HTML tambem nao carrega rotulo solto.
  const semWifi = renderizarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO, {
    ...COMPLETO, wifi_rede: "", wifi_senha: "",
  });
  assert.doesNotMatch(semWifi.html, /Wi-Fi:/);
  assert.doesNotMatch(semWifi.html, /Rede:/);
  ok("HTML derivado do texto, com a mesma remocao de bloco");
}

console.log("\n== HTML escapa conteudo do hospede ==");
{
  const r = renderizarTemplate("Olá, {{hospede_nome}}!", {
    hospede_nome: '<script>alert("x")</script>',
  });
  assert.doesNotMatch(r.html, /<script>/, "nome do hospede entrou cru no HTML");
  assert.match(r.html, /&lt;script&gt;/);
  ok("valor de parametro e escapado no HTML");
}

console.log("\n== Parametro desconhecido nao gera texto enganoso ==");
{
  const r = renderizarTemplate(
    ["Olá, {{hospede_nome}}!", "Saldo: {{valor_total_devido}}", "Tchau."].join("\n"),
    COMPLETO,
  );
  // Nem a chave crua nem um valor inventado chegam ao hospede.
  assert.doesNotMatch(r.texto, /\{\{valor_total_devido\}\}/);
  assert.doesNotMatch(r.texto, /Saldo:/);
  assert.match(r.texto, /Olá, Breno Santoriano!/);
  assert.match(r.texto, /Tchau\./);
  assert.deepEqual(r.parametros_desconhecidos, ["valor_total_devido"]);
  ok("linha com parametro inexistente sai, e o nome volta para diagnostico");
}

console.log("\n== Validacao antes de salvar ==");
{
  const bom = validarTemplate(TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO);
  assert.equal(bom.valido, true);
  assert.deepEqual(bom.erros, []);
  assert.ok(bom.parametros_usados.includes("wifi_rede"));

  assert.equal(validarTemplate("").valido, false);
  assert.equal(validarTemplate("   ").valido, false);

  const desconhecido = validarTemplate("Olá {{nao_existe}}");
  assert.equal(desconhecido.valido, false);
  assert.ok(desconhecido.erros.some((e) => e.includes("nao_existe")));

  const chaveAberta = validarTemplate("Olá {{hospede_nome}");
  assert.equal(chaveAberta.valido, false);

  const semParam = validarTemplate("Bem-vindo ao Yes Hotel.");
  assert.equal(semParam.valido, true);
  assert.ok(semParam.avisos.length > 0, "deveria avisar que e igual para todos");

  assert.equal(validarTemplate("x".repeat(4001)).valido, false);
  ok("vazio, parametro inexistente, chave aberta e tamanho recusados");
}

console.log("\n== Lista de parametros e fechada ==");
{
  assert.deepEqual([...PARAMETROS_SUPORTADOS], [
    "hospede_nome",
    "apartamento",
    "wifi_rede",
    "wifi_senha",
    "checkout_horario",
    "telefone_recepcao",
    "data_entrada",
    "data_saida",
  ]);
  // Todos resolvem de verdade.
  const corpo = PARAMETROS_SUPORTADOS.map((p) => `${p}={{${p}}}`).join("\n");
  const r = renderizarTemplate(corpo, COMPLETO);
  for (const p of PARAMETROS_SUPORTADOS) {
    assert.match(r.texto, new RegExp(`${p}=`), "parametro nao resolveu: " + p);
  }
  assert.doesNotMatch(r.texto, /\{\{/);
  ok("os oito parametros exigidos resolvem");
}

console.log("\n== Espacos dentro da chave ==");
{
  const r = renderizarTemplate("Olá, {{ hospede_nome }}!", COMPLETO);
  assert.match(r.texto, /Olá, Breno Santoriano!/);
  ok("chave com espaco interno e aceita");
}

console.log("\nMotor de mensagens: todos os testes passaram.\n");

console.log("\n== Catalogo: cada mensagem e um registro proprio ==");
{
  // As oito mensagens pedidas, cada uma com chave propria.
  assert.deepEqual(CHAVES_MENSAGENS, [
    "boas_vindas_primeiro_acesso",
    "senha_de_acesso",
    "pendencia_fnrh",
    "pendencia_pagamento",
    "pendencia_fnrh_e_pagamento",
    "aviso_tolerancia_1h",
    "pagamento_presencial_diferido",
    "check_out",
  ]);
  assert.equal(new Set(CHAVES_MENSAGENS).size, CHAVES_MENSAGENS.length, "chave duplicada");

  // O catalogo nao pode prometer parametro que o motor nao resolve.
  assert.deepEqual(validarCatalogo(), []);

  for (const m of CATALOGO_MENSAGENS) {
    assert.ok(m.nome.trim(), "sem nome: " + m.chave);
    assert.ok(m.quando.trim(), "sem descricao de gatilho: " + m.chave);
    assert.ok(m.corpo_padrao.trim(), "sem corpo padrao: " + m.chave);
    // Todo corpo padrao tem de ser valido e renderizavel.
    assert.equal(validarTemplate(m.corpo_padrao).valido, true, "corpo invalido: " + m.chave);
    const r = renderizarTemplate(m.corpo_padrao, COMPLETO);
    assert.doesNotMatch(r.texto, /\{\{/, "sobrou chave em " + m.chave);
    assert.ok(r.texto.trim(), "renderizou vazio: " + m.chave);
  }

  // Só a de boas-vindas está ligada ao envio neste PR; as demais são editáveis
  // mas ainda não trocam o texto do código — a tela não pode prometer o que o
  // backend não faz.
  const ativas = CATALOGO_MENSAGENS.filter((m) => m.status === "ativa").map((m) => m.chave);
  assert.deepEqual(ativas, ["boas_vindas_primeiro_acesso"]);

  assert.equal(buscarDefinicaoMensagem("boas_vindas_primeiro_acesso")?.status, "ativa");
  assert.equal(buscarDefinicaoMensagem("nao_existe"), null);
  assert.equal(buscarDefinicaoMensagem(null), null);
  ok("oito mensagens, chaves unicas, corpos validos e gatilho documentado");
}

console.log("\nCatalogo de mensagens: verificado.\n");
