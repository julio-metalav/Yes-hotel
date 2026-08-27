(function () {
  const msgEl = document.getElementById("geo-msg");
  const accessEl = document.getElementById("access-state");
  const panelEl = document.getElementById("content-panel");
  const formEl = document.getElementById("geo-form");

  function authApp() {
    return window.YesHotelAuthApp;
  }

  function setMsg(text, ok) {
    if (!msgEl) {
      return;
    }
    msgEl.textContent = text || "";
    msgEl.className = "geo-msg " + (ok ? "ok" : text ? "err" : "");
  }

  function showAccess(title, message) {
    if (!accessEl) {
      return;
    }
    panelEl?.classList.add("hidden");
    accessEl.classList.remove("hidden");
    accessEl.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = message;
    const action = document.createElement("a");
    action.className = "primary-link";
    action.setAttribute("href", "./usuarios-login-mvp.html");
    action.textContent = "Ir para a tela inicial";
    accessEl.append(heading, paragraph, action);
  }

  async function requireAdmin() {
    const auth = authApp();
    if (!auth || !auth.isConfigured()) {
      showAccess("Autenticação indisponível", auth?.getConfigError?.() || "Configure o Supabase.");
      return null;
    }
    const user = await auth.getCurrentUser();
    if (!user) {
      showAccess("Login necessário", "Entre com um usuário interno.");
      return null;
    }
    if (user.role !== "admin") {
      showAccess("Acesso negado", "Somente admin configura a geolocalização do hotel.");
      return null;
    }

    accessEl?.classList.add("hidden");
    panelEl?.classList.remove("hidden");

    const canManage =
      typeof auth.canAccessManagement === "function"
        ? auth.canAccessManagement(user)
        : user.role === "admin" || user.role === "recepcao";
    document.querySelectorAll('[data-nav="gestao"]').forEach(function (node) {
      node.classList.toggle("hidden", !canManage);
    });
    document.querySelectorAll('[data-nav="financeiro"]').forEach(function (node) {
      node.classList.toggle("hidden", user.role !== "admin");
    });

    return auth.getSupabaseClient();
  }

  async function loadConfig(client) {
    const { data, error } = await client.from("hotel_geo_config").select("*").maybeSingle();
    if (error) {
      setMsg("Erro ao carregar: " + error.message, false);
      return;
    }
    if (!(formEl instanceof HTMLFormElement) || !data) {
      return;
    }
    formEl.elements.latitude.value = data.latitude;
    formEl.elements.longitude.value = data.longitude;
    formEl.elements.raio.value = data.raio_metros;
  }

  formEl?.addEventListener("submit", async function (event) {
    event.preventDefault();
    const auth = authApp();
    const client = auth?.getSupabaseClient();
    if (!client || !(formEl instanceof HTMLFormElement)) {
      return;
    }
    try {
      const { error } = await client.rpc("demandas_atualizar_geo_config", {
        p_latitude: Number(formEl.elements.latitude.value),
        p_longitude: Number(formEl.elements.longitude.value),
        p_raio_metros: Number(formEl.elements.raio.value),
      });
      if (error) {
        throw new Error(error.message);
      }
      setMsg("Geolocalização atualizada.", true);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Falha ao salvar geo.", false);
    }
  });

  (async function boot() {
    const client = await requireAdmin();
    if (!client) {
      return;
    }
    await loadConfig(client);
  })();
})();
