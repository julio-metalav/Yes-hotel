/**
 * Espelho no navegador de src/lib/domain/yes-hotel/mensagens-template.ts e
 * mensagens-catalogo.ts. A previa da tela precisa mostrar exatamente o que o
 * hospede vai receber; um render diferente aqui seria pior que nao ter previa.
 *
 * Ha teste que compara os dois lado a lado e falha se divergirem.
 */
(function (global) {
  "use strict";

  var PARAMETROS_SUPORTADOS = [
    "hospede_nome",
    "apartamento",
    "wifi_rede",
    "wifi_senha",
    "checkout_horario",
    "telefone_recepcao",
    "data_entrada",
    "data_saida",
  ];
  var SUPORTADOS = {};
  for (var i = 0; i < PARAMETROS_SUPORTADOS.length; i++) {
    SUPORTADOS[PARAMETROS_SUPORTADOS[i]] = true;
  }

  function paramRe() {
    return /\{\{\s*([a-z_]+)\s*\}\}/g;
  }

  function valorDe(valores, nome) {
    var v = valores && valores[nome];
    return String(v == null ? "" : v).trim();
  }

  function usadosNaLinha(linha) {
    var re = paramRe();
    var out = [];
    var m;
    while ((m = re.exec(linha)) !== null) out.push(m[1]);
    return out;
  }

  function ehCabecalho(linha) {
    var t = String(linha).trim();
    return t.charAt(t.length - 1) === ":" && usadosNaLinha(t).length === 0;
  }

  function removerCabecalhosOrfaos(linhas) {
    var out = [];
    for (var i = 0; i < linhas.length; i++) {
      var atual = linhas[i];
      if (!ehCabecalho(atual)) {
        out.push(atual);
        continue;
      }
      var temConteudo = false;
      for (var j = i + 1; j < linhas.length; j++) {
        if (String(linhas[j]).trim() === "") break;
        temConteudo = true;
        break;
      }
      if (temConteudo) out.push(atual);
    }
    return out;
  }

  function normalizarEspacos(texto) {
    return texto
      .split("\n")
      .map(function (l) { return l.replace(/[ \t]+$/g, ""); })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }

  function escaparHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function textoParaHtml(texto) {
    return texto
      .split(/\n{2,}/)
      .filter(function (b) { return b.trim() !== ""; })
      .map(function (b) {
        return "<p>" + b.split("\n").map(escaparHtml).join("<br/>") + "</p>";
      })
      .join("\n");
  }

  function renderizarTemplate(corpo, valores) {
    var bruto = String(corpo == null ? "" : corpo);
    var ausentes = {};
    var desconhecidos = {};
    var re = paramRe();
    var m;
    while ((m = re.exec(bruto)) !== null) {
      var nome = m[1];
      if (!SUPORTADOS[nome]) desconhecidos[nome] = true;
      else if (!valorDe(valores, nome)) ausentes[nome] = true;
    }

    var mantidas = bruto.split(/\r?\n/).filter(function (linha) {
      var usados = usadosNaLinha(linha);
      for (var k = 0; k < usados.length; k++) {
        if (!SUPORTADOS[usados[k]]) return false;
        if (!valorDe(valores, usados[k])) return false;
      }
      return true;
    });

    var substituidas = removerCabecalhosOrfaos(mantidas).map(function (linha) {
      return linha.replace(paramRe(), function (_all, nome) {
        return valorDe(valores, nome);
      });
    });

    var texto = normalizarEspacos(substituidas.join("\n"));
    return {
      texto: texto,
      html: textoParaHtml(texto),
      parametros_ausentes: Object.keys(ausentes).sort(),
      parametros_desconhecidos: Object.keys(desconhecidos).sort(),
    };
  }

  function validarTemplate(corpo) {
    var texto = String(corpo == null ? "" : corpo);
    var erros = [];
    var avisos = [];
    var usados = usadosNaLinha(texto);

    if (!texto.trim()) erros.push("O texto da mensagem não pode ficar vazio.");
    if (texto.length > 4000) erros.push("O texto passou de 4000 caracteres.");

    var vistos = {};
    for (var i = 0; i < usados.length; i++) {
      if (!SUPORTADOS[usados[i]] && !vistos[usados[i]]) {
        vistos[usados[i]] = true;
        erros.push("Parâmetro não reconhecido: {{" + usados[i] + "}}.");
      }
    }
    var abre = (texto.match(/\{\{/g) || []).length;
    var fecha = (texto.match(/\}\}/g) || []).length;
    if (abre !== fecha) erros.push("Há chaves {{ }} abertas e não fechadas.");
    if (usados.length === 0) {
      avisos.push("O texto não usa nenhum parâmetro: será igual para todos os hóspedes.");
    }

    var unicos = {};
    for (var j = 0; j < usados.length; j++) unicos[usados[j]] = true;
    return {
      valido: erros.length === 0,
      erros: erros,
      avisos: avisos,
      parametros_usados: Object.keys(unicos).sort(),
    };
  }

  /** Dados fictícios da prévia. Nunca dados reais de hóspede. */
  var EXEMPLO = {
    hospede_nome: "Maria Souza",
    apartamento: "34",
    wifi_rede: "YES-34",
    wifi_senha: "hotel2026",
    // Nulos de proposito: horario de check-out e telefone da recepcao sao
    // configuracao do hotel (hotel_operacao_config), nao dado de exemplo. A
    // tela injeta o valor real; sem ele, a previa mostra o que o hospede
    // realmente receberia -- a linha inteira sai.
    checkout_horario: null,
    telefone_recepcao: null,
    data_entrada: "11/08/2026",
    data_saida: "13/08/2026",
  };

  global.YesMensagensPolicy = {
    PARAMETROS_SUPORTADOS: PARAMETROS_SUPORTADOS,
    EXEMPLO: EXEMPLO,
    renderizarTemplate: renderizarTemplate,
    validarTemplate: validarTemplate,
  };
})(typeof window !== "undefined" ? window : globalThis);
