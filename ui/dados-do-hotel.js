/**
 * Configurações → Dados do hotel.
 *
 * Horário de check-out e telefone da recepção. São os valores que as mensagens
 * automáticas citam como {{checkout_horario}} e {{telefone_recepcao}}.
 *
 * Fronteira deliberada: esta tela edita VALOR; a tela de Mensagens automáticas
 * edita TEXTO. A RPC daqui não aceita texto de mensagem e a RPC de lá não
 * aceita horário nem telefone — nenhuma das duas consegue invadir a outra.
 */
(function () {
  "use strict";

  var msgEl = document.getElementById("hotel-msg");
  var rodapeEl = document.getElementById("hotel-rodape");
  var accessEl = document.getElementById("access-state");
  var panelEl = document.getElementById("content-panel");
  var formEl = document.getElementById("hotel-form");

  // Espelha as constraints de hotel_operacao_config: erro claro na tela em vez
  // de uma exceção crua do Postgres.
  var RE_CHECKOUT = /^[0-9]{1,2}(h[0-9]{0,2}|:[0-9]{2})$/;
  var RE_TELEFONE = /^[0-9()+ -]{8,24}$/;

  function authApp() {
    return window.YesHotelAuthApp;
  }

  function setMsg(text, ok) {
    if (!msgEl) return;
    msgEl.textContent = text || "";
    msgEl.className = "hotel-msg " + (ok ? "ok" : text ? "err" : "");
  }

  function showAccess(title, message) {
    if (!accessEl) return;
    if (panelEl) panelEl.classList.add("hidden");
    accessEl.classList.remove("hidden");
    accessEl.replaceChildren();
    var heading = document.createElement("h2");
    heading.textContent = title;
    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    var action = document.createElement("a");
    action.className = "primary-link";
    action.setAttribute("href", "./usuarios-login-mvp.html");
    action.textContent = "Ir para a tela inicial";
    accessEl.append(heading, paragraph, action);
  }

  async function requireAcesso() {
    var auth = authApp();
    if (!auth || !auth.isConfigured()) {
      showAccess(
        "Autenticação indisponível",
        (auth && auth.getConfigError && auth.getConfigError()) || "Configure o Supabase."
      );
      return null;
    }
    var user = await auth.getCurrentUser();
    if (!user) {
      showAccess("Login necessário", "Entre com um usuário interno.");
      return null;
    }
    var navPolicy = window.YesHotelNavPolicy;
    if (!navPolicy || !navPolicy.isRouteAuthorized(user.role, "hotel")) {
      showAccess("Acesso negado", "Seu perfil não acessa os dados do hotel.");
      return null;
    }

    if (accessEl) accessEl.classList.add("hidden");
    if (panelEl) panelEl.classList.remove("hidden");

    var sidebarNavElement = document.querySelector(
      '.yes-sidebar nav[aria-label="Navegação principal"]'
    );
    navPolicy.renderSidebarNav(sidebarNavElement, user.role, "hotel");

    return auth.getSupabaseClient();
  }

  function mostrarRodape(row) {
    if (!rodapeEl) return;
    if (!row || !row.updated_at) {
      rodapeEl.textContent = "";
      return;
    }
    var quem = row.atualizado_por_nome ? " por " + row.atualizado_por_nome : "";
    var quando = String(row.updated_at).slice(0, 10).split("-").reverse().join("/");
    rodapeEl.textContent = "Última alteração em " + quando + quem + ".";
  }

  async function carregar(client) {
    var res = await client
      .from("hotel_operacao_config")
      .select("checkout_horario, telefone_recepcao, atualizado_por_nome, updated_at")
      .eq("id", true)
      .maybeSingle();
    if (res.error) {
      setMsg(
        "Erro ao carregar: " +
          res.error.message +
          " (verifique se a migration foi aplicada).",
        false
      );
      return;
    }
    if (!(formEl instanceof HTMLFormElement)) return;
    if (!res.data) {
      setMsg("Ainda não há dados do hotel configurados. Preencha e salve.", false);
      return;
    }
    formEl.elements.checkout_horario.value = res.data.checkout_horario || "";
    formEl.elements.telefone_recepcao.value = res.data.telefone_recepcao || "";
    mostrarRodape(res.data);
  }

  if (formEl) {
    formEl.addEventListener("submit", async function (event) {
      event.preventDefault();
      var auth = authApp();
      var client = auth && auth.getSupabaseClient();
      if (!client || !(formEl instanceof HTMLFormElement)) return;

      var checkout = String(formEl.elements.checkout_horario.value || "").trim();
      var telefone = String(formEl.elements.telefone_recepcao.value || "").trim();

      if (!RE_CHECKOUT.test(checkout)) {
        setMsg("Horário de check-out inválido. Use 11h, 11h30 ou 11:00.", false);
        return;
      }
      if (!RE_TELEFONE.test(telefone)) {
        setMsg("Telefone inválido. Use apenas números, espaço, parênteses, + e hífen.", false);
        return;
      }

      try {
        var res = await client.rpc("hotel_operacao_config_salvar", {
          p_checkout_horario: checkout,
          p_telefone_recepcao: telefone
        });
        if (res.error) throw new Error(res.error.message);
        setMsg("Dados do hotel atualizados. As próximas mensagens já usam estes valores.", true);
        mostrarRodape(res.data);
      } catch (err) {
        setMsg(err instanceof Error ? err.message : "Falha ao salvar.", false);
      }
    });
  }

  (async function boot() {
    var client = await requireAcesso();
    if (!client) return;
    await carregar(client);
  })();
})();
