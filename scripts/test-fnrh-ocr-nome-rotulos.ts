/**
 * Regressao: OCR gravando rotulo do documento como nome do hospede.
 *
 * Caso real em PROD: fichas com "NOME" e "SOBRENOME" no campo de nome.
 *
 * Causa: o extrator do Google usava `[:\s]+` entre rotulo e valor, e `\s`
 * casa quebra de linha. Em documento com rotulo numa linha e valor na
 * seguinte, o regex atravessava a quebra e capturava o PROXIMO ROTULO.
 *
 * A defesa tem duas camadas de proposito: lista de rotulos para o caso
 * conhecido, analise de forma para o que a lista nao previu.
 */
import assert from "node:assert/strict";

import {
  avaliarNomeHospede,
  isNomeHospedePlausivel,
  isRotuloDocumento,
  normalizarParaComparacao,
  sanitizarNomeHospede,
} from "../src/lib/domain/yes-hotel/fnrh-nome-plausibilidade.ts";
import { normalizeGoogleVisionText } from "../src/lib/domain/yes-hotel/fnrh-ocr-normalize-google.ts";
import {
  buildOcrPersistPatch,
  canonicalizeOcrSuggestedFields,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-apply-suggestions.ts";

function ok(label: string) {
  console.log("  OK  " + label);
}

console.log("\n== Rotulos do documento nunca sao nome ==");
{
  const rotulos = [
    "NOME", "SOBRENOME", "NAME", "SURNAME", "APELIDO", "FILIACAO",
    "FILIAÇÃO", "NACIONALIDADE", "DATA DE NASCIMENTO", "DOCUMENTO",
    "CPF", "RG", "SEXO", "ORGAO EMISSOR", "ÓRGÃO EMISSOR", "VALIDADE",
    "PASSAPORTE", "PASSPORT", "GIVEN NAMES", "NOME COMPLETO",
    "REPUBLICA FEDERATIVA DO BRASIL", "REGISTRO GERAL",
    "nome", "Sobrenome", "  NOME  ", "NOME:", "N O M E".replace(/ /g, ""),
  ];
  for (const r of rotulos) {
    assert.equal(isNomeHospedePlausivel(r), false, "aceitou rotulo: " + r);
    assert.equal(sanitizarNomeHospede(r), "", "sanitizar devolveu valor para: " + r);
  }
  // Acento e caixa nao escapam da lista.
  assert.equal(isRotuloDocumento("FILIAÇÃO"), true);
  assert.equal(isRotuloDocumento("filiacao"), true);
  assert.equal(normalizarParaComparacao("Órgão Emissor"), "ORGAO EMISSOR");
  ok("lista de rotulos cobre acento, caixa e espaco");
}

console.log("\n== Nomes reais continuam passando ==");
{
  const nomes = [
    "CARLOS GABRIEL PREZENSZKY",
    "ANA TESTE SILVA",
    "MARIA DA CONCEIÇÃO SOUZA",
    "JOSÉ ANTÔNIO DE OLIVEIRA",
    "JEAN-PIERRE DUPONT",
    "O'BRIEN MACARTHUR",
    "LUÍS INÁCIO",
    "Ana Paula Ferreira",
    "ALVARO BANDUCCI JUNIOR",
  ];
  for (const n of nomes) {
    assert.equal(isNomeHospedePlausivel(n), true, "recusou nome real: " + n);
    assert.equal(sanitizarNomeHospede(n), n.replace(/\s+/g, " ").trim());
  }
  // Acentos e compostos preservados: a validacao normaliza so para comparar.
  assert.equal(sanitizarNomeHospede("  MARIA DA CONCEIÇÃO   SOUZA "), "MARIA DA CONCEIÇÃO SOUZA");
  assert.equal(sanitizarNomeHospede("JEAN-PIERRE DUPONT"), "JEAN-PIERRE DUPONT");
  ok("nome composto, acento, hifen e apostrofo preservados");
}

console.log("\n== Forma implausivel: nao depende da lista ==");
{
  const casos: Array<[string, string]> = [
    ["12/03/1990", "parece_data"],
    ["1990-03-12", "parece_data"],
    ["529.982.247-25", "contem_digito"],
    ["ANA SILVA 1234", "contem_digito"],
    ["MG1234567", "contem_digito"],
    ["P<BRASILVA<<CARLOS", "parece_codigo_documento"],
    ["AB", "curto_demais"],
    ["XKQ", "palavra_unica_curta"],
    ["", "vazio"],
    ["   ", "vazio"],
    ["///", "sem_letras"],
  ];
  for (const [valor, motivo] of casos) {
    const r = avaliarNomeHospede(valor);
    assert.equal(r.plausivel, false, "aceitou: " + JSON.stringify(valor));
    if (!r.plausivel) assert.equal(r.motivo, motivo, "motivo errado para " + JSON.stringify(valor));
  }
  // Rotulo colado no INICIO do valor e recusado.
  assert.equal(isNomeHospedePlausivel("NOME CARLOS SILVA"), false);
  assert.equal(isNomeHospedePlausivel("SOBRENOME ANA PAULA"), false);
  // Mas palavra coincidente em outra posicao NAO reprova nome legitimo:
  // rejeitar por coincidencia custaria mais do que o caso raro que pegaria.
  assert.equal(isNomeHospedePlausivel("OCR NOME"), true);
  ok("data, numero, codigo, sigla e rotulo no inicio sao recusados por forma");
}

console.log("\n== O bug real: rotulo na linha seguinte ==");
{
  // Layout que causou o incidente: rotulos empilhados, valor so na terceira
  // linha. O regex antigo capturava "SOBRENOME".
  const doc = [
    "REPUBLICA FEDERATIVA DO BRASIL",
    "NOME",
    "SOBRENOME",
    "CARLOS GABRIEL PREZENSZKY",
    "CPF",
    "529.982.247-25",
  ].join("\n");
  const r = normalizeGoogleVisionText({ fullText: doc });
  assert.notEqual(r.suggested_fields.hospede_nome, "SOBRENOME", "gravou o rotulo seguinte");
  assert.notEqual(r.suggested_fields.hospede_nome, "NOME");
  ok("rotulo na linha seguinte nao vira nome");

  // Valor legitimo na linha seguinte continua sendo aproveitado.
  const doc2 = ["NOME", "CARLOS GABRIEL PREZENSZKY", "CPF: 529.982.247-25"].join("\n");
  const r2 = normalizeGoogleVisionText({ fullText: doc2 });
  assert.equal(r2.suggested_fields.hospede_nome, "CARLOS GABRIEL PREZENSZKY");
  ok("valor real na linha seguinte ainda e lido");

  // Mesma linha, o caso mais comum, segue funcionando.
  const doc3 = "NOME: MARIA TESTE SILVA\nDATA DE NASCIMENTO: 01/02/1990\nSEXO: F\n";
  const r3 = normalizeGoogleVisionText({ fullText: doc3 });
  assert.equal(r3.suggested_fields.hospede_nome, "MARIA TESTE SILVA");
  ok("rotulo e valor na mesma linha seguem funcionando");

  // So rotulos: nao preenche nada, deixa para confirmacao manual.
  const doc4 = ["NOME", "SOBRENOME", "FILIAÇÃO", "NACIONALIDADE"].join("\n");
  const r4 = normalizeGoogleVisionText({ fullText: doc4 });
  assert.equal(r4.suggested_fields.hospede_nome, undefined, "deveria ficar vazio");
  ok("documento so com rotulos nao preenche nome");

  // Rotulo seguido de data: recusa, nao inventa.
  const doc5 = ["NOME", "12/03/1990", "SEXO: M"].join("\n");
  const r5 = normalizeGoogleVisionText({ fullText: doc5 });
  assert.equal(r5.suggested_fields.hospede_nome, undefined);
  ok("rotulo seguido de data nao preenche nome");
}

console.log("\n== Barreira final na persistencia ==");
{
  // Vale para QUALQUER provider, inclusive Azure e um futuro.
  assert.equal(canonicalizeOcrSuggestedFields({ hospede_nome: "SOBRENOME" }).hospede_nome, undefined);
  assert.equal(canonicalizeOcrSuggestedFields({ hospede_nome: "NOME" }).hospede_nome, undefined);
  assert.equal(canonicalizeOcrSuggestedFields({ hospede_nome: "12/03/1990" }).hospede_nome, undefined);
  assert.equal(
    canonicalizeOcrSuggestedFields({ hospede_nome: "CARLOS GABRIEL PREZENSZKY" }).hospede_nome,
    "CARLOS GABRIEL PREZENSZKY",
  );

  // O patch que vai ao banco nao recebe rotulo nem em ficha vazia.
  const patchRuim = buildOcrPersistPatch({
    currentRow: { hospede_nome: null },
    currentProvenance: {},
    suggested: { hospede_nome: "SOBRENOME" },
  });
  assert.equal(patchRuim.update.hospede_nome, undefined, "rotulo chegou ao update");
  assert.equal(patchRuim.appliedKeys.includes("hospede_nome"), false);

  const patchBom = buildOcrPersistPatch({
    currentRow: { hospede_nome: null },
    currentProvenance: {},
    suggested: { hospede_nome: "CARLOS GABRIEL PREZENSZKY" },
  });
  assert.equal(patchBom.update.hospede_nome, "CARLOS GABRIEL PREZENSZKY");
  assert.equal(patchBom.provenanceUpdates.hospede_nome, "ocr");
  ok("rotulo nunca chega ao update de fnrh_hospedes");
}

console.log("\n== Escopo: so o nome ==");
{
  // Os demais campos continuam saindo normalmente do mesmo documento.
  const doc = [
    "NOME",
    "SOBRENOME",
    "ANA TESTE SILVA",
    "DATA DE NASCIMENTO: 01/02/1990",
    "SEXO: F",
    "CPF: 529.982.247-25",
  ].join("\n");
  const r = normalizeGoogleVisionText({ fullText: doc });
  assert.equal(r.suggested_fields.hospede_nome, "ANA TESTE SILVA");
  assert.equal(r.suggested_fields.data_nascimento, "1990-02-01");
  assert.ok(r.suggested_fields.sexo);
  assert.equal(r.suggested_fields.cpf, "52998224725");
  ok("data, sexo e CPF seguem extraidos do mesmo documento");
}

console.log("\nOCR nome x rotulos: todos os testes passaram.\n");
