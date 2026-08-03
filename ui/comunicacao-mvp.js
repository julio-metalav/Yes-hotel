/**
 * Central de Comunicação — MVP 2.
 * Dados reais: conversas e mensagens no Supabase; resumo da reserva do núcleo operacional.
 * Preparado para: canal WhatsApp (status_envio, provider_message_id), automações.
 */
"use strict";

const auth = window.YesHotelAuthApp;

const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const sessionUserElement = document.querySelector("#session-user");
const logoutButtonElement = document.querySelector("#logout-button");
const conversasListEl = document.getElementById("conversas-list");
const conversasLoadingEl = document.getElementById("conversas-loading");
const conversasEmptyEl = document.getElementById("conversas-empty");
const conversasSearchEl = document.getElementById("conversas-search");
const conversasFilterEl = document.getElementById("conversas-filter");
const chatEmptyEl = document.getElementById("chat-empty");
const chatActiveEl = document.getElementById("chat-active");
const chatHeaderNameEl = document.getElementById("chat-header-name");
const chatHeaderMetaEl = document.getElementById("chat-header-meta");
const chatMessagesLoadingEl = document.getElementById("chat-messages-loading");
const chatMessagesEl = document.getElementById("chat-messages");
const chatInputEl = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatTemplateBtn = document.getElementById("chat-template-btn");
const chatDetalhesBtn = document.getElementById("chat-detalhes-btn");
const resumoEmptyEl = document.getElementById("resumo-empty");
const resumoContentEl = document.getElementById("resumo-content");
const resumoListEl = document.getElementById("resumo-list");
const resumoActionsBtnsEl = document.getElementById("resumo-actions-btns");
const resumoDrawer = document.getElementById("resumo-drawer");
const resumoDrawerBody = document.getElementById("resumo-drawer-body");
const drawerCloseBtn = document.getElementById("drawer-close");
const drawerBackdrop = document.getElementById("drawer-backdrop");

function getSupabase() {
  return auth && typeof auth.getSupabaseClient === "function" ? auth.getSupabaseClient() : null;
}

let conversasCache = [];
let selectedConversaId = null;
let templatesCache = [];

function escapeHtml(s) {
  if (s == null || s === undefined) return "";
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}

function formatMsgTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function showAccessState(title, message, actionLabel) {
  if (!(accessStateElement instanceof HTMLElement)) return;
  if (contentPanelElement instanceof HTMLElement) contentPanelElement.classList.add("hidden");
  accessStateElement.classList.remove("hidden");
  accessStateElement.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><a class="primary-link" href="./usuarios-login-mvp.html">${escapeHtml(actionLabel)}</a>`;
}

function nomeExibicaoConversa(conv) {
  const r = conv.operacional_reservas;
  if (r && (r.hospede_principal || r.apartamento)) return (r.hospede_principal || "").trim() || "Apto " + (r.apartamento || "").trim() || "—";
  return (conv.telefone || "Sem identificação").trim() || "—";
}

function apartamentoConversa(conv) {
  const r = conv.operacional_reservas;
  return (r && r.apartamento) ? String(r.apartamento).trim() : "";
}

async function loadConversas() {
  const supabase = getSupabase();
  if (!supabase) return [];
  setConversasLoading(true);
  setConversasEmpty(false);
  const { data, error } = await supabase
    .from("comunicacao_conversas")
    .select("id, canal, telefone, reserva_id, hospede_id, status, ultima_mensagem_em, ultima_mensagem_preview, created_at, operacional_reservas(apartamento, hospede_principal)")
    .order("ultima_mensagem_em", { ascending: false, nullsFirst: false });
  setConversasLoading(false);
  if (error) {
    console.warn("[comunicacao] loadConversas error", error);
    return [];
  }
  conversasCache = Array.isArray(data) ? data : [];
  setConversasEmpty(conversasCache.length === 0);
  return conversasCache;
}

function setConversasLoading(on) {
  if (conversasLoadingEl) conversasLoadingEl.classList.toggle("hidden", !on);
  if (conversasListEl) conversasListEl.classList.toggle("hidden", on);
}

function setConversasEmpty(empty) {
  if (conversasEmptyEl) conversasEmptyEl.classList.toggle("hidden", !empty);
}

function filterConversas() {
  const q = (conversasSearchEl?.value || "").trim().toLowerCase();
  const status = conversasFilterEl?.value || "all";
  return conversasCache.filter((c) => {
    const nome = nomeExibicaoConversa(c);
    const apto = apartamentoConversa(c);
    const matchSearch = !q || nome.toLowerCase().includes(q) || apto.toLowerCase().includes(q) || (c.ultima_mensagem_preview || "").toLowerCase().includes(q);
    const matchStatus = status === "all" || c.status === status;
    return matchSearch && matchStatus;
  });
}

function statusLabel(s) {
  if (s === "resolvida") return "Resolvida";
  if (s === "aguardando_hospede") return "Aguardando hóspede";
  return s === "aberta" ? "Aberta" : (s || "—");
}

function renderConversasList() {
  if (!conversasListEl) return;
  const list = filterConversas();
  conversasListEl.innerHTML = list
    .map(
      (c) => {
        const isSelected = c.id === selectedConversaId;
        const isResolvida = c.status === "resolvida";
        const classes = [isSelected ? "selected" : "", isResolvida ? "status-resolvida" : ""].filter(Boolean).join(" ");
        const nome = nomeExibicaoConversa(c);
        const initials = nome.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase() || "H";
        return `
    <li data-conversa-id="${escapeHtml(c.id)}" class="${classes}">
      <span class="conv-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
      <div class="conv-preview-body">
        <div class="conv-preview-top"><span class="conv-preview-name">${escapeHtml(nome)}</span><time>${formatMsgTime(c.ultima_mensagem_em || c.updated_at || c.created_at)}</time></div>
        <div class="conv-preview-meta">Apartamento ${escapeHtml(apartamentoConversa(c) || "—")} · <span class="conv-status">${escapeHtml(statusLabel(c.status))}</span></div>
        <div class="conv-preview-msg">${escapeHtml(c.ultima_mensagem_preview || "Sem mensagens recentes")}</div>
      </div>
    </li>`;
      }
    )
    .join("");
  conversasListEl.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => selectConversa(li.dataset.conversaId));
  });
}

async function loadMensagens(conversaId) {
  const supabase = getSupabase();
  if (!supabase || !conversaId) return [];
  if (chatMessagesLoadingEl) chatMessagesLoadingEl.classList.remove("hidden");
  if (chatMessagesEl) chatMessagesEl.classList.add("hidden");
  const { data, error } = await supabase
    .from("comunicacao_mensagens")
    .select("id, direcao, tipo_mensagem, mensagem, status_envio, created_at")
    .eq("conversa_id", conversaId)
    .order("created_at", { ascending: true });
  if (chatMessagesLoadingEl) chatMessagesLoadingEl.classList.add("hidden");
  if (chatMessagesEl) chatMessagesEl.classList.remove("hidden");
  if (error) {
    console.warn("[comunicacao] loadMensagens error", error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

async function selectConversa(id) {
  selectedConversaId = id || null;
  renderConversasList();
  if (id) {
    const conv = conversasCache.find((c) => c.id === id);
    if (conv) {
      chatEmptyEl?.classList.add("hidden");
      chatActiveEl?.classList.remove("hidden");
      const displayName = nomeExibicaoConversa(conv);
      if (chatHeaderNameEl) chatHeaderNameEl.textContent = displayName;
      const chatAvatar = document.getElementById("chat-header-avatar");
      if (chatAvatar) chatAvatar.textContent = displayName.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase() || "H";
      if (chatHeaderMetaEl) {
        chatHeaderMetaEl.textContent = `Apto ${apartamentoConversa(conv) || "—"} · ${conv.telefone || "—"} · ${statusLabel(conv.status)}`;
        chatHeaderMetaEl.classList.toggle("status-resolvida", conv.status === "resolvida");
      }
      const msgs = await loadMensagens(id);
      renderMessages(msgs);
      const reserva = conv.reserva_id ? await loadResumoReserva(conv.reserva_id) : null;
      renderResumo(reserva, conv);
    }
  } else {
    chatEmptyEl?.classList.remove("hidden");
    chatActiveEl?.classList.add("hidden");
    renderResumo(null, null);
  }
}

function renderMessages(msgs) {
  if (!chatMessagesEl) return;
  chatMessagesEl.innerHTML = (msgs || [])
    .map(
      (m) => {
        const type = m.tipo_mensagem === "automacao" || m.tipo_mensagem === "sistema" ? "system" : (m.direcao === "entrada" ? "guest" : "operator");
        const label = type === "guest" ? "Hóspede" : type === "system" ? "Automação" : "Recepção";
        const delivery = m.status_envio ? ` · ${escapeHtml(m.status_envio)}` : "";
        return `
    <div class="msg-bubble ${escapeHtml(m.direcao)} msg-${type}">
      <div class="msg-label">${label}</div>
      <div>${escapeHtml(m.mensagem)}</div>
      <div class="msg-meta">${formatMsgTime(m.created_at)}${delivery}</div>
    </div>`;
      }
    )
    .join("");
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function loadResumoReserva(reservaId) {
  const supabase = getSupabase();
  if (!supabase || !reservaId) return null;
  const { data: reserva, error: errR } = await supabase.from("operacional_reservas").select("id, apartamento, hospede_principal, check_in_previsto, check_out_previsto, pagamento_status, acesso_liberado, entrou_no_apto").eq("id", reservaId).maybeSingle();
  if (errR || !reserva) return null;
  const { data: hospedes } = await supabase.from("operacional_hospedes").select("id, nome, principal, status_operacional").eq("reserva_id", reservaId).order("created_at", { ascending: true });
  const lista = hospedes || [];
  const principal = lista.find((h) => h.principal) || lista[0];
  const totalConfirmados = lista.filter((h) => h.status_operacional === "confirmado").length;
  const statusFnrh = lista.length === 0 ? "—" : totalConfirmados === lista.length ? "Completo" : totalConfirmados > 0 ? "Parcial" : "Pendente";
  const statusAcesso = reserva.acesso_liberado ? (reserva.entrou_no_apto ? "Entrada registrada" : "Liberado") : "Não liberado";
  let statusTtlock = "—";
  try {
    const { data: cred } = await supabase.from("operacional_credenciais_acesso").select("id, status").eq("reserva_id", reservaId).maybeSingle();
    if (cred) statusTtlock = cred.status || "—";
  } catch (_) {}
  const checkIn = reserva.check_in_previsto ? String(reserva.check_in_previsto).slice(0, 10) : "—";
  const checkOut = reserva.check_out_previsto ? String(reserva.check_out_previsto).slice(0, 10) : "—";
  return {
    id: reserva.id,
    apartamento: (reserva.apartamento || "").trim() || "—",
    hospedePrincipal: (reserva.hospede_principal || (principal && principal.nome) || "").trim() || "—",
    checkIn,
    checkOut,
    statusFnrh,
    statusAcesso,
    statusTtlock,
    cafe: "Incluso",
    observacoes: "",
  };
}

function renderResumo(reserva, conv) {
  const hasResumo = reserva && resumoContentEl && resumoListEl && resumoActionsBtnsEl;
  if (resumoEmptyEl) resumoEmptyEl.classList.toggle("hidden", !!hasResumo);
  if (resumoContentEl) resumoContentEl.classList.toggle("hidden", !hasResumo);
  if (!hasResumo) return;
  const resolvida = conv && conv.status === "resolvida";
  resumoListEl.innerHTML = `
    <dt>Status</dt><dd class="${resolvida ? "resumo-status-resolvida" : ""}">${escapeHtml(statusLabel(conv.status))}</dd>
    <dt>Apartamento</dt><dd>${escapeHtml(reserva.apartamento)}</dd>
    <dt>Check-in / Check-out</dt><dd>${escapeHtml(reserva.checkIn)} — ${escapeHtml(reserva.checkOut)}</dd>
    <dt>Hóspede principal</dt><dd>${escapeHtml(reserva.hospedePrincipal)}</dd>
    <dt>FNRH</dt><dd>${escapeHtml(reserva.statusFnrh)}</dd>
    <dt>Acesso</dt><dd>${escapeHtml(reserva.statusAcesso)}</dd>
    <dt>TTLock</dt><dd>${escapeHtml(reserva.statusTtlock)}</dd>
    <dt>Café</dt><dd>${escapeHtml(reserva.cafe)}</dd>
    <dt>Observações</dt><dd>${escapeHtml(reserva.observacoes || "—")}</dd>
  `;
  if (resolvida) {
    resumoActionsBtnsEl.innerHTML = `<p class="resumo-conversa-resolvida">Conversa marcada como resolvida.</p>`;
  } else {
    resumoActionsBtnsEl.innerHTML = `
    <button type="button" class="secondary-button" data-action="reenviar_senha">Enviar senha de acesso</button>
    <button type="button" class="secondary-button" data-action="reenviar_fnrh">Enviar link FNRH</button>
    <button type="button" class="secondary-button" data-action="reenviar_instrucoes">Enviar instruções de chegada</button>
    <button type="button" class="secondary-button" data-action="copiar_acesso">Copiar dados de acesso</button>
    <button type="button" class="secondary-button action-resolve" data-action="marcar_resolvida">Marcar como resolvida</button>
  `;
    resumoActionsBtnsEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => handleQuickAction(btn.dataset.action, conv));
    });
  }
}

async function handleQuickAction(action, conv) {
  if (action === "copiar_acesso" && conv) {
    const text = `Yes Hotel · Apartamento ${apartamentoConversa(conv) || "—"}\nDados de acesso disponíveis no atendimento.`;
    try {
      await navigator.clipboard.writeText(text);
      if (window.alert) window.alert("Dados de acesso copiados.");
    } catch (_) {
      if (window.alert) window.alert("Não foi possível copiar automaticamente.");
    }
    return;
  }
  if (action === "marcar_resolvida" && conv) {
    const supabase = getSupabase();
    if (supabase) {
      const { error } = await supabase.from("comunicacao_conversas").update({ status: "resolvida" }).eq("id", conv.id);
      if (!error) {
        conv.status = "resolvida";
        renderConversasList();
        if (selectedConversaId === conv.id) {
          if (chatHeaderMetaEl) {
            chatHeaderMetaEl.textContent = `Apto ${apartamentoConversa(conv) || "—"} · ${conv.telefone || "—"} · ${statusLabel(conv.status)}`;
            chatHeaderMetaEl.classList.add("status-resolvida");
          }
          const reserva = conv.reserva_id ? await loadResumoReserva(conv.reserva_id) : null;
          renderResumo(reserva, conv);
        }
        closeResumoDrawer();
        if (window.alert) window.alert("Conversa marcada como resolvida.");
      } else {
        if (window.alert) window.alert("Erro ao atualizar: " + (error.message || "tente novamente."));
      }
    }
    return;
  }
  if (action === "reenviar_fnrh" || action === "reenviar_instrucoes" || action === "reenviar_senha") {
    if (window.alert) window.alert('Ação rápida "' + action + '" preparada para integração com backend. (Placeholder.)');
  }
}

async function sendMessage() {
  const text = (chatInputEl?.value || "").trim();
  if (!text || !selectedConversaId) return;
  const conv = conversasCache.find((c) => c.id === selectedConversaId);
  if (!conv) return;
  const supabase = getSupabase();
  if (!supabase) return;

  // WhatsApp: camada operacional DigiSac (Edge operacional-comunicacao-dispatch).
  const useWhatsAppFunction = conv.canal === "whatsapp" || (conv.telefone && conv.canal !== "interno");
  if (useWhatsAppFunction) {
    if (!auth || typeof auth.invokeOperacionalComunicacaoDispatch !== "function") {
      if (window.alert) {
        window.alert("Atualize o bundle de autenticação (yes-supabase-auth) ou faça login novamente.");
      }
      return;
    }
    try {
      await auth.invokeOperacionalComunicacaoDispatch({
        conversa_id: selectedConversaId,
        text,
        proposito: "chat_operador",
      });
      chatInputEl.value = "";
      const msgs = await loadMensagens(selectedConversaId);
      renderMessages(msgs);
      conv.ultima_mensagem_preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
      renderConversasList();
      return;
    } catch (err) {
      console.warn("[comunicacao] sendMessage dispatch error", err);
      if (window.alert) window.alert(err instanceof Error ? err.message : "Falha ao enviar.");
      try {
        const msgs = await loadMensagens(selectedConversaId);
        renderMessages(msgs);
        renderConversasList();
      } catch (_) {}
      return;
    }
  }

  const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
  const now = new Date().toISOString();
  const { data: inserted, error: errInsert } = await supabase
    .from("comunicacao_mensagens")
    .insert({
      conversa_id: selectedConversaId,
      direcao: "saida",
      tipo_mensagem: "texto",
      mensagem: text,
      status_envio: "local",
    })
    .select("id, created_at")
    .single();
  if (errInsert) {
    console.warn("[comunicacao] sendMessage insert error", errInsert);
    if (window.alert) window.alert("Erro ao enviar: " + (errInsert.message || "tente novamente."));
    return;
  }
  const { error: errUpdate } = await supabase
    .from("comunicacao_conversas")
    .update({ ultima_mensagem_em: inserted.created_at || now, ultima_mensagem_preview: preview })
    .eq("id", selectedConversaId);
  if (!errUpdate) {
    conv.ultima_mensagem_em = inserted.created_at || now;
    conv.ultima_mensagem_preview = preview;
  }
  chatInputEl.value = "";
  const msgs = await loadMensagens(selectedConversaId);
  renderMessages(msgs);
  renderConversasList();
}

async function loadTemplates() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.from("comunicacao_templates").select("id, codigo, titulo, conteudo").eq("ativo", true).order("titulo");
  if (error) return [];
  templatesCache = Array.isArray(data) ? data : [];
  return templatesCache;
}

function openTemplatePicker() {
  if (!selectedConversaId) return;
  if (templatesCache.length > 0 && chatInputEl) {
    const t = templatesCache[0];
    chatInputEl.value = t.conteudo || "";
    if (window.alert) window.alert('Template "' + (t.titulo || t.codigo) + '" inserido. Edite se quiser e envie.');
    return;
  }
  if (window.alert) window.alert("Nenhum template ativo no banco. Cadastre em comunicacao_templates.");
}

function openResumoDrawer() {
  const conv = selectedConversaId ? conversasCache.find((c) => c.id === selectedConversaId) : null;
  if (!resumoDrawerBody) return;
  if (!conv) {
    resumoDrawerBody.innerHTML = "<p class=\"resumo-empty-text\">Nenhuma conversa selecionada.</p>";
    resumoDrawer?.classList.remove("hidden");
    drawerBackdrop?.classList.remove("hidden");
    return;
  }
  if (!conv.reserva_id) {
    resumoDrawerBody.innerHTML = "<p class=\"resumo-empty-text\">Nenhuma reserva vinculada a esta conversa.</p>";
    resumoDrawer?.classList.remove("hidden");
    drawerBackdrop?.classList.remove("hidden");
    return;
  }
  loadResumoReserva(conv.reserva_id).then((reserva) => {
    if (!resumoDrawerBody) return;
    if (!reserva) {
      resumoDrawerBody.innerHTML = "<p class=\"resumo-empty-text\">Reserva não encontrada.</p>";
    } else {
      const resolvida = conv.status === "resolvida";
      resumoDrawerBody.innerHTML = `
        <dl class="resumo-list">
          <dt>Status</dt><dd class="${resolvida ? "resumo-status-resolvida" : ""}">${escapeHtml(statusLabel(conv.status))}</dd>
          <dt>Apartamento</dt><dd>${escapeHtml(reserva.apartamento)}</dd>
          <dt>Check-in / Check-out</dt><dd>${escapeHtml(reserva.checkIn)} — ${escapeHtml(reserva.checkOut)}</dd>
          <dt>Hóspede principal</dt><dd>${escapeHtml(reserva.hospedePrincipal)}</dd>
          <dt>FNRH</dt><dd>${escapeHtml(reserva.statusFnrh)}</dd>
          <dt>Acesso</dt><dd>${escapeHtml(reserva.statusAcesso)}</dd>
          <dt>TTLock</dt><dd>${escapeHtml(reserva.statusTtlock)}</dd>
          <dt>Café</dt><dd>${escapeHtml(reserva.cafe)}</dd>
        </dl>
        <div class="resumo-actions">
          <h4 class="resumo-actions-title">Ações rápidas</h4>
          <div class="resumo-actions-btns">
            ${resolvida ? '<p class="resumo-conversa-resolvida">Conversa marcada como resolvida.</p>' : `
            <button type="button" class="secondary-button" data-action="reenviar_fnrh">Reenviar link FNRH</button>
            <button type="button" class="secondary-button" data-action="reenviar_instrucoes">Reenviar instruções</button>
            <button type="button" class="secondary-button" data-action="reenviar_senha">Reenviar senha</button>
            <button type="button" class="secondary-button" data-action="marcar_resolvida">Marcar como resolvida</button>
            `}
          </div>
        </div>
      `;
      if (!resolvida) {
        resumoDrawerBody.querySelectorAll("[data-action]").forEach((btn) => {
          btn.addEventListener("click", () => handleQuickAction(btn.dataset.action, conv));
        });
      }
    }
    resumoDrawer?.classList.remove("hidden");
    drawerBackdrop?.classList.remove("hidden");
  });
}

function closeResumoDrawer() {
  resumoDrawer?.classList.add("hidden");
  drawerBackdrop?.classList.add("hidden");
}

async function initPage() {
  if (!auth || !auth.isConfigured()) {
    showAccessState("Autenticação indisponível", auth?.getConfigError?.() || "Configure o Supabase para usar a central de comunicação.", "Ir para login");
    return;
  }
  const currentUser = await auth.getCurrentUser();
  if (!currentUser) {
    showAccessState("Login necessário", "Entre com um usuário interno para acessar a central de comunicação.", "Fazer login");
    return;
  }
  if (currentUser.role === "cafe") {
    window.location.href = "./cafe-da-manha-mvp.html";
    return;
  }
  accessStateElement?.classList.add("hidden");
  contentPanelElement?.classList.remove("hidden");
  if (sessionUserElement) sessionUserElement.textContent = `${currentUser.name} | ${auth.getRoleLabel(currentUser.role)} | sessão de ${auth.getSessionDurationHours()} horas`;

  await loadTemplates();
  await loadConversas();
  renderConversasList();
  selectConversa(null);

  conversasSearchEl?.addEventListener("input", () => renderConversasList());
  conversasFilterEl?.addEventListener("change", () => renderConversasList());
  chatSendBtn?.addEventListener("click", sendMessage);
  chatInputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  chatTemplateBtn?.addEventListener("click", openTemplatePicker);
  chatDetalhesBtn?.addEventListener("click", openResumoDrawer);
  drawerCloseBtn?.addEventListener("click", closeResumoDrawer);
  drawerBackdrop?.addEventListener("click", closeResumoDrawer);
}

logoutButtonElement?.addEventListener("click", async () => {
  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

initPage().catch((err) => {
  showAccessState("Falha ao carregar", err instanceof Error ? err.message : "Erro inesperado.", "Voltar para login");
});
