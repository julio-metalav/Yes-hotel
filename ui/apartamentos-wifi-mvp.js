(function () {
  const listEl = document.getElementById("wifi-list");
  const msgEl = document.getElementById("wifi-msg");
  const accessEl = document.getElementById("access-state");
  const panelEl = document.getElementById("content-panel");

  function authApp() {
    return window.YesHotelAuthApp;
  }

  function setMsg(text, ok) {
    if (!msgEl) return;
    msgEl.textContent = text || "";
    msgEl.className = "wifi-msg " + (ok ? "ok" : text ? "err" : "");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function requireAuth() {
    const auth = authApp();
    if (!auth || !auth.isConfigured()) {
      accessEl.classList.remove("hidden");
      accessEl.textContent = "Configure o Supabase em yes-supabase-config.js.";
      return null;
    }
    const user = await auth.getCurrentUser();
    if (!user) {
      accessEl.classList.remove("hidden");
      accessEl.innerHTML =
        '<p>Faça login na <a href="./checkin-operacional-mvp.html">Operação</a> para editar Wi-Fi.</p>';
      return null;
    }
    accessEl.classList.add("hidden");
    panelEl.classList.remove("hidden");

    var canManage =
      typeof auth.canAccessManagement === "function"
        ? auth.canAccessManagement(user)
        : user.role === "admin" || user.role === "recepcao";
    document.querySelectorAll('[data-nav="gestao"]').forEach(function (node) {
      node.classList.toggle("hidden", !canManage);
    });
    var canFinancial =
      typeof auth.canAccessFinancialRecon === "function"
        ? auth.canAccessFinancialRecon(user)
        : user.role === "admin";
    document.querySelectorAll('[data-nav="financeiro"]').forEach(function (node) {
      node.classList.toggle("hidden", !canFinancial);
    });

    return auth.getSupabaseClient();
  }

  function renderRows(rows) {
    if (!rows.length) {
      listEl.innerHTML = "<p>Nenhum apartamento encontrado.</p>";
      return;
    }
    const body = rows
      .map((r) => {
        const id = escapeHtml(r.id);
        const num = escapeHtml(r.numero);
        const ssid = escapeHtml(r.wifi_ssid || "");
        const pwd = escapeHtml(r.wifi_password || "");
        return `<tr data-id="${id}">
          <td><strong>${num}</strong></td>
          <td><input type="text" data-field="wifi_ssid" value="${ssid}" autocomplete="off" placeholder="Rede Wi-Fi" /></td>
          <td>
            <div class="wifi-actions">
              <input type="password" data-field="wifi_password" value="${pwd}" autocomplete="new-password" placeholder="Senha Wi-Fi" />
              <button type="button" class="op-btn op-btn--secondary" data-toggle-pwd title="Mostrar/ocultar">👁</button>
            </div>
          </td>
          <td><button type="button" class="op-btn" data-save>Salvar</button></td>
        </tr>`;
      })
      .join("");
    listEl.innerHTML = `<table class="wifi-table">
      <thead><tr><th>Apto</th><th>Rede Wi-Fi</th><th>Senha Wi-Fi</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  async function load(client) {
    const { data, error } = await client
      .from("apartamentos")
      .select("id, numero, wifi_ssid, wifi_password, ativo")
      .eq("ativo", true)
      .order("numero", { ascending: true });
    if (error) {
      setMsg("Erro ao carregar: " + error.message, false);
      return;
    }
    renderRows(data || []);
  }

  async function saveRow(client, tr) {
    const id = tr.getAttribute("data-id");
    const ssid = tr.querySelector('[data-field="wifi_ssid"]').value.trim() || null;
    const pwd = tr.querySelector('[data-field="wifi_password"]').value.trim() || null;
    const { error } = await client
      .from("apartamentos")
      .update({
        wifi_ssid: ssid,
        wifi_password: pwd,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      setMsg("Falha ao salvar apto: " + error.message, false);
      return;
    }
    setMsg("Salvo.", true);
  }

  listEl.addEventListener("click", async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const tr = t.closest("tr");
    if (!tr) return;
    if (t.matches("[data-toggle-pwd]")) {
      const input = tr.querySelector('[data-field="wifi_password"]');
      if (input) input.type = input.type === "password" ? "text" : "password";
      return;
    }
    if (t.matches("[data-save]")) {
      const client = window.__wifiClient;
      if (!client) return;
      t.disabled = true;
      await saveRow(client, tr);
      t.disabled = false;
    }
  });

  (async function boot() {
    const client = await requireAuth();
    if (!client) return;
    window.__wifiClient = client;
    await load(client);
  })();
})();
