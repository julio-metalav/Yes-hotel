/**
 * Correcoes funcionais da FNRH: PDF, estado da Etapa 1, fluxo exterior,
 * banner do OCR e links do aceite.
 *
 * O grosso da FNRH e um arquivo de UI sem modulos, entao boa parte destes
 * testes le o fonte e cobra a REGRA -- que e exatamente onde os defeitos
 * estavam: condicao invertida, estado faltando, lista fixa.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GoogleVisionOcrProvider,
  isPdfMime,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-google-vision.ts";

const ROOT = process.cwd();
const ler = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function ok(label: string) {
  console.log("  OK  " + label);
}

const ui = ler("ui/fnrh-checkin-v2.js");

/** Captura as chamadas para inspecionar URL e corpo enviados ao Vision. */
function visionFake(resposta: unknown) {
  const chamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    const alvo = String(url);
    if (alvo.indexOf("oauth2") >= 0 || alvo.indexOf("token") >= 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fake-token", expires_in: 3600 }),
      };
    }
    chamadas.push({ url: alvo, body: JSON.parse(String(init?.body ?? "{}")) });
    return { ok: true, status: 200, json: async () => resposta };
  }) as unknown as typeof fetch;
  return { chamadas, fetchImpl };
}

function provider(fetchImpl: typeof fetch) {
  return new GoogleVisionOcrProvider({
    projectId: "proj",
    clientEmail: "svc@proj.iam.gserviceaccount.com",
    // Hook existente do provider: evita assinar JWT de verdade no teste.
    accessTokenProvider: async () => "fake-token",
    // Chave de teste: nunca usada de verdade, o fetch e falso.
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
    fetchImpl,
  } as never);
}

const CNH_TEXTO = [
  "REPUBLICA FEDERATIVA DO BRASIL",
  "NOME E SOBRENOME",
  "JULIO CESAR LOPES DE OLIVEIRA",
  "CPF",
  "529.982.247-25",
].join("\n");

async function main() {
  console.log("\n== A. PDF vai pelo endpoint de documento, imagem pelo de imagem ==");
  {
    assert.equal(isPdfMime("application/pdf"), true);
    assert.equal(isPdfMime("image/jpeg"), false);
    assert.equal(isPdfMime(null), false);

    // PDF: files:annotate, com inputConfig (nao `image`).
    const pdf = visionFake({
      responses: [{ responses: [{ fullTextAnnotation: { text: CNH_TEXTO } }] }],
    });
    const rPdf = await provider(pdf.fetchImpl).extract({
      bytes: new Uint8Array([37, 80, 68, 70]),
      mime_type: "application/pdf",
      document_type: "cnh",
      side: "single",
    } as never);
    const chamadaPdf = pdf.chamadas[0]!;
    assert.match(chamadaPdf.url, /files:annotate/, "PDF nao foi para files:annotate");
    const reqPdf = (chamadaPdf.body.requests as Array<Record<string, unknown>>)[0]!;
    assert.ok(reqPdf.inputConfig, "PDF precisa de inputConfig");
    assert.equal(reqPdf.image, undefined, "PDF nao pode ir como image");
    assert.equal(rPdf.ok, true, "PDF deveria ter sido lido");
    assert.equal(rPdf.suggested_fields.hospede_nome, "JULIO CESAR LOPES DE OLIVEIRA");
    ok("PDF usa files:annotate e o texto das paginas e aproveitado");

    // Imagem: continua em images:annotate, com `image`.
    const img = visionFake({ responses: [{ fullTextAnnotation: { text: CNH_TEXTO } }] });
    const rImg = await provider(img.fetchImpl).extract({
      bytes: new Uint8Array([255, 216, 255]),
      mime_type: "image/jpeg",
      document_type: "cnh",
      side: "single",
    } as never);
    const chamadaImg = img.chamadas[0]!;
    assert.match(chamadaImg.url, /images:annotate/, "imagem mudou de endpoint");
    const reqImg = (chamadaImg.body.requests as Array<Record<string, unknown>>)[0]!;
    assert.ok(reqImg.image, "imagem precisa de `image`");
    assert.equal(reqImg.inputConfig, undefined);
    assert.equal(rImg.ok, true);
    ok("imagem continua em images:annotate, sem regressao");
  }

  console.log("\n== A2. Erro de envio reflete a causa, nao 'erro de conexao' ==");
  {
    // A mensagem generica escondia tamanho, formato e erro de plataforma.
    assert.match(ui, /function mensagemDeFalhaNoEnvio\(/);
    assert.match(ui, /Arquivo grande demais/);
    assert.match(ui, /Resposta inesperada do servidor/);
    assert.match(ui, /O servidor não conseguiu processar o documento/);
    // "Erro de conexao" so sobra para falha real de rede.
    assert.equal(
      ui.indexOf("Erro de conexão ao enviar o documento."),
      -1,
      "a mensagem generica antiga ainda esta no codigo",
    );
    assert.match(ui, /Verifique sua conexão e tente de novo/);
    // Resposta nao-JSON nao pode mais estourar no `.then`.
    assert.match(ui, /\.catch\(function \(\) \{\s*\n\s*return \{ okHttp: r\.ok, status: r\.status, body: null \};/);
    // Rascunho preservado quando o envio falha.
    const bloco = ui.slice(ui.indexOf("function uploadDocument("), ui.indexOf("function lookupCep("));
    assert.equal(
      (bloco.match(/scheduleDraft\(\)/g) || []).length >= 3,
      true,
      "o rascunho precisa ser salvo tambem nos caminhos de falha",
    );
    ok("cada causa tem sua mensagem e o rascunho sobrevive a falha");
  }

  console.log("\n== D. Banner do OCR so na etapa que mostra os dados lidos ==");
  {
    // A condicao era `step.id !== "confira_dados"`: invertida, o shell
    // imprimia o aviso em todas as OUTRAS etapas.
    assert.equal(
      ui.indexOf('state.ocrBanner && !state.analyzing && step.id !== "confira_dados"'),
      -1,
      "a condicao invertida do banner ainda esta no codigo",
    );
    assert.match(ui, /var ETAPAS_COM_DADOS_DO_OCR = \["confira_dados"\];/);
    assert.match(ui, /var ocrBanner = ocrBannerDaEtapa\(step\.id\);/);

    // A regra, executada de verdade.
    const fn = ui.slice(ui.indexOf("function ocrBannerDaEtapa("));
    const corpo = fn.slice(0, fn.indexOf("\n    }") + 6);
    const avaliar = new Function(
      "stepId",
      "state",
      "escapeHtml",
      "ETAPAS_COM_DADOS_DO_OCR",
      corpo.replace("function ocrBannerDaEtapa(stepId) {", "") .replace(/\}\s*$/, "") ,
    );
    const st = { ocrBanner: "Encontramos estes dados no seu documento.", analyzing: false };
    for (const etapa of ["viagem", "revisao", "aceite", "concluido"]) {
      assert.equal(
        avaliar(etapa, st, String, ["confira_dados"]),
        "",
        "banner vazou para a etapa " + etapa,
      );
    }
    assert.equal(avaliar("confira_dados", st, String, ["confira_dados"]), "");
    ok("viagem, revisao, aceite e concluido nunca recebem o aviso");
  }

  console.log("\n== E. Etapa 1 muda de estado depois da leitura ==");
  {
    assert.match(ui, /function docLeituraConcluida\(\) \{/);
    assert.match(
      ui,
      /return !!state\.showConfiraCta && !state\.analyzing && !needsVersoAfterOcr\(\);/,
    );
    // Capturas somem depois da leitura.
    assert.match(ui, /var primaryCapture =\s*\n\s*analyzing \|\| docLeituraConcluida\(\)/);
    // "Continuar" do shell sai de cena quando "Conferir meus dados" aparece.
    assert.match(ui, /var leituraConcluida = step\.id === "documento" && docLeituraConcluida\(\);/);
    assert.match(ui, /step\.id === "concluido" \|\| leituraConcluida/);
    // Sobra UMA secundaria para trocar o documento.
    assert.match(ui, /id="btn-doc-retake-file">Trocar documento</);
    assert.equal(ui.indexOf("btn-doc-retake-camera"), -1, "sobrou a segunda acao de retake");
    assert.equal(ui.indexOf("Tirar outra foto"), -1);
    assert.equal(ui.indexOf("Trocar arquivo"), -1);
    // A acao principal de avanco continua existindo.
    assert.match(ui, /id="btn-goto-confira">Conferir meus dados</);
    ok("apos a leitura sobram conferir (principal) e trocar documento (secundaria)");
  }

  console.log("\n== C. Brasil exige CPF; exterior nao ==");
  {
    // A pergunta passou para a etapa 2, ANTES da exigencia de documento.
    const confira = ui.slice(
      ui.indexOf("function renderConfiraDados()"),
      ui.indexOf("function renderEndereco()"),
    );
    assert.match(confira, /id="toggle-foreign-doc"/, "a etapa 2 precisa perguntar a residencia");
    assert.ok(
      confira.indexOf("toggle-foreign-doc") < confira.indexOf("Identifica"),
      "a residencia tem de vir ANTES da identificacao",
    );

    // Listas por fluxo: CPF so existe no fluxo brasileiro.
    assert.match(ui, /var DOC_TYPES_BRASIL = \[/);
    assert.match(ui, /var DOC_TYPES_EXTERIOR = \[/);
    const exterior = ui.slice(ui.indexOf("var DOC_TYPES_EXTERIOR"), ui.indexOf("function docTypesFor"));
    assert.equal(exterior.indexOf('"cpf"'), -1, "CPF nao pode aparecer no fluxo exterior");
    assert.match(exterior, /passport/);
    assert.match(exterior, /Mercosul/);
    assert.match(exterior, /value: "other"/);

    // Validacao recusa CPF no fluxo exterior.
    assert.match(ui, /!isBrazilResident\(state\) && state\.documento_tipo === "cpf"/);
    // E o CEP brasileiro ja era exigido so no fluxo Brasil.
    assert.match(ui, /if \(isBrazilResident\(state\)\) \{\s*\n\s*if \(digitsOnly\(state\.cep\)\.length !== 8\)/);
    // pais_emissor e reaproveitado (coluna ja existente), sem campo novo.
    assert.match(ui, /data-field="pais_emissor"/);
    assert.match(ui, /pais_emissor: state\.pais_emissor,/);
    ok("CPF obrigatorio so no Brasil, documento estrangeiro disponivel, CEP nao exigido fora");
  }

  console.log("\n== C2. A residencia e perguntada uma vez so ==");
  {
    const endereco = ui.slice(ui.indexOf("function renderEndereco()"), ui.indexOf("function renderViagem"));
    assert.equal(
      endereco.indexOf('id="toggle-foreign"'),
      -1,
      "a etapa de endereco voltou a perguntar a mesma coisa",
    );
    assert.match(endereco, /btn-corrigir-residencia/, "precisa ter como corrigir a decisao");
    // Mesmo campo de estado nas duas etapas: nada duplicado no modelo.
    assert.equal((ui.match(/state\.pais = "Exterior"/g) || []).length, 1);
    ok("uma pergunta, um campo, com caminho de correcao");
  }

  console.log("\n== F. Aceite: documentos acessiveis, semantica intacta ==");
  {
    const aceite = ui.slice(ui.indexOf("function renderAceite()"), ui.indexOf("function renderConcluido()"));
    assert.match(aceite, /href=\\"\.\/aviso-de-privacidade\.html\\"/);
    assert.match(aceite, /href=\\"\.\/termos-de-hospedagem\.html\\"/);
    assert.match(aceite, /target=\\"_blank\\"/);
    assert.match(aceite, /rel=\\"noopener\\"/);
    // Nenhuma pre-marcacao.
    assert.match(aceite, /state\.data_confirmed \? " checked" : ""/);
    assert.match(aceite, /state\.privacy_accepted \? " checked" : ""/);
    // Abrir o documento nao e pre-requisito.
    assert.match(aceite, /pode marcar as declara\u00e7\u00f5es sem abri-los/);
    assert.equal(aceite.indexOf("disabled"), -1, "o aceite nao pode depender de abrir o link");
    // Versoes preservadas.
    assert.match(aceite, /escapeHtml\(termsVersion\)/);
    assert.match(aceite, /escapeHtml\(privacyVersion\)/);
    ok("links reais, checkboxes limpos, versoes preservadas");

    // As paginas existem e estao marcadas como pendentes de aprovacao.
    for (const pagina of ["ui/aviso-de-privacidade.html", "ui/termos-de-hospedagem.html"]) {
      const html = ler(pagina);
      assert.match(html, /Conte\u00fado pendente de aprova\u00e7\u00e3o/, pagina + " sem aviso de pendencia");
      assert.match(html, /n\u00e3o deve ser publicada em produ\u00e7\u00e3o/, pagina + " sem trava de publicacao");
      assert.match(html, /Texto pendente/, pagina + " sem placeholder explicito");
    }
    assert.match(ler("ui/aviso-de-privacidade.html"), /privacy-v1-2026-08/);
    assert.match(ler("ui/termos-de-hospedagem.html"), /terms-v1-2026-08/);
    ok("paginas criadas, sem conteudo juridico inventado, versoes batendo");
  }

  console.log("\n== 9. Revisao com funcao clara ==");
  {
    assert.equal(ui.indexOf("Corrigir desde o in\u00edcio"), -1, "o texto antigo sugeria refazer tudo");
    assert.match(ui, /id="v2-edit-start">Corrigir informa\u00e7\u00f5es</);
    assert.equal(ui.indexOf("Revise tudo antes do aceite final."), -1);
    // O id do botao nao mudou: a navegacao existente continua valendo.
    assert.match(ui, /v2-edit-start/);
    ok("texto da revisao aponta para a acao certa, sem navegacao nova");
  }

  console.log("\n== G. Regressao: nada do fluxo essencial mudou ==");
  {
    // Rascunho, navegacao e submit continuam nos mesmos pontos.
    assert.match(ui, /function scheduleDraft\(/);
    assert.match(ui, /id="v2-back">Voltar</);
    assert.match(ui, /id="v2-next"/);
    assert.match(ui, /function goNext\(/);
    // As 8 etapas continuam as mesmas, na mesma ordem.
    const steps = [...ui.matchAll(/\{ id: "([a-z_]+)", label:/g)].map((m) => m[1]);
    assert.deepEqual(steps, [
      "documento",
      "confira_dados",
      "endereco",
      "viagem",
      "hospedes_menores",
      "revisao",
      "aceite",
      "concluido",
    ]);
    // Nada fora da FNRH foi tocado neste arquivo.
    for (const proibido of ["ttlock", "pagarme", "senha_enviada", "entrou_no_apto", "comission"]) {
      assert.equal(ui.toLowerCase().indexOf(proibido), -1, "a UI da FNRH cita " + proibido);
    }
    ok("etapas, rascunho, navegacao e submit intactos");
  }

  console.log("\nFNRH correcoes funcionais: todos os testes passaram.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
