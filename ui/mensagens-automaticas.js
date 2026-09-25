/**
 * Configurações → Mensagens automáticas.
 *
 * Edita SOMENTE o texto. Não há controle de gatilho, canal ou horário nesta
 * tela, de propósito: a RPC de gravação nem sequer aceita esses parâmetros.
 *
 * Cada mensagem tem seu próprio editor e seu próprio salvar. Um campo único
 * com tudo faria uma edição de boas-vindas derrubar outra mensagem.
 */
(function () {
  "use strict";

  var policy = window.YesMensagensPolicy;
  var listaEl = document.querySelector("#msg-lista");
  var erroGeralEl = document.querySelector("#msg-erro-geral");

  if (!policy || !listaEl) return;

  /**
   * Catálogo: nome, gatilho em texto e parâmetros de cada mensagem.
   * Espelha src/lib/domain/yes-hotel/mensagens-catalogo.ts; há teste que
   * falha se as chaves divergirem.
   */
  var CATALOGO = [
    {
      chave: "boas_vindas_primeiro_acesso",
      nome: "Boas-vindas no primeiro acesso",
      quando: "Na primeira vez que a fechadura do apartamento é aberta com a senha do hóspede.",
      parametros: ["hospede_nome", "apartamento", "wifi_rede", "wifi_senha", "checkout_horario", "telefone_recepcao", "data_entrada", "data_saida"],
      status: "ativa"
    },
    {
      chave: "senha_de_acesso",
      nome: "Senha de acesso",
      quando: "Quando a senha é liberada, seja pelos requisitos cumpridos ou pela rotina das 13h.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao", "data_entrada", "checkout_horario"],
      status: "preparada"
    },
    {
      chave: "pendencia_fnrh",
      nome: "Pendência de FNRH",
      quando: "No primeiro acesso, quando faltam fichas de hóspedes e o pagamento está em dia.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao"],
      status: "preparada"
    },
    {
      chave: "pendencia_pagamento",
      nome: "Pendência de pagamento",
      quando: "No primeiro acesso, quando falta pagamento e as fichas estão em dia.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao"],
      status: "preparada"
    },
    {
      chave: "pendencia_fnrh_e_pagamento",
      nome: "FNRH e pagamento pendentes",
      quando: "No primeiro acesso, quando faltam as fichas e o pagamento.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao"],
      status: "preparada"
    },
    {
      chave: "aviso_tolerancia_1h",
      nome: "Aviso de tolerância de 1 hora",
      quando: "Quando a tolerância vence sem regularização e as senhas são suspensas.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao"],
      status: "preparada"
    },
    {
      chave: "pagamento_presencial_diferido",
      nome: "Pagamento presencial diferido",
      quando: "No primeiro acesso após o horário limite, quando o pagamento presencial foi autorizado.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao", "data_saida"],
      status: "preparada"
    },
    {
      chave: "check_out",
      nome: "Check-out",
      quando: "Na aproximação do horário de saída previsto da reserva.",
      parametros: ["hospede_nome", "apartamento", "telefone_recepcao", "checkout_horario", "data_saida"],
      status: "preparada"
    }
  ];

  var corposSalvos = {};
  var corposPadrao = {};
  var abertos = {};

  function getAuth() {
    return window.YesHotelAuthApp;
  }

  function erroGeral(texto) {
    if (erroGeralEl) erroGeralEl.textContent = texto || "";
  }

  function el(tag, className, texto) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function sel(attr, chave) {
    return document.querySelector("[" + attr + '="' + chave + '"]');
  }

  function atualizarPreview(chave) {
    var area = sel("data-texto", chave);
    var previewEl = sel("data-preview", chave);
    var statusEl = sel("data-status", chave);
    if (!area || !previewEl) return;

    var v = policy.validarTemplate(area.value);
    var r = policy.renderizarTemplate(area.value, policy.EXEMPLO);
    previewEl.textContent = r.texto || "(a mensagem ficaria vazia)";

    if (statusEl) {
      if (!v.valido) {
        statusEl.className = "msg-status err";
        statusEl.textContent = v.erros[0];
      } else if (r.parametros_ausentes.length > 0) {
        statusEl.className = "msg-status";
        statusEl.textContent =
          "Sem dado para " + r.parametros_ausentes.join(", ") + ": essas linhas saem da mensagem.";
      } else if (v.avisos.length > 0) {
        statusEl.className = "msg-status";
        statusEl.textContent = v.avisos[0];
      } else {
        statusEl.className = "msg-status";
        statusEl.textContent = "";
      }
    }
    var btn = sel("data-salvar", chave);
    if (btn) btn.disabled = !v.valido;
  }

  async function salvar(chave) {
    var area = sel("data-texto", chave);
    var statusEl = sel("data-status", chave);
    if (!area) return;

    var v = policy.validarTemplate(area.value);
    if (!v.valido) {
      if (statusEl) {
        statusEl.className = "msg-status err";
        statusEl.textContent = v.erros[0];
      }
      return;
    }

    var auth = getAuth();
    var supabase = auth && auth.getSupabaseClient();
    if (!supabase) return;
    var btn = sel("data-salvar", chave);
    if (btn) btn.disabled = true;
    try {
      var res = await supabase.rpc("operacional_mensagens_salvar", {
        p_chave: chave,
        p_corpo: area.value
      });
      if (res.error) throw res.error;
      corposSalvos[chave] = area.value;
      if (statusEl) {
        statusEl.className = "msg-status ok";
        statusEl.textContent = "Mensagem salva.";
      }
    } catch (e) {
      if (statusEl) {
        statusEl.className = "msg-status err";
        statusEl.textContent = (e && e.message) || "Não foi possível salvar.";
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function restaurarPadrao(chave) {
    var area = sel("data-texto", chave);
    if (!area) return;
    // Restaura no editor; só vale de fato depois de Salvar.
    area.value = corposPadrao[chave] != null ? corposPadrao[chave] : area.value;
    atualizarPreview(chave);
    var statusEl = sel("data-status", chave);
    if (statusEl) {
      statusEl.className = "msg-status";
      statusEl.textContent = "Texto padrão carregado. Clique em Salvar para aplicar.";
    }
  }

  function montarEditor(def) {
    var box = el("div", "msg-editor hidden");
    box.setAttribute("data-editor", def.chave);

    if (def.status !== "ativa") {
      box.appendChild(
        el(
          "p",
          "msg-aviso",
          "Esta mensagem ainda não controla o envio real: o sistema continua usando o texto interno. A edição fica guardada para quando ela for ligada."
        )
      );
    }

    box.appendChild(el("label", "msg-campo-rotulo", "Texto da mensagem"));
    var area = el("textarea", "msg-texto");
    area.setAttribute("data-texto", def.chave);
    area.setAttribute("aria-label", "Texto da mensagem " + def.nome);
    box.appendChild(area);

    box.appendChild(el("span", "msg-campo-rotulo", "Parâmetros disponíveis"));
    var ul = el("ul", "msg-params");
    def.parametros.forEach(function (p) {
      var li = el("li");
      var b = el("button", "msg-param", "{{" + p + "}}");
      b.type = "button";
      b.title = "Inserir no texto";
      b.addEventListener("click", function () {
        var pos = area.selectionStart != null ? area.selectionStart : area.value.length;
        var token = "{{" + p + "}}";
        area.value = area.value.slice(0, pos) + token + area.value.slice(pos);
        area.focus();
        area.selectionStart = pos + token.length;
        area.selectionEnd = pos + token.length;
        atualizarPreview(def.chave);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    box.appendChild(ul);

    box.appendChild(el("span", "msg-campo-rotulo", "Prévia com dados de exemplo"));
    var pre = el("div", "msg-preview");
    pre.setAttribute("data-preview", def.chave);
    box.appendChild(pre);

    var acoes = el("div", "msg-acoes");
    var salvarBtn = el("button", "op-btn op-btn--primary", "Salvar");
    salvarBtn.type = "button";
    salvarBtn.setAttribute("data-salvar", def.chave);
    salvarBtn.addEventListener("click", function () {
      void salvar(def.chave);
    });
    var restaurarBtn = el("button", "op-btn op-btn--secondary", "Restaurar padrão");
    restaurarBtn.type = "button";
    restaurarBtn.addEventListener("click", function () {
      restaurarPadrao(def.chave);
    });
    var status = el("span", "msg-status");
    status.setAttribute("data-status", def.chave);
    status.setAttribute("role", "status");
    acoes.appendChild(salvarBtn);
    acoes.appendChild(restaurarBtn);
    acoes.appendChild(status);
    box.appendChild(acoes);

    area.addEventListener("input", function () {
      atualizarPreview(def.chave);
    });
    return box;
  }

  function render() {
    listaEl.replaceChildren();
    CATALOGO.forEach(function (def) {
      var item = el("div", "msg-item");

      var cab = el("button", "msg-cabecalho");
      cab.type = "button";
      cab.setAttribute("aria-expanded", abertos[def.chave] ? "true" : "false");

      var textos = el("span");
      textos.appendChild(el("span", "msg-nome", def.nome));
      textos.appendChild(el("span", "msg-quando", "Quando é enviada: " + def.quando));
      cab.appendChild(textos);
      cab.appendChild(
        el("span", "msg-tag " + def.status, def.status === "ativa" ? "Em uso" : "Preparada")
      );
      var seta = el("span", "msg-seta", abertos[def.chave] ? "▾" : "▸");
      cab.appendChild(seta);
      item.appendChild(cab);

      var editor = montarEditor(def);
      item.appendChild(editor);
      listaEl.appendChild(item);

      var area = editor.querySelector("textarea");
      area.value = corposSalvos[def.chave] != null ? corposSalvos[def.chave] : "";

      cab.addEventListener("click", function () {
        abertos[def.chave] = !abertos[def.chave];
        editor.classList.toggle("hidden", !abertos[def.chave]);
        cab.setAttribute("aria-expanded", abertos[def.chave] ? "true" : "false");
        seta.textContent = abertos[def.chave] ? "▾" : "▸";
        if (abertos[def.chave]) atualizarPreview(def.chave);
      });

      if (abertos[def.chave]) {
        editor.classList.remove("hidden");
        atualizarPreview(def.chave);
      }
    });
  }

  async function carregar() {
    var auth = getAuth();
    var supabase = auth && auth.getSupabaseClient();
    if (!supabase) {
      erroGeral("Sessão inválida. Faça login novamente.");
      render();
      return;
    }
    try {
      var res = await supabase.rpc("operacional_mensagens_listar");
      if (res.error) throw res.error;
      (res.data || []).forEach(function (row) {
        corposSalvos[row.chave] = String(row.corpo || "");
        // O texto da primeira carga é a referência do botão Restaurar padrão.
        if (corposPadrao[row.chave] == null) {
          corposPadrao[row.chave] = String(row.corpo || "");
        }
      });
      erroGeral("");
    } catch (e) {
      erroGeral(
        (e && e.message) ||
          "Não foi possível carregar as mensagens. Verifique se a migration foi aplicada."
      );
    }
    render();
  }

  void carregar();
})();
